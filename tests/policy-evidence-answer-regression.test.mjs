// Block 2 delta close-out, task 2: F-B / F-C regressions on a synthetic policy shaped like a real one (benefits table
// labelled as an exclusion, opt-out rows in the schedule, a described-but-not-selected benefit). Synthetic only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackendServices } from '../src/backend/services/backend-services.js';
import { INVESTIGATION_VERSION, buildClauses, investigate } from '../src/features/policy-evidence/index.js';
import { parameterAt as at, seedParameterWorld } from './support/parameter-fixtures.mjs';
import { freshDatabase, postgresTestOptions } from './support/pg.mjs';

const row = (...cells) => `<tr>${cells.map(cell => `<td>${cell}</td>`).join('')}</tr>`;
const table = (...rows) => `<table>${rows.join('')}</table>`;
const stored = { pages: [
  { page: 3, status: 'stored', blocks: [
    { tag: 'section-title', text: 'Add-ons and optional covers' },
    { tag: 'table', text: table(row('Parenthood', 'Not Opted'), row('Infinite Benefit', 'Not Opted'), row('Base Plan as opted', 'Active')) },
  ] },
  { page: 6, status: 'stored', blocks: [
    { tag: 'section-title', text: 'Schedule of benefits and exclusions' },
    { tag: 'table', text: table(row('1.1.a', 'Room Rent', 'At Actuals'), row('1.2', 'Cosmetic surgery', 'Not Covered'), row('2.13', 'Infinite Benefit', 'Bonus of 100% of the Base Sum Insured post every policy year'), row('2.14', 'Parenthood', 'Cover for delivery expenses after a waiting period')) },
  ] },
  { page: 8, status: 'stored', blocks: [
    { tag: 'section-title', text: 'Room rent limits' },
    { tag: 'paragraph', text: 'For the Shared room plan, room rent is limited to 1% of the sum insured per day.' },
  ] },
  { page: 17, status: 'stored', blocks: [
    { tag: 'section-title', text: 'Claim procedure' },
    { tag: 'paragraph', text: 'Decision on cashless authorization will be provided within 1 hour from the time of receipt of the request.' },
  ] },
  { page: 19, status: 'stored', blocks: [
    { tag: 'section-title', text: 'Schedule' },
    { tag: 'paragraph', text: 'Policy schedule: room rent is capped at Rs. 5,000 per day for this policy.' },
  ] },
] };
const clauses = buildClauses(stored, { documentId: 'doc-1', sourceVersion: 'v1' }).clauses;
const textOf = needle => clauses.find(clause => clause.text.includes(needle));
const finding = (needle, quote, extra = {}) => ({ clause_ids: [textOf(needle).clauseId], quote, subject: 'x', conditions: [], exceptions: [], ...extra });
const ask = async (question, findings, overrides = []) => investigate({
  question, clauses, consentCheck: async () => {},
  call: async ({ task }) => ({ json: task === 'policy_evidence_investigate' ? { findings } : { overrides }, usage: {} }),
});
const everyBucket = answer => JSON.stringify([answer.covered, answer.limited_or_excluded, answer.conditions]);

test('room rent "At Actuals" from a table labelled as an exclusion is covered (F-B)', async () => {
  const { answer } = await ask('What is the room rent limit?', [finding('At Actuals', 'Room Rent | At Actuals', { subject: 'Room rent', effect: 'covers' })]);
  assert.equal(answer.covered.length, 1);
  assert.equal(answer.limited_or_excluded.length, 0);
});

test('a genuine room rent sublimit is limited, and a covers label on it does not make it covered', async () => {
  const limited = await ask('Is room rent limited?', [finding('limited to 1%', 'room rent is limited to 1% of the sum insured per day', { subject: 'Room rent', effect: 'limits' })]);
  assert.equal(limited.answer.limited_or_excluded.length, 1);
  assert.equal(limited.answer.covered.length, 0);
  const mislabelled = await ask('Is room rent limited?', [finding('limited to 1%', 'room rent is limited to 1% of the sum insured per day', { subject: 'Room rent', effect: 'covers' })]);
  assert.equal(mislabelled.answer.covered.length, 0);
});

test('Parenthood "Not Opted" in the schedule outranks a covers label on the described benefit', async () => {
  const { answer } = await ask('Is parenthood cover included?', [finding('Cover for delivery expenses', 'Cover for delivery expenses after a waiting period', { subject: 'Parenthood', effect: 'covers' })]);
  assert.equal(answer.covered.length, 0, everyBucket(answer));
  assert.ok(answer.conditions.some(entry => entry.effect === 'excludes' && /Parenthood \| Not Opted/.test(entry.text)), everyBucket(answer));
  assert.ok(answer.sources.some(source => source.page === 3 && /Not Opted/.test(source.quote)), 'the opt-out row is cited');
  assert.equal(answer.state, 'conditional');
});

test('Infinite Benefit described in the benefits table but not selected is not covered', async () => {
  const { answer } = await ask('Do I get the Infinite Benefit bonus?', [finding('Bonus of 100%', 'Bonus of 100% of the Base Sum Insured post every policy year', { subject: 'Infinite Benefit bonus', effect: 'covers' })]);
  assert.equal(answer.covered.length, 0, everyBucket(answer));
  assert.ok(answer.conditions.some(entry => /Infinite Benefit \| Not Opted/.test(entry.text)));
});

test('a covers label on a partial quote of a "Not Covered" row is not covered', async () => {
  const { answer } = await ask('Is cosmetic surgery covered?', [finding('Cosmetic surgery', 'Cosmetic surgery', { subject: 'Cosmetic surgery', effect: 'covers' })]);
  assert.equal(answer.covered.length, 0);
  assert.ok(answer.conditions.some(entry => entry.effect === 'excludes'));
});

test('an opted benefit for a different subject is untouched by an unrelated opt-out', async () => {
  const { answer } = await ask('What is the room rent?', [finding('At Actuals', 'Room Rent | At Actuals', { subject: 'Room rent', effect: 'covers' })]);
  assert.equal(answer.covered.length, 1);
});

test('"Not Applicable" in another plan column does not demote real coverage', async () => {
  const plans = [{ page: 2, status: 'stored', blocks: [{ tag: 'table', text: table(row('Maternity', 'Plan A: Covered after 24 months', 'Plan B: Not Applicable')) }] }];
  const built = buildClauses({ pages: plans }, { documentId: 'doc-2', sourceVersion: 'v1' }).clauses;
  const { answer } = await investigate({
    question: 'Is maternity covered on Plan A?', clauses: built, consentCheck: async () => {},
    call: async ({ task }) => ({ json: task === 'policy_evidence_investigate' ? { findings: [{ clause_ids: [built[0].clauseId], quote: 'Plan A: Covered after 24 months', subject: 'Maternity', effect: 'covers', conditions: [], exceptions: [] }] } : { overrides: [] }, usage: {} }),
  });
  assert.equal(answer.covered.length, 1);
});

test('an opt-out inside a very long row is still honoured', async () => {
  const long = [{ page: 2, status: 'stored', blocks: [{ tag: 'table', text: table(row('Parenthood', 'Not Opted', ...Array.from({ length: 80 }, () => 'filler cell text'))) }, { tag: 'paragraph', text: 'Parenthood cover pays delivery expenses.' }] }];
  const built = buildClauses({ pages: long }, { documentId: 'doc-3', sourceVersion: 'v1' }).clauses;
  const prose = built.find(clause => /delivery expenses/.test(clause.text));
  const { answer } = await investigate({
    question: 'Is parenthood cover included?', clauses: built, consentCheck: async () => {},
    call: async ({ task }) => ({ json: task === 'policy_evidence_investigate' ? { findings: [{ clause_ids: [prose.clauseId], quote: 'Parenthood cover pays delivery expenses', subject: 'Parenthood', effect: 'covers', conditions: [], exceptions: [] }] } : { overrides: [] }, usage: {} }),
  });
  assert.equal(answer.covered.length, 0);
});

test('cataract absent from every clause read gives a not-named unknown and no evidence', async () => {
  const { answer } = await ask('Is cataract surgery covered?', []);
  assert.ok(answer.unknowns.some(text => /cataract/.test(text) && /not named/.test(text)));
  assert.equal(answer.state, 'insufficient_evidence');
  assert.equal(answer.covered.length, 0);
});

test('cashless authorization time is kept as a cited condition', async () => {
  const { answer } = await ask('How long does cashless authorization take?', [finding('within 1 hour', 'within 1 hour from the time of receipt of the request', { subject: 'Cashless authorization', effect: 'conditions' })]);
  assert.ok(answer.conditions.some(entry => /within 1 hour/.test(entry.text)));
  assert.ok(answer.sources.some(source => source.page === 17));
});

test('schedule capping room rent against product wording "At Actuals": both are shown and the answer is conditional', async () => {
  const { answer } = await ask('What is the room rent limit?',
    [finding('At Actuals', 'Room Rent | At Actuals', { subject: 'Room rent', effect: 'covers' })],
    [{ clause_ids: [textOf('capped at Rs. 5,000').clauseId], quote: 'room rent is capped at Rs. 5,000 per day', effect: 'limits', target_finding_ids: ['f1'] }]);
  assert.equal(answer.covered.length, 1);
  assert.equal(answer.limited_or_excluded.length, 1);
  assert.deepEqual(answer.limited_or_excluded[0].targets, ['f1']);
  assert.equal(answer.state, 'conditional');
});

test('a model effect label never turns an excludes or conditions finding into covered', async () => {
  const { answer } = await ask('Is cosmetic surgery covered?', [finding('Cosmetic surgery', 'Cosmetic surgery | Not Covered', { subject: 'Cosmetic surgery', effect: 'excludes' })]);
  assert.equal(answer.covered.length, 0);
  assert.equal(answer.limited_or_excluded.length, 1);
});

test('answers are stamped with the v2 pipeline version', async () => {
  const { answer } = await ask('What is the room rent limit?', []);
  assert.equal(answer.pipelineVersion, INVESTIGATION_VERSION);
  assert.match(INVESTIGATION_VERSION, /\/v2$/);
});

// Stored answers from the v1 pipeline carry no effect-based buckets. They must stay readable, keep their own version
// stamp, and replay without a model call; they are never restamped or re-bucketed as v2 evidence.
test('a stored v1 answer replays unchanged and is not restamped as v2', postgresTestOptions(), async t => {
  const { db: database } = await freshDatabase(t);
  await seedParameterWorld(database);
  const services = createBackendServices(database, { clock: () => new Date(at) });
  const v1 = {
    question: 'Is room rent limited?', state: 'conditional', covered: [], legalReview: 'required', calculations: [], unknowns: ['x'], overrides_checked: [],
    limited_or_excluded: [{ findingId: 'f1', subject: 'Room rent', quote: 'At Actuals', clauseIds: ['c1'], pages: [6], conditions: [], exceptions: [], overrides: [] }],
    conditions: [], sources: [{ documentId: 'document-parameters', page: 6, quote: 'At Actuals', clauseId: 'c1' }], pipelineVersion: 'policy-evidence-investigation/v1',
  };
  const save = () => services.clauses.saveAnswer({
    householdId: 'household-parameters', caseId: 'case-parameters', requestedByAdultId: 'adult-parameters', idempotencyKey: 'idem-key-v1-0001', requestDigest: 'a'.repeat(64),
    question: v1.question, answer: v1, access: { consentGrantId: 'grant-question', subjectAdultId: 'adult-parameters', documentIds: ['document-parameters'] },
  });
  const first = await save();
  const replay = await save();
  assert.equal(replay.replayed, true);
  assert.equal(replay.answer.pipelineVersion, 'policy-evidence-investigation/v1');
  assert.deepEqual(replay.answer.limited_or_excluded, v1.limited_or_excluded);
  assert.notEqual(first.answer.pipelineVersion, INVESTIGATION_VERSION);
});
