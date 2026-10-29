// Decision catalogue and household preview services on the async runtime (S3.2 WP2c). The review and curated repositories
// are real (PostgreSQL); answer, clause, document, household and access lookups are async stubs, as they will be once their
// repositories are converted. The section-4 silent-failure sites are pinned here: a rejected access check must deny, never
// pass and never escape as an unhandled rejection (tests/support/pg.mjs fails the run on one). Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { freshDatabase, postgresTestOptions } from './support/pg.mjs';
import { parameterAt, parameterIds, seedParameterWorld } from './support/parameter-fixtures.mjs';
import { AuditRepository } from '../src/backend/repositories/audit-repository.js';
import { CatalogueReviewRepository } from '../src/backend/repositories/catalogue-review-repository.js';
import { createDecisionCatalogueService } from '../src/backend/services/decision-catalogue-service.js';
import { createHouseholdPreviewService } from '../src/backend/services/household-preview-service.js';

const { householdId: H, caseId: CASE, documentId: DOC } = parameterIds;
const OWNER = 'adult-parameters';
const OUTSIDER = 'adult-outsider';
const ANSWER = 'answer-synthetic';
const CLAUSES = [{ clauseId: 'clause-room', documentId: DOC, sourceVersion: 'version-1', page: 2, digest: 'c'.repeat(64), kind: 'limit', text: 'Room rent limit: Rs 5,000 per day', sectionPath: [] }];
const STORED = { answerId: ANSWER, answer: { covered: [{ clauseIds: ['clause-room'], subject: 'room rent', conditions: [], exceptions: [] }] }, documentIds: [DOC], pipelineCurrent: true };
const later = ms => new Date(Date.now() + ms).toISOString();
const deny = code => Object.assign(new Error('denied'), { code, statusCode: 404 });

async function world(t, { env = {}, overrides = {} } = {}) {
  const { db } = await freshDatabase(t);
  await seedParameterWorld(db);
  await db.run("INSERT INTO adult_users (id, display_name, account_status, created_at, updated_at) VALUES (?, 'Synthetic reviewer', 'active', ?, ?)", [OUTSIDER, parameterAt, parameterAt]);
  const audit = new AuditRepository(db);
  const reviews = new CatalogueReviewRepository(db, { audit });
  const calls = { requireHousehold: 0, getDocument: 0 };
  const caseRecord = await db.one('SELECT * FROM service_cases WHERE id = ?', [CASE]);
  const services = {
    audit,
    catalogueReviews: reviews,
    curatedProducts: { listVerified: async () => [] },
    clauses: { listClauses: async ({ householdId }) => (householdId === H ? CLAUSES : []) },
    documents: { getDocument: async id => { calls.getDocument += 1; return id === DOC ? { id, documentKind: 'policy_schedule', createdAt: parameterAt } : null; } },
    households: { getHousehold: async id => ({ id, status: 'active' }), listMembers: async () => [{ id: 'member-parameters' }] },
    access: {
      database: db,
      requireHousehold: async (principal, householdId) => { calls.requireHousehold += 1; if (principal.adultId !== OWNER || householdId !== H) throw deny('HOUSEHOLD_NOT_FOUND'); },
      requireCase: async (principal, caseId) => { if (principal.adultId !== OWNER || caseId !== CASE) throw deny('CASE_NOT_FOUND'); return caseRecord; },
    },
    ...overrides,
  };
  const evidence = { readForCatalogue: async ({ answerId }) => { if (answerId !== ANSWER) throw deny('POLICY_EVIDENCE_NOT_FOUND'); return STORED; } };
  const catalogue = createDecisionCatalogueService({ services, evidence, env });
  return { db, reviews, services, calls, catalogue, caseRecord, preview: createHouseholdPreviewService({ services, catalogue }) };
}
const failure = async promise => { try { await promise; } catch (error) { return error; } return assert.fail('expected an error'); };
const owner = { adultId: OWNER };
const outsider = { adultId: OUTSIDER };

test('build: a stored answer becomes unverified facts; a household confirmation is self_confirmed at most', postgresTestOptions(), async t => {
  const w = await world(t);
  const built = await w.catalogue.build({ caseRecord: w.caseRecord, answerId: ANSWER });
  assert.ok(built.catalogue.facts.length >= 1);
  assert.ok(built.catalogue.facts.every(fact => fact.state === 'extracted_unverified' && fact.verified === false));
  assert.deepEqual(built.catalogue.reviews, []);
  await w.reviews.grantHouseholdConfirmer({ householdId: H, adultUserId: OWNER, grantedByAdultId: OWNER });
  const factId = built.catalogue.facts[0].factId;
  const recorded = await w.catalogue.record({ principal: owner, caseId: CASE, answerId: ANSWER, factId, decision: 'accepted', reasonCode: 'matches_clause', idempotencyKey: 'service-key-0001', attestedSourceType: 'issued_schedule', attestsPolicyAssociation: true });
  assert.equal(recorded.authority, 'household');
  assert.equal(recorded.replayed, false);
  assert.equal((await w.catalogue.record({ principal: owner, caseId: CASE, answerId: ANSWER, factId, decision: 'accepted', reasonCode: 'matches_clause', idempotencyKey: 'service-key-0001', attestedSourceType: 'issued_schedule', attestsPolicyAssociation: true })).replayed, true);
  const after = await w.catalogue.build({ caseRecord: w.caseRecord, answerId: ANSWER });
  assert.deepEqual(after.catalogue.reviews.map(review => [review.state, review.authority]), [['accepted', 'household']]);
  const reviewed = after.catalogue.facts.filter(fact => fact.origin === 'human_review');
  assert.equal(reviewed.length, 1);
  assert.equal(reviewed[0].verified, false);
  assert.equal(reviewed[0].sourceType, 'user_statement', 'a household confirmer cannot make a source contractual');
  assert.equal((await failure(w.catalogue.record({ principal: owner, caseId: CASE, answerId: ANSWER, factId: 'fact-forged', decision: 'accepted', reasonCode: 'matches_clause', idempotencyKey: 'service-key-0002' }))).code, 'POLICY_EVIDENCE_NOT_FOUND');
});

test('build: a rejection removes the model proposal; a dispute keeps review required', postgresTestOptions(), async t => {
  const w = await world(t, { env: { CATALOGUE_INDEPENDENT_REVIEW_ENABLED: 'true' } });
  await w.reviews.grantIndependentReviewer({ householdId: H, adultUserId: OUTSIDER, operatorId: 'test-operator', caseId: CASE, expiresAt: later(3_600_000) });
  const { catalogue } = await w.catalogue.build({ caseRecord: w.caseRecord, answerId: ANSWER });
  const factId = catalogue.facts[0].factId;
  await w.catalogue.record({ principal: outsider, caseId: CASE, answerId: ANSWER, factId, decision: 'rejected', reasonCode: 'does_not_match_clause', idempotencyKey: 'service-key-rej1' });
  let built = await w.catalogue.build({ caseRecord: w.caseRecord, answerId: ANSWER });
  assert.ok(!built.catalogue.facts.some(fact => fact.factId === factId), 'a rejected proposal leaves the rule pool');
  assert.equal(built.catalogue.reviews[0].state, 'rejected');
  await new Promise(resolve => setTimeout(resolve, 5));
  await w.catalogue.record({ principal: outsider, caseId: CASE, answerId: ANSWER, factId, decision: 'disputed', reasonCode: 'clause_ambiguous', idempotencyKey: 'service-key-dis1' });
  built = await w.catalogue.build({ caseRecord: w.caseRecord, answerId: ANSWER });
  assert.ok(built.catalogue.facts.some(fact => fact.factId === factId));
  assert.equal(built.catalogue.reviewRequired, true);
  assert.ok(built.catalogue.conflicts.some(conflict => conflict.rule.startsWith('review_disputed/')));
});

test('silent failure: a rejected household check denies the confirmer (not found) and never escapes', postgresTestOptions(), async t => {
  const w = await world(t);
  await w.reviews.grantHouseholdConfirmer({ householdId: H, adultUserId: OWNER, grantedByAdultId: OWNER });
  assert.equal((await w.catalogue.confirmerCase(owner, CASE)).caseRecord.id, CASE, 'the awaited check passes for the owner');
  assert.equal(w.calls.requireHousehold, 1);
  w.services.access.requireHousehold = async () => { throw Object.assign(new Error('connection lost'), { code: '08006' }); };
  assert.equal((await failure(w.catalogue.confirmerCase(owner, CASE))).code, 'POLICY_EVIDENCE_NOT_FOUND', 'a dropped check fails closed');
  w.services.access.requireHousehold = async () => { throw deny('HOUSEHOLD_NOT_FOUND'); };
  assert.equal((await failure(w.catalogue.record({ principal: owner, caseId: CASE, answerId: ANSWER, factId: 'x', decision: 'accepted', reasonCode: 'matches_clause', idempotencyKey: 'service-key-0003' }))).code, 'POLICY_EVIDENCE_NOT_FOUND');
  assert.equal((await w.db.one('SELECT count(*) AS n FROM catalogue_reviews')).n, 0);
  assert.equal((await failure(w.catalogue.confirmerCase(outsider, CASE))).code, 'POLICY_EVIDENCE_NOT_FOUND', 'no grant');
  assert.equal((await failure(w.catalogue.confirmerCase(owner, 'case-missing'))).code, 'POLICY_EVIDENCE_NOT_FOUND', 'unknown case');
});

test('silent failure: an async household status is awaited: a closed household blocks every reviewer', postgresTestOptions(), async t => {
  const w = await world(t, { env: { CATALOGUE_INDEPENDENT_REVIEW_ENABLED: 'true' } });
  await w.reviews.grantHouseholdConfirmer({ householdId: H, adultUserId: OWNER, grantedByAdultId: OWNER });
  await w.reviews.grantIndependentReviewer({ householdId: H, adultUserId: OUTSIDER, operatorId: 'test-operator', caseId: CASE, expiresAt: later(3_600_000) });
  assert.ok(await w.catalogue.independentReviewerCase(outsider, CASE));
  w.services.households.getHousehold = async id => ({ id, status: 'closed' });
  assert.equal((await failure(w.catalogue.confirmerCase(owner, CASE))).code, 'POLICY_EVIDENCE_NOT_FOUND');
  assert.equal(await w.catalogue.independentReviewerCase(outsider, CASE), null);
  w.services.households.getHousehold = async () => { throw Object.assign(new Error('connection lost'), { code: '08006' }); };
  assert.equal((await failure(w.catalogue.independentReviewerCase(outsider, CASE))).code, '08006', 'a failed lookup is an error, never an open case');
});

test('independent reads: off unless enabled, audited before they are served, and an audit failure fails the read', postgresTestOptions(), async t => {
  const off = await world(t);
  await off.reviews.grantIndependentReviewer({ householdId: H, adultUserId: OUTSIDER, operatorId: 'test-operator', caseId: CASE, expiresAt: later(3_600_000) });
  assert.equal(await off.catalogue.independentReviewerCase(outsider, CASE), null);
  assert.equal((await failure(off.catalogue.confirmerCase(outsider, CASE))).code, 'POLICY_EVIDENCE_NOT_FOUND');

  const w = await world(t, { env: { CATALOGUE_INDEPENDENT_REVIEW_ENABLED: 'true' } });
  const views = async () => (await w.db.one("SELECT count(*) AS n FROM audit_events WHERE action = 'catalogue_reviewer.viewed'")).n;
  assert.equal(await w.catalogue.independentReviewerCase(outsider, CASE), null, 'no grant, no case');
  await w.reviews.grantIndependentReviewer({ householdId: H, adultUserId: OUTSIDER, operatorId: 'test-operator', caseId: CASE, expiresAt: later(3_600_000) });
  const opened = await w.catalogue.independentReviewerCase(outsider, CASE);
  assert.equal(opened.caseRecord.id, CASE);
  assert.equal(await views(), 1, 'the view was committed before the case was returned');
  assert.equal(await w.catalogue.independentReviewerCase(owner, CASE), null, 'a household confirmer is not independent');
  w.services.audit = { append: async () => { throw Object.assign(new Error('audit down'), { code: '57P01' }); } };
  const blocked = createDecisionCatalogueService({ services: w.services, evidence: { readForCatalogue: async () => STORED }, env: { CATALOGUE_INDEPENDENT_REVIEW_ENABLED: 'true' } });
  assert.equal((await failure(blocked.independentReviewerCase(outsider, CASE))).code, '57P01', 'no unaudited view');
  assert.equal(await views(), 1);
});

test('an independent grant covers only documents the case held when it was issued (each lookup awaited)', postgresTestOptions(), async t => {
  const w = await world(t, { env: { CATALOGUE_INDEPENDENT_REVIEW_ENABLED: 'true' } });
  const grant = await w.reviews.grantIndependentReviewer({ householdId: H, adultUserId: OUTSIDER, operatorId: 'test-operator', caseId: CASE, expiresAt: later(3_600_000) });
  const { catalogue } = await w.catalogue.build({ caseRecord: w.caseRecord, answerId: ANSWER, documentsUntil: grant.granted_at });
  assert.ok(catalogue.facts.length >= 1, 'a document uploaded before the grant is covered');
  w.services.documents.getDocument = async id => ({ id, documentKind: 'policy_schedule', createdAt: later(86_400_000) });
  assert.equal((await failure(w.catalogue.build({ caseRecord: w.caseRecord, answerId: ANSWER, documentsUntil: grant.granted_at }))).code, 'POLICY_EVIDENCE_NOT_FOUND', 'a later document is not covered');
  w.services.documents.getDocument = async () => null;
  assert.equal((await failure(w.catalogue.build({ caseRecord: w.caseRecord, answerId: ANSWER, documentsUntil: grant.granted_at }))).code, 'POLICY_EVIDENCE_NOT_FOUND', 'a missing document fails closed');
});

test('build: published curated products are read once per request through the shared cache', postgresTestOptions(), async t => {
  let reads = 0;
  const w = await world(t, { overrides: { curatedProducts: { listVerified: async () => { reads += 1; return []; } } } });
  const curatedCache = {};
  await w.catalogue.build({ caseRecord: w.caseRecord, answerId: ANSWER, curatedCache });
  await w.catalogue.build({ caseRecord: w.caseRecord, answerId: ANSWER, curatedCache });
  assert.equal(reads, 1);
});

const scenarioBody = (sources = [{ caseId: CASE, answerId: ANSWER }]) => ({ contractVersion: 'household-scenario/v1', sources, scenario: { scenarioType: 'general_benefit' } });

test('preview: awaits every access check; a rejected household, case or consent gate stops the request', postgresTestOptions(), async t => {
  const w = await world(t);
  let gated = 0;
  const authorizeCase = async () => { gated += 1; };
  const result = await w.preview.preview({ principal: owner, householdId: H, body: scenarioBody(), authorizeCase });
  assert.ok(result, 'the preview is built');
  assert.equal(gated, 1);
  assert.equal((await failure(w.preview.preview({ principal: outsider, householdId: H, body: scenarioBody(), authorizeCase }))).code, 'HOUSEHOLD_NOT_FOUND', 'a foreign household');
  assert.equal((await failure(w.preview.preview({ principal: owner, householdId: H, body: scenarioBody([{ caseId: 'case-foreign', answerId: ANSWER }]), authorizeCase }))).code, 'CASE_NOT_FOUND');
  const consentMissing = async () => { throw Object.assign(new Error('consent required'), { code: 'CONSENT_REQUIRED', statusCode: 403 }); };
  assert.equal((await failure(w.preview.preview({ principal: owner, householdId: H, body: scenarioBody(), authorizeCase: consentMissing }))).code, 'CONSENT_REQUIRED', 'an async consent gate is awaited');
  w.services.access.requireCase = async () => ({ ...w.caseRecord, household_id: 'household-other' });
  assert.equal((await failure(w.preview.preview({ principal: owner, householdId: H, body: scenarioBody(), authorizeCase }))).code, 'CASE_NOT_FOUND', 'a case of another household');
});

test('preview: a stale answer asks for revalidation; any other build failure fails the request', postgresTestOptions(), async t => {
  const w = await world(t);
  const stale = createHouseholdPreviewService({ services: w.services, catalogue: { build: async () => { throw Object.assign(new Error('stale'), { code: 'POLICY_EVIDENCE_ANSWER_STALE' }); } } });
  const result = await stale.preview({ principal: owner, householdId: H, body: scenarioBody(), authorizeCase: async () => {} });
  assert.ok(JSON.stringify(result).includes('answer_stale'));
  const broken = createHouseholdPreviewService({ services: w.services, catalogue: { build: async () => { throw Object.assign(new Error('down'), { code: '08006' }); } } });
  assert.equal((await failure(broken.preview({ principal: owner, householdId: H, body: scenarioBody(), authorizeCase: async () => {} }))).code, '08006');
});

test('review keys are server-derived: the stored fact key is the digest of the server-held fact id', postgresTestOptions(), async t => {
  const w = await world(t);
  await w.reviews.grantHouseholdConfirmer({ householdId: H, adultUserId: OWNER, grantedByAdultId: OWNER });
  const { catalogue } = await w.catalogue.build({ caseRecord: w.caseRecord, answerId: ANSWER });
  const factId = catalogue.facts[0].factId;
  await w.catalogue.record({ principal: owner, caseId: CASE, answerId: ANSWER, factId, decision: 'accepted', reasonCode: 'matches_clause', idempotencyKey: 'service-key-0009' });
  const row = await w.db.one('SELECT fact_key, document_id FROM catalogue_reviews');
  assert.equal(row.fact_key, createHash('sha256').update(factId).digest('hex'));
  assert.equal(row.document_id, DOC);
});
