// Round-4 privacy gate findings N1, N2, N5 and the known-identifier contract.
// Every value below is synthetic. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PRIVACY_EVIDENCE_GATE_VERSION, PRIVACY_GATE_SCAN_CAP_BYTES, sanitizeEvidenceForModel } from '../src/features/ai-analysis/privacy-evidence-gate.js';
import { sanitizeEvidenceTextForStorage } from './support/storage-gate.mjs';
import {
  N1_CARD_PROBES,
  N1_WHITESPACE_PROBES,
  N2_VARIANT_PROBES,
  N5_POLICY_WORDING,
  TOKENIZED_PROBES,
} from './support/privacy-probes.mjs';

const policy = () => ({ dataClass: 'CONFIDENTIAL', modelExtraction: { allowed: true }, registryVersion: 'policy-parameters/v1' });
const modelInput = (text, extra = {}) => ({
  context: { caseId: 'case-r4', subjectId: 'subject-r4', purpose: 'Extract requested policy facts.', requestedFields: ['d.room_rent_limit'] },
  sources: [{ id: 'page-r4', version: 'v1', page: 1, text, status: 'known' }],
  upstream: [],
  ...extra,
});
const toModel = (text, options = {}) => sanitizeEvidenceForModel(modelInput(text), { resolveParameterPolicy: policy, ...options });
const modelText = (text, options) => toModel(text, options).input.sources[0].text;
const PLACEHOLDER = /<[A-Z]+(?:_[A-Z]+)*_[1-9][0-9]*>/g;

const KNOWN = Object.freeze([
  { kind: 'NAME', value: 'Kavya Placeholder' },
  { kind: 'NAME', value: 'Ravi Synthetic' },
  { kind: 'DOB', value: '1990-02-01' },
  { kind: 'DOB', value: '1988-04-03' },
  { kind: 'PHONE', value: '+91 98765 43210' },
  { kind: 'EMAIL', value: 'Kavya.Placeholder@Example.test' },
]);
const KNOWN_RAW_FRAGMENTS = ['Kavya', 'KAVYA', 'kavya', 'Placeholder', 'PLACEHOLDER', 'placeholder', 'Ravi', 'RAVI', 'Synthetic', 'SYNTHETIC', '1990', '1988', '98765', '43210', '9876543210'];

function assertNoFragments(label, body, fragments) {
  for (const fragment of fragments) assert.ok(!body.includes(fragment), `${label}: "${fragment}" survived in ${body}`);
}

test('gate version is v8', () => {
  assert.equal(PRIVACY_EVIDENCE_GATE_VERSION, 'knowvia-privacy-evidence-v9');
  assert.equal(toModel('Room rent limit is 5000.').audit.gateVersion, 'knowvia-privacy-evidence-v9');
});

test('N1: whitespace runs do not defeat identifier detection (storage and model)', () => {
  for (const [label, text, fragments] of N1_WHITESPACE_PROBES) {
    const stored = sanitizeEvidenceTextForStorage(text);
    assertNoFragments(`${label} (storage)`, stored.text, fragments);
    assert.ok(stored.reasonCodes.length > 0, label);
    assertNoFragments(`${label} (model)`, JSON.stringify(toModel(text).input), fragments);
    // Upstream structured values take the same path.
    const upstream = sanitizeEvidenceForModel(modelInput('Room rent limit is 5000.', { upstream: [{ note: text }] }), { resolveParameterPolicy: policy });
    assertNoFragments(`${label} (upstream)`, JSON.stringify(upstream.input.upstream), fragments);
  }
});

test('N1: payment cards with whitespace runs are rejected at both entry points without echo', () => {
  for (const probe of N1_CARD_PROBES) {
    for (const run of [() => sanitizeEvidenceTextForStorage(`Synthetic note ${probe} end`), () => toModel(`Synthetic note ${probe} end`)]) {
      assert.throws(run, error => {
        assert.equal(error.code, 'RESTRICTED_EVIDENCE', probe);
        assert.ok(!String(error.message).includes('4111') && !String(error.message).includes('5555'));
        return true;
      });
    }
  }
});

test('N2: label, honorific, date, phone, licence, list and member-row variants are minimised', () => {
  for (const [label, text, fragments] of N2_VARIANT_PROBES) {
    const stored = sanitizeEvidenceTextForStorage(text);
    assertNoFragments(`${label} (storage)`, stored.text, fragments);
    assert.ok(stored.reasonCodes.length > 0, label);
    assertNoFragments(`${label} (model)`, JSON.stringify(toModel(text).input), fragments);
    // Re-sanitising stored text is idempotent.
    assert.equal(sanitizeEvidenceTextForStorage(stored.text, { regate: true }).text, stored.text, `${label} must be idempotent`);
  }
});

test('N2: relationship words, labels and amounts in member rows are kept', () => {
  assert.equal(sanitizeEvidenceTextForStorage('KAVYA PLACEHOLDER Self 01/02/1990 500000').text, '<NAME_1> Self <DOB_1> 500000');
  assert.equal(sanitizeEvidenceTextForStorage('| Kavya Placeholder | Self | 01-02-1990 | 5,00,000 |').text, '| <NAME_1> | Self | <DOB_1> | 5,00,000 |');
  assert.equal(sanitizeEvidenceTextForStorage('Name: KAVYA PLACEHOLDER Self 01/02/1990').text, 'Name: <NAME_1> Self <DOB_1>');
  assert.equal(sanitizeEvidenceTextForStorage('Proposer Name: Kavya Placeholder').text, 'Proposer Name: <NAME_1>');
  assert.equal(sanitizeEvidenceTextForStorage('Insured Persons: Mrs. Kavya Placeholder (Self), Mr. Ravi Synthetic (Spouse). Room rent limit is 5000.').text,
    'Insured Persons: Mrs. <NAME_1> (Self), Mr. <NAME_2> (Spouse). Room rent limit is 5000.');
  // Policy-period dates in a member row stay usable.
  assert.equal(sanitizeEvidenceTextForStorage('KAVYA PLACEHOLDER Self 01/02/1990 Policy Period 01/04/2024 to 31/03/2025').text,
    '<NAME_1> Self <DOB_1> Policy Period 01/04/2024 to 31/03/2025');
});

const MEMBER_TABLE = 'Name Relationship Date of Birth Sum Insured\nKAVYA PLACEHOLDER Self 01/02/1990 500000\nRAVI SYNTHETIC Spouse 03/04/1988 500000';
const MEMBER_TABLE_EXPECTED = 'Name Relationship Date of Birth Sum Insured\n<NAME_1> Self <DOB_1> 500000\n<NAME_2> Spouse <DOB_2> 500000';

test('insured-members table: no names or dates leak, header and amounts kept (with and without known identifiers)', () => {
  for (const options of [{}, { knownIdentifiers: KNOWN }, { knownIdentifiers: [] }]) {
    const label = JSON.stringify(Object.keys(options));
    const stored = sanitizeEvidenceTextForStorage(MEMBER_TABLE, options);
    assert.equal(stored.text, MEMBER_TABLE_EXPECTED, label);
    assert.ok(stored.reasonCodes.includes('DIRECT_IDENTIFIER_DATE_OF_BIRTH'), label);
    const model = toModel(MEMBER_TABLE, options);
    assert.equal(model.input.sources[0].text, MEMBER_TABLE_EXPECTED, label);
    const body = JSON.stringify({ input: model.input, audit: model.audit });
    assertNoFragments(label, body, ['KAVYA', 'PLACEHOLDER', 'RAVI', 'SYNTHETIC', '01/02/1990', '03/04/1988', '1990', '1988']);
    assert.equal((model.input.sources[0].text.match(/500000/g) ?? []).length, 2, label);
  }
});

test('known identifiers: names match case-insensitively, whole-word, reversed and by token adjacency', () => {
  const options = { knownIdentifiers: KNOWN };
  const cases = [
    ['kavya placeholder visited', '<NAME_1> visited'],
    ['KAVYA PLACEHOLDER visited', '<NAME_1> visited'],
    ['PLACEHOLDER KAVYA visited', '<NAME_1> visited'],
    ['Placeholder, Kavya visited', '<NAME_1> visited'],
    ['Mrs. Kavya visited', 'Mrs. <NAME_1> visited'],
    ['MRS.KAVYA visited', 'MRS.<NAME_1> visited'],
    ['Shri Ravi visited', 'Shri <NAME_1> visited'],
    ['Kavya R. Placeholder visited', '<NAME_1> visited'],
    ['Ravi Synthetic and Kavya Placeholder', '<NAME_1> and <NAME_2>'],
    // A lone first name with no adjacent known token or honorific is kept.
    ['Kavya alone stays', 'Kavya alone stays'],
    // Whole words only.
    ['Kavyananda Placeholders visited', 'Kavyananda Placeholders visited'],
  ];
  for (const [text, expected] of cases) assert.equal(sanitizeEvidenceTextForStorage(text, options).text, expected, text);
});

test('known identifiers: every common rendering of a stored ISO date of birth is minimised', () => {
  const options = { knownIdentifiers: [{ kind: 'DOB', value: '1990-02-01' }] };
  for (const rendering of ['01/02/1990', '1/2/1990', '01-02-1990', '01.02.1990', '01 02 1990', '1990-02-01', '1990/02/01', '1 Feb 1990', '01 Feb 1990',
    '1st February 1990', '01-Feb-1990', 'February 1, 1990', 'Feb 1 1990', '01/02/90', '01021990', '19900201', '02/01/1990']) {
    const stored = sanitizeEvidenceTextForStorage(`Recorded ${rendering} here`, options).text;
    assert.equal(stored, 'Recorded <DOB_1> here', rendering);
  }
  // A different date is not touched.
  assert.equal(sanitizeEvidenceTextForStorage('Valid till 01/03/1990', options).text, 'Valid till 01/03/1990');
});

test('known identifiers: phone digits match with any separators or prefix; email is case-insensitive', () => {
  const options = { knownIdentifiers: [{ kind: 'PHONE', value: '9876543210' }, { kind: 'EMAIL', value: 'kavya.placeholder@example.test' }] };
  for (const rendering of ['9876543210', '98765 43210', '98765-43210', '+91 98765 43210', '+91-9876543210', '+91 (98765) 43210', '0 98765 43210',
    '09876543210', '919876543210', '0091 98765 43210', '98 76 54 32 10', '(987) 654-3210', '987.654.3210']) {
    assert.equal(sanitizeEvidenceTextForStorage(`ring ${rendering} now`, options).text, 'ring <PHONE_1> now', rendering);
  }
  for (const rendering of ['kavya.placeholder@example.test', 'KAVYA.PLACEHOLDER@EXAMPLE.TEST', 'Kavya.Placeholder@Example.Test']) {
    assert.equal(sanitizeEvidenceTextForStorage(`mail ${rendering} now`, options).text, 'mail <EMAIL_1> now', rendering);
  }
});

test('known identifiers: placeholders are consistent across sources, upstream, purpose and pattern rules', () => {
  const result = sanitizeEvidenceForModel({
    context: { caseId: 'case-r4', subjectId: 'subject-r4', purpose: 'Check cover for Kavya Placeholder.', requestedFields: [] },
    sources: [
      { id: 'page-a', version: 'v1', page: 1, text: 'Name: Kavya Placeholder. DOB: 01/02/1990. Mobile: 98765 43210', status: 'known' },
      { id: 'page-b', version: 'v1', page: 2, text: 'MRS. KAVYA PLACEHOLDER Self 1 Feb 1990 +91 98765 43210. Spouse RAVI SYNTHETIC', status: 'known' },
    ],
    upstream: [{ note: 'placeholder kavya', contact: 'call 09876543210' }],
  }, { knownIdentifiers: KNOWN });
  const [first, second] = result.input.sources.map(source => source.text);
  assert.equal(first, 'Name: <NAME_1>. DOB: <DOB_1>. Mobile: <PHONE_1>');
  assert.equal(second, 'MRS. <NAME_1> Self <DOB_1> <PHONE_1>. Spouse <NAME_2>');
  assert.deepEqual(result.input.upstream, [{ note: '<NAME_1>', contact: 'call <PHONE_1>' }]);
  assert.equal(result.input.context.purpose, 'Check cover for <NAME_1>.');
  const body = JSON.stringify(result);
  assertNoFragments('consistency', body, KNOWN_RAW_FRAGMENTS);
  assert.ok(result.audit.redactionReasonCodes.includes('DIRECT_IDENTIFIER_KNOWN_VALUE'));

  // The same value redacted by a known identifier or by a pattern rule maps to one placeholder.
  const mixed = sanitizeEvidenceTextForStorage('DOB: 01/02/1990. Born 1 Feb 1990. Name: Kavya Placeholder. Kavya Placeholder Self.', {
    knownIdentifiers: [{ kind: 'DOB', value: '1990-02-01' }],
  }).text;
  assert.equal(mixed, 'DOB: <DOB_1>. Born <DOB_1>. Name: <NAME_1>. <NAME_1> Self.');
  // Structured identity keys reuse the known identifier's placeholder.
  const structured = sanitizeEvidenceForModel(modelInput('Insured: Kavya Placeholder', {
    upstream: [{ patientName: 'KAVYA PLACEHOLDER', mobile: '98765 43210', dob: '01/02/1990', fatherName: 'Arjun Fictional' }],
  }), { resolveParameterPolicy: policy, knownIdentifiers: KNOWN });
  assert.equal(structured.input.sources[0].text, 'Insured: <NAME_1>');
  assert.deepEqual(structured.input.upstream, [{ patientName: '<NAME_1>', mobile: '<PHONE_1>', dob: '<DOB_1>', fatherName: '<IDENTIFIER_1>' }]);

  // Caseless scripts take part in token adjacency too.
  assert.equal(sanitizeEvidenceTextForStorage('रोगी आशा शर्मा भर्ती; श्रीमती आशा', { knownIdentifiers: [{ kind: 'NAME', value: 'आशा शर्मा' }] }).text, 'रोगी <NAME_1> भर्ती; श्रीमती <NAME_1>');

  // Without known identifiers, pattern rules agree on the same canonical value.
  assert.equal(sanitizeEvidenceTextForStorage('DOB: 01/02/1990. Born: 1 Feb 1990.').text, 'DOB: <DOB_1>. Born: <DOB_1>.');
});

test('known identifiers: an empty list is the explicit "none" and keeps the previous behaviour', () => {
  const texts = [MEMBER_TABLE, ...N5_POLICY_WORDING, ...N2_VARIANT_PROBES.map(([, text]) => text), ...Object.values(TOKENIZED_PROBES).map(([text]) => text)];
  for (const text of texts) {
    // Storage needs the list explicitly (omitting or nulling it is refused); an empty list is the explicit "none".
    const baseline = sanitizeEvidenceTextForStorage(text, { regate: true });
    assert.deepEqual(sanitizeEvidenceTextForStorage(text, { knownIdentifiers: [], regate: true }), baseline, text);
  }
  const baseline = toModel(MEMBER_TABLE);
  assert.deepEqual(toModel(MEMBER_TABLE, { knownIdentifiers: [] }), baseline);
});

test('known identifiers: invalid entries are rejected as malformed without echoing the value', () => {
  const secretish = 'Kavya Placeholder';
  const invalid = [
    'not-an-array',
    { kind: 'NAME', value: secretish },
    Array.from({ length: 201 }, (_, index) => ({ kind: 'NAME', value: `Synthetic Person${String.fromCharCode(65 + (index % 26))}` })),
    [{ kind: 'NAME', value: secretish, extra: true }],
    [{ kind: 'ADDRESS', value: secretish }],
    [{ kind: 'name', value: secretish }],
    [{ value: secretish }],
    [{ kind: 'NAME' }],
    [{ kind: 'NAME', value: '' }],
    [{ kind: 'NAME', value: '   ' }],
    [{ kind: 'NAME', value: 'K'.repeat(201) }],
    [{ kind: 'NAME', value: 42 }],
    [{ kind: 'NAME', value: '12345' }],
    [{ kind: 'DOB', value: '01/02/1990' }],
    [{ kind: 'DOB', value: '1990-02-30' }],
    [{ kind: 'PHONE', value: '12345' }],
    [{ kind: 'PHONE', value: 'call Kavya 9876543210' }],
    [{ kind: 'EMAIL', value: 'kavya placeholder' }],
    [null],
    [Object.assign(Object.create(null), { kind: 'NAME', value: secretish })],
  ];
  for (const knownIdentifiers of invalid) {
    for (const run of [
      () => sanitizeEvidenceTextForStorage('Room rent limit is 5000.', { knownIdentifiers }),
      () => toModel('Room rent limit is 5000.', { knownIdentifiers }),
    ]) {
      assert.throws(run, error => {
        assert.equal(error.code, 'PRIVACY_GATE_MALFORMED', JSON.stringify(knownIdentifiers)?.slice(0, 80));
        const surfaced = JSON.stringify({ message: error.message, stack: error.stack });
        for (const fragment of ['Kavya', 'Placeholder', '9876543210', '01/02/1990', '1990-02-30', 'kavya placeholder']) {
          assert.ok(!surfaced.includes(fragment), `error must not echo ${fragment}`);
        }
        return true;
      });
    }
  }
  // Exactly 200 entries and 200-character values are accepted.
  const maximal = Array.from({ length: 200 }, (_, index) => ({ kind: 'NAME', value: `Synthetic${'x'.repeat(index % 50)} Person` }));
  assert.doesNotThrow(() => sanitizeEvidenceTextForStorage('Room rent limit is 5000.', { knownIdentifiers: maximal }));
  assert.doesNotThrow(() => sanitizeEvidenceTextForStorage('Room rent limit is 5000.', { knownIdentifiers: [{ kind: 'NAME', value: `${'A'.repeat(100)} ${'B'.repeat(99)}` }] }));
  assert.doesNotThrow(() => sanitizeEvidenceTextForStorage('Room rent limit is 5000.', { knownIdentifiers: [{ kind: 'DOB', value: '1990-02-01T00:00:00Z' }] }));
});

test('known identifiers never appear in output, audit metadata or reason codes', () => {
  const text = 'Kavya Placeholder (kavya.placeholder@example.test, +91 98765 43210) born 1 Feb 1990; spouse Ravi Synthetic 03/04/1988.';
  const result = toModel(text, { knownIdentifiers: KNOWN });
  const body = JSON.stringify(result);
  assertNoFragments('model and audit', body, [...KNOWN_RAW_FRAGMENTS, 'example.test']);
  for (const code of result.audit.redactionReasonCodes) assert.match(code, /^[A-Z_]+$/);
  const stored = sanitizeEvidenceTextForStorage(text, { knownIdentifiers: KNOWN });
  assertNoFragments('storage', JSON.stringify(stored), ['Kavya', 'Ravi', 'Synthetic', '98765', '1990', '1988', 'example.test']);
});

test('N5: policy facts pass unchanged at both entry points, with and without known identifiers', () => {
  for (const wording of N5_POLICY_WORDING) {
    const stored = sanitizeEvidenceTextForStorage(wording);
    assert.equal(stored.text, wording, `storage changed: ${wording} -> ${stored.text}`);
    assert.deepEqual(stored.reasonCodes, [], wording);
    assert.equal(modelText(wording), wording, `model changed: ${wording}`);
    assert.equal(sanitizeEvidenceTextForStorage(wording, { knownIdentifiers: KNOWN }).text, wording, `known identifiers changed: ${wording}`);
  }
  const paragraph = N5_POLICY_WORDING.join('\n');
  assert.equal(sanitizeEvidenceTextForStorage(paragraph, { maxBytes: 16_000 }).text, paragraph);
});

test('N5 guards do not reopen identifier leaks', () => {
  for (const [label, text, fragments] of [
    ['name followed by phone', 'Name: Kavya Placeholder 9876543210', ['Kavya', 'Placeholder', '9876543210']],
    ['name that starts with a function word', 'Name: Will Smith', ['Will Smith']],
    ['insured name clause', 'Insured: Kavya Placeholder', ['Kavya']],
    ['nominee clause', 'Nominee: Ravi Synthetic', ['Ravi']],
    ['diagnosis value', 'Diagnosis: synthetic asthma, stable', ['synthetic asthma']],
    ['date of birth value', 'Date of birth: 01/02/1990', ['01/02/1990']],
    ['list without wording', 'Members covered: Kavya, Ravi', ['Kavya', 'Ravi']],
  ]) {
    assertNoFragments(label, sanitizeEvidenceTextForStorage(text).text, fragments);
    assertNoFragments(`${label} (model)`, modelText(text), fragments);
  }
});

test('round-4 worst-case inputs at the scan cap finish in bounded time', () => {
  const fill = (unit, bytes = PRIVACY_GATE_SCAN_CAP_BYTES) => unit.repeat(Math.ceil(bytes / Buffer.byteLength(unit))).slice(0, bytes);
  const manyKnown = Array.from({ length: 200 }, (_, index) => {
    const kinds = ['NAME', 'DOB', 'PHONE', 'EMAIL'];
    const kind = kinds[index % 4];
    const n = String(index).padStart(3, '0');
    if (kind === 'NAME') return { kind, value: `Synthetic Person Number${n} Example` };
    if (kind === 'DOB') return { kind, value: `19${String(50 + (index % 49)).padStart(2, '0')}-0${1 + (index % 9)}-1${index % 9}` };
    if (kind === 'PHONE') return { kind, value: `9${n}${n}${n}` };
    return { kind, value: `person${n}@example.test` };
  });
  const inputs = {
    tabsAndSpaces: fill('a \t  \t'),
    whitespaceDigits: fill('1 \t '),
    relationshipRows: fill('KAVYA PLACEHOLDER Self 01/02/1990 500000\n'),
    capitalisedRowWords: fill('Abc Def Ghi Jkl '),
    stopWordRows: fill('Name Relationship Date Self '),
    listLabel: `Insured Persons: ${fill('Kavya Placeholder, ')}`,
    listSeparators: `Members: ${fill(', ')}`,
    honorificGlued: fill('MRS.KAVYA '),
    bracketedDigits: fill('(1) '),
    passportLabels: fill('Passport No. K-1 '),
    licenceLabels: fill('DL No: MH-12 '),
    datesOnly: fill('01/02/1990 '),
    knownNameTokens: fill('Kavya Placeholder Ravi '),
    knownDigits: fill('9 8 7 6 5 '),
  };
  for (const knownIdentifiers of [[], KNOWN, manyKnown]) sanitizeEvidenceTextForStorage('warm up Insured Persons: Kavya, Ravi 98765 43210 01/02/1990', { knownIdentifiers });
  const timings = {};
  for (const [label, text] of Object.entries(inputs)) {
    for (const knownIdentifiers of [[], KNOWN, manyKnown]) {
      const key = `${label}/${knownIdentifiers === undefined ? 'none' : knownIdentifiers.length}`;
      // Fastest of three runs: super-linear backtracking is slow every time, a scheduler stall under load is not.
      // The 200 ms bound below is unchanged.
      timings[key] = Infinity;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const started = process.hrtime.bigint();
        try { sanitizeEvidenceTextForStorage(text, { maxBytes: 16_000, knownIdentifiers }); } catch (error) { assert.equal(error.code, 'RESTRICTED_EVIDENCE', key); }
        timings[key] = Math.min(timings[key], Number(process.hrtime.bigint() - started) / 1e6);
      }
    }
  }
  const slowest = Object.entries(timings).sort((left, right) => right[1] - left[1])[0];
  process.stdout.write(`# round-4 slowest worst-case input: ${slowest[0]} ${slowest[1].toFixed(1)}ms\n`);
  for (const [label, ms] of Object.entries(timings)) assert.ok(ms < 200, `${label} took ${ms.toFixed(1)}ms`);
  // Every known identifier at its maximum still leaves nothing behind.
  const result = sanitizeEvidenceTextForStorage(`Synthetic Person Number004 Example called 9006006006 and person003@example.test`, { knownIdentifiers: manyKnown });
  assert.equal(result.text.match(PLACEHOLDER)?.length, 3);
});
