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

test('recall: scorer reports first-pass and sweep recall and flags unresolvable expectations', t => {
  const database = openDatabase({ path: ':memory:' });
  t.after(() => database.close());
  seedParameterWorld(database);
  const services = createBackendServices(database, { clock: () => new Date(parameterAt) });
  const { householdId, caseId, documentId } = parameterIds;
  services.clauses.saveClauses({ householdId, caseId, documentId, clauses: buildClauses(stored, { documentId, sourceVersion: 'v1' }).clauses });
  const clauses = services.clauses.listClauses({ householdId, caseId, documentIds: [documentId] });
  const search = ({ query, kinds, limit }) => services.clauses.searchClauses({ householdId, caseId, documentIds: [documentId], query, kinds, limit });
  const golden = [{ id: 'q1', question: 'Is cataract surgery covered?', expected: [{ page: 2, quote: 'cataract surgery as a hospitalisation benefit' }, { page: 61, quote: 'phacoemulsification performed within the first 24 months' }] },
    { id: 'q2', question: 'bad', expected: [{ page: 99, quote: 'nope' }] }];
  const report = evaluateRecall({ clauses, search, golden, budgetBytes: 1500 });
  assert.equal(report.questions, 2);
  assert.equal(report.unresolvable, 1);
  assert.equal(report.results[0].path, 'retrieved');
  assert.ok(report.results[0].sweepRecall >= report.results[0].firstRecall);
  assert.equal(report.results[1].firstRecall, null);
  assert.throws(() => evaluateRecall({ clauses, search, golden: [] }), { code: 'RECALL_INPUT_INVALID' });
});
