import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createNetworkCountRefresher, NETWORK_LOCATOR_DISCOVERY_SOURCES } from '../src/modules/policy-breakdown/references/network-counts.js';
import { createFakeOfficialSourceAdapter } from '../src/modules/policy-breakdown/references/official/fake-adapter.js';
import { OFFICIAL_SOURCE_REGISTRY } from '../src/modules/policy-breakdown/references/official/registry.js';
import { createReferenceProvider } from '../src/modules/policy-breakdown/references/reference-store.js';
import { sectionByNumber } from '../src/modules/policy-breakdown/sections/index.js';

const insurer = 'HDFC ERGO General Insurance Company Limited';
const url = 'https://customer-portal.hdfcergo.com/content/v1/locator/hospitals?offset=0&limit=1&city=Pune';
// Synthetic locator page: invented hospital, invented count.
const body = JSON.stringify({ count: 123, data: [{ enabled: 1, name: 'Example Hospital', address: 'Example Road', city: 'PUNE', pincode: '411001' }] });

test('the locator count becomes a dated, insurer-reported Section 10 value and is fetched once a day', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'knowvia-network-'));
  try {
    let calls = 0;
    const fake = createFakeOfficialSourceAdapter({ registry: OFFICIAL_SOURCE_REGISTRY, discoverySources: NETWORK_LOCATOR_DISCOVERY_SOURCES, responses: { [url]: { body, mimeType: 'application/json' } } });
    const adapter = { fetchDiscovered: (...args) => { calls += 1; return fake.fetchDiscovered(...args); } };
    const provider = createReferenceProvider({ directory, ttlMs: 60_000 });
    provider();
    const refresher = createNetworkCountRefresher({ adapter, directory, now: () => new Date('2026-10-08T06:00:00Z'), onUpdated: () => provider.invalidate() });
    assert.deepEqual(await refresher.ensureCount({ insurerName: insurer, city: 'Pune' }), { status: 'ok', count: 123 });
    assert.deepEqual(await refresher.ensureCount({ insurerName: insurer, city: 'Pune' }), { status: 'fresh' });
    assert.equal(calls, 1);

    const parameters = { insurer_name: { evidenceState: 'Proven', value: { kind: 'text', text: insurer } } };
    const result = sectionByNumber(10).analyze({ asOf: '2026-10-08', parameters, household: { members: [], city: 'Pune' }, references: provider() })
      .find(item => item.key === 'network_hospitals_in_city');
    assert.equal(result.evidenceState, 'Dynamic');
    assert.equal(result.value.count, 123);
    assert.match(result.stateReason, /retrieved 2026-10-08/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an insurer without a registered locator costs no request and adds nothing', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'knowvia-network-'));
  try {
    let calls = 0;
    const refresher = createNetworkCountRefresher({ adapter: { fetchDiscovered: () => { calls += 1; } }, directory });
    assert.equal((await refresher.ensureCount({ insurerName: 'Some Other Insurer Limited', city: 'Pune' })).status, 'unsupported');
    assert.equal(calls, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
