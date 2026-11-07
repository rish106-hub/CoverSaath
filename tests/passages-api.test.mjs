import test from 'node:test';
import assert from 'node:assert/strict';
import { postgresTestOptions } from './support/pg.mjs';
import { tableCounts } from './support/household-api-harness.mjs';
import { createBackendServices } from '../src/backend/services/index.js';
import { buildClauses } from '../src/features/policy-evidence/index.js';
import {
  HOLDER, POLICY_NUMBER, fixture, table, startApp, scenario, uploadDocument, grantReading, readDocument,
} from './support/read-back-harness.mjs';

const pgOptions = postgresTestOptions();

// GET /api/v1/cases/{caseId}/passages (ADR 0012 D9, run V3b) through the real application: upload, stored OCR blocks from
// a local Sarvam stub, deterministic clauses, full-text search. No model call, no real provider call. Synthetic data only.

const FILLER = Array.from({ length: 120 }, (_, index) => `filler${index}`).join(' ');
const LONG_TEXT = `${FILLER} ambulance charges are paid up to the stated limit ${FILLER}`;
const MEMBER_ID = 'SYN-MEM-0042';
const PREMIUM = 'Rs 12,345';

fixture.pages = [
  [
    { text: 'Room rent', tag: 'section-title' },
    { text: `Dear ${HOLDER}, the room rent for a private room is limited to Rs 5,000 per day. Reference ${POLICY_NUMBER} shows the room rent limit.`, tag: 'paragraph' },
    { text: 'Room rent summary', tag: 'section-title' },
    // A four-column row puts the policy number on the same row as the searched words: it holds an identity label, so the
    // whole clause is dropped rather than masked.
    { text: table([['Customer reference', POLICY_NUMBER, 'Room rent', 'Rs 5,000 per day']]), tag: 'table' },
    { text: 'Policy Schedule', tag: 'section-title' },
    { text: table([
      ['Policy Number', POLICY_NUMBER], ['Policyholder Name', HOLDER], ['Premium', PREMIUM], ['Room Rent', 'Rs 5,000 per day'],
    ]), tag: 'table' },
  ],
  [
    { text: 'Ambulance', tag: 'section-title' },
    { text: LONG_TEXT, tag: 'paragraph' },
  ],
];

const passages = (app, s, query = 'room rent', { token = s.token, caseId = s.caseId, limit } = {}) =>
  app.call(`/api/v1/cases/${caseId}/passages?q=${encodeURIComponent(query)}${limit === undefined ? '' : `&limit=${limit}`}`, { token });

const FORBIDDEN = [POLICY_NUMBER, HOLDER, 'Asha', 'Synthetic', MEMBER_ID, PREMIUM, 'Policyholder Name'];
const assertNoIdentity = (data, message = '') => {
  const text = JSON.stringify(data);
  for (const forbidden of FORBIDDEN) assert.ok(!text.includes(forbidden), `${message} ${forbidden} must not be returned`);
};

test('V3b: a query returns labelled, bounded passages with page and kind, no schedule fact, no identity, no model, no provider', pgOptions, async t => {
  const app = await startApp(t);
  const s = await scenario(app);
  const providerBefore = app.providerCalls.length;

  const res = await passages(app, s);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.label, 'passage_not_answer');
  assert.equal(res.data.notice, 'These are passages from your documents, not an answer or a claim decision.');
  assert.equal(res.data.query, 'room rent');
  assert.deepEqual(res.data.excluded, []);
  assert.ok(res.data.passages.length >= 1, JSON.stringify(res.data.passages));
  for (const passage of res.data.passages) {
    assert.deepEqual(Object.keys(passage), ['clauseId', 'documentId', 'page', 'kind', 'title', 'snippet']);
    assert.equal(passage.documentId, s.documentId);
    assert.ok(Number.isSafeInteger(passage.page) && passage.page >= 1);
    assert.notEqual(passage.kind, 'schedule_fact');
    assert.ok(passage.snippet.length > 0 && passage.snippet.length <= 280);
    assert.ok(/room rent/i.test(passage.snippet), passage.snippet);
  }
  assertNoIdentity(res.data);
  const text = JSON.stringify(res.data);
  assert.ok(text.includes('[hidden]'), 'identity strings are replaced, not just dropped');
  assert.ok(text.includes('Rs 5,000 per day'), 'the policy wording itself is kept');
  assert.ok(!text.includes('consentGrantId'));

  assert.equal(app.providerCalls.length, providerBefore, 'passages make no Sarvam call');
  assert.deepEqual(app.modelCalls, []);
  assert.deepEqual(app.outbound, []);
});

test('V3b: a long clause gives a snippet of at most 280 characters centred on the match and cut at word boundaries', pgOptions, async t => {
  const app = await startApp(t);
  const s = await scenario(app);
  const res = await passages(app, s, 'ambulance');
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const hit = res.data.passages.find(passage => passage.page === 2);
  assert.ok(hit, JSON.stringify(res.data.passages));
  assert.ok(hit.snippet.length <= 280);
  assert.ok(hit.snippet.length > 200, 'a long clause fills the window');
  assert.ok(/ambulance/i.test(hit.snippet), 'the window is centred on the match');
  const words = new Set(`Ambulance ${LONG_TEXT}`.split(' '));
  for (const word of hit.snippet.split(' ')) assert.ok(words.has(word), `"${word}" is a whole word of the clause, not a cut one`);
  assert.ok(!hit.snippet.startsWith('filler0 '), 'a long clause is cut around the match, not at its start');
});

test('V3b: the limit applies, and bad q or limit is 400 INVALID_REQUEST', pgOptions, async t => {
  const app = await startApp(t);
  const s = await scenario(app);
  assert.equal((await passages(app, s, 'room rent', { limit: 1 })).data.passages.length, 1);
  assert.equal((await passages(app, s, 'room rent', { limit: 10 })).status, 200);
  for (const limit of [0, 11, 'abc', -1, 100]) {
    const res = await passages(app, s, 'room rent', { limit });
    assert.equal(res.status, 400, `limit ${limit}`);
    assert.equal(res.data.error.code, 'INVALID_REQUEST');
  }
  for (const query of ['a', '  b ', '', ' ', 'x'.repeat(121)]) {
    const res = await passages(app, s, query);
    assert.equal(res.status, 400, JSON.stringify(query));
    assert.equal(res.data.error.code, 'INVALID_REQUEST');
  }
  assert.equal((await app.call(`/api/v1/cases/${s.caseId}/passages`, { token: s.token })).status, 400, 'q is required');
  assert.equal((await passages(app, s, ` ${'x'.repeat(120)} `)).status, 200, 'q is trimmed before the length check');
  // The query is echoed back to its owner only and never appears in the 400 body.
  assert.ok(!JSON.stringify((await passages(app, s, 'x'.repeat(121))).data).includes('xxxxxxxx'));
});

test('V3b: flag off answers 503 READBACK_DISABLED after the case and permission checks', pgOptions, async t => {
  for (const flag of [undefined, 'false', 'TRUE']) {
    const app = await startApp(t, { env: { DOCUMENT_READBACK_ENABLED: flag, APP_EVENTS_ENABLED: 'false' } });
    const s = await scenario(app);
    const res = await passages(app, s);
    assert.equal(res.status, 503, `${flag}: ${JSON.stringify(res.data)}`);
    assert.equal(res.data.error.code, 'READBACK_DISABLED');
    assert.ok(!JSON.stringify(res.data).includes('Rs 5,000'));
    assert.equal((await passages(app, s, 'a')).status, 503, 'the flag is checked before q and limit');
    assert.equal((await passages(app, s, 'room rent', { limit: 11 })).status, 503);
    const other = await scenario(app, { name: 'Other', read: false });
    assert.equal((await passages(app, s, 'room rent', { token: other.token })).status, 404, 'a foreign caller sees the 404, not the flag state');
    const countsBefore = await tableCounts(app.database);
    await passages(app, s);
    assert.deepEqual(await tableCounts(app.database), countsBefore, 'a disabled route writes nothing');
  }
});

test('V3b: a foreign or missing case is the same 404, a missing token is 401, a revoked collect consent is 403', pgOptions, async t => {
  const app = await startApp(t);
  const mine = await scenario(app, { name: 'Mine' });
  const other = await scenario(app, { name: 'Other' });
  const foreign = await passages(app, mine, 'room rent', { token: other.token });
  const missing = await passages(app, mine, 'room rent', { token: other.token, caseId: 'case-does-not-exist' });
  assert.equal(foreign.status, 404);
  assert.deepEqual(foreign.data.error, missing.data.error);
  assert.ok(!JSON.stringify(foreign.data).includes('Rs 5,000'));
  assert.equal((await app.call(`/api/v1/cases/${mine.caseId}/passages?q=room`)).status, 401);
  assert.equal((await passages(app, other)).status, 200, 'the owner of the other case reads their own');
  // A foreign caller with an invalid query still gets the 404: nothing about the case is revealed.
  assert.equal((await passages(app, mine, 'a', { token: other.token })).status, 404);

  const revoked = await app.call(`/api/v1/consents/${mine.processingGrantId}/revoke`, { method: 'POST', token: mine.token, body: { reason: 'test' } });
  assert.equal(revoked.status, 200, JSON.stringify(revoked.data));
  const res = await passages(app, mine);
  assert.equal(res.status, 403, JSON.stringify(res.data));
  assert.equal(res.data.error.code, 'FIELD_ACCESS_REQUIRED');
});

test('V3b: a document not yet read, superseded, or being deleted is excluded or absent; reading is decided per document', pgOptions, async t => {
  const app = await startApp(t);
  const s = await scenario(app, { read: false, logicalId: 'logical-policy' });
  const none = await passages(app, s);
  assert.equal(none.status, 200);
  assert.deepEqual(none.data.passages, []);
  assert.deepEqual(none.data.excluded, [{ documentId: s.documentId, reason: 'not_read' }]);

  s.readingGrantId = await grantReading(app, s, s.documentId);
  await readDocument(app, s, s.documentId, s.readingGrantId);
  const second = await uploadDocument(app, s);
  const mixed = await passages(app, s);
  assert.deepEqual(mixed.data.excluded, [{ documentId: second, reason: 'not_read' }]);
  assert.ok(mixed.data.passages.length >= 1);
  assert.ok(mixed.data.passages.every(passage => passage.documentId === s.documentId));

  const newer = await uploadDocument(app, s, { logicalId: 'logical-policy', version: 2 });
  const superseded = await passages(app, s);
  assert.deepEqual(superseded.data.passages, []);
  assert.deepEqual(superseded.data.excluded.map(entry => [entry.documentId, entry.reason]).sort(), [
    [s.documentId, 'superseded'], [second, 'not_read'], [newer, 'not_read'],
  ].sort());

  const other = await scenario(app, { name: 'Deleting' });
  await app.database.run("UPDATE document_uploads SET lifecycle_state = 'deletion_requested' WHERE id = ?", [other.documentId]);
  const gone = await passages(app, other);
  assert.equal(gone.status, 200);
  assert.deepEqual(gone.data.passages, []);
  assert.ok(!JSON.stringify(gone.data).includes('Rs 5,000'));
});

test('V3b: the per-request grant check decides: an expired reading grant hides passages that are still stored', pgOptions, async t => {
  const app = await startApp(t);
  const s = await scenario(app);
  assert.ok((await passages(app, s)).data.passages.length >= 1);
  await app.database.run('UPDATE consent_grants SET expires_at = ? WHERE id = ?', ['2000-01-01T00:00:00.000Z', s.readingGrantId]);
  assert.ok((await app.database.one('SELECT count(*) AS n FROM policy_clauses WHERE document_id = ?', [s.documentId])).n > 0, 'clauses are still stored');
  const res = await passages(app, s);
  assert.equal(res.status, 200);
  assert.deepEqual(res.data.passages, []);
  assert.deepEqual(res.data.excluded, [{ documentId: s.documentId, reason: 'reading_permission_expired' }]);
  assert.ok(!JSON.stringify(res.data).includes('Rs 5,000'));
});

test('V3b: a job authorization naming someone other than the uploader, or a non-sarvam job, never yields passages', pgOptions, async t => {
  const app = await startApp(t);
  const s = await scenario(app);
  assert.ok((await passages(app, s)).data.passages.length >= 1);
  await app.database.run(`UPDATE ocr_jobs SET authorization_json = CAST(jsonb_set(CAST(authorization_json AS jsonb), '{requestedByAdultId}', '"adult-someone-else"') AS text)
    WHERE document_upload_id = ?`, [s.documentId]);
  const mismatch = await passages(app, s);
  assert.deepEqual(mismatch.data.passages, []);
  assert.deepEqual(mismatch.data.excluded, [{ documentId: s.documentId, reason: 'reading_permission_withdrawn' }]);

  const app2 = await startApp(t);
  const s2 = await scenario(app2);
  await app2.database.run("UPDATE ocr_jobs SET provider = 'fixture' WHERE document_upload_id = ?", [s2.documentId]);
  const fixtureJob = await passages(app2, s2);
  assert.deepEqual(fixtureJob.data.passages, []);
  assert.deepEqual(fixtureJob.data.excluded, [{ documentId: s2.documentId, reason: 'not_read' }]);
});

test('V3b: revoking the reading grant withdraws the document and erases its pages and clauses; a new grant reads it again', pgOptions, async t => {
  const app = await startApp(t);
  const s = await scenario(app);
  assert.ok((await passages(app, s)).data.passages.length >= 1, 'the first search derives the clauses');
  const clauseCount = () => app.database.one('SELECT count(*) AS n FROM policy_clauses WHERE document_id = ?', [s.documentId]);
  const pagesWithText = () => app.database.one('SELECT count(*) AS n FROM source_pages WHERE document_upload_id = ? AND (extracted_text IS NOT NULL OR blocks_json IS NOT NULL)', [s.documentId]);
  assert.ok((await clauseCount()).n > 0);
  assert.ok((await pagesWithText()).n > 0);

  const revoked = await app.call(`/api/v1/consents/${s.readingGrantId}/revoke`, { method: 'POST', token: s.token, body: { reason: 'test' } });
  assert.equal(revoked.status, 200, JSON.stringify(revoked.data));
  const res = await passages(app, s);
  assert.equal(res.status, 200);
  assert.deepEqual(res.data.passages, []);
  assert.deepEqual(res.data.excluded, [{ documentId: s.documentId, reason: 'reading_permission_withdrawn' }]);
  assert.equal((await clauseCount()).n, 0, 'derived clauses are erased');
  assert.equal((await pagesWithText()).n, 0, 'extracted_text and blocks_json are NULL');
  assert.equal((await clauseCount()).n, 0, 'a search after revocation derives nothing');

  const newGrantId = await grantReading(app, s, s.documentId);
  await readDocument(app, s, s.documentId, newGrantId);
  const again = await passages(app, s);
  assert.deepEqual(again.data.excluded, []);
  assert.ok(again.data.passages.length >= 1);
  assertNoIdentity(again.data);
  assert.deepEqual(app.modelCalls, []);
  assert.deepEqual(app.outbound, []);
});

const LEAK_PAGES = [
  [
    { text: 'Policy Schedule', tag: 'section-title' },
    // The classifier files this table as a waiting period, not a schedule fact, because of its last row.
    { text: table([
      ['Policy Number', POLICY_NUMBER], ['Policyholder Name', HOLDER], ['Mobile No.', '98765 43210'], ['Address', '12 Lake Road, Pune'],
      ['Nominee Name', 'Ravi Kumar'], ['Premium', PREMIUM], ['Waiting period', '30 days'],
    ]), tag: 'table' },
    { text: 'Waiting period for named illnesses', tag: 'section-title' },
    { text: 'A waiting period of 24 months applies to named illnesses from the start of the policy.', tag: 'paragraph' },
  ],
  [
    { text: 'Contact', tag: 'section-title' },
    { text: 'Your policy no. SYN PERS 410001 is active. Mobile No: 9876543210. DOB 01-02-1990. Call for cashless claims.', tag: 'paragraph' },
    { text: 'Online', tag: 'section-title' },
    { text: 'E-mail ID: asha.synthetic@example.test. Cashless treatment needs prior approval.', tag: 'paragraph' },
    { text: 'Payment', tag: 'section-title' },
    { text: `Premium paid is ${PREMIUM} and covers cashless treatment.`, tag: 'paragraph' },
    { text: 'Beneficiary', tag: 'section-title' },
    { text: 'The nominee Ravi Kumar receives the cashless benefit information.', tag: 'paragraph' },
    { text: 'Cashless claims', tag: 'section-title' },
    { text: 'Cashless hospitalisation needs intimation to the insurer 48 hours before a planned admission.', tag: 'paragraph' },
    { text: 'Cashless helpline', tag: 'section-title' },
    { text: 'For cashless help call 1800 123 4567 or write to claims@insurer.example.test any day.', tag: 'paragraph' },
    { text: 'Cashless reference', tag: 'section-title' },
    { text: 'Reference SYN PERS 410001 applies to every cashless claim.', tag: 'paragraph' },
  ],
];

test('V3b: schedule content filed under another kind, labelled identity and bare numbers never reach a snippet', pgOptions, async t => {
  const original = fixture.pages;
  fixture.pages = LEAK_PAGES;
  t.after(() => { fixture.pages = original; });
  const app = await startApp(t);
  const s = await scenario(app);
  const leaks = [
    '98765', '9876543210', '410001', 'SYN PERS', 'SYN-PERS', 'Ravi', 'Kumar', 'Lake Road', '12,345', '01-02-1990', 'asha.synthetic', 'example.test',
    '1800 123', '4567', 'Policy Number', 'Policyholder', 'Mobile', 'Nominee', 'Premium', HOLDER, 'Asha',
  ];
  const seen = {};
  for (const query of ['waiting period', 'cashless', 'premium', 'nominee', 'mobile', 'birth', 'policy', 'address', 'email', 'schedule']) {
    const res = await passages(app, s, query);
    assert.equal(res.status, 200, `${query}: ${JSON.stringify(res.data)}`);
    const text = JSON.stringify(res.data);
    for (const leak of leaks) assert.ok(!text.includes(leak), `${query}: "${leak}" in ${text}`);
    seen[query] = res.data.passages;
  }
  // Genuine clauses still come back, with whatever number or address they carry hidden.
  const waiting = seen['waiting period'];
  assert.ok(waiting.some(passage => /24 months/.test(passage.snippet)), JSON.stringify(waiting));
  assert.ok(waiting.every(passage => !/30 days/.test(passage.snippet)), 'the schedule table is not a waiting-period passage');
  const cashless = seen.cashless.map(passage => passage.snippet);
  assert.ok(cashless.some(snippet => /intimation to the insurer 48 hours/.test(snippet)), JSON.stringify(cashless));
  assert.ok(cashless.some(snippet => /call \[hidden\] or write to \[hidden\]/.test(snippet)), JSON.stringify(cashless));
  assert.ok(cashless.some(snippet => /Reference \[hidden\] applies/.test(snippet)), JSON.stringify(cashless));
  assert.equal(seen.cashless.length, 3, 'the four clauses holding a label are dropped, the three clean ones kept');
  for (const query of ['premium', 'nominee', 'mobile', 'birth', 'address', 'email', 'schedule']) {
    assert.deepEqual(seen[query], [], `${query} matches only labelled or schedule clauses`);
  }
});

test('V3b: clauses of an expired document that are still stored are never searched', pgOptions, async t => {
  const app = await startApp(t);
  const s = await scenario(app);
  const second = await uploadDocument(app, s);
  const secondGrant = await grantReading(app, s, second);
  await readDocument(app, s, second, secondGrant);
  const both = await passages(app, s);
  assert.deepEqual(new Set(both.data.passages.map(passage => passage.documentId)), new Set([s.documentId, second]), 'both documents answer while both are readable');
  await app.database.run('UPDATE consent_grants SET expires_at = ? WHERE id = ?', ['2000-01-01T00:00:00.000Z', secondGrant]);
  assert.ok((await app.database.one('SELECT count(*) AS n FROM policy_clauses WHERE document_id = ?', [second])).n > 0, 'its clauses are still stored');
  const res = await passages(app, s);
  assert.equal(res.status, 200);
  assert.ok(res.data.passages.length >= 1);
  assert.ok(res.data.passages.every(passage => passage.documentId === s.documentId));
  assert.deepEqual(res.data.excluded, [{ documentId: second, reason: 'reading_permission_expired' }]);
});

test('V3b: clauses are not written for text erased between the read and the save (revoke race)', pgOptions, async t => {
  const app = await startApp(t);
  const s = await scenario(app);
  const { clauses, ocr } = createBackendServices(app.database);
  // 1. The search path reads the stored pages and builds clauses outside any lock.
  const stored = await ocr.getDocumentBlockPages({ documentId: s.documentId, householdId: s.householdId });
  const { clauses: built } = buildClauses(stored, { documentId: s.documentId, sourceVersion: stored.sourceVersion });
  assert.ok(built.length > 0);
  // 2. The reading grant is revoked before they are saved: the text is erased.
  const revoked = await app.call(`/api/v1/consents/${s.readingGrantId}/revoke`, { method: 'POST', token: s.token, body: { reason: 'test' } });
  assert.equal(revoked.status, 200);
  // 3. The save finds no stored text and writes nothing.
  await assert.rejects(clauses.saveClauses({ householdId: s.householdId, caseId: s.caseId, documentId: s.documentId, clauses: built }), { code: 'OCR_PAGES_UNAVAILABLE' });
  assert.equal((await app.database.one('SELECT count(*) AS n FROM policy_clauses WHERE document_id = ?', [s.documentId])).n, 0);
});
