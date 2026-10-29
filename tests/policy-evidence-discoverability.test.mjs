import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackendServices } from '../src/backend/services/backend-services.js';
import { CLAUSE_KINDS } from '../src/contracts/policy-evidence.js';
import { buildClauses, checklistFor, classifyClause, selectContext, selectSweepContext } from '../src/features/policy-evidence/index.js';
import { parameterAt, parameterIds, seedParameterWorld } from './support/parameter-fixtures.mjs';
import { freshDatabase, postgresTestOptions } from './support/pg.mjs';

const pgOptions = postgresTestOptions();

// Synthetic only. Clause kind ranks retrieval; it must never make a stored clause unreachable.
const filler = Array.from({ length: 30 }, (_, index) => ({ page: 10 + index, status: 'stored', blocks: [
  { tag: 'section-title', text: `General provisions ${index}` },
  { tag: 'paragraph', text: `Provision ${index} describes administrative handling of correspondence and renewal reminders.` },
] }));
const stored = { pages: [
  { page: 2, status: 'stored', blocks: [{ tag: 'section-title', text: 'Eye Benefits' }, { tag: 'paragraph', text: 'We will pay for cataract surgery as a hospitalisation benefit.' }] },
  ...filler,
  { page: 61, status: 'stored', blocks: [{ tag: 'section-title', text: 'Lens Charges' }, { tag: 'paragraph', text: 'Notwithstanding anything stated elsewhere, phacoemulsification lens costs beyond the package rate are borne by the insured.' }] },
  { page: 62, status: 'stored', blocks: [{ tag: 'section-title', text: 'Lens Claims' }, { tag: 'paragraph', text: 'Phacoemulsification lens claims are settled only as reimbursement, never cashless.' }] },
] };

async function world(t) {
  const { db: database } = await freshDatabase(t);
  await seedParameterWorld(database);
  const services = createBackendServices(database, { clock: () => new Date(parameterAt) });
  const { householdId, caseId, documentId } = parameterIds;
  await services.clauses.saveClauses({ householdId, caseId, documentId, clauses: buildClauses(stored, { documentId, sourceVersion: 'v1' }).clauses });
  const clauses = await services.clauses.listClauses({ householdId, caseId, documentIds: [documentId] });
  const search = ({ query, kinds, limit }) => services.clauses.searchClauses({ householdId, caseId, documentIds: [documentId], query, kinds, limit });
  return { clauses, search, lens: clauses.find(clause => clause.page === 61), claims: clauses.find(clause => clause.page === 62) };
}

test('S2: a relevant clause classified other reaches the first-pass context on the retrieved path', pgOptions, async t => {
  const { clauses, search, lens } = await world(t);
  assert.equal(lens.kind, 'other', 'fixture premise: the clause matches no kind rule');
  const question = 'Are phacoemulsification lens costs covered?';
  const context = await selectContext({ gated: clauses, checklist: checklistFor(question), question, search, budgetBytes: 1500 });
  assert.equal(context.path, 'retrieved');
  assert.ok(context.clauses.some(clause => clause.clauseId === lens.clauseId));
});

test('S2: the sweep reaches overriding clauses of kinds outside its boost list that the first pass did not read', pgOptions, async t => {
  const { clauses, search, lens, claims } = await world(t);
  assert.equal(claims.kind, 'procedure', 'fixture premise: procedure is not a sweep kind, so only the unfiltered search finds it');
  const benefit = clauses.find(clause => clause.page === 2);
  const context = { path: 'retrieved', clauses: [benefit], truncated: true };
  const findings = [{ subject: 'phacoemulsification lens', quote: 'cataract surgery', clauseIds: [benefit.clauseId] }];
  const sweep = await selectSweepContext({ context, gated: clauses, findings, search, budgetBytes: 1500 });
  assert.ok(sweep.clauses.some(clause => clause.clauseId === lens.clauseId));
  assert.ok(sweep.clauses.some(clause => clause.clauseId === claims.clauseId));
  assert.ok(sweep.clauses.some(clause => clause.clauseId === benefit.clauseId), 'cited clause kept');
});

test('S2: every clause kind is reachable by retrieval, including kinds outside the checklist', async () => {
  const question = 'Is zygomycosis treatment payable?';
  const words = text => new Set(text.toLowerCase().match(/[a-z]{2,}/g));
  for (const kind of CLAUSE_KINDS) {
    const target = { clauseId: `t-${kind}`, documentId: 'd', page: 99, kind, text: 'Zygomycosis treatment terms.', sectionPath: [] };
    const padding = Array.from({ length: 40 }, (_, index) => ({ clauseId: `p-${index}`, documentId: 'd', page: index + 1, kind: 'benefit', text: `Unrelated administrative wording number ${index}.`, sectionPath: [] }));
    const gated = [...padding, target];
    const search = ({ query, kinds }) => gated.filter(clause => (!kinds || kinds.includes(clause.kind)) && [...words(query)].some(word => words(clause.text).has(word)));
    const context = await selectContext({ gated, checklist: checklistFor(question), question, search, budgetBytes: 600 });
    assert.equal(context.path, 'retrieved');
    assert.ok(context.clauses.some(clause => clause.clauseId === target.clauseId), `${kind} clause must be reachable`);
  }
});

test('S2: condition wording is classified as condition without taking exclusion, waiting period or limit wording', () => {
  assert.equal(classifyClause(null, 'Cataract surgery is payable subject to prior approval by the insurer.'), 'condition');
  assert.equal(classifyClause(null, 'Treatment abroad is admissible only if the patient is resident in India.'), 'condition');
  assert.equal(classifyClause(null, 'We will not pay for cosmetic surgery, subject to the terms below.'), 'exclusion');
  assert.equal(classifyClause(null, 'A waiting period of 24 months applies, subject to continuity.'), 'waiting_period');
  assert.equal(classifyClause(null, 'Room rent is capped at Rs. 5,000 per day, subject to network rates.'), 'limit');
  assert.equal(classifyClause(null, 'We will pay for dialysis, subject to the terms of this policy.'), 'benefit', 'boilerplate is not a condition');
  assert.equal(classifyClause(null, 'Hello there.'), 'other');
});
