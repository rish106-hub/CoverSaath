import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createInsurerDisclosureRefresher, parseQuarterLabel, parseRetailHealthClaimsTables } from '../src/modules/policy-breakdown/references/insurer-reported-disclosures.js';
import { loadBreakdownReferences } from '../src/modules/policy-breakdown/references/reference-store.js';
import { createFakeOfficialSourceAdapter } from '../src/modules/policy-breakdown/references/official/fake-adapter.js';
import { OFFICIAL_SOURCE_REGISTRY } from '../src/modules/policy-breakdown/references/official/registry.js';
import { sectionByNumber } from '../src/modules/policy-breakdown/sections/index.js';

// Synthetic page in the published table shape; the numbers are invented.
const page = readFileSync(new URL('./fixtures/official-sources/insurer-claims-data.html', import.meta.url), 'utf8');
const source = OFFICIAL_SOURCE_REGISTRY.find(entry => entry.id === 'hdfc-ergo.claims-data');
const insurer = source.publisher;

test('quarter labels map to the quarter end date', () => {
  assert.deepEqual(parseQuarterLabel("Apr'26 - Jun'26"), { label: "Apr'26 - Jun'26", start: '2026-04-01', end: '2026-06-30' });
  assert.equal(parseQuarterLabel("Jan'27 – Mar'27").end, '2027-03-31');
  assert.equal(parseQuarterLabel('Q1 2026'), null);
});

test('the retail health column is parsed, reconciled and the TAT read; script payloads are ignored', () => {
  const parsed = parseRetailHealthClaimsTables(page);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.period.end, '2027-03-31');
  assert.deepEqual(parsed.counts, { opening: 1000, intimated: 10000, paid: 9000, repudiated: 500, closedWithoutPayment: 100, closing: 1400 });
  assert.equal(parsed.disposed, 9600);
  assert.equal(parsed.averageReimbursementDays, 5);
});

test('a table that does not reconcile is rejected, not half-used', () => {
  assert.deepEqual(parseRetailHealthClaimsTables(page.replace('<td>1,400</td>', '<td>1,401</td>')), { ok: false, reason: 'claims_table_does_not_reconcile' });
  assert.equal(parseRetailHealthClaimsTables('<table><tr><td>nothing</td></tr></table>').ok, false);
});

test('the refresher writes dated entries, skips fresh sources, keeps the last good file on failure, and section 10 shows the newest period', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'knowvia-disclosures-'));
  try {
    // An older government figure for the same insurer and metric.
    writeFileSync(join(directory, 'insurer-disclosures.json'), JSON.stringify({ entries: [
      { insurerName: 'HDFC ERGO General Insurance Co. Ltd.', metric: 'incurred_claim_ratio', value: 87.04, period: 'FY2024-25', publishedOn: '2026-02-03', source: 'IRDAI Handbook 2024-25, Table 62' },
      { insurerName: 'HDFC ERGO General Insurance Co. Ltd.', metric: 'claim_settlement_ratio_count', value: 90, period: 'FY2024-25', publishedOn: '2026-02-03', source: 'synthetic older figure' },
    ] }));
    let clock = new Date('2027-05-02T10:00:00Z');
    let responses = { [source.canonicalUrl]: { body: page, mimeType: 'text/html' } };
    const adapter = { fetch: request => createFakeOfficialSourceAdapter({ registry: [source], responses }).fetch(request) };
    const refresher = createInsurerDisclosureRefresher({ adapter, registry: [source], directory, now: () => clock });
    assert.deepEqual(await refresher.refreshIfStale(), [{ source: source.id, status: 'refreshed', period: '2027-03-31', entries: 3 }]);
    assert.deepEqual(await refresher.refreshIfStale(), [], 'a fresh source is not fetched again');

    const references = loadBreakdownReferences({ directory });
    const parameters = { insurer_name: { evidenceState: 'Proven', value: { kind: 'text', text: insurer } } };
    const byKey = new Map(sectionByNumber(10).analyze({ asOf: '2027-05-02', parameters, household: { members: [], city: null }, references }).map(item => [item.key, item]));
    const csr = byKey.get('claim_settlement_ratio_count');
    assert.equal(csr.evidenceState, 'Dynamic');
    assert.deepEqual(csr.value, { kind: 'percent', percent: 93.75 });
    assert.match(csr.stateReason, /2027-03-31/);
    assert.match(csr.notes, /insurer-reported/);
    assert.equal(byKey.get('incurred_claim_ratio').value.percent, 87.04, 'government-only metrics still come from IRDAI');
    assert.equal(byKey.get('average_settlement_days').value.count, 5);

    // A week later the page fails to parse: the last good entries stay and the failure is recorded.
    clock = new Date('2027-05-10T10:00:00Z');
    responses = { [source.canonicalUrl]: { body: '<html>maintenance</html>', mimeType: 'text/html' } };
    assert.equal((await refresher.refreshIfStale())[0].status, 'failed');
    assert.equal(loadBreakdownReferences({ directory }).insurerDisclosures.filter(entry => entry.sourceKind === 'insurer_reported').length, 3);
    assert.equal(refresher.status()[source.id].lastError, 'PARSE_RETAIL_HEALTH_TABLE_NOT_FOUND');
    assert.deepEqual(await refresher.refreshIfStale(), [], 'a failed source waits before retrying');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
