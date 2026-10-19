import test from 'node:test';
import assert from 'node:assert/strict';
import { structurePolicyDocument } from '../src/modules/policy-structuring/index.js';
import { TOKENIZED_PROBES } from './support/privacy-probes.mjs';

// W2 outgoing-payload harness. structurePolicyDocument runs with an injected fake provider that captures
// the exact request every call would send (system prompt, registry catalog, chunk text, section titles,
// reconcile input). Every assertion is on that captured body, never on the source pages or on the
// sanitised chunks. No network. Every person, number and condition below is synthetic.
const enabled = { POLICY_STRUCTURING_ENABLED: 'true' };
const html = rows => `<table>${rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}</table>`;

// Household members, passed to the gate as known identifiers (the server loads these for the call only).
const KNOWN = Object.freeze([
  { kind: 'NAME', value: 'Kavya Zorbanath' }, { kind: 'NAME', value: 'Ravi Zorbanath' },
  { kind: 'DOB', value: '1971-03-14' }, { kind: 'DOB', value: '1975-09-02' },
  { kind: 'PHONE', value: '+91 98765 43210' }, { kind: 'EMAIL', value: 'kavya.zorbanath@example.test' },
]);

const PAGES = Object.freeze([
  { page: 1, blocks: [
    { text: 'Synthetic Assurance Ltd', tag: 'header' },
    { text: 'Policy Schedule for Kavya Zorbanath', tag: 'section-title' },
    { text: [
      'Policy No: 4455/7788/2026-01',
      'Customer ID: CUST55123409',
      'Proposer Name: Kavya Zorbanath',
      'Address: Flat 12, Larkspur Residency, Brindle Road, Pune 411001',
      'Mobile: +91 98765 43210',
      'Email: kavya.zorbanath@example.test',
      'Nominee Name: Meera Vellichor (Mother)',
      'Aadhaar: 2345 6789 0124',
    ].join('\n'), tag: 'paragraph' },
    { text: html([
      ['Insured Name', 'Member ID', 'Date Of Birth', 'Relationship', 'Pre-existing Disease', 'Loading Reason'],
      ['Kavya Zorbanath', 'QZ8812345678', '14/03/1971', 'Self', 'Synthetic Gout', 'Fictional Obesity'],
      ['Ravi Zorbanath', 'QZ8812345679', '02/09/1975', 'Spouse', 'Nil', 'Nil'],
    ]), tag: 'table' },
    { text: html([['Aadhaar Number', 'XXXX XXXX 9101', 'PAN', 'QWERT5678Z']]), tag: 'table' },
  ] },
  { page: 2, blocks: [
    { text: 'Declared Conditions of Ravi Zorbanath', tag: 'section-title' },
    { text: html([['ICD Code', 'Description'], ['Q99.1', 'Fictional joint disorder'], ['E11.9', 'Synthetic sugar disorder']]), tag: 'table' },
    { text: 'Medical condition: Synthetic Gout', tag: 'paragraph' },
    { text: html([
      ['Insured', 'Member', 'Date of', 'Pre-existing'],
      ['Person Name', 'ID', 'Birth', 'Condition'],
      ['Anaya Trenholm', 'QZ8812345680', '21/11/2001', 'Fictional Asthma'],
    ]), tag: 'table' },
    { text: 'Member ID\tDate Of Birth\tLoading Reason\nQZ8812345681\t05/06/1999\tFictional Obesity', tag: 'paragraph' },
  ] },
  { page: 3, blocks: [
    { text: 'Waiting Periods', tag: 'section-title' },
    { text: 'Pre-existing diseases are covered after 3 Years of continuous cover.', tag: 'paragraph' },
    { text: 'PED waiting period: 36 months.', tag: 'paragraph' },
    { text: html([['Benefit', 'Limit'], ['Room rent', '1% of SI'], ['Pre-hospitalisation', '60 days']]), tag: 'table' },
  ] },
]);

// Every sensitive category the fixtures hold. Matched case-insensitively against the captured body.
const SWEEP = Object.freeze({
  names: ['Kavya Zorbanath', 'Ravi Zorbanath', 'Meera Vellichor', 'Anaya Trenholm'],
  nameParts: ['Kavya', 'Ravi', 'Zorbanath', 'Meera', 'Vellichor', 'Anaya', 'Trenholm'],
  datesOfBirth: ['14/03/1971', '02/09/1975', '21/11/2001', '05/06/1999', '1971', '1975', '2001', '1999'],
  memberIds: ['QZ8812345678', 'QZ8812345679', 'QZ8812345680', 'QZ8812345681', '88123456'],
  customerIds: ['CUST55123409', '55123409'],
  policyNumbers: ['4455/7788/2026-01', '4455', '7788'],
  aadhaar: ['2345 6789 0124', '234567890124', '6789', '0124'],
  aadhaarTail: ['9101'],
  pan: ['QWERT5678Z', '5678Z'],
  phone: ['98765', '43210', '9876543210'],
  email: ['kavya.zorbanath@example.test', 'kavya.zorbanath'],
  address: ['Flat 12', 'Larkspur', 'Brindle Road', 'Pune', '411001'],
  icdCodes: ['Q99.1', 'E11.9'],
  conditions: ['Gout', 'Asthma', 'joint disorder', 'sugar disorder'],
  loadingReasons: ['Obesity'],
});

function sweep(body) {
  const lower = body.toLowerCase();
  const hits = {};
  for (const [category, values] of Object.entries(SWEEP)) {
    const found = values.filter(value => lower.includes(value.toLowerCase()));
    if (found.length) hits[category] = found;
  }
  return hits;
}

// Captures each request body exactly as it would be serialised for the provider. Extraction answers quote
// every line it was sent (as proposals keyed by line number), so the reconcile call carries document text too.
function capturingProvider() {
  const requests = [];
  const call = async request => {
    requests.push(JSON.stringify(request));
    const { payload } = request;
    if (!payload.chunks) return { json: { conflicts: [] }, usage: { inputTokens: 10, outputTokens: 2 } };
    const items = payload.chunks.flatMap(chunk => chunk.text.split('\n').filter(line => line.trim()).map((line, index) => ({
      chunk_id: chunk.chunk_id, proposed: { proposed_key: `synthetic_line_${index}`, category: 'unassigned', label: 'Line' },
      value: line.trim(), subject: 'policy', evidence_quote: line.trim(), page: chunk.page, block_index: chunk.block_indexes[0],
      confidence: 'high', rationale: 'Synthetic.',
    })));
    for (const chunk of payload.chunks) {
      for (const [quote, value] of [['after 3 Years', '3 Years'], ['waiting period: 36 months', '36 months']]) {
        if (chunk.text.includes(quote)) items.push({ chunk_id: chunk.chunk_id, registry_key: 'f.ped_waiting_period', value, subject: 'policy', evidence_quote: quote, page: chunk.page, block_index: chunk.block_indexes[0], confidence: 'high', rationale: 'Synthetic.' });
      }
    }
    return { json: { items }, usage: { inputTokens: 100, outputTokens: 20 } };
  };
  return { call, requests };
}

const run = provider => structurePolicyDocument({ pages: PAGES, call: provider.call, consentCheck: () => {}, knownIdentifiers: KNOWN, env: enabled });

test('positive control: the sweep finds every category in the source pages', () => {
  const hits = sweep(JSON.stringify(PAGES));
  assert.deepEqual(Object.keys(hits).sort(), Object.keys(SWEEP).sort());
});

test('every captured outgoing request has 0 sensitive-data matches in every category', async () => {
  const provider = capturingProvider();
  const result = await run(provider);
  const kinds = provider.requests.map(body => (JSON.parse(body).payload.chunks ? 'extract' : 'reconcile'));  assert.ok(kinds.includes('extract') && kinds.includes('reconcile'), 'both call kinds were captured');
  for (const [index, body] of provider.requests.entries()) {
    assert.deepEqual(sweep(body), {}, `request ${index} (${kinds[index]}) leaked`);
    // Every probe class in the shared probe set as well: none of their raw values is in the body.
    for (const [name, [, raw]] of Object.entries(TOKENIZED_PROBES)) assert.equal(body.includes(raw), false, `${name} in request ${index}`);
  }
  // The registry catalog, prompt, titles and chunk text were all in the swept bodies.
  const extract = JSON.parse(provider.requests[kinds.indexOf('extract')]);
  assert.ok(Array.isArray(extract.payload.registry) && extract.payload.registry.length > 0);
  assert.equal(typeof extract.system, 'string');
  const titles = provider.requests.flatMap(body => JSON.parse(body).payload.chunks ?? []).map(chunk => chunk.title);
  assert.ok(titles.some(title => typeof title === 'string' && title.includes('<NAME_')), 'a gated title with a person placeholder was sent');
  const reconcile = JSON.parse(provider.requests[kinds.indexOf('reconcile')]);
  assert.ok(reconcile.payload.groups.some(group => group.readings.some(reading => reading.quote.includes('<'))), 'reconcile readings carry gated table text');
  // The tab-separated table is refused by the gate and never sent.
  assert.ok(Object.values(result.extraction.chunkOutcomes).some(outcome => outcome.reason === 'privacy_gate_refused'));
  assert.equal(provider.requests.some(body => body.includes('Loading Reason')), true, 'the member table header itself is kept');
});

test('the payload sweep holds without known identifiers, relying on labels and table headers alone', async () => {
  const provider = capturingProvider();
  await structurePolicyDocument({ pages: PAGES, call: provider.call, consentCheck: () => {}, env: enabled });
  assert.ok(provider.requests.length > 0);
  for (const [index, body] of provider.requests.entries()) {
    const hits = sweep(body);
    // Household names in prose titles need the known identifiers; every other category must hold.
    delete hits.names;
    delete hits.nameParts;
    assert.deepEqual(hits, {}, `request ${index} leaked`);
  }
});
