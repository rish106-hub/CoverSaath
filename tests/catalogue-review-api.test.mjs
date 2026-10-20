import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { testTempRoot as tmpdir } from './support/temp-root.mjs';
import { openDatabase } from '../src/backend/database/index.js';
import { createApiServer } from '../src/server/server.js';

// Block 3 decision catalogue API on top of the ADR 0008 answer API through the real application: upload, Sarvam OCR (mocked HTTP), stored blocks, clauses,
// Gemini through the model gateway (mocked SDK driver), cited conditional answer. Synthetic data only.

const bootstrapToken = 'coversaath-test-bootstrap-token-0001';
const OWNER_NAME = 'Ishaan Synthetic';
const PAGES = [
  [
    { text: 'Policy Schedule', tag: 'headline' },
    { text: `Policyholder: ${OWNER_NAME}`, tag: 'paragraph' },
    { text: 'Policy Number: SYN-PH-000123', tag: 'paragraph' },
    { text: 'Room rent limit: Rs 5,000 per day', tag: 'paragraph' },
    { text: 'Pre-existing disease waiting period: 3 years', tag: 'paragraph' },
  ],
  [
    { text: 'Customer Information Sheet', tag: 'headline' },
    { text: 'Pre-existing disease waiting period: 36 months of continuous coverage', tag: 'paragraph' },
    { text: 'Free look period: 15 days', tag: 'paragraph' },
  ],
];
// Readings the stub "model" returns when a chunk contains the printed phrase.
const READINGS = [
  { phrase: '5,000 per day', key: 'd.room_rent_limit' },
  { phrase: '3 years', key: 'f.ped_waiting_period' },
  { phrase: '36 months', key: 'f.ped_waiting_period' },
  { phrase: '15 days', key: 'b.free_look_period' },
];

function stubDriver(requests) {
  return {
    loadModel: async () => ({ mocked: true }),
    createAgent: settings => ({
      generate: async ({ prompt }) => {
        requests.push({ agentId: settings.id, instructions: settings.instructions, prompt });
        const payload = JSON.parse(prompt);
        if (settings.id === 'knowvia-policy_evidence_investigate') {
          const clause = payload.clauses.find(entry => entry.text.includes('Room rent limit: Rs 5,000 per day'));
          const findings = clause ? [{ clause_ids: [clause.clause_id], quote: 'Room rent limit: Rs 5,000 per day', subject: 'room rent', conditions: [], exceptions: [] }] : [];
          return { output: { findings }, totalUsage: { inputTokens: 300, outputTokens: 40 } };
        }
        if (settings.id === 'knowvia-policy_evidence_override_sweep') return { output: { overrides: [] }, totalUsage: { inputTokens: 300, outputTokens: 10 } };
        throw new Error(`unexpected agent ${settings.id}`);
      },
    }),
  };
}

const providerJson = (value, status = 200) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, async text() { return JSON.stringify(value); } });

function sarvamFetch() {
  let submissions = 0;
  return async url => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/digitise')) {
      submissions += 1;
      return providerJson({ job_id: `structuring-job-${submissions}`, status: 'pending' }, 201);
    }
    const jobId = parsed.pathname.split('/').at(-2);
    if (parsed.pathname.endsWith('/status')) return providerJson({ job_id: jobId, status: 'completed' });
    if (parsed.pathname.endsWith('/results')) {
      return providerJson({
        type: 'digitise', job_id: jobId, status: 'completed',
        usage: { pages_total: 2, pages_processed: 2, pages_succeeded: 2, pages_failed: 0 },
        documents: [{ pages: PAGES.map((blocks, index) => ({
          page_num: index + 1,
          blocks: blocks.map((block, order) => ({ block_id: `p${index + 1}b${order}`, text: block.text, layout_tag: block.tag, reading_order: order + 1 })),
        })) }],
      });
    }
    throw new Error(`Unexpected provider request: ${url}`);
  };
}

async function twoPagePdf() {
  const document = await PDFDocument.create();
  document.addPage([300, 400]);
  document.addPage([301, 401]);
  return Buffer.from(await document.save({ useObjectStreams: false }));
}

async function eventually(check, { timeoutMs = 3000 } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error('Condition not met in time.');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function startApp(t, { env: extraEnv = {} } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'coversaath-structuring-'));
  const database = openDatabase({ path: join(directory, 'app.sqlite') });
  const requests = [];
  const env = {
    KNOWVIA_BOOTSTRAP_TOKEN: bootstrapToken,
    DOCUMENT_STORAGE_PATH: join(directory, 'documents'),
    DOCUMENT_ENCRYPTION_KEY_BASE64: randomBytes(32).toString('base64'),
    SARVAM_OCR_ENABLED: 'true', SARVAM_API_KEY: 'test-only', SARVAM_OCR_RETRY_DELAY_MS: '0', SARVAM_OCR_POLL_INTERVAL_MS: '0',
    LLM_PROVIDER: 'google', GEMINI_API_KEY: 'test-only-not-a-real-key', LLM_MODEL: 'mock-gemini', LLM_MODEL_VERSION: 'mock-gemini-v1',
    LLM_INPUT_USD_PER_MILLION: '0.75', LLM_OUTPUT_USD_PER_MILLION: '4.50',
    ORCHESTRATION_RUN_BUDGET_USD: '0.25', ORCHESTRATION_PROJECT_BUDGET_USD: '5',
    POLICY_STRUCTURING_ENABLED: 'true', POLICY_EVIDENCE_ENABLED: 'true',
    ...extraEnv,
  };
  const server = createApiServer({
    database, env, sarvamFetch: sarvamFetch(), analysisLiveModelDriver: stubDriver(requests),
    documentScanner: { mode: 'clamd', async scan() { return { status: 'clean' }; }, async ping() { return true; } },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = 'GET', body, token, headers = {} } = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: await response.json() };
  };
  return { server, database, requests, call, base };
}

// Household, case, uploaded and OCR'd document, a fixture analysis run, and a document-specific Gemini grant.
async function scenario(app, name = 'Structuring') {
  const { call } = app;
  const identity = await call('/api/v1/households', {
    method: 'POST', token: bootstrapToken, body: { displayName: `${name} household`, owner: { displayName: OWNER_NAME } },
  });
  assert.equal(identity.status, 201);
  const token = identity.data.session.token;
  const householdId = identity.data.household.id;
  const adultId = identity.data.owner.id;
  const opened = await call('/api/v1/cases', { method: 'POST', token, body: { householdId, subjectMemberId: identity.data.ownerMember.id, triggerType: 'planned_care' } });
  assert.equal(opened.status, 201);
  const caseId = opened.data.id;
  const processing = await call('/api/v1/consents', {
    method: 'POST', token,
    body: {
      householdId, subjectAdultId: adultId, purpose: 'document_processing',
      scopes: [
        { resourceType: 'document', action: 'collect', dataCategory: 'insurance_document' },
        { resourceType: 'case', resourceId: caseId, action: 'read', dataCategory: 'source_pack_metadata', recipient: adultId },
      ],
    },
  });
  assert.equal(processing.status, 201);
  const upload = await fetch(`${app.base}/api/v1/cases/${caseId}/documents`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/pdf', 'Idempotency-Key': randomUUID(),
      'X-Document-Kind': 'policy_schedule', 'X-Consent-Grant-Id': processing.data.id, 'X-Filename': 'synthetic-policy.pdf',
    },
    body: await twoPagePdf(),
  });
  assert.equal(upload.status, 201);
  const documentId = (await upload.json()).document.id;
  await eventually(() => app.database.prepare(`SELECT 1 FROM document_uploads WHERE id = ? AND lifecycle_state = 'active' AND malware_status = 'clean'`).get(documentId));
  const sarvamGrant = await call('/api/v1/consents', {
    method: 'POST', token,
    body: { householdId, subjectAdultId: adultId, grantedToActor: 'sarvam', purpose: 'document_processing',
      scopes: [{ resourceType: 'document', resourceId: documentId, action: 'derive', dataCategory: 'insurance_document', recipient: 'sarvam' }] },
  });
  assert.equal(sarvamGrant.status, 201);
  const ocr = await call(`/api/v1/documents/${documentId}/ocr-jobs`, { method: 'POST', token, body: { consentGrantId: sarvamGrant.data.id } });
  assert.equal(ocr.status, 202, JSON.stringify(ocr.data));
  const refreshed = await call(`/api/v1/ocr-jobs/${ocr.data.job.id}/refresh`, { method: 'POST', token, body: { consentGrantId: sarvamGrant.data.id } });
  assert.equal(refreshed.data.job.status, 'succeeded', JSON.stringify(refreshed.data));

  const grant = (dataCategory) => call('/api/v1/consents', {
    method: 'POST', token,
    body: { householdId, subjectAdultId: adultId, grantedToActor: 'google-gemini', purpose: 'document_processing',
      scopes: [{ resourceType: 'document', resourceId: documentId, action: 'derive', dataCategory, recipient: 'google-gemini' }] },
  });
  const questionGrant = await grant('insurance_question');
  assert.equal(questionGrant.status, 201, JSON.stringify(questionGrant.data));
  const structuringGrant = await grant('insurance_document');
  assert.equal(structuringGrant.status, 201, JSON.stringify(structuringGrant.data));
  return { token, householdId, adultId, caseId, documentId, questionGrantId: questionGrant.data.id, structuringGrantId: structuringGrant.data.id, ownerMemberId: identity.data.ownerMember.id };
}

const ask = (app, s, { grantId = s.questionGrantId, key = randomUUID(), question = 'What is the room rent limit?', token = s.token, caseId = s.caseId } = {}) => app.call(`/api/v1/cases/${caseId}/questions`, {
  method: 'POST', token, headers: { 'Idempotency-Key': key }, body: { question, consentGrantId: grantId },
});
const rows = (app, table) => app.database.prepare(`SELECT count(*) AS count FROM ${table}`).get().count;


const catalogue = (app, s, answerId, query = '', { token = s.token, caseId = s.caseId } = {}) =>
  app.call(`/api/v1/cases/${caseId}/decision-catalogue?answerId=${encodeURIComponent(answerId)}${query}`, { token });


import { CatalogueReviewRepository } from '../src/backend/repositories/index.js';

const review = (app, s, body, { token = s.token, key = randomUUID(), caseId = s.caseId } = {}) => app.call(`/api/v1/cases/${caseId}/decision-catalogue/reviews`, {
  method: 'POST', token, headers: { 'Idempotency-Key': key }, body,
});
async function answered(app, s) {
  const a = await ask(app, s);
  assert.equal(a.status, 201, JSON.stringify(a.data));
  const c = await catalogue(app, s, a.data.answerId);
  const typed = c.data.catalogue.facts.find(fact => fact.factType === 'room_rent_limit');
  assert.ok(typed);
  return { answerId: a.data.answerId, factId: typed.factId };
}
const roomRule = res => res.data.catalogue.policies[0].rules.find(rule => rule.rule === 'room_rent_limit' && rule.topic === 'room rent');
const makeConfirmer = (app, s) => app.call(`/api/v1/households/${s.householdId}/catalogue-reviewers`, { method: 'POST', token: s.token, body: { adultUserId: s.adultId } });

test('Phase 4: no grant means no review, and a foreign household cannot see the case', async t => {
  const app = await startApp(t);
  const s = await scenario(app, 'Mine');
  const other = await scenario(app, 'Other');
  const { answerId, factId } = await answered(app, s);
  const body = { answerId, factId, decision: 'accepted', reasonCode: 'matches_clause' };
  assert.equal((await review(app, s, body)).status, 404, 'an owner without a reviewer grant cannot review');
  assert.equal((await review(app, s, body, { token: other.token })).status, 404);
  assert.equal((await review(app, s, body, { token: null })).status, 401);
  assert.equal(rows(app, 'catalogue_reviews'), 0);
});

test('Phase 4: a household confirmer reaches reported at most; a claimed authority in the body is ignored', async t => {
  const app = await startApp(t);
  const s = await scenario(app, 'Mine');
  const { answerId, factId } = await answered(app, s);
  const mc = await makeConfirmer(app, s); assert.equal(mc.status, 201, JSON.stringify(mc.data));
  const before = app.requests.length;
  const res = await review(app, s, { answerId, factId, decision: 'accepted', reasonCode: 'matches_clause', authority: 'independent', reviewStatus: 'accepted', attestedSourceType: 'issued_schedule', attestsPolicyAssociation: true });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.equal(res.data.authority, 'household');
  assert.equal(app.requests.length, before, 'a review makes no model call');
  const c = await catalogue(app, s, answerId);
  const reviewed = c.data.catalogue.facts.filter(fact => fact.factType === 'room_rent_limit' && fact.origin === 'human_review');
  assert.equal(reviewed.length, 1);
  assert.equal(reviewed[0].state, 'reported');
  assert.equal(reviewed[0].verified, false);
  assert.equal(reviewed[0].sourceType, 'user_statement', 'a household confirmer cannot make a source contractual');
  assert.notEqual(roomRule(c).result.status, 'known');
  assert.deepEqual(c.data.catalogue.reviews.map(r => [r.state, r.authority]), [['accepted', 'household']]);
  assert.equal(c.data.catalogue.reviewRequired, true);
});

test('Phase 4: an independent reviewer can make a fact known; model proposal and original stay visible', async t => {
  const app = await startApp(t, { env: { CATALOGUE_INDEPENDENT_REVIEW_ENABLED: 'true' } });
  const s = await scenario(app, 'Mine');
  const reviewer = await scenario(app, 'Reviewer');
  new CatalogueReviewRepository(app.database).grantIndependentReviewer({ householdId: s.householdId, adultUserId: reviewer.adultId, operatorId: 'test-operator' });
  const { answerId, factId } = await answered(app, s);
  // The reviewer reads the catalogue of a case they have no household role in.
  assert.equal((await catalogue(app, s, answerId, '', { token: reviewer.token })).status, 200);
  const withoutAttest = await review(app, s, { answerId, factId, decision: 'accepted', reasonCode: 'matches_clause' }, { token: reviewer.token });
  assert.equal(withoutAttest.status, 201, JSON.stringify(withoutAttest.data));
  assert.equal(withoutAttest.data.authority, 'independent');
  let c = await catalogue(app, s, answerId);
  assert.notEqual(roomRule(c).result.status, 'known', 'proven value of a non-contractual, unassociated fact is not known');
  const full = await review(app, s, { answerId, factId, decision: 'accepted', reasonCode: 'matches_clause', attestedSourceType: 'issued_schedule', attestsPolicyAssociation: true }, { token: reviewer.token });
  assert.equal(full.status, 201);
  c = await catalogue(app, s, answerId);
  const rule = roomRule(c);
  assert.equal(rule.result.status, 'known');
  assert.deepEqual(rule.result.value, { kind: 'amount', amountMinor: 500000, currency: 'INR', basis: 'day' });
  assert.ok(c.data.catalogue.facts.some(f => f.origin === 'model' && f.factId === factId && f.state === 'extracted_unverified'), 'the model proposal stays visible');
  assert.deepEqual(c.data.catalogue.reviews.map(r => r.state).sort(), ['accepted', 'superseded']);
});

test('Phase 4: rejection removes the proposal from rules; disputes keep review required; later review wins', async t => {
  const app = await startApp(t, { env: { CATALOGUE_INDEPENDENT_REVIEW_ENABLED: 'true' } });
  const s = await scenario(app, 'Mine');
  const reviewer = await scenario(app, 'Reviewer');
  new CatalogueReviewRepository(app.database).grantIndependentReviewer({ householdId: s.householdId, adultUserId: reviewer.adultId, operatorId: 'test-operator' });
  const { answerId, factId } = await answered(app, s);
  const as = (decision, reasonCode = 'does_not_match_clause') => review(app, s, { answerId, factId, decision, reasonCode }, { token: reviewer.token });
  assert.equal((await as('rejected')).status, 201);
  let c = await catalogue(app, s, answerId);
  assert.ok(!c.data.catalogue.facts.some(f => f.factId === factId), 'a rejected proposal leaves the rule pool');
  assert.equal(c.data.catalogue.reviews[0].state, 'rejected');
  assert.equal((await as('disputed', 'clause_ambiguous')).status, 201);
  c = await catalogue(app, s, answerId);
  assert.ok(c.data.catalogue.facts.some(f => f.factId === factId));
  assert.equal(c.data.catalogue.reviewRequired, true);
  assert.ok(c.data.catalogue.conflicts.some(x => x.rule.startsWith('review_disputed/')));
});

test('Phase 4: idempotent writes, bad input and a forged fact id', async t => {
  const app = await startApp(t);
  const s = await scenario(app, 'Mine');
  const { answerId, factId } = await answered(app, s);
  await makeConfirmer(app, s);
  const body = { answerId, factId, decision: 'accepted', reasonCode: 'matches_clause' };
  const key = randomUUID();
  const first = await review(app, s, body, { key });
  const replay = await review(app, s, body, { key });
  assert.equal(first.status, 201);
  assert.equal(replay.status, 200);
  assert.equal(replay.data.reviewId, first.data.reviewId);
  assert.equal((await review(app, s, { ...body, decision: 'rejected' }, { key })).status, 409);
  assert.equal(rows(app, 'catalogue_reviews'), 1);
  assert.equal((await review(app, s, { ...body, factId: 'fact-forged' })).status, 404);
  assert.equal((await review(app, s, { ...body, decision: 'proven' })).status, 400);
  assert.equal((await review(app, s, { ...body, reasonCode: 'because' })).status, 400);
  assert.equal((await review(app, s, { ...body, attestedSourceType: 'marketing_material' })).status, 400);
  assert.equal(rows(app, 'catalogue_reviews'), 1);
  const audit = app.database.prepare("SELECT event_payload_json FROM audit_events WHERE action = 'catalogue_review.recorded'").all();
  assert.equal(audit.length, 1);
  assert.ok(!audit[0].event_payload_json.includes('500000') && !audit[0].event_payload_json.includes('Rs'), 'audit holds no fact content');
});

test('Phase 4: only the household owner designates a confirmer, and only an adult of that household', async t => {
  const app = await startApp(t);
  const s = await scenario(app, 'Mine');
  const other = await scenario(app, 'Other');
  const path = `/api/v1/households/${s.householdId}/catalogue-reviewers`;
  assert.equal((await app.call(path, { method: 'POST', token: other.token, body: { adultUserId: other.adultId } })).status, 404);
  assert.equal((await app.call(path, { method: 'POST', token: s.token, body: { adultUserId: other.adultId } })).status, 400, 'an adult outside the household');
  assert.equal((await app.call(path, { method: 'POST', token: s.token, body: { adultUserId: s.adultId } })).status, 201);
});

test('Phase 4: erasure and revocation remove reviews and what they supported', async t => {
  const app = await startApp(t);
  const s = await scenario(app, 'Mine');
  const { answerId, factId } = await answered(app, s);
  await makeConfirmer(app, s);
  assert.equal((await review(app, s, { answerId, factId, decision: 'accepted', reasonCode: 'matches_clause' })).status, 201);
  assert.equal(rows(app, 'catalogue_reviews'), 1);
  // Document erasure (trigger safety net and repository path).
  app.database.prepare("UPDATE document_uploads SET lifecycle_state = 'deletion_requested' WHERE id = ?").run(s.documentId);
  assert.equal(rows(app, 'catalogue_reviews'), 0);
  assert.equal(rows(app, 'policy_clauses'), 0);
  assert.notEqual((await catalogue(app, s, answerId)).status, 200, 'the stale answer no longer builds a catalogue');
});

test('Phase 4: reviews are immutable', async t => {
  const app = await startApp(t);
  const s = await scenario(app, 'Mine');
  const { answerId, factId } = await answered(app, s);
  await makeConfirmer(app, s);
  await review(app, s, { answerId, factId, decision: 'accepted', reasonCode: 'matches_clause' });
  assert.throws(() => app.database.prepare("UPDATE catalogue_reviews SET decision = 'rejected'").run(), /immutable/);
});

const independent = async (t, extra = {}) => {
  const app = await startApp(t, { env: { CATALOGUE_INDEPENDENT_REVIEW_ENABLED: 'true', ...extra } });
  const s = await scenario(app, 'Mine');
  const reviewer = await scenario(app, 'Reviewer');
  const repo = new CatalogueReviewRepository(app.database);
  const grant = repo.grantIndependentReviewer({ householdId: s.householdId, adultUserId: reviewer.adultId, operatorId: 'test-operator' });
  return { app, s, reviewer, repo, grant };
};
const attest = { decision: 'accepted', reasonCode: 'matches_clause', attestedSourceType: 'issued_schedule', attestsPolicyAssociation: true };

test('review fix P1-5: the independent path is off unless explicitly enabled', async t => {
  const app = await startApp(t);
  const s = await scenario(app, 'Mine');
  const reviewer = await scenario(app, 'Reviewer');
  new CatalogueReviewRepository(app.database).grantIndependentReviewer({ householdId: s.householdId, adultUserId: reviewer.adultId, operatorId: 'test-operator' });
  const { answerId, factId } = await answered(app, s);
  assert.equal((await catalogue(app, s, answerId, '', { token: reviewer.token })).status, 404);
  assert.equal((await review(app, s, { answerId, factId, ...attest }, { token: reviewer.token })).status, 404);
});

test('review fix P1-1: revoking an independent reviewer withdraws what their reviews supported', async t => {
  const { app, s, reviewer, repo, grant } = await independent(t);
  const { answerId, factId } = await answered(app, s);
  assert.equal((await review(app, s, { answerId, factId, ...attest }, { token: reviewer.token })).status, 201);
  assert.equal(roomRule(await catalogue(app, s, answerId)).result.status, 'known');
  assert.equal(repo.revokeGrant({ householdId: s.householdId, grantId: grant.id }), true);
  const c = await catalogue(app, s, answerId);
  assert.notEqual(roomRule(c).result.status, 'known');
  assert.equal(c.data.catalogue.reviews[0].state, 'reviewer_revoked');
  assert.equal((await review(app, s, { answerId, factId, ...attest }, { token: reviewer.token })).status, 404, 'a revoked reviewer cannot write');
});

test('review fix P1-2: a household confirmation never overrides an independent review', async t => {
  const { app, s, reviewer } = await independent(t);
  const { answerId, factId } = await answered(app, s);
  await makeConfirmer(app, s);
  assert.equal((await review(app, s, { answerId, factId, ...attest }, { token: reviewer.token })).status, 201);
  assert.equal((await review(app, s, { answerId, factId, decision: 'rejected', reasonCode: 'does_not_match_clause' })).status, 201);
  const c = await catalogue(app, s, answerId);
  assert.equal(roomRule(c).result.status, 'known', 'household rejection did not remove the independently proven fact');
  assert.deepEqual(c.data.catalogue.reviews.map(r => [r.authority, r.state]).sort(), [['household', 'superseded'], ['independent', 'accepted']]);
});

test('review fix P1-3: a closed household blocks the independent reviewer', async t => {
  const { app, s, reviewer } = await independent(t);
  const { answerId, factId } = await answered(app, s);
  app.database.prepare("UPDATE households SET status = 'closed' WHERE id = ?").run(s.householdId);
  assert.equal((await catalogue(app, s, answerId, '', { token: reviewer.token })).status, 404);
  assert.equal((await review(app, s, { answerId, factId, ...attest }, { token: reviewer.token })).status, 404);
});

test('review fix P2: bad asOf is a 400, an array source type is a 400, a household member cannot be independent', async t => {
  const { app, s, reviewer, repo } = await independent(t);
  const { answerId, factId } = await answered(app, s);
  assert.equal((await review(app, s, { answerId, factId, ...attest, asOf: 'nope' }, { token: reviewer.token })).status, 400);
  assert.equal((await review(app, s, { answerId, factId, ...attest, attestedSourceType: ['issued_schedule'] }, { token: reviewer.token })).status, 400);
  assert.throws(() => repo.grantIndependentReviewer({ householdId: s.householdId, adultUserId: s.adultId, operatorId: 'test-operator' }), /independent reviewer/);
  const events = app.database.prepare("SELECT actor_type, action FROM audit_events WHERE action LIKE 'catalogue_reviewer.%'").all();
  assert.ok(events.every(e => ['system', 'adult_user'].includes(e.actor_type)));
  assert.equal(rows(app, 'catalogue_reviews'), 0);
});

test('Phase 7 journey: upload, OCR, question, typed candidate, independent review, handoff, then revocation withdraws everything', async t => {
  const { app, s, reviewer } = await independent(t);
  const { answerId, factId } = await answered(app, s);
  const handoffOf = (token = s.token) => app.call(`/api/v1/cases/${s.caseId}/decision-catalogue?answerId=${encodeURIComponent(answerId)}&format=handoff`, { token });
  const roomItem = res => res.data.policies[0].items.find(i => i.rule === 'room_rent_limit' && i.topic === 'room rent');

  // Model-derived: a candidate only. The handoff keeps it unverified and carries no usable value.
  const first = await handoffOf();
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(first.data.handoffVersion, 'decision-handoff/v1');
  assert.equal(roomItem(first).state, 'missing');
  assert.ok(first.data.openEndedFindings.length >= 1, 'the open-ended finding survives');
  assert.equal(first.data.reviewRequired, true);
  assert.equal(first.data.policies[0].association.documents[0].status, 'candidate');
  assert.equal(first.data.policies[0].association.verified, false);

  // Independent, attested review makes the value known with its citation.
  assert.equal((await review(app, s, { answerId, factId, ...attest }, { token: reviewer.token })).status, 201);
  const known = await handoffOf();
  assert.equal(roomItem(known).state, 'known');
  assert.deepEqual(roomItem(known).value, { kind: 'amount', amountMinor: 500000, currency: 'INR', basis: 'day' });
  assert.equal(roomItem(known).citations[0].documentId, s.documentId);
  assert.equal(roomItem(known).associationVerified, true);
  assert.ok(!JSON.stringify(known.data).includes('000123') && !JSON.stringify(known.data).includes('Ishaan'));

  // Revoking the question consent: every derived read stops, and a replay of the same request is refused.
  const revoked = await app.call(`/api/v1/consents/${s.questionGrantId}/revoke`, { method: 'POST', token: s.token, body: { reason: 'journey test' } });
  assert.ok([200, 201].includes(revoked.status), JSON.stringify(revoked.data));
  assert.notEqual((await handoffOf()).status, 200);
  assert.notEqual((await handoffOf(reviewer.token)).status, 200);
  assert.equal(rows(app, 'catalogue_reviews'), 0, 'revocation erased the reviews that cited the document');
  assert.equal(rows(app, 'policy_clauses'), 0);
});
