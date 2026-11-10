import test from 'node:test';
import assert from 'node:assert/strict';
import {
  amountBand, canonicalJson, comparable, parse, parseMemberAges, parseNcbTiers, parsePaymentEvent, scan, toStorage, valuesIn,
} from '../src/features/policy-facts/normalisers.js';
import { extractFacts } from '../src/features/policy-facts/deterministic-extractors.js';
import { verifyEvidence } from '../src/features/policy-facts/evidence-verify.js';
import {
  FACT_TYPES, FACT_TYPE_PATTERN, FACT_TYPE_TO_REGISTRY_KEY, VALUE_TYPES, applicableFactTypes, isFactType, modelMayProposeFact,
} from '../src/features/policy-facts/fact-types.js';
import { POLICY_PARAMETER_REGISTRY_VERSION, getPolicyParameterRegistry } from '../src/features/coverage-analysis/policy-parameter-registry.js';

// Policy facts slice 2 (ADR 0025): pure tests of the normalisers, the deterministic extractors, the evidence verifier and the fact-type
// list. Synthetic text only. No database.

const first = (kind, text) => valuesIn(kind, text)[0] ?? null;

test('money: INR minor units, lakh and crore, trailing /-, words in brackets, and refusal of rates', () => {
  const table = [
    ['Rs. 5,00,000/-', 50_000_000],
    ['₹5 Lakh', 50_000_000],
    ['INR 12,345.50', 1_234_550],
    ['Rs 1 crore', 1_000_000_000],
    ['5,00,000 (Rupees Five Lakh only)', 50_000_000],
    ['Rs. 2,500', 250_000],
    ['rs 0', 0],
  ];
  for (const [text, minor] of table) assert.deepEqual(first('money', text), { amountMinor: minor, currency: 'INR' }, text);
  assert.deepEqual(valuesIn('money', 'no amount here'), []);
  assert.equal(valuesIn('money', 'Rs 5 lakh or Rs 6 lakh').length, 2, 'two amounts are two values; a fact needs exactly one');
  assert.deepEqual(valuesIn('money', 'Rs 99999999999999999'), [], 'a runaway amount is refused');
  assert.equal(parse('money', 'Rs. 2,000 per day'), null, 'a rate is not a plain amount');
  assert.equal(parse('money', 'seven'), null);
});

test('amount bands cover the range with no gap and no overlap', () => {
  const table = [[0, 'lt_10k'], [999_999, 'lt_10k'], [1_000_000, '10k_50k'], [4_999_999, '10k_50k'], [5_000_000, '50k_1l'], [10_000_000, '1l_5l'],
    [50_000_000, '5l_10l'], [100_000_000, '10l_25l'], [250_000_000, '25l_50l'], [500_000_000, '50l_1cr'], [1_000_000_000, 'gte_1cr']];
  for (const [minor, band] of table) assert.equal(amountBand(minor), band, String(minor));
});

test('dates: day-first order, month names, ordinals, ISO; impossible dates and odd years are refused', () => {
  const table = [
    ['01/04/2026', '2026-04-01'], ['1-4-2026', '2026-04-01'], ['2026-04-01', '2026-04-01'], ['1 April 2026', '2026-04-01'],
    ['1st Apr, 2026', '2026-04-01'], ['31-Mar-2027', '2027-03-31'], ['29/02/2028', '2028-02-29'],
  ];
  for (const [text, iso] of table) assert.deepEqual(first('date', text), { iso }, text);
  for (const text of ['31/02/2026', '32/01/2026', '01/13/2026', '01/01/1850', 'no date']) assert.equal(first('date', text), null, text);
});

test('date_range: a policy period needs exactly two dates in order; days are inclusive', () => {
  assert.deepEqual(first('date_range', '01/04/2026 to 31/03/2027'), { startIso: '2026-04-01', endIso: '2027-03-31', days: 365 });
  assert.deepEqual(first('date_range', 'From 15 Jan 2026 until 14 Jan 2027, 00:00 hrs'), { startIso: '2026-01-15', endIso: '2027-01-14', days: 365 });
  assert.deepEqual(first('date_range', '2027-03-01 - 2028-02-29'), { startIso: '2027-03-01', endIso: '2028-02-29', days: 366 });
  assert.equal(first('date_range', '01/04/2026'), null, 'one date is not a range');
  assert.equal(first('date_range', '31/03/2027 to 01/04/2026'), null, 'end before start');
  assert.equal(first('date_range', '01/01/2026 to 01/02/2026 to 01/03/2026'), null, 'three dates');
});

test('durations: compound waiting periods become days and keep the printed unit', () => {
  const table = [
    ['30 days', 30, [{ amount: 30, unit: 'day' }]],
    ['36 months', 1095, [{ amount: 36, unit: 'month' }]],
    ['3 years', 1095, [{ amount: 3, unit: 'year' }]],
    ['2 years 6 months', 910, [{ amount: 2, unit: 'year' }, { amount: 6, unit: 'month' }]],
    ['2 years and 6 months', 910, [{ amount: 2, unit: 'year' }, { amount: 6, unit: 'month' }]],
    ['48 months', 1460, [{ amount: 48, unit: 'month' }]],
    ['six months', 180, [{ amount: 6, unit: 'month' }]],
    ['two (2) years', 730, [{ amount: 2, unit: 'year' }]],
    ['1 year 1 month 5 days', 400, [{ amount: 1, unit: 'year' }, { amount: 1, unit: 'month' }, { amount: 5, unit: 'day' }]],
    ['Nil', 0, [{ amount: 0, unit: 'day' }]],
  ];
  for (const [text, days, original] of table) assert.deepEqual(first('duration', text), { days, original }, text);
  assert.equal(first('duration', '6 months 2 years'), null, 'units out of order are ambiguous');
  assert.equal(first('duration', 'sometime'), null);
  assert.equal(toStorage('duration', first('duration', '2 years 6 months')).sealed, '{"days":910,"original":[{"amount":2,"unit":"year"},{"amount":6,"unit":"month"}]}');
});

test('percent and copay: basis points, decimals, and refusal of out-of-range or repeated values', () => {
  assert.deepEqual(first('percent', '20%'), { bp: 2000 });
  assert.deepEqual(first('percent', '7.5 percent'), { bp: 750 });
  assert.deepEqual(first('percent', '100 per cent'), { bp: 10_000 });
  assert.deepEqual(valuesIn('percent', '10% of claim, 20% above 60 years').map(item => item.bp), [1000, 2000]);
  assert.equal(first('percent', '150%'), null);
  assert.equal(first('percent', 'twenty'), null);
});

test('no-claim bonus tiers: a plain ascending list or labelled years; duplicates and overflows are refused', () => {
  assert.deepEqual(parseNcbTiers('10%, 20%, 30%, 40%, 50%'), { tiers: [1, 2, 3, 4, 5].map(year => ({ year, bp: year * 1000 })), maxBp: 5000 });
  assert.deepEqual(parseNcbTiers('Year 1: 10%, Year 3: 30%'), { tiers: [{ year: 1, bp: 1000 }, { year: 3, bp: 3000 }], maxBp: 3000 });
  assert.equal(parseNcbTiers('Year 1: 10%, Year 1: 20%'), null);
  assert.equal(parseNcbTiers('no percentages'), null);
  assert.equal(parseNcbTiers(Array.from({ length: 21 }, () => '5%').join(', ')), null);
});

test('payment: mode and frequency enums; an event with two modes or two dates is refused', () => {
  const modes = [['UPI', 'upi'], ['Credit Card', 'credit_card'], ['Debit card', 'debit_card'], ['Net Banking', 'net_banking'], ['Cheque', 'cheque'],
    ['Cash', 'cash'], ['NACH mandate', 'auto_debit'], ['Auto-debit', 'auto_debit']];
  for (const [text, mode] of modes) assert.deepEqual(first('payment_mode', text), { value: mode }, text);
  assert.equal(first('payment_mode', 'UPI or cheque'), null, 'two modes is ambiguous');
  assert.equal(first('payment_mode', 'Annual'), null, 'a frequency is not a mode');
  const frequencies = [['Annual', 'annual'], ['Yearly', 'annual'], ['Half-yearly', 'half_yearly'], ['Quarterly', 'quarterly'], ['Monthly', 'monthly'], ['Single premium', 'single']];
  for (const [text, value] of frequencies) assert.deepEqual(first('payment_frequency', text), { value }, text);
  assert.deepEqual(parsePaymentEvent('Paid via UPI on 12-03-2026, Rs. 12,345'), { mode: 'upi', dateIso: '2026-03-12', amountMinor: 1_234_500 });
  assert.deepEqual(parsePaymentEvent('Credit Card'), { mode: 'credit_card', dateIso: null, amountMinor: null });
  assert.equal(parsePaymentEvent('UPI on 01-01-2026 and cash on 02-02-2026'), null);
  assert.equal(parsePaymentEvent('thank you'), null);
});

test('seller type: only a printed word gives a type, direct needs the exact word, and nothing is ever inferred', () => {
  const table = [['Individual Agent', 'agent'], ['Corporate agent', 'agent'], ['Broker', 'broker'], ['POSP', 'posp'], ['Point of Sales Person (POSP) agent', 'posp'],
    ['Bancassurance', 'bancassurance'], ['Web aggregator', 'aggregator'], ['Direct', 'direct'], ['Insurer branch', 'insurer_branch']];
  for (const [text, value] of table) assert.deepEqual(first('seller_type', text), { value }, text);
  for (const text of ['', 'Website', 'Online', 'Self', 'Agent or Broker']) assert.equal(first('seller_type', text), null, text);
});

test('member ages: numbers with a unit or the word age; never a date of birth', () => {
  assert.deepEqual(parseMemberAges('Age: 34'), [34]);
  assert.deepEqual(parseMemberAges('Self 34 yrs, Spouse 36 years, Child 5 years old'), [34, 36, 5]);
  assert.deepEqual(parseMemberAges('DOB 01/01/1990'), []);
  assert.deepEqual(parseMemberAges('Age: 130'), []);
});

test('every scan is bounded and never throws on hostile input', () => {
  const hostile = [`${'9'.repeat(20000)}`, `Rs ${'1,'.repeat(5000)}`, `${'1 year '.repeat(2000)}`, `${'a'.repeat(100000)}`, '\u0000\uD800', `${'(('.repeat(5000)}`];
  const started = Date.now();
  for (const text of hostile) {
    for (const kind of ['money', 'date', 'date_range', 'duration', 'percent', 'number', 'age', 'payment_mode', 'payment_frequency', 'seller_type', 'text']) {
      assert.ok(Array.isArray(scan(kind, text)));
      assert.doesNotThrow(() => valuesIn(kind, text));
    }
    assert.doesNotThrow(() => parseNcbTiers(text));
    assert.doesNotThrow(() => parsePaymentEvent(text));
  }
  assert.ok(Date.now() - started < 3000, 'bounded CPU');
  assert.deepEqual(scan('money', 42), []);
  assert.equal(parse('nope', 'x'), null);
});

test('toStorage splits a value into coarse plaintext and one sealed canonical JSON, and refuses a mismatch', () => {
  assert.deepEqual(toStorage('money', { amountMinor: 50_000_000 }), {
    currency: 'INR', amountBand: '5l_10l', durationDays: null, percentBp: null, bool: null, enumValue: null, ym: null, sealed: '{"amountMinor":50000000,"currency":"INR"}',
  });
  assert.equal(toStorage('percent', { bp: 2000 }).sealed, null);
  assert.equal(toStorage('percent', { bp: 2000 }).percentBp, 2000);
  assert.equal(toStorage('date', { iso: '2026-04-01' }).ym, '2026-04');
  assert.equal(toStorage('date_range', { startIso: '2026-04-01', endIso: '2027-03-31', days: 365 }).durationDays, 365);
  assert.equal(toStorage('enum', { value: 'upi' }).enumValue, 'upi');
  assert.equal(toStorage('money', { iso: 'x' }), null);
  assert.equal(toStorage('mystery', { n: 1 }), null);
  assert.equal(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] }), '{"a":[{"c":2,"d":1}],"b":1}');
  assert.equal(comparable('duration', { days: 910, original: [] }), '910');
});

// ---- fact types --------------------------------------------------------------------------------------------------------------

test('fact types: shape, registry mapping (drift), model permission, and the term-life subset', () => {
  const registry = getPolicyParameterRegistry(POLICY_PARAMETER_REGISTRY_VERSION).parameters;
  const keys = new Set(registry.map(entry => entry.key));
  for (const [name, spec] of Object.entries(FACT_TYPES)) {
    assert.match(name, FACT_TYPE_PATTERN, name);
    assert.ok(VALUE_TYPES.includes(spec.valueType), name);
    assert.ok(spec.registryKey === null || keys.has(spec.registryKey), `${name} maps to a registry key that exists`);
    assert.equal(FACT_TYPE_TO_REGISTRY_KEY[name], spec.registryKey);
  }
  // A model may propose only a fact that maps to a registry key with modelExtraction.allowed.
  for (const name of Object.keys(FACT_TYPES)) {
    const key = FACT_TYPES[name].registryKey;
    const allowed = key !== null && registry.find(entry => entry.key === key).modelExtraction?.allowed === true;
    assert.equal(modelMayProposeFact(name), allowed, name);
  }
  for (const name of ['seller_type', 'seller_name', 'seller_code', 'seller_irdai_registration', 'member_age', 'member_count', 'premium_gst', 'payment_total', 'waiting_specific']) {
    assert.equal(modelMayProposeFact(name), false, `${name} is deterministic-only`);
  }
  assert.equal(modelMayProposeFact('sum_insured'), true);
  assert.equal(modelMayProposeFact('not_a_type'), false);
  assert.equal(isFactType('sum_insured'), true);
  assert.equal(isFactType('constructor'), false);
  assert.equal(isFactType('__proto__'), false);
  const term = applicableFactTypes('term_life');
  assert.ok(term.includes('sum_insured') && term.includes('policy_period') && term.includes('seller_type'));
  assert.ok(!term.includes('waiting_ped') && !term.includes('copay_percent') && !term.includes('ncb_tier'));
  assert.ok(applicableFactTypes('personal_health').includes('waiting_ped'));
});

// ---- extraction and verification -----------------------------------------------------------------------------------------------

const chunk = (id, page, blockIndexes, text) => ({ id, page, blockIndexes, text });
const SCHEDULE = chunk('p1-b0', 1, [0, 1], [
  'Policy Schedule',
  'Sum Insured: Rs. 5,00,000/-',
  'Policy Period: 01/04/2026 to 31/03/2027',
  'Total Premium Payable: Rs. 12,345',
  'GST @ 18%: Rs. 1,883',
  'Initial Waiting Period: 30 days',
  'Pre-existing Diseases Waiting Period: 36 months',
  'Maternity Waiting Period: 2 years 6 months',
  'Waiting Period for Cataract: 24 months',
  'Co-payment: 20%',
  'No Claim Bonus: 10%, 20%, 30%, 40%, 50%',
  'Mode of Payment: UPI',
  'Premium Payment Frequency: Annual',
  'Sold By: Individual Agent',
  'Agent Name: Meera Example',
  'Insured | Relation | Age',
  'Self 34 yrs',
  'Spouse age: 36',
].join('\n'));

function byKey(facts) {
  return new Map(facts.map(fact => [`${fact.factType}|${fact.scopeKey}`, fact]));
}

test('extraction: a labelled schedule gives each fact its normalised value and a quote that is a line of the chunk', () => {
  const { facts } = extractFacts([SCHEDULE]);
  const map = byKey(facts);
  assert.deepEqual(map.get('sum_insured|').value, { amountMinor: 50_000_000, currency: 'INR' });
  assert.deepEqual(map.get('policy_period|').value, { startIso: '2026-04-01', endIso: '2027-03-31', days: 365 });
  assert.equal(map.get('premium_total|').value.amountMinor, 1_234_500);
  assert.equal(map.get('premium_gst|').value.amountMinor, 188_300);
  assert.equal(map.get('waiting_initial|').value.days, 30);
  assert.equal(map.get('waiting_ped|').value.days, 1095);
  assert.equal(map.get('waiting_maternity|').value.days, 910);
  assert.equal(map.get('waiting_specific|cataract').value.days, 730);
  assert.equal(map.get('copay_percent|').value.bp, 2000);
  assert.equal(map.get('ncb_tier|year_3').value.bp, 3000);
  assert.equal(map.get('ncb_max|').value.bp, 5000);
  assert.equal(map.get('payment_mode_last|').value.value, 'upi');
  assert.equal(map.get('payment_frequency|').value.value, 'annual');
  assert.equal(map.get('seller_type|').value.value, 'agent');
  assert.equal(map.get('seller_name|').value.text, 'Meera Example');
  assert.equal(map.get('member_age|member_1').value.n, 34);
  assert.equal(map.get('member_age|member_2').value.n, 36);
  for (const fact of facts.filter(item => item.state === 'extracted_unverified')) {
    for (const evidence of fact.evidence) assert.ok(SCHEDULE.text.includes(evidence.quote), `${fact.factType} quote is a substring`);
    assert.equal(fact.evidence[0].role, 'primary');
  }
  assert.equal(facts.every(fact => fact.state !== 'reported'), true);
});

test('extraction: two different printed values give a conflicting fact with no value; the same value twice is corroborated', () => {
  const conflicting = extractFacts([chunk('p1-b0', 1, [0], 'Sum Insured: Rs. 5,00,000\nBasic Sum Insured: Rs. 10,00,000')]).facts.find(fact => fact.factType === 'sum_insured');
  assert.equal(conflicting.state, 'conflicting');
  assert.equal(conflicting.value, null);
  assert.deepEqual(conflicting.evidence.map(item => item.role), ['conflicting', 'conflicting']);
  const twice = extractFacts([chunk('p1-b0', 1, [0], 'Sum Insured: Rs. 5,00,000'), chunk('p2-b0', 2, [0], 'Total Sum Insured: 5 Lakh')]).facts.find(fact => fact.factType === 'sum_insured');
  assert.equal(twice.state, 'extracted_unverified');
  assert.deepEqual(twice.evidence.map(item => item.role), ['primary', 'corroborating']);
});

test('extraction: a line with two amounts is ambiguous and not read; a rate, a value-less label and a long line give nothing', () => {
  const text = ['Sum Insured: Rs. 5,00,000 or Rs. 10,00,000', 'Deductible: none given', `Room Rent: ${'x'.repeat(600)}`, 'Grace Period: a few days'].join('\n');
  const { facts } = extractFacts([chunk('p1-b0', 1, [0], text)]);
  assert.deepEqual(facts.filter(fact => fact.factType !== 'seller_type'), []);
});

test('extraction: a seller is never inferred. No printed seller gives unknown with no evidence; "Direct" counts only when printed', () => {
  const none = extractFacts([chunk('p1-b0', 1, [0], 'Sum Insured: Rs. 5,00,000\nPurchased online through the insurer website')]).facts.find(fact => fact.factType === 'seller_type');
  assert.equal(none.state, 'unknown');
  assert.equal(none.value, null);
  assert.deepEqual(none.evidence, []);
  const direct = extractFacts([chunk('p1-b0', 1, [0], 'Channel: Direct')]).facts.find(fact => fact.factType === 'seller_type');
  assert.equal(direct.state, 'extracted_unverified');
  assert.equal(direct.value.value, 'direct');
  const vague = extractFacts([chunk('p1-b0', 1, [0], 'Channel: Website')]).facts.find(fact => fact.factType === 'seller_type');
  assert.equal(vague.state, 'unknown');
});

test('extraction: lines that mention a waiting period or a term are not member ages', () => {
  const { facts } = extractFacts([chunk('p1-b0', 1, [0], 'Policy term: 3 years\nWaiting period for self: 2 years\nSelf age: 40')]);
  assert.deepEqual(facts.filter(fact => fact.factType === 'member_age').map(fact => fact.value.n), [40]);
});

test('extraction is bounded: a huge chunk list is truncated, not unbounded', () => {
  const lines = Array.from({ length: 6000 }, (_, index) => `Sum Insured: Rs. ${index + 1}`).join('\n');
  const result = extractFacts([chunk('p1-b0', 1, [0], lines)]);
  assert.equal(result.truncated, true);
  assert.ok(result.facts.length <= 200);
});

test('verify: the quote must be a substring of the cited chunk (NFC) on the cited page and block', () => {
  const base = { factType: 'sum_insured', value: { amountMinor: 50_000_000, currency: 'INR' }, quote: 'Sum Insured: Rs. 5,00,000/-', page: 1, blockIndex: 0 };
  assert.equal(verifyEvidence(base, SCHEDULE).ok, true);
  assert.equal(verifyEvidence({ ...base, quote: 'Sum Insured: Rs. 6,00,000/-' }, SCHEDULE).reason, 'quote_not_in_chunk');
  assert.equal(verifyEvidence({ ...base, page: 2 }, SCHEDULE).reason, 'page_mismatch');
  assert.equal(verifyEvidence({ ...base, blockIndex: 9 }, SCHEDULE).reason, 'block_not_in_chunk');
  assert.equal(verifyEvidence({ ...base, quote: '' }, SCHEDULE).reason, 'quote_missing');
  assert.equal(verifyEvidence({ ...base, quote: 'x'.repeat(501) }, SCHEDULE).reason, 'quote_too_long');
  assert.equal(verifyEvidence({ ...base, factType: 'not_a_type' }, SCHEDULE).reason, 'unknown_fact_type');
  assert.equal(verifyEvidence({ ...base, factType: 'constructor' }, SCHEDULE).reason, 'unknown_fact_type');
  // NFC: a decomposed accent in the quote matches the composed one in the chunk, and the other way round.
  const composed = chunk('p1-b0', 1, [0], 'Insurer: Café Synthetic');
  assert.equal(verifyEvidence({ factType: 'seller_name', value: { text: 'Café Synthetic' }, quote: 'Insurer: Café Synthetic', page: 1, blockIndex: 0 }, composed).ok, true);
});

test('verify: the value must parse from its own quote, and to the same value', () => {
  const quote = 'Sum Insured: Rs. 5,00,000/-';
  const make = value => ({ factType: 'sum_insured', value, quote, page: 1, blockIndex: 0 });
  assert.equal(verifyEvidence(make({ amountMinor: 50_000_000, currency: 'INR' }), SCHEDULE).ok, true);
  assert.equal(verifyEvidence(make({ amountMinor: 60_000_000, currency: 'INR' }), SCHEDULE).reason, 'value_not_in_quote', 'a paraphrased value is dropped');
  assert.equal(verifyEvidence(make(null), SCHEDULE).reason, 'value_invalid');
  // A quote that exists in the chunk but holds no money for a money fact.
  assert.equal(verifyEvidence({ factType: 'sum_insured', value: { amountMinor: 1, currency: 'INR' }, quote: 'Policy Schedule', page: 1, blockIndex: 0 }, SCHEDULE).reason, 'value_not_in_quote');
  // Durations compare by days: 36 months in the value, "3 years" in the quote.
  assert.equal(verifyEvidence({ factType: 'waiting_ped', value: { days: 1095, original: [{ amount: 36, unit: 'month' }] }, quote: 'Pre-existing Diseases Waiting Period: 36 months', page: 1, blockIndex: 0 }, SCHEDULE).ok, true);
  assert.equal(verifyEvidence({ factType: 'waiting_ped', value: { days: 365, original: [] }, quote: 'Pre-existing Diseases Waiting Period: 36 months', page: 1, blockIndex: 0 }, SCHEDULE).ok, false);
  // Free text must be a literal piece of the quote.
  assert.equal(verifyEvidence({ factType: 'seller_name', value: { text: 'Meera Example' }, quote: 'Agent Name: Meera Example', page: 1, blockIndex: 0 }, SCHEDULE).ok, true);
  assert.equal(verifyEvidence({ factType: 'seller_name', value: { text: 'Someone Else' }, quote: 'Agent Name: Meera Example', page: 1, blockIndex: 0 }, SCHEDULE).reason, 'value_not_in_quote');
});

test('verify: a model-proposed fact needs a fact type the registry lets a model propose', () => {
  const base = { value: { text: 'Meera Example' }, quote: 'Agent Name: Meera Example', page: 1, blockIndex: 0, origin: 'model_proposed' };
  assert.equal(verifyEvidence({ ...base, factType: 'seller_name' }, SCHEDULE).reason, 'model_not_permitted');
  assert.equal(verifyEvidence({ factType: 'sum_insured', value: { amountMinor: 50_000_000, currency: 'INR' }, quote: 'Sum Insured: Rs. 5,00,000/-', page: 1, blockIndex: 0, origin: 'model_proposed' }, SCHEDULE).ok, true);
});
