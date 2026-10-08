import test from 'node:test';
import assert from 'node:assert/strict';

import {
  INSURER_CLAIMS_INPUT, INSURER_CLAIMS_PARSERS, INSURER_CLAIMS_SOURCES, defineInsurerClaimsSources,
  nl37Period, parseNl37HealthPdf, parseNl37HealthText,
} from '../src/modules/policy-breakdown/references/insurer-claims-sources.js';
import { claimsTableEntries } from '../src/modules/policy-breakdown/references/insurer-reported-disclosures.js';
import { OFFICIAL_SOURCE_REGISTRY } from '../src/modules/policy-breakdown/references/official/registry.js';

// Synthetic NL-37 layouts (invented numbers). Health column is index 7 of 19 columns.
const HEADER = 'Sl. No. Claims Experience Fire Marine Cargo Marine Hull Total Marine Motor OD Motor TP Total Motor Health Personal Accident Travel Total Health Workmen’s Compensation Public Product Liability Engineering Aviation Crop Insurance Other segments Miscellaneous Total';
const nums = (health, lead = '') => `${lead ? `${lead} ` : ''}1 2 3 5 40 50 90 ${health.toLocaleString('en-US')} 10 5 ${(health + 15).toLocaleString('en-US')} 7 8 9 0 - 11 12 200`;
const VALUES = { opening: 1000, booked: 5000, reopened: 200, paid: 4500, repudiated: 300, closed: 150, buckets: [800, 250, 120, 80] };
const lakhs = ['₹ in Lakhs', `1 Claims O/S at the beginning of the period ${nums(999999)}`, `4 Claims Repudiated during the period ${nums(888888)}`];

function digit(v = VALUES, header = 'As at June 30, 2026\nUpto the quarter ending Jun 26') {
  return [
    'Go Digit style', 'Form NL-37-CLAIMS DATA', header, HEADER,
    `1 Claims O/S at the beginning of the period (A) ${nums(v.opening)}`,
    '2 Claims reported during the period (B)',
    `(a) Booked During the period ${nums(v.booked)}`,
    `(b) Reopened during the Period ${nums(v.reopened)}`,
    '(c) Other Adjustment - - - - - - - - - - - - - - - - - -',
    '3 Claims Settled during the period (C)',
    '(a) paid during the period', nums(v.paid),
    `4 Claims Repudiated during the period (D) ${nums(v.repudiated)}`,
    `Claims closed (E) ${nums(v.closed)}`,
    '6 Claims O/S at End of the period (F)',
    `Less than 3months ${nums(v.buckets[0])}`, `3 months to 6 months ${nums(v.buckets[1])}`,
    `6months to 1 year ${nums(v.buckets[2])}`, `1year and above ${nums(v.buckets[3])}`,
    'Claims Settlement Ratio 97% 100% - 100%', ...lakhs,
  ].join('\n');
}

function bajaj(v = VALUES) {
  return [
    'FORM NL-37-CLAIMS DATA', 'Name of the Insurer: Example General Upto the quarter ending _Q1 FY 2026-27', HEADER,
    `1 Claims O/S at the beginning of the period ${nums(v.opening)}`,
    '2 Claims reported during the period - -',
    `(a) Booked During the period ${nums(v.booked)}`, `(b) Reopened during the Period ${nums(v.reopened)}`,
    '3 Claims Settled during the period - -', '(a) paid during the period', `_____ ${nums(v.paid)}`,
    '(b) Other Adjustment ( to be specified)', '(i)_Partial Payments', '(ii)_______ - - - - - - -',
    '4 Claims Repudiated during the period - -', `Claims Repudiated during the period ${nums(v.repudiated)}`,
    'Other Adjustment ( to be specified)', '(i)_Other than Repudiated Claims',
    `(ii) - - - - - - - ${nums(v.closed)}`,
    '5 Unclaimed (Pending claims which are transferred) - - - - -', '6 Claims O/S at End of the period - -',
    `Less than 3months ${nums(v.buckets[0])}`, `3 months to 6 months ${nums(v.buckets[1])}`,
    `6months to 1 year ${nums(v.buckets[2])}`, `1year and above ${nums(v.buckets[3])}`, ...lakhs,
  ].join('\n');
}

function tata(v = VALUES) {
  return [
    'FORM NL-37-CLAIMS DATA', 'Upto the quarter ending 30th June 2026', HEADER,
    `1 Claims O/S at the beginning of the period ${nums(v.opening)}`,
    `2 Claims reported during the period ${nums(v.booked + v.reopened)}`,
    `(a) Booked During the period ${nums(v.booked)}`, `(b) Reopened during the Period ${nums(v.reopened)}`,
    '(c) Other Adjustment (to be specified)', '(i)__________', `(ii) ${nums(0)}`,
    `3 Claims Settled during the period ${nums(v.paid + v.repudiated)}`, '(a) paid during the period',
    '(b) Other Adjustment ( to be specified)', '(i)_______', `(ii)_______ ${nums(v.paid)}`,
    `4 Claims Repudiated during the period ${nums(v.repudiated)}`, 'Other Adjustment ( to be specified)',
    `(i) Claim Closed without payment ${nums(v.closed)}`, `5 Unclaimed (Pending claims) ${nums(5)}`,
    `6 Claims O/S at End of the period ${nums(v.buckets.reduce((a, b) => a + b, 0))}`,
    `Less than 3months ${nums(v.buckets[0])}`, `3 months to 6 months ${nums(v.buckets[1])}`,
    `6months to 1 year ${nums(v.buckets[2])}`, `1year and above ${nums(v.buckets[3])}`,
  ].join('\n');
}

function iffco(v = VALUES) {
  return [
    'FORM NL-37-CLAIMS DATA', 'Name of the Insurer: Example Ltd. Upto the quarter ending on September 2026', HEADER,
    `1 Claims O/S at the beginning of the period ${nums(v.opening)}`, `2 Claims reported during the period ${nums(v.booked + v.reopened)}`,
    `(a) Booked During the period ${nums(v.booked)}`, `(b) Reopened during the Period ${nums(v.reopened)}`,
    '(c) Other Adjustment (to be specified)', `(i)__________3 Claims Settled during the period ${nums(v.paid)}`,
    `(a) paid during the period ${nums(v.paid)}`, `4 Claims Repudiated during the period ${nums(v.repudiated)}`,
    'Other Adjustment ( to be specified)', '(i) Closed Claims', '(ii)_____________', nums(v.closed),
    '5 Unclaimed (Pending claims which are', 'transferred to Unclaimed A/c.)', nums(0),
    `6 Claims O/S at End of the period ${nums(1250)}`,
    `Less than 3months ${nums(v.buckets[0])}`, `3 months to 6 months ${nums(v.buckets[1])}`,
    `6months to 1 year ${nums(v.buckets[2])}`, `1year and above ${nums(v.buckets[3])}`, 'No. of claims only',
  ].join('\n');
}

const EXPECTED_COUNTS = { opening: 1000, intimated: 5200, paid: 4500, repudiated: 300, closedWithoutPayment: 150, closing: 1250 };
const BAD = { ...VALUES, buckets: [801, 250, 120, 80] };

for (const [name, build, end] of [['Go Digit layout', digit, '2026-06-30'], ['Bajaj layout', bajaj, '2026-06-30'], ['Tata AIG layout', tata, '2026-06-30'], ['IFFCO-Tokio layout', iffco, '2026-09-30']]) {
  test(`${name}: Health column is parsed and reconciled`, () => {
    const parsed = parseNl37HealthText(build());
    assert.equal(parsed.ok, true, parsed.reason);
    assert.deepEqual(parsed.counts, EXPECTED_COUNTS);
    assert.equal(parsed.disposed, 4950);
    assert.equal(parsed.period.end, end);
    assert.equal(parsed.segment, 'health_all_lines');
    assert.equal(Math.round(parsed.counts.paid / parsed.disposed * 10000) / 100, 90.91);
  });

  test(`${name}: a table that does not reconcile is rejected`, () => {
    assert.deepEqual(parseNl37HealthText(build(BAD)), { ok: false, reason: 'claims_table_does_not_reconcile' });
  });
}

test('the amounts table that follows the counts is never read', () => {
  assert.equal(parseNl37HealthText(digit()).counts.opening, 1000);
});

test('unrecognised column order, unknown period and misaligned columns fail closed', () => {
  assert.equal(parseNl37HealthText(digit().replace('Motor TP Total Motor Health', 'Motor TP Health Total Motor')).reason, 'nl37_columns_unrecognised');
  assert.equal(parseNl37HealthText(digit(VALUES, 'Upto the period')).reason, 'period_not_found');
  assert.equal(parseNl37HealthText(digit().replace(`${nums(VALUES.opening)}`, `${nums(VALUES.opening)}`.replace(/ 10 5 /, ' 11 5 '))).reason, 'health_column_not_aligned');
  assert.equal(parseNl37HealthText(digit().replace(`Claims closed (E) ${nums(VALUES.closed)}`, 'Claims closed (E) 1 2 3')).reason, 'claims_rows_incomplete');
  assert.equal(parseNl37HealthText('<html>not a claims table</html>').ok, false);
  assert.equal(parseNl37HealthText(undefined).ok, false);
});

test('a ragged row (wrong column count) is rejected, not shifted', () => {
  const ragged = digit().replace(`4 Claims Repudiated during the period (D) ${nums(VALUES.repudiated)}`, `4 Claims Repudiated during the period (D) ${nums(VALUES.repudiated).split(' ').slice(1).join(' ')}`);
  assert.equal(parseNl37HealthText(ragged).reason, 'row_shape_mismatch');
});

test('too few disposed claims is rejected', () => {
  assert.equal(parseNl37HealthText(digit({ opening: 10, booked: 40, reopened: 0, paid: 30, repudiated: 5, closed: 5, buckets: [5, 3, 1, 1] })).reason, 'too_few_disposed_claims');
});

test('periods are cumulative financial years up to a quarter end', () => {
  assert.deepEqual(nl37Period('Upto the quarter ending 30th June 2026'), { label: 'FY 2026-27 up to Jun 2026', start: '2026-04-01', end: '2026-06-30' });
  assert.equal(nl37Period('quarter ending Mar 27').start, '2026-04-01');
  assert.equal(nl37Period('Upto the quarter ending _Q4 FY 2025-26').end, '2026-03-31');
  assert.equal(nl37Period('Upto the quarter ending Q3 FY 2025-26').end, '2025-12-31');
  assert.equal(nl37Period('as at 15 July 2026'), null);
  assert.equal(nl37Period('quarter ending 15 June 2026'), null);
});

test('a PDF that cannot be read fails closed', async () => {
  assert.deepEqual(await parseNl37HealthPdf(Buffer.from('not a pdf')), { ok: false, reason: 'pdf_text_unreadable' });
});

test('parsed output feeds the existing reference entries', () => {
  const entries = claimsTableEntries(parseNl37HealthText(digit()), { insurerName: 'Example General', url: 'https://example.test/nl37.pdf', retrievedOn: '2026-10-08' });
  assert.equal(entries.find(entry => entry.metric === 'claim_settlement_ratio_count').value, 90.91);
  assert.equal(entries.find(entry => entry.metric === 'repudiation_ratio').value, 6.06);
});

test('every claims source passes defineOfficialSource and has a parser and input kind', () => {
  const defined = defineInsurerClaimsSources();
  assert.equal(defined.length, INSURER_CLAIMS_SOURCES.length);
  const ids = INSURER_CLAIMS_SOURCES.map(entry => entry.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const entry of defined) {
    assert.equal(entry.sourceClass, 'insurer_disclosure');
    assert.equal(entry.identity.scope, 'insurer');
    assert.ok(entry.canonicalUrl.startsWith('https://'));
    assert.ok(!entry.canonicalUrl.includes('?'));
    assert.equal(typeof INSURER_CLAIMS_PARSERS[entry.id], 'function');
    assert.equal(INSURER_CLAIMS_INPUT[entry.id], 'pdf');
    assert.equal(OFFICIAL_SOURCE_REGISTRY.filter(existing => existing.id === entry.id).length, 1, 'registered exactly once in the official registry');
  }
});
