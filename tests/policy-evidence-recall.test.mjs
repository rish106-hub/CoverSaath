import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/backend/database/index.js';
import { createBackendServices } from '../src/backend/services/backend-services.js';
import { buildClauses, evaluateRecall } from '../src/features/policy-evidence/index.js';
import { parameterAt, parameterIds, seedParameterWorld } from './support/parameter-fixtures.mjs';

// Synthetic only. Proves the scorer and the sweep reach; says nothing about recall on real policies.
const filler = Array.from({ length: 30 }, (_, index) => ({ page: 20 + index, status: 'stored', blocks: [
  { tag: 'section-title', text: `General provisions ${index}` },
  { tag: 'paragraph', text: `Provision ${index} describes administrative handling of correspondence, notices and renewal reminders for the insured.` },
] }));
const stored = { pages: [
  { page: 2, status: 'stored', blocks: [{ tag: 'section-title', text: 'Eye Benefits' }, { tag: 'paragraph', text: 'We will pay for cataract surgery as a hospitalisation benefit.' }] },
  ...filler,
  { page: 61, status: 'stored', blocks: [{ tag: 'section-title', text: 'Exclusions' }, { tag: 'paragraph', text: 'We will not pay for phacoemulsification performed within the first 24 months.' }] },
] };

function world(t) {
  const database = openDatabase({ path: ':memory:' });
  t.after(() => database.close());
  seedParameterWorld(database);
  const services = createBackendServices(database, { clock: () => new Date(parameterAt) });
  const { householdId, caseId, documentId } = parameterIds;
  services.clauses.saveClauses({ householdId, caseId, documentId, clauses: buildClauses(stored, { documentId, sourceVersion: 'v1' }).clauses });
  const clauses = services.clauses.listClauses({ householdId, caseId, documentIds: [documentId] });
  const queries = [];
  const search = ({ query, kinds, limit }) => { queries.push(query); return services.clauses.searchClauses({ householdId, caseId, documentIds: [documentId], query, kinds, limit }); };
  return { clauses, search, queries };
}
// A ceiling that forces the retrieved path for this small synthetic policy.
const SMALL = 3_000;
const golden = [{ id: 'q1', question: 'Is cataract surgery covered?', expected: [{ page: 2, quote: 'cataract surgery as a hospitalisation benefit' }, { page: 61, quote: 'phacoemulsification performed within the first 24 months' }] },
  { id: 'q2', question: 'bad', expected: [{ page: 99, quote: 'nope' }] }];

test('recall: scorer reports first-pass and sweep recall end to end', t => {
  const { clauses, search } = world(t);
  const report = evaluateRecall({ clauses, search, golden, maxInputBytes: SMALL });
  assert.equal(report.questions, 2);
  assert.equal(report.results[0].path, 'retrieved');
  assert.ok(report.results[0].sweepRecall >= report.results[0].firstRecall);
  assert.throws(() => evaluateRecall({ clauses, search, golden: [] }), { code: 'RECALL_INPUT_INVALID' });
});

test('S3: an unresolvable expected clause is a miss in end-to-end recall, not dropped from the denominator', t => {
  const { clauses, search } = world(t);
  const report = evaluateRecall({ clauses, search, golden, maxInputBytes: SMALL });
  assert.equal(report.unresolvable, 1);
  assert.equal(report.results[1].firstRecall, 0, 'unresolvable counts as zero, not null');
  assert.equal(report.results[1].notInStoredText, 1);
  assert.deepEqual(report.results[1].missed, [99]);
  assert.equal(report.results[1].retrievalRecall, null, 'the diagnostic has nothing to score');
  assert.ok(report.endToEndRecall <= 2 / 3, 'three expected clauses, one cannot be found');
  const withheld = evaluateRecall({ clauses, search, golden: [golden[0]], maxInputBytes: SMALL, knownIdentifiers: [{ kind: 'NAME', value: 'phacoemulsification' }] });
  assert.equal(withheld.results[0].withheldByGate, 1);
  assert.ok(withheld.results[0].sweepRecall <= 0.5);
});

test('S3: the sweep is never seeded with golden quotes', t => {
  const { clauses, search, queries } = world(t);
  const report = evaluateRecall({ clauses, search, golden: [golden[0]], maxInputBytes: SMALL });
  assert.equal(report.results[0].sweepSeed, 'question_only');
  for (const { quote } of golden[0].expected) assert.ok(!queries.some(query => query.includes(quote)), `no search query carries "${quote}"`);
});

test('S3: recorded first-pass findings seed the sweep exactly as investigate would', t => {
  const { clauses, search } = world(t);
  const benefit = clauses.find(clause => clause.page === 2);
  const recorded = { q1: [{ subject: 'cataract surgery waiting period exclusion', quote: 'cataract surgery as a hospitalisation benefit', clauseIds: [benefit.clauseId] }] };
  const seeded = evaluateRecall({ clauses, search, golden: [golden[0]], maxInputBytes: SMALL, firstPassFindings: recorded });
  assert.equal(seeded.results[0].sweepSeed, 'recorded_first_pass');
  assert.ok(seeded.results[0].sweepRecall >= seeded.results[0].firstRecall);
  assert.throws(() => evaluateRecall({ clauses, search, golden: [golden[0]], firstPassFindings: { q1: 'x' } }), { code: 'RECALL_INPUT_INVALID' });
});
