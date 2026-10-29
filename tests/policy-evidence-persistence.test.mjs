import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackendServices } from '../src/backend/services/backend-services.js';
import { buildClauses } from '../src/features/policy-evidence/index.js';
import { ftsQuery } from '../src/backend/repositories/clause-repository.js';
import { parameterAt as at, seedParameterWorld } from './support/parameter-fixtures.mjs';
import { freshDatabase, postgresTestOptions } from './support/pg.mjs';

const pgOptions = postgresTestOptions();

// Synthetic only. Clause store (PostgreSQL migration 012), query-time text search, erasure and household scoping.
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

async function open(t) {
  const { db: database } = await freshDatabase(t);
  await seedParameterWorld(database);
  const services = createBackendServices(database, { clock: () => new Date(at) });
  const built = buildClauses(stored, { documentId, sourceVersion: 'version-1' });
  await services.clauses.saveClauses({ householdId: household, caseId, documentId, clauses: built.clauses });
  return { database, services, built };
}
const scope = { householdId: household, caseId, documentIds: [documentId] };
const count = async (database, table) => (await database.prepare(`SELECT count(*) AS count FROM ${table}`).get()).count;
// No stored text-search index exists on PostgreSQL: any clause text left anywhere in the table would match here.
const searchable = async (database, word) => (await database.prepare("SELECT count(*) AS count FROM policy_clauses clause WHERE to_tsvector('english', clause.text || ' ' || coalesce(clause.title, '')) @@ to_tsquery('english', ?)").get(word)).count;
const answer = (extra = {}) => ({ question: 'cataract?', covered: [], limited_or_excluded: [], conditions: [], overrides_checked: [], unknowns: ['x'], calculations: [], sources: [{ documentId, page: 2, quote: 'q' }], state: 'conditional', legalReview: 'required', ...extra });
const saveAnswer = (services, key = 'idem-key-0001', digest = 'a'.repeat(64)) => services.clauses.saveAnswer({
  householdId: household, caseId, requestedByAdultId: 'adult-parameters', idempotencyKey: key, requestDigest: digest, question: 'cataract?', answer: answer(),
  access: { consentGrantId: 'grant-question', subjectAdultId: 'adult-parameters', documentIds: [documentId] },
});

test('B1: clauses persist, replay as no-ops and list in page order', pgOptions, async t => {
  const { services, built } = await open(t);
  assert.deepEqual(await services.clauses.saveClauses({ householdId: household, caseId, documentId, clauses: built.clauses }), { inserted: 0, total: built.clauses.length });
  const listed = await services.clauses.listClauses(scope);
  assert.deepEqual(listed.map(c => c.clauseId), built.clauses.map(c => c.clauseId));
  assert.deepEqual(listed.map(c => c.page), [...listed.map(c => c.page)].sort());
  await assert.rejects(services.clauses.saveClauses({ householdId: household, caseId, documentId, clauses: [{ ...built.clauses[0], digest: 'f'.repeat(64) }] }), { code: 'CLAUSE_DIGEST_CONFLICT' });
});

test('B1: another household cannot save or read clauses (single not-found error)', pgOptions, async t => {
  const { database, services, built } = await open(t);
  await database.run(`INSERT INTO households (id, display_name, created_at, updated_at) VALUES ('household-other', 'Other', '${at}', '${at}')`);
  await assert.rejects(services.clauses.saveClauses({ householdId: 'household-other', caseId, documentId, clauses: built.clauses }), { code: 'POLICY_EVIDENCE_NOT_FOUND' });
  assert.deepEqual(await services.clauses.listClauses({ householdId: 'household-other', caseId, documentIds: [documentId] }), []);
  assert.deepEqual(await services.clauses.searchClauses({ householdId: 'household-other', caseId, documentIds: [documentId], query: 'cataract' }), []);
  await assert.rejects(services.clauses.getAnswer({ householdId: 'household-other', caseId, answerId: 'nope' }), { code: 'POLICY_EVIDENCE_NOT_FOUND' });
});

test('B1: clauses are immutable and require an active document', pgOptions, async t => {
  const { database, services } = await open(t);
  await saveAnswer(services);
  await assert.rejects(database.run("UPDATE policy_clauses SET text = 'x'"), /immutable/);
  await assert.rejects(database.run("UPDATE policy_answers SET question = 'x'"), /immutable/);
  await database.run("UPDATE document_uploads SET lifecycle_state = 'quarantined' WHERE id = 'document-parameters'");
  await assert.rejects(services.clauses.saveClauses({ householdId: household, caseId, documentId, clauses: buildClauses(stored, { documentId, sourceVersion: 'version-2' }).clauses }), { code: 'POLICY_EVIDENCE_NOT_FOUND' });
});

test('B2: FTS finds clauses by stemmed word, filters by kind, and never leaks operators', pgOptions, async t => {
  const { services } = await open(t);
  const hits = await services.clauses.searchClauses({ ...scope, query: 'cataract waiting' });
  assert.ok(hits.length >= 2);
  assert.ok(hits.every(hit => /cataract/i.test(hit.text) || /waiting/i.test(hit.text)));
  assert.equal((await services.clauses.searchClauses({ ...scope, query: 'cataracts' })).length > 0, true, 'english stemming');
  assert.deepEqual(await services.clauses.searchClauses({ ...scope, query: 'cataract', kinds: ['exclusion'] }), []);
  assert.equal(ftsQuery('NEAR(a b) OR "x" -y*'), '"near" OR "or"');
  assert.deepEqual(await services.clauses.searchClauses({ ...scope, query: '*** ""' }), []);
});

test('B1/B2: consent revocation deletes clauses, FTS rows and answers with a counts-only audit', pgOptions, async t => {
  const { database, services } = await open(t);
  await saveAnswer(services);
  assert.ok(await count(database, 'policy_clauses') > 0 && await count(database, 'policy_answers') === 1);
  await services.consents.revoke({ grantId: 'consent-parameters', revokedByAdultId: 'adult-parameters' });
  assert.equal(await count(database, 'policy_clauses'), 0);
  assert.equal(await count(database, 'policy_answers'), 0);
  assert.deepEqual(await services.clauses.searchClauses({ ...scope, query: 'cataract' }), []);
  assert.equal(await searchable(database, 'cataract'), 0, 'no searchable clause text is left');
  assert.equal((await database.prepare("SELECT to_regclass('policy_clauses_fts') AS fts").get()).fts, null, 'no separate text index to erase');
  const audit = await database.prepare("SELECT event_payload_json FROM audit_events WHERE action = 'policy_evidence.erased'").get();
  const payload = JSON.parse(audit.event_payload_json);
  assert.equal(payload.reasonCode, 'consent_revoked');
  assert.ok(payload.clauses > 0 && payload.answers === 1);
  assert.doesNotMatch(audit.event_payload_json, /cataract|Sum Insured/i);
});

test('B1/B2: document erasure deletes clauses, FTS rows and answers', pgOptions, async t => {
  const { database, services } = await open(t);
  await saveAnswer(services);
  await services.documents.requestDeletion(documentId, { actorAdultId: 'adult-parameters' });
  assert.equal(await count(database, 'policy_clauses'), 0);
  assert.equal(await count(database, 'policy_answers'), 0);
  assert.equal(await searchable(database, 'cataract'), 0);
});

test('B1: the database safety net deletes clauses and citing answers when a document leaves active', pgOptions, async t => {
  const { database, services } = await open(t);
  await saveAnswer(services);
  await database.run(`UPDATE document_uploads SET lifecycle_state = 'deletion_requested' WHERE id = '${documentId}'`);
  assert.equal(await count(database, 'policy_clauses'), 0);
  assert.equal(await count(database, 'policy_answers'), 0);
});

test('B4 storage: answers replay on the same key and digest and conflict on a different digest', pgOptions, async t => {
  const { database, services } = await open(t);
  const first = await saveAnswer(services);
  const replay = await saveAnswer(services);
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.answerId, first.answerId);
  await assert.rejects(saveAnswer(services, 'idem-key-0001', 'b'.repeat(64)), { code: 'IDEMPOTENCY_KEY_REUSED' });
  assert.equal(await count(database, 'policy_answers'), 1);
});

test('answer access metadata round-trips beside the answer, never inside it', pgOptions, async t => {
  const { services } = await open(t);
  const saved = await saveAnswer(services);
  assert.deepEqual(saved.access, { consentGrantId: 'grant-question', subjectAdultId: 'adult-parameters', documentIds: [documentId] });
  assert.equal(Object.hasOwn(saved.answer, 'access'), false);
  const read = await services.clauses.getAnswer({ householdId: household, caseId, answerId: saved.answerId });
  assert.deepEqual(read.access, saved.access);
  assert.equal(Object.hasOwn(read.answer, 'access'), false);
  await assert.rejects(services.clauses.saveAnswer({
    householdId: household, caseId, requestedByAdultId: 'adult-parameters', idempotencyKey: 'idem-key-0002', requestDigest: 'c'.repeat(64), question: 'cataract?', answer: answer(),
  }), { code: 'CLAUSE_INPUT_INVALID' });
});

test('latest active version per logical document is household-scoped and fails closed on a bad version', pgOptions, async t => {
  const { database, services } = await open(t);
  await database.prepare("UPDATE document_uploads SET logical_document_id = 'logical-wording', source_version = '3' WHERE id = ?").run(documentId);
  assert.deepEqual([...await services.documents.latestActiveVersions(household, ['logical-wording', 'logical-absent'])], [['logical-wording', 3]]);
  assert.equal((await services.documents.latestActiveVersions('household-other', ['logical-wording'])).size, 0);
  await database.prepare("UPDATE document_uploads SET source_version = 'v3' WHERE id = ?").run(documentId);
  assert.ok(Number.isNaN((await services.documents.latestActiveVersions(household, ['logical-wording'])).get('logical-wording')));
  assert.equal((await services.documents.latestActiveVersions(household, [])).size, 0);
});
