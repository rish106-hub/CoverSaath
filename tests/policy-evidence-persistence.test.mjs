import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/backend/database/index.js';
import { createBackendServices } from '../src/backend/services/backend-services.js';
import { buildClauses } from '../src/features/policy-evidence/index.js';
import { ftsQuery } from '../src/backend/repositories/clause-repository.js';
import { parameterAt as at, seedParameterWorld } from './support/parameter-fixtures.mjs';

// Synthetic only. Clause store (migration 015), FTS index (016), erasure and household scoping.
const household = 'household-parameters';
const caseId = 'case-parameters';
const documentId = 'document-parameters';
const stored = {
  pages: [
    { page: 1, status: 'stored', blocks: [
      { tag: 'headline', text: 'Policy Schedule' },
      { tag: 'paragraph', text: 'Sum Insured Rs. 5,00,000 for the synthetic family floater.' },
    ] },
    { page: 2, status: 'stored', blocks: [
      { tag: 'section-title', text: 'Waiting Periods' },
      { tag: 'paragraph', text: 'Cataract surgery has a waiting period of 24 months.' },
      { tag: 'section-title', text: 'Endorsement' },
      { tag: 'paragraph', text: 'The waiting period for cataract is waived for eligible members by this endorsement.' },
    ] },
  ],
};

function open(t) {
  const database = openDatabase({ path: ':memory:' });
  t.after(() => database.close());
  seedParameterWorld(database);
  const services = createBackendServices(database, { clock: () => new Date(at) });
  const built = buildClauses(stored, { documentId, sourceVersion: 'version-1' });
  services.clauses.saveClauses({ householdId: household, caseId, documentId, clauses: built.clauses });
  return { database, services, built };
}
const scope = { householdId: household, caseId, documentIds: [documentId] };
const count = (database, table) => database.prepare(`SELECT count(*) AS count FROM ${table}`).get().count;
const answer = (extra = {}) => ({ question: 'cataract?', covered: [], limited_or_excluded: [], conditions: [], overrides_checked: [], unknowns: ['x'], calculations: [], sources: [{ documentId, page: 2, quote: 'q' }], state: 'conditional', legalReview: 'required', ...extra });
const saveAnswer = (services, key = 'idem-key-0001', digest = 'a'.repeat(64)) => services.clauses.saveAnswer({
  householdId: household, caseId, requestedByAdultId: 'adult-parameters', idempotencyKey: key, requestDigest: digest, question: 'cataract?', answer: answer(),
});

test('B1: clauses persist, replay as no-ops and list in page order', t => {
  const { services, built } = open(t);
  assert.deepEqual(services.clauses.saveClauses({ householdId: household, caseId, documentId, clauses: built.clauses }), { inserted: 0, total: built.clauses.length });
  const listed = services.clauses.listClauses(scope);
  assert.deepEqual(listed.map(c => c.clauseId), built.clauses.map(c => c.clauseId));
  assert.deepEqual(listed.map(c => c.page), [...listed.map(c => c.page)].sort());
  assert.throws(() => services.clauses.saveClauses({ householdId: household, caseId, documentId, clauses: [{ ...built.clauses[0], digest: 'f'.repeat(64) }] }), { code: 'CLAUSE_DIGEST_CONFLICT' });
});

test('B1: another household cannot save or read clauses (single not-found error)', t => {
  const { database, services, built } = open(t);
  database.exec(`INSERT INTO households (id, display_name, created_at, updated_at) VALUES ('household-other', 'Other', '${at}', '${at}')`);
  assert.throws(() => services.clauses.saveClauses({ householdId: 'household-other', caseId, documentId, clauses: built.clauses }), { code: 'POLICY_EVIDENCE_NOT_FOUND' });
  assert.deepEqual(services.clauses.listClauses({ householdId: 'household-other', caseId, documentIds: [documentId] }), []);
  assert.deepEqual(services.clauses.searchClauses({ householdId: 'household-other', caseId, documentIds: [documentId], query: 'cataract' }), []);
  assert.throws(() => services.clauses.getAnswer({ householdId: 'household-other', caseId, answerId: 'nope' }), { code: 'POLICY_EVIDENCE_NOT_FOUND' });
});

test('B1: clauses are immutable and require an active document', t => {
  const { database, services } = open(t);
  saveAnswer(services);
  assert.throws(() => database.exec("UPDATE policy_clauses SET text = 'x'"), /immutable/);
  assert.throws(() => database.exec("UPDATE policy_answers SET question = 'x'"), /immutable/);
  database.exec("UPDATE document_uploads SET lifecycle_state = 'quarantined' WHERE id = 'document-parameters'");
  assert.throws(() => services.clauses.saveClauses({ householdId: household, caseId, documentId, clauses: buildClauses(stored, { documentId, sourceVersion: 'version-2' }).clauses }), { code: 'POLICY_EVIDENCE_NOT_FOUND' });
});

test('B2: FTS finds clauses by stemmed word, filters by kind, and never leaks operators', t => {
  const { services } = open(t);
  const hits = services.clauses.searchClauses({ ...scope, query: 'cataract waiting' });
  assert.ok(hits.length >= 2);
  assert.ok(hits.every(hit => /cataract/i.test(hit.text) || /waiting/i.test(hit.text)));
  assert.equal(services.clauses.searchClauses({ ...scope, query: 'cataracts' }).length > 0, true, 'porter stemming');
  assert.deepEqual(services.clauses.searchClauses({ ...scope, query: 'cataract', kinds: ['exclusion'] }), []);
  assert.equal(ftsQuery('NEAR(a b) OR "x" -y*'), '"near" OR "or"');
  assert.deepEqual(services.clauses.searchClauses({ ...scope, query: '*** ""' }), []);
});

test('B1/B2: consent revocation deletes clauses, FTS rows and answers with a counts-only audit', t => {
  const { database, services } = open(t);
  saveAnswer(services);
  assert.ok(count(database, 'policy_clauses') > 0 && count(database, 'policy_answers') === 1);
  services.consents.revoke({ grantId: 'consent-parameters', revokedByAdultId: 'adult-parameters' });
  assert.equal(count(database, 'policy_clauses'), 0);
  assert.equal(count(database, 'policy_answers'), 0);
  assert.deepEqual(services.clauses.searchClauses({ ...scope, query: 'cataract' }), []);
  assert.equal(database.prepare("SELECT count(*) AS count FROM policy_clauses_fts WHERE policy_clauses_fts MATCH 'cataract'").get().count, 0, 'FTS index rows are gone');
  const audit = database.prepare("SELECT event_payload_json FROM audit_events WHERE action = 'policy_evidence.erased'").get();
  const payload = JSON.parse(audit.event_payload_json);
  assert.equal(payload.reasonCode, 'consent_revoked');
  assert.ok(payload.clauses > 0 && payload.answers === 1);
  assert.doesNotMatch(audit.event_payload_json, /cataract|Sum Insured/i);
});

test('B1/B2: document erasure deletes clauses, FTS rows and answers', t => {
  const { database, services } = open(t);
  saveAnswer(services);
  services.documents.requestDeletion(documentId, { actorAdultId: 'adult-parameters' });
  assert.equal(count(database, 'policy_clauses'), 0);
  assert.equal(count(database, 'policy_answers'), 0);
  assert.equal(database.prepare("SELECT count(*) AS count FROM policy_clauses_fts WHERE policy_clauses_fts MATCH 'cataract'").get().count, 0);
});

test('B1: the database safety net deletes clauses and citing answers when a document leaves active', t => {
  const { database, services } = open(t);
  saveAnswer(services);
  database.exec(`UPDATE document_uploads SET lifecycle_state = 'deletion_requested' WHERE id = '${documentId}'`);
  assert.equal(count(database, 'policy_clauses'), 0);
  assert.equal(count(database, 'policy_answers'), 0);
});

test('B4 storage: answers replay on the same key and digest and conflict on a different digest', t => {
  const { database, services } = open(t);
  const first = saveAnswer(services);
  const replay = saveAnswer(services);
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.answerId, first.answerId);
  assert.throws(() => saveAnswer(services, 'idem-key-0001', 'b'.repeat(64)), { code: 'IDEMPOTENCY_KEY_REUSED' });
  assert.equal(count(database, 'policy_answers'), 1);
});
