// Round-2 privacy gate findings G1-G4. Every value below is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  PRIVACY_GATE_SCAN_CAP_BYTES,
  opaqueSourceId,
  sanitizeEvidenceForModel,
  sanitizeEvidenceTextForStorage,
} from '../src/features/ai-analysis/privacy-evidence-gate.js';
import { RESTRICTED_PROBES } from './support/privacy-probes.mjs';
import { setupLiveCase, startLiveServer } from './support/live-analysis-scenario.mjs';

const policy = () => ({ dataClass: 'CONFIDENTIAL', modelExtraction: { allowed: true }, registryVersion: 'policy-parameters/v1' });
const modelInput = (text, upstream = []) => ({
  context: { caseId: 'case-r2', subjectId: 'subject-r2', purpose: 'Extract requested policy facts.', requestedFields: ['d.room_rent_limit'] },
  sources: [{ id: 'page-r2', version: 'v1', page: 1, text, status: 'known' }],
  upstream,
});
const PLACEHOLDER = /<[A-Z]+(?:_[A-Z]+)*_[1-9][0-9]*>/g;

// [label, text, raw fragments that must not survive]
const G1_PROBES = Object.freeze([
  ['spaced unprefixed mobile', 'call 98765 43210 today', ['98765', '43210']],
  ['3-3-4 dashed mobile', 'dial 987-654-3210 today', ['987-654-3210', '3210']],
  ['Mobile No label', 'Mobile No: 9876543210', ['9876543210']],
  ['mobile label with dash', 'Mobile - 98765-43210', ['98765', '43210']],
  ['upper-case honorific with stop', 'Admitted MRS. ASHA SHARMA yesterday', ['ASHA', 'SHARMA']],
  ['upper-case honorific without stop', 'MR RAVI EXAMPLE signed', ['RAVI', 'EXAMPLE']],
  ['insured name without colon', 'Insured Name ASHA SHARMA', ['ASHA', 'SHARMA']],
  ['bare address label', 'Address: 12 Synthetic Road, Andheri, Mumbai 400001. Room rent limit is 5000.', ['12 Synthetic Road', 'Andheri', '400001']],
  ['DOB without separator', 'DOB 01/02/1980', ['01/02/1980']],
  ['date of birth with dash', 'Date of Birth - 01-02-1980', ['01-02-1980']],
  ['aadhaar split by dots', 'Aadhaar 2345.6789.0123 on file', ['2345.6789.0123', '6789']],
  ['aadhaar split by zero-width', 'id 2345​6789​0123 on file', ['6789', '234567890123']],
  ['full-width digits', 'number ２３４５ ６７８９ ０１２３ on file', ['２３４５', '6789', '６７８９']],
  ['Devanagari digits', 'मोबाइल ९८७६५४३२१०', ['९८७६५४३२१०', '9876543210']],
  ['lower-case unlabelled passport', 'travel k1234567 document', ['k1234567']],
  ['base64-encoded identifier', `ref ${Buffer.from('Asha Sharma 9876543210').toString('base64')} kept`, [Buffer.from('Asha Sharma 9876543210').toString('base64')]],
  ['Hindi honorific', 'रोगी श्रीमती आशा शर्मा भर्ती', ['आशा', 'शर्मा']],
  ['email label', 'E-mail: asha_at_example_test', ['asha_at_example_test']],
]);

test('G1: normalised identifier variants are minimised before storage and model use', () => {
  for (const [label, text, fragments] of G1_PROBES) {
    const stored = sanitizeEvidenceTextForStorage(text);
    const model = JSON.stringify(sanitizeEvidenceForModel(modelInput(text), { resolveParameterPolicy: policy }).input);
    for (const fragment of fragments) {
      assert.ok(!stored.text.includes(fragment), `${label}: "${fragment}" survived storage as ${stored.text}`);
      assert.ok(!model.includes(fragment), `${label}: "${fragment}" reached the model`);
    }
    assert.ok(stored.reasonCodes.length > 0, label);
  }
});

test('G1: policy wording that resembles identity labels is left intact', () => {
  for (const wording of [
    'Plan name: Gold Synthetic. Sum insured: 500000. In-patient: covered after admission.',
    'We will address your grievance within 15 days.',
    'Address of the hospital must be on the bill.',
    'Dr. visit fees are payable; do not miss the deadline.',
    'The Insured Person shall notify the TPA within 24 hours.',
    'Sum Assured is stated in the schedule.',
    'Contact the TPA helpdesk for cashless requests.',
  ]) {
    assert.equal(sanitizeEvidenceTextForStorage(wording).text, wording);
  }
});

const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Persisted rows and prompts carry random uuids and sha256 digests, whose hex digits
// can contain a short number by chance. A digit-only probe therefore counts as a leak
// only as a stand-alone token, i.e. not embedded in a longer run of hex characters.
// A real leak (the number, with or without spaces, in running text) still matches.
const leakPattern = fragment => (/^[0-9 ]+$/.test(fragment)
  ? new RegExp(`(?<![0-9a-fA-F])${escapeRegExp(fragment)}(?![0-9a-fA-F])`)
  : new RegExp(escapeRegExp(fragment)));

test('G1 end to end: OCR identifiers never reach the provider, run input, task output or audit', async t => {
  const modelRequests = [];
  const app = await startLiveServer(t, { modelRequests });
  // The identifiers share one allowlisted line (a requested parameter is named), since
  // the runtime sends only allowlisted lines of a page.
  const pageText = 'Room rent limit is 5000 for proposer MRS. KAVYA PLACEHOLDER, Mobile: 98765 43210, Address: 12 Synthetic Road';
  const scenario = await setupLiveCase(app, { pageText, suffix: 'g1-e2e' });
  const response = await scenario.startLiveRun('g1-end-to-end');
  assert.equal(response.status, 202);
  assert.ok(modelRequests.length >= 1, 'the live path must have dispatched to the stub model');

  const surfaces = {
    prompt: JSON.stringify(modelRequests.map(request => request.prompt)),
    runInput: JSON.stringify(app.database.prepare('SELECT input_json FROM workflow_runs').all()),
    taskOutput: JSON.stringify(app.database.prepare('SELECT input_json, output_json, last_error_message FROM workflow_tasks').all()),
    audit: JSON.stringify(app.database.prepare('SELECT event_payload_json FROM audit_events').all()),
    response: response.raw,
  };
  for (const fragment of ['KAVYA', 'Kavya', 'PLACEHOLDER', '98765', '43210', '9876543210', '12 Synthetic Road', 'Synthetic Road']) {
    for (const [surface, body] of Object.entries(surfaces)) {
      assert.doesNotMatch(body, leakPattern(fragment), `${fragment} leaked to ${surface}`);
    }
  }
  assert.match(surfaces.prompt, /<NAME_\d+>/);
  assert.match(surfaces.prompt, /<PHONE_\d+>/);
  assert.match(surfaces.prompt, /<ADDRESS_\d+>/);
});

test('G2: placeholders are per-request indices with no value-derived hash', () => {
  const values = ['Asha Example', 'asha@example.test', '9876543210', 'ABCDE1234F', '2345 6789 0123', 'K1234567'];
  const text = 'Patient name: Asha Example; email asha@example.test; phone +91 9876543210; PAN ABCDE1234F; Aadhaar 2345 6789 0123; Passport K1234567.';
  const runs = [
    sanitizeEvidenceTextForStorage(text).text,
    JSON.stringify(sanitizeEvidenceForModel(modelInput(text), { resolveParameterPolicy: policy }).input),
  ];
  for (const body of runs) {
    for (const value of values) {
      assert.ok(!body.includes(value), `${value} survived`);
      for (const variant of [value, value.trim(), value.replace(/\s+/g, ''), value.toLowerCase()]) {
        const hex = createHash('sha256').update(variant, 'utf8').digest('hex');
        for (const length of [8, 12, 16]) assert.ok(!body.includes(hex.slice(0, length)), `sha256 prefix of ${value} present`);
      }
    }
    assert.doesNotMatch(body, /<[A-Z_]+:[a-f0-9]{8,}>/, 'no hash-style tokens');
    assert.ok((body.match(PLACEHOLDER) ?? []).length >= 6);
  }

  // Same value -> same placeholder within one call, across sources and upstream.
  const repeated = sanitizeEvidenceForModel({
    ...modelInput('Mobile: 98765 43210. Call 9876543210 again. Other 91234 56789.'),
    upstream: [{ note: 'Mobile 98765-43210' }],
  }, { resolveParameterPolicy: policy });
  const sourceText = repeated.input.sources[0].text;
  const placeholders = sourceText.match(PLACEHOLDER);
  assert.deepEqual(placeholders, ['<PHONE_1>', '<PHONE_1>', '<PHONE_2>']);
  assert.match(JSON.stringify(repeated.input.upstream), /<PHONE_1>/);

  // Idempotent: stored placeholders are never rescanned; new ones do not collide.
  const stored = sanitizeEvidenceTextForStorage('Mobile: 98765 43210.');
  assert.equal(sanitizeEvidenceTextForStorage(stored.text).text, stored.text);
  const extended = sanitizeEvidenceTextForStorage(`${stored.text} Second 91234 56789.`).text;
  assert.equal(extended, `${stored.text} Second <PHONE_2>.`);

  // Legacy v1 hash tokens are replaced so their digests never reach a model.
  const legacy = sanitizeEvidenceTextForStorage('Earlier <PHONE:0123456789abcdef> and <NAME:fedcba9876543210>.');
  assert.doesNotMatch(legacy.text, /[a-f0-9]{16}/);
  assert.match(legacy.text, /^Earlier <PHONE_1> and <NAME_1>\.$/);
});

test('G2: opaqueSourceId returns exactly the id the gate assigns to a source', () => {
  for (const rawId of ['page-1', 'page-0b4f5e1a-1111-4222-8333-944455556666', 'p'.repeat(200)]) {
    const gate = sanitizeEvidenceForModel({ ...modelInput('Room rent limit is 5000.'), sources: [{ id: rawId, version: 'v1', page: 1, text: 'Room rent limit is 5000.', status: 'known' }] }, { resolveParameterPolicy: policy });
    assert.equal(opaqueSourceId(rawId), gate.input.sources[0].id);
    assert.match(opaqueSourceId(rawId), /^source_[a-f0-9]{24}$/);
  }
  assert.throws(() => opaqueSourceId(''), { code: 'PRIVACY_GATE_MALFORMED' });
  assert.throws(() => opaqueSourceId('p'.repeat(201)), { code: 'PRIVACY_GATE_MALFORMED' });
});

// Deterministic generator for ordinary policy-table rows.
function policyTableCorpus() {
  let seed = 20261014;
  const next = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed; };
  const unchanged = [];
  const anyOutcome = [];
  for (let year = 1995; year <= 2026; year += 1) {
    unchanged.push(`Premium table ${year} ${year + 1} ${year + 2} ${year + 3} ${year + 4}`);
    unchanged.push(`Policy years ${year} ${year + 1} ${year + 2} ${year + 3}`);
  }
  for (let step = 5; step <= 50; step += 5) {
    unchanged.push(`Copay ${Array.from({ length: 12 }, (_, index) => step * (index + 1)).join(' ')}`);
  }
  for (let index = 0; index < 40; index += 1) {
    const five = () => String(10000 + (next() % 90000));
    unchanged.push(`Zone ${String.fromCharCode(65 + (index % 4))} ${five()} ${five()} ${five()}`);
  }
  for (let index = 0; index < 30; index += 1) {
    const lakh = base => `${base + index},00,000`;
    unchanged.push(`Sum insured slabs ${lakh(1)} ${lakh(3)} ${lakh(5)} ${lakh(10)} with premium Rs. ${4000 + index * 37}`);
  }
  for (let index = 0; index < 20; index += 1) {
    unchanged.push(`Room rent ${1000 + index * 500} ${2000 + index * 500} per day; ICU ${5000 + index * 100} per day`);
  }
  for (let index = 0; index < 20; index += 1) {
    unchanged.push(`Sub-limit ${index + 1}% of sum insured up to ${(index + 1) * 25000} for cataract; waiting period ${12 + index} months`);
  }
  // Exactly four or five bare 4-digit premiums by age band. These are table
  // rows: they must never be rejected as payment cards (they may be minimised).
  for (let index = 0; index < 40; index += 1) {
    let premium = 2000 + (next() % 3000);
    const row = Array.from({ length: 4 + (index % 2) }, () => { premium += 100 + (next() % 900); return Math.min(premium, 9999); });
    anyOutcome.push(`Age band ${18 + index}-${25 + index} premium ${row.join(' ')}`);
  }
  return { unchanged, anyOutcome };
}

test('G3: at least 200 generated policy-table rows pass and are never treated as payment cards', () => {
  const { unchanged, anyOutcome } = policyTableCorpus();
  assert.ok(unchanged.length + anyOutcome.length >= 200, `corpus has ${unchanged.length + anyOutcome.length} rows`);
  for (const row of unchanged) {
    const stored = sanitizeEvidenceTextForStorage(row);
    assert.equal(stored.text, row, `table row changed: ${row}`);
    assert.doesNotThrow(() => sanitizeEvidenceForModel(modelInput(row), { resolveParameterPolicy: policy }), row);
  }
  for (const row of anyOutcome) {
    assert.doesNotThrow(() => sanitizeEvidenceTextForStorage(row), row);
  }
  for (const row of ['Premium table 2023 2024 2025 2026 2027', `Copay ${[10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120].join(' ')}`, 'Zone A 12345 23456 34567']) {
    assert.equal(sanitizeEvidenceTextForStorage(row).text, row);
  }
});

test('G3: real card shapes, labelled cards and embedded cards are still rejected', () => {
  for (const probe of [
    RESTRICTED_PROBES.cardSpaced, RESTRICTED_PROBES.cardDashed, RESTRICTED_PROBES.cardEmbeddedAfterReference,
    '4111111111111111', '3782 822463 10005', '5555.5555.5555.4444', '4111​1111​1111​1111',
    '４１１１ １１１１ １１１１ １１１１', 'Card no: 4111 1111 1111 1111', 'debit card 6011 0009 9013 9424',
    '5000 4111 1111 1111 1111',
  ]) {
    assert.throws(() => sanitizeEvidenceTextForStorage(`Synthetic note ${probe} end`), { code: 'RESTRICTED_EVIDENCE' }, probe);
  }
  // A base64-wrapped card is rejected too.
  assert.throws(() => sanitizeEvidenceTextForStorage(`blob ${Buffer.from('card 4111 1111 1111 1111').toString('base64')}`), { code: 'RESTRICTED_EVIDENCE' });
});

test('G4: worst-case inputs at the scan cap finish in bounded time', () => {
  const fill = (unit, bytes = PRIVACY_GATE_SCAN_CAP_BYTES) => unit.repeat(Math.ceil(bytes / Buffer.byteLength(unit))).slice(0, bytes);
  const inputs = {
    backslashRun: fill('\\'),
    escapedStructuredKey: fill('\\\\\\"caseId\\\\\\" '),
    hyphenatedWords: fill('a-'),
    hyphenatedHexWords: fill('abcdef-'),
    emailManyDots: `a@${fill('a.')}`,
    localPartNoAt: fill('a.'),
    repeatedAt: fill('a@'),
    spacedDigits: fill('1 '),
    dottedDigits: fill('4.'),
    fourDigitGroups: fill('4111 '),
    spacesAfterOtp: `otp${fill(' ')}`,
    spacesAfterPassport: `passport${fill(' ')}x`,
    repeatedLabels: fill('Name: '),
    repeatedHonorifics: fill('Mr '),
    capitalisedWords: fill('Mr A '),
    base64Upper: fill('A'),
    base64Mixed: fill('aB3+'),
    devanagariLabels: fill('मोबाइल '),
    placeholders: fill('<PHONE_1>'),
    legacyTokens: fill('<ID:0123456789abcdef>'),
    addressAbbreviations: `Address: ${fill('Rd. ')}`,
    mixedIdentifiers: fill('Proposer MRS. KAVYA PLACEHOLDER. Mobile: 98765 43210. Address: 12 Synthetic Road. '),
    overCap63k: fill('a-a@a.a\\', 63_000),
  };
  sanitizeEvidenceTextForStorage('warm up Mobile: 98765 43210 मोबाइल ९८७६५४३२१०');
  const timings = {};
  for (const [label, text] of Object.entries(inputs)) {
    const started = process.hrtime.bigint();
    try { sanitizeEvidenceTextForStorage(text, { maxBytes: 16_000 }); } catch (error) { assert.equal(error.code, 'RESTRICTED_EVIDENCE', label); }
    timings[label] = Number(process.hrtime.bigint() - started) / 1e6;
  }
  const slowest = Object.entries(timings).sort((left, right) => right[1] - left[1])[0];
  t_diagnostic(`slowest worst-case input: ${slowest[0]} ${slowest[1].toFixed(1)}ms`);
  for (const [label, ms] of Object.entries(timings)) assert.ok(ms < 200, `${label} took ${ms.toFixed(1)}ms`);
});

function t_diagnostic(message) {
  process.stdout.write(`# ${message}\n`);
}

test('G4: text beyond the scan cap never leaves the gate and is reported as truncated', () => {
  const head = 'Room rent limit is 5000. '.repeat(700);
  const result = sanitizeEvidenceTextForStorage(`${head}Mobile: 98765 43210`, { maxBytes: 16_000 });
  assert.ok(Buffer.byteLength(result.text) <= PRIVACY_GATE_SCAN_CAP_BYTES);
  assert.ok(!result.text.includes('98765'));
  assert.ok(result.reasonCodes.includes('TEXT_TRUNCATED'));
  assert.equal(result.truncated, true);
});
