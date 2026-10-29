import test from 'node:test';
import assert from 'node:assert/strict';
import { QUESTION_CONSENT_SCOPE } from '../src/contracts/policy-evidence.js';
import { createPolicyEvidenceService } from '../src/backend/services/policy-evidence-service.js';

// Synthetic stubs. Document boundaries of question-time evidence:
// - an older version of a logical document is never read as the current policy (household-wide);
// - several current documents are read together only when the request names them, and the association is
//   recorded as asserted, not verified;
// - a stored answer is served only while its question grant is still active, and a replay built from a
//   version that is no longer current is refused.

const scope = id => ({ resource_type: QUESTION_CONSENT_SCOPE.resourceType, resource_id: id, action: QUESTION_CONSENT_SCOPE.action, data_category: QUESTION_CONSENT_SCOPE.dataCategory, recipient: QUESTION_CONSENT_SCOPE.recipient });
const pagesFor = documentId => [{ page: 1, status: 'stored', blocks: [
  { tag: 'section-title', text: 'Room Rent' },
  { tag: 'paragraph', text: `Room rent is capped at 1% of sum insured per day (${documentId}).` },
] }];
const doc = (id, logicalDocumentId, version, lifecycleState = 'active', caseId = 'c') => ({ id, householdId: 'h', caseId, logicalDocumentId, version, lifecycleState });

function harness({ documents, granted, others = [] }) {
  const state = { expired: false, calls: 0 };
  const read = [];
  const sentDocuments = new Set();
  const saved = new Map();
  const answers = new Map();
  const household = () => [...documents, ...others];
  const services = {
    documents: {
      listForCase: (caseId, householdId, limit) => documents.filter(document => document.caseId === caseId && document.householdId === householdId).slice(0, limit),
      latestActiveVersions: (householdId, logicalIds) => {
        const latest = new Map();
        for (const document of household()) {
          if (document.householdId !== householdId || document.lifecycleState !== 'active' || !logicalIds.includes(document.logicalDocumentId)) continue;
          latest.set(document.logicalDocumentId, Math.max(latest.get(document.logicalDocumentId) ?? -Infinity, document.version));
        }
        return latest;
      },
      getDocument: id => household().find(document => document.id === id) ?? null,
    },
    consents: {
      requireActive: (_grant, { resourceId }) => {
        if (state.expired) throw Object.assign(new Error('x'), { code: 'CONSENT_REQUIRED' });
        if (!granted.includes(resourceId)) throw Object.assign(new Error('x'), { code: 'CONSENT_SCOPE_REQUIRED' });
      },
      get: () => ({ household_id: 'h', scopes: granted.map(scope) }),
    },
    ocr: { getDocumentBlockPages: ({ documentId }) => { read.push(documentId); return { documentId, sourceVersion: '1', complete: true, pages: pagesFor(documentId) }; } },
    clauses: {
      findAnswerByKey: ({ idempotencyKey, requestDigest }) => {
        const stored = answers.get(idempotencyKey);
        if (!stored) return null;
        if (stored.requestDigest !== requestDigest) throw Object.assign(new Error('x'), { code: 'IDEMPOTENCY_KEY_REUSED' });
        return { replayed: true, ...stored.record };
      },
      clauseDocumentIds: () => [...saved.keys()],
      saveClauses: ({ documentId, clauses }) => { saved.set(documentId, clauses); },
      listClauses: ({ documentIds }) => documentIds.flatMap(id => saved.get(id) ?? []),
      searchClauses: () => [],
      // Like ClauseRepository.saveAnswer: the (async) consent check is awaited before anything is written.
      saveAnswer: async ({ idempotencyKey, requestDigest, answer, access, consentCheck }) => {
        await consentCheck();
        const record = { answerId: `answer-${answers.size + 1}`, caseId: 'c', answer, access };
        answers.set(idempotencyKey, { requestDigest, record });
        return { replayed: false, ...record };
      },
      getAnswer: ({ answerId }) => {
        const found = [...answers.values()].find(entry => entry.record.answerId === answerId);
        if (!found) throw Object.assign(new Error('x'), { code: 'POLICY_EVIDENCE_NOT_FOUND' });
        return found.record;
      },
    },
  };
  const createModelCall = () => async ({ payload }) => {
    state.calls += 1;
    await state.onCall?.();
    for (const clause of payload.clauses) sentDocuments.add(clause.document_id);
    return { json: { findings: [] }, usage: { inputTokens: 1, outputTokens: 1 } };
  };
  const service = createPolicyEvidenceService({ services, loadKnownIdentifiers: async () => [], createModelCall, env: { POLICY_EVIDENCE_ENABLED: 'true' } });
  const caseRecord = { id: 'c', household_id: 'h' };
  const ask = ({ documentIds, key = 'idem-key-0001' } = {}) => service.ask({ caseRecord, subjectAdultId: 'a', question: 'What is the room rent limit?', consentGrantId: 'g', idempotencyKey: key, documentIds });
  const get = answerId => service.get({ caseRecord, answerId });
  return { ask, get, read, sentDocuments, state, answers };
}

// D1: superseded versions.

test('D1: only the latest active version is read; an authorised superseded version is reported', async () => {
  const { ask, read, sentDocuments } = harness({ documents: [doc('wording-v1', 'wording', 1), doc('wording-v2', 'wording', 2)], granted: ['wording-v1', 'wording-v2'] });
  const { answer } = await ask();
  assert.deepEqual(read, ['wording-v2']);
  assert.deepEqual([...sentDocuments], ['wording-v2'], 'no clause of the superseded version reaches the model');
  assert.deepEqual(answer.completeness.documentsExcluded, [{ reason: 'superseded_version', count: 1 }]);
  assert.equal(answer.completeness.documentsAuthorised, 2);
  assert.ok(answer.unknowns.some(line => /newer version/.test(line)));
});

test('D1: a newer version that is not active yet does not supersede the current one', async () => {
  const { ask, read } = harness({ documents: [doc('wording-v1', 'wording', 1), doc('wording-v2', 'wording', 2, 'quarantined')], granted: ['wording-v1', 'wording-v2'] });
  const { answer } = await ask();
  assert.deepEqual(read, ['wording-v1']);
  assert.deepEqual(answer.completeness.documentsExcluded, []);
});

test('D1: a newer active version supersedes the old one even when the grant does not name it', async () => {
  const { ask, read, state } = harness({ documents: [doc('wording-v1', 'wording', 1), doc('wording-v2', 'wording', 2)], granted: ['wording-v1'] });
  await assert.rejects(ask(), { code: 'POLICY_EVIDENCE_SUPERSEDED', statusCode: 409 });
  assert.deepEqual(read, []);
  assert.equal(state.calls, 0);
});

test('D1: an ungranted older version beside a granted current one is neither read nor reported', async () => {
  const { ask, read } = harness({ documents: [doc('wording-v1', 'wording', 1), doc('wording-v2', 'wording', 2)], granted: ['wording-v2'] });
  const { answer } = await ask();
  assert.deepEqual(read, ['wording-v2']);
  assert.deepEqual(answer.completeness.documentsExcluded, []);
  assert.equal(answer.completeness.documentsAuthorised, 1);
});

test('D1: an unreadable version number fails closed before anything is read', async () => {
  const { ask, read } = harness({ documents: [doc('wording-x', 'wording', Number('not-a-number')), doc('wording-v2', 'wording', 2)], granted: ['wording-x', 'wording-v2'] });
  await assert.rejects(ask(), { code: 'POLICY_EVIDENCE_VERSION_INVALID', statusCode: 409 });
  assert.deepEqual(read, []);
});

test('D1: a case listing that could be truncated fails closed', async () => {
  const documents = Array.from({ length: 1_001 }, (_, index) => doc(`d-${index}`, `l-${index}`, 1));
  const { ask, read } = harness({ documents, granted: ['d-0'] });
  await assert.rejects(ask(), { code: 'POLICY_EVIDENCE_CASE_TOO_LARGE', statusCode: 409 });
  assert.deepEqual(read, []);
});

// D1a: versions are household-wide.

test('D1a: a newer version uploaded to another case of the household supersedes this one', async () => {
  const { ask, read, state } = harness({ documents: [doc('wording-v1', 'wording', 1)], others: [doc('wording-v2', 'wording', 2, 'active', 'other-case')], granted: ['wording-v1'] });
  await assert.rejects(ask(), { code: 'POLICY_EVIDENCE_SUPERSEDED', statusCode: 409 });
  assert.deepEqual(read, []);
  assert.equal(state.calls, 0);
});

// D2: several current documents are read together only when the request names them.

test('D2: several current authorised documents need documentIds; nothing is read without them', async () => {
  const { ask, read, state } = harness({ documents: [doc('wording', 'wording', 1), doc('schedule', 'schedule', 1)], granted: ['wording', 'schedule'] });
  await assert.rejects(ask(), { code: 'POLICY_EVIDENCE_DOCUMENTS_REQUIRED', statusCode: 409 });
  assert.deepEqual(read, []);
  assert.equal(state.calls, 0);
});

test('D2: named documents are read together and the association is recorded as unverified', async () => {
  const { ask, read } = harness({ documents: [doc('wording', 'wording', 1), doc('schedule', 'schedule', 1), doc('other-policy', 'other', 1)], granted: ['wording', 'schedule', 'other-policy'] });
  const { answer } = await ask({ documentIds: ['wording', 'schedule'] });
  assert.deepEqual(read.sort(), ['schedule', 'wording']);
  assert.deepEqual(answer.documentAssociation, { basis: 'requester_named', verified: false });
  assert.deepEqual(answer.completeness.documentsExcluded, [{ reason: 'not_named', count: 1 }], 'the granted document left out is reported');
  assert.equal(answer.completeness.documentsAuthorised, 3);
  assert.ok(answer.unknowns.some(line => /not verified/.test(line)));
});

test('D2: documents without a logical id are separate documents and must be named', async () => {
  const documents = [{ id: 'a', householdId: 'h', caseId: 'c', lifecycleState: 'active' }, { id: 'b', householdId: 'h', caseId: 'c', lifecycleState: 'active' }];
  const { ask, read } = harness({ documents, granted: ['a', 'b'] });
  await assert.rejects(ask(), { code: 'POLICY_EVIDENCE_DOCUMENTS_REQUIRED' });
  await ask({ documentIds: ['a', 'b'] });
  assert.deepEqual(read.sort(), ['a', 'b']);
});

test('D2: a named document that is unknown, ungranted or superseded fails the whole request', async () => {
  const documents = [doc('wording-v1', 'wording', 1), doc('wording-v2', 'wording', 2), doc('schedule', 'schedule', 1), doc('ungranted', 'u', 1)];
  const { ask, read, state } = harness({ documents, granted: ['wording-v1', 'wording-v2', 'schedule'] });
  await assert.rejects(ask({ documentIds: ['schedule', 'missing'] }), { code: 'POLICY_EVIDENCE_NOT_FOUND', statusCode: 404 });
  await assert.rejects(ask({ documentIds: ['schedule', 'ungranted'] }), { code: 'CONSENT_SCOPE_REQUIRED', statusCode: 403 });
  await assert.rejects(ask({ documentIds: ['schedule', 'wording-v1'] }), { code: 'POLICY_EVIDENCE_SUPERSEDED', statusCode: 409 });
  assert.deepEqual(read, []);
  assert.equal(state.calls, 0);
});

test('D2: documentIds must be 1 to 10 unique ids', async () => {
  const documents = [doc('wording', 'wording', 1)];
  const { ask } = harness({ documents, granted: ['wording'] });
  for (const documentIds of [[], ['wording', 'wording'], Array.from({ length: 11 }, (_, index) => `d${index}`), [42], 'wording']) {
    await assert.rejects(ask({ documentIds }), { code: 'VALIDATION_ERROR', statusCode: 400 });
  }
});

test('D2: the same idempotency key with a different document set is a different request', async () => {
  const { ask } = harness({ documents: [doc('wording', 'wording', 1), doc('schedule', 'schedule', 1)], granted: ['wording', 'schedule'] });
  await ask({ documentIds: ['wording', 'schedule'] });
  await assert.rejects(ask({ documentIds: ['wording'] }), { code: 'IDEMPOTENCY_KEY_REUSED' });
  const replay = await ask({ documentIds: ['schedule', 'wording'] });
  assert.equal(replay.replayed, true, 'order of documentIds does not change the request');
});

// D3: stored answers are served only while the question grant is active.

test('D3: replay and GET after consent expiry are refused without a model call', async () => {
  const { ask, get, state } = harness({ documents: [doc('wording', 'wording', 1)], granted: ['wording'] });
  const first = await ask();
  assert.equal((await get(first.answerId)).answerId, first.answerId);
  const calls = state.calls;
  state.expired = true;
  await assert.rejects(ask(), { code: 'CONSENT_REQUIRED' });
  await assert.rejects(get(first.answerId), { code: 'CONSENT_REQUIRED' });
  assert.equal(state.calls, calls);
});

test('D3: an answer stored without access metadata is never served', async () => {
  const { ask, get, answers } = harness({ documents: [doc('wording', 'wording', 1)], granted: ['wording'] });
  const first = await ask();
  assert.equal(Object.hasOwn(first, 'access'), false, 'access metadata is never returned');
  // Dropping access from the stored record simulates a row written before access was recorded.
  answers.get('idem-key-0001').record.access = null;
  await assert.rejects(get(first.answerId), { code: 'CONSENT_REQUIRED' });
  await assert.rejects(ask(), { code: 'CONSENT_REQUIRED' });
});

// D1b: a replay built from a version that is no longer current is refused; GET marks it.

test('D1b: replay after a newer version arrives is refused; GET returns the answer marked not current', async () => {
  const documents = [doc('wording-v1', 'wording', 1)];
  const others = [];
  const { ask, get, state } = harness({ documents, granted: ['wording-v1', 'wording-v2'], others });
  const first = await ask();
  assert.equal((await get(first.answerId)).current, true);
  others.push(doc('wording-v2', 'wording', 2, 'active', 'other-case'));
  const calls = state.calls;
  await assert.rejects(ask(), { code: 'POLICY_EVIDENCE_ANSWER_STALE', statusCode: 409 });
  assert.equal(state.calls, calls);
  assert.equal((await get(first.answerId)).current, false);
});

test('D1b: an answer whose document left the active state is not current', async () => {
  const documents = [doc('wording', 'wording', 1)];
  const { ask, get } = harness({ documents, granted: ['wording'] });
  const first = await ask();
  documents[0].lifecycleState = 'deletion_requested';
  await assert.rejects(ask(), { code: 'POLICY_EVIDENCE_ANSWER_STALE' });
  assert.equal((await get(first.answerId)).current, false);
});

test('D1b: a newer version arriving during the model call stops the answer from being stored', async () => {
  const documents = [doc('wording-v1', 'wording', 1)];
  const others = [];
  const { ask, state, answers } = harness({ documents, granted: ['wording-v1'], others });
  state.onCall = () => others.push(doc('wording-v2', 'wording', 2, 'active', 'other-case'));
  await assert.rejects(ask(), { code: 'POLICY_EVIDENCE_ANSWER_STALE', statusCode: 409 });
  assert.equal(answers.size, 0);
});

test('D1b: an answer is not current when a read document now belongs to another case', async () => {
  const documents = [doc('wording', 'wording', 1)];
  const { ask, get } = harness({ documents, granted: ['wording'] });
  const first = await ask();
  documents[0].caseId = 'other-case';
  assert.equal((await get(first.answerId)).current, false);
});

// D5: one in-flight question per idempotency key.

test('D5: a duplicate key while the first question runs is refused, so the model is not billed twice', async () => {
  const { ask, state } = harness({ documents: [doc('wording-v1', 'wording', 1)], granted: ['wording-v1'] });
  const releases = [];
  // The timer only keeps a regression from hanging the suite; it is not part of the behaviour under test.
  state.onCall = () => new Promise(resolve => { releases.push(resolve); setTimeout(resolve, 400).unref(); });
  const first = ask();
  while (!releases.length) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(ask(), { code: 'IDEMPOTENCY_IN_PROGRESS', statusCode: 409 });
  assert.equal(state.calls, 1, 'the duplicate did not start a second model call');
  // A different key is a different question and is not blocked by the claim.
  const other = ask({ key: 'idem-key-0002' });
  while (state.calls < 2) await new Promise(resolve => setImmediate(resolve));
  releases[0]();
  await first;
  state.onCall = undefined;
  await other;
  const replay = await ask();
  assert.equal(replay.replayed, true, 'once finished, the same key replays the stored answer');
  assert.equal(state.calls, 2);
});

test('D5: a failed question frees its key for a retry', async () => {
  const { ask, state } = harness({ documents: [doc('wording-v1', 'wording', 1)], granted: ['wording-v1'] });
  state.onCall = () => { throw Object.assign(new Error('provider down'), { code: 'PROVIDER_FAILED' }); };
  await assert.rejects(ask());
  state.onCall = undefined;
  const retried = await ask();
  assert.equal(retried.replayed, false);
});
