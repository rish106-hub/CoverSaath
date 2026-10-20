import test from 'node:test';
import assert from 'node:assert/strict';
import { AI_CONTRACT_VERSION, PROMPT_VERSION, createModelGateway } from '../src/features/ai-analysis/index.js';
import { INVESTIGATION_LIMITS, buildClauses, checklistFor, investigate } from '../src/features/policy-evidence/index.js';
import { QUESTION_CONSENT_SCOPE } from '../src/contracts/policy-evidence.js';
import { validateAnswer } from '../src/contracts/index.js';
import { createPolicyEvidenceService } from '../src/backend/services/policy-evidence-service.js';

// Synthetic policies only. Budgets must follow the gateway limit the call states, and nothing authorised is dropped silently.
const QUESTION = 'Is cataract surgery covered?';
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const firstSkeleton = { questions: [{ text: QUESTION }], checklist: checklistFor(QUESTION), clauses: [] };

function policy(pages, { documentId = 'doc-1', words = 40 } = {}) {
  const filler = Array.from({ length: words }, (_, index) => `term${index}`).join(' ');
  const stored = { pages: Array.from({ length: pages }, (_, index) => ({ page: index + 1, status: 'stored', blocks: [
    { tag: 'section-title', text: `Section ${index + 1}` },
    { tag: 'paragraph', text: `Clause ${index + 1}: we will pay for cataract surgery as a hospitalisation benefit. ${filler}` },
  ] })) };
  return buildClauses(stored, { documentId, sourceVersion: 'v1' }).clauses;
}
const wireBytes = list => list.reduce((sum, clause) => sum + bytes({ clause_id: clause.clauseId, document_id: clause.documentId, page: clause.page, kind: clause.kind, title: clause.sectionPath?.[0] ?? null, text: clause.text }) + 1, 0);

const metadata = { contractVersion: AI_CONTRACT_VERSION, mode: 'fixture', provider: 'fixture', model: 'fixture', modelVersion: '1', promptVersion: PROMPT_VERSION, inputTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0, latencyMs: 0, costUsd: 0 };
const citeFirst = ({ input }) => ({ output: { findings: [{ clause_ids: [input.payload.clauses[0].clause_id], quote: 'cataract surgery', subject: 'cataract surgery', conditions: [], exceptions: [] }] }, metadata });

/** The real gateway in fixture mode, wrapped the way structuring-runtime wraps it, so its input limit is enforced. */
function gatewayCall(maxInputBytes, { first = citeFirst, second = () => ({ output: { overrides: [] }, metadata }), sizes = [] } = {}) {
  const gateway = createModelGateway({ mode: 'fixture', limits: { maxInputBytes, maxReservationUsd: 0 }, fixtures: {
    policy_evidence_investigate: first, policy_evidence_override_sweep: second,
  } });
  return Object.assign(async ({ task, payload }) => {
    sizes.push({ task, bytes: bytes(payload), clauses: payload.clauses.length });
    const result = await gateway.execute({ task, input: { payload }, reservationUsd: 0 });
    return { json: result.output, usage: { inputTokens: 0, outputTokens: 0 } };
  }, { maxInputBytes });
}
const ask = (clauses, call, extra = {}) => investigate({ question: QUESTION, clauses, call, consentCheck: async () => {}, search: () => [], ...extra });

test('S1: a policy that fits the first-pass budget exactly is read whole and the gateway accepts it', async () => {
  const clauses = policy(20);
  const exact = wireBytes(clauses) + INVESTIGATION_LIMITS.payloadMarginBytes + bytes(firstSkeleton);
  const sizes = [];
  const { answer, contextPath } = await ask(clauses, gatewayCall(exact, { sizes }));
  assert.equal(contextPath, 'whole_policy');
  assert.equal(answer.overrides_checked.at(-1).status, 'completed', 'the sweep also fits');
  assert.ok(sizes.every(entry => entry.bytes <= exact));
  assert.equal(answer.completeness.clausesNotRead, 0);
  assert.deepEqual(validateAnswer(answer), []);
});

test('S1: one byte over the first-pass budget takes the retrieved path and the gateway still accepts it', async () => {
  const clauses = policy(20);
  const cap = wireBytes(clauses) + INVESTIGATION_LIMITS.payloadMarginBytes + bytes(firstSkeleton) - 1;
  const sizes = [];
  const { answer, contextPath } = await ask(clauses, gatewayCall(cap, { sizes }), { search: ({ kinds }) => clauses.filter(clause => !kinds || kinds.includes(clause.kind)) });
  assert.equal(contextPath, 'retrieved');
  assert.ok(sizes.length >= 1 && sizes.every(entry => entry.bytes <= cap));
  assert.ok(answer.completeness.clausesNotRead > 0);
  assert.ok(answer.unknowns.some(text => /reading budget/.test(text)));
  assert.equal(answer.state, 'conditional');
});

test('S1: a policy between the gateway limit and the old 80 KB budget is no longer sent whole and rejected', async () => {
  const clauses = policy(140, { words: 50 });
  const size = wireBytes(clauses);
  assert.ok(size > 64_000 && size < 80_000, `fixture size ${size} must sit in the gap`);
  const sizes = [];
  const { contextPath } = await ask(clauses, gatewayCall(64_000, { sizes }), { search: ({ kinds }) => clauses.filter(clause => !kinds || kinds.includes(clause.kind)) });
  assert.equal(contextPath, 'retrieved');
  assert.ok(sizes.every(entry => entry.bytes <= 64_000));
});

test('S1: the sweep has its own budget; many findings shrink it, cited clauses stay and drops are reported', async () => {
  const clauses = policy(60);
  const cap = wireBytes(clauses) + INVESTIGATION_LIMITS.payloadMarginBytes + bytes(firstSkeleton);
  const cited = clauses.slice(0, 30).map(clause => clause.clauseId);
  const first = () => ({ output: { findings: cited.map(id => ({ clause_ids: [id], quote: 'we will pay for cataract surgery', subject: 'cataract surgery as a hospitalisation benefit for the insured member', conditions: [], exceptions: [] })) }, metadata });
  const sizes = [];
  const sent = [];
  const second = ({ input }) => { sent.push(...input.payload.clauses.map(clause => clause.clause_id)); return { output: { overrides: [] }, metadata }; };
  const { answer, contextPath } = await ask(clauses, gatewayCall(cap, { first, second, sizes }));
  assert.equal(contextPath, 'whole_policy');
  const sweep = sizes.find(entry => entry.task === 'policy_evidence_override_sweep');
  assert.ok(sweep && sweep.bytes <= cap, 'sweep payload fits the gateway');
  assert.ok(cited.every(id => sent.includes(id)), 'every cited clause reaches the sweep');
  assert.ok(answer.completeness.sweepClausesDropped > 0);
  assert.equal(answer.completeness.sweepTruncated, true);
  assert.equal(answer.completeness.clausesNotRead, 0, 'dropped from the sweep is not unread: the first pass read them');
  assert.ok(answer.unknowns.some(text => /overriding or conflicting clauses could not read every candidate/.test(text)));
});

test('S1: budgets follow the stated gateway limit, and the smaller of call and caller limits wins', async () => {
  const clauses = policy(150, { words: 50 });
  const wide = await ask(clauses, gatewayCall(96_000));
  assert.equal(wide.contextPath, 'whole_policy');
  const sizes = [];
  const narrow = await ask(clauses, gatewayCall(96_000, { sizes }), { limits: { maxInputBytes: 8_000 }, search: ({ kinds }) => clauses.filter(clause => !kinds || kinds.includes(clause.kind)) });
  assert.equal(narrow.contextPath, 'retrieved');
  assert.ok(sizes.every(entry => entry.bytes <= 8_000));
});

test('S1: no payload carries more clauses than the gateway array bound', async () => {
  const clauses = policy(520, { words: 2 });
  const sizes = [];
  const { answer } = await ask(clauses, gatewayCall(96_000, { sizes }), { search: ({ kinds }) => clauses.filter(clause => !kinds || kinds.includes(clause.kind)) });
  assert.ok(sizes.every(entry => entry.clauses <= INVESTIGATION_LIMITS.maxClausesPerCall));
  assert.ok(answer.completeness.clausesNotRead > 0);
});

test('S1: a payload over the limit is a coded budget defect, never a provider error', async () => {
  const clauses = policy(3);
  await assert.rejects(ask(clauses, gatewayCall(200)), { code: 'INVESTIGATION_BUDGET_EXCEEDED' });
});

// Service-level: consent filtering first, then the document limit, and every unread authorised document is reported.
function serviceWorld({ total, granted, incomplete = new Set() }) {
  const documents = Array.from({ length: total }, (_, index) => ({ id: `doc-${index}`, lifecycleState: 'active' }));
  const scope = id => ({ resource_type: QUESTION_CONSENT_SCOPE.resourceType, resource_id: id, action: QUESTION_CONSENT_SCOPE.action, data_category: QUESTION_CONSENT_SCOPE.dataCategory, recipient: QUESTION_CONSENT_SCOPE.recipient });
  const saved = new Map();
  const page = { page: 1, status: 'stored', blocks: [{ tag: 'section-title', text: 'Eye Benefits' }, { tag: 'paragraph', text: 'We will pay for cataract surgery as a hospitalisation benefit.' }] };
  const services = {
    documents: { listForCase: () => documents },
    consents: {
      requireActive: (_grant, { resourceId }) => { if (!granted.has(resourceId)) throw Object.assign(new Error('x'), { code: 'CONSENT_SCOPE_REQUIRED' }); },
      get: () => ({ household_id: 'h', scopes: [...granted].map(scope) }),
    },
    ocr: { getDocumentBlockPages: ({ documentId }) => (incomplete.has(documentId) ? { complete: false } : { complete: true, sourceVersion: 'v1', pages: [page] }) },
    clauses: {
      findAnswerByKey: () => null,
      clauseDocumentIds: () => [...saved.keys()],
      saveClauses: ({ documentId, clauses }) => saved.set(documentId, clauses),
      listClauses: ({ documentIds }) => documentIds.flatMap(id => saved.get(id) ?? []),
      searchClauses: () => [],
      saveAnswer: ({ answer }) => ({ answer }),
    },
  };
  const payloads = [];
  const createModelCall = () => Object.assign(async ({ task, payload }) => {
    payloads.push({ task, payload });
    if (task === 'policy_evidence_investigate') return { json: { findings: [{ clause_ids: [payload.clauses[0].clause_id], quote: 'cataract surgery', subject: 'cataract', conditions: [], exceptions: [] }] } };
    return { json: { overrides: [] } };
  }, { maxInputBytes: 64_000 });
  const service = createPolicyEvidenceService({ services, loadKnownIdentifiers: async () => [], createModelCall, env: { POLICY_EVIDENCE_ENABLED: 'true' } });
  const askService = documentIds => service.ask({ caseRecord: { id: 'c', household_id: 'h' }, subjectAdultId: 'a', question: QUESTION, consentGrantId: 'g', idempotencyKey: 'idem-key-0001', documentIds });
  return { askService, payloads };
}

// D2 (2026-10-20): several current documents are read together only when the request names them (at most 10).
test('S1: several authorised documents need documentIds; 10 named documents are all read', async () => {
  const { askService, payloads } = serviceWorld({ total: 14, granted: new Set(Array.from({ length: 12 }, (_, index) => `doc-${index + 2}`)) });
  await assert.rejects(askService(), { code: 'POLICY_EVIDENCE_DOCUMENTS_REQUIRED' });
  assert.equal(payloads.length, 0, 'nothing is sent without a named document set');
  await assert.rejects(askService(['doc-0', 'doc-2']), { code: 'CONSENT_SCOPE_REQUIRED' }, 'an unauthorised named document fails the request');
  const { answer } = await askService(Array.from({ length: 10 }, (_, index) => `doc-${index + 2}`));
  const sentDocuments = new Set(payloads[0].payload.clauses.map(clause => clause.document_id));
  assert.equal(sentDocuments.size, 10);
  assert.ok(!sentDocuments.has('doc-0') && !sentDocuments.has('doc-1'), 'unauthorised documents are never read');
  assert.equal(answer.completeness.documentsAuthorised, 12, 'unauthorised documents are not counted');
  assert.equal(answer.completeness.documentsRead, 10);
  assert.deepEqual(answer.completeness.documentsExcluded, [{ reason: 'not_named', count: 2 }]);
  assert.ok(answer.unknowns.some(text => /^2 authorised document\(s\) were not read because the request did not name them/.test(text)));
  assert.equal(answer.state, 'conditional');
  assert.doesNotMatch(answer.unknowns.join(' '), /doc-/, 'no document identifiers in unknowns');
});

test('S1: an authorised document without complete stored text is reported, not skipped silently', async () => {
  const { askService } = serviceWorld({ total: 2, granted: new Set(['doc-0', 'doc-1']), incomplete: new Set(['doc-1']) });
  const { answer } = await askService(['doc-0', 'doc-1']);
  assert.deepEqual(answer.completeness.documentsExcluded, [{ reason: 'ocr_incomplete', count: 1 }]);
  assert.equal(answer.completeness.documentsAuthorised, 2);
  assert.equal(answer.completeness.documentsRead, 1);
  assert.notEqual(answer.state, 'evidence_found');
  assert.ok(answer.unknowns.some(text => /stored text is incomplete/.test(text)));
});

test('S1: investigate refuses an exclusion with an unknown reason or count', async () => {
  await assert.rejects(ask(policy(2), gatewayCall(64_000), { documentScope: { authorised: 3, excluded: [{ reason: 'whatever', count: 1 }] } }), { code: 'INVESTIGATION_INPUT_INVALID' });
  await assert.rejects(ask(policy(2), gatewayCall(64_000), { documentScope: { authorised: 3, excluded: [{ reason: 'not_found', count: 0 }] } }), { code: 'INVESTIGATION_INPUT_INVALID' });
});

test('S1 review: findings citing more than the sweep can carry skip the sweep and report it, without failing the question', async () => {
  const clauses = policy(60);
  const cap = wireBytes(clauses) + INVESTIGATION_LIMITS.payloadMarginBytes + bytes(firstSkeleton);
  const first = () => ({ output: { findings: clauses.map(clause => ({ clause_ids: [clause.clauseId], quote: 'we will pay for cataract surgery', subject: 'cataract surgery as a hospitalisation benefit for the insured member', conditions: [], exceptions: [] })) }, metadata });
  const sizes = [];
  const { answer } = await ask(clauses, gatewayCall(cap, { first, sizes }));
  assert.ok(!sizes.some(entry => entry.task === 'policy_evidence_override_sweep'), 'no oversized sweep is sent');
  assert.equal(answer.completeness.sweepOverBudget, true);
  assert.equal(answer.overrides_checked.at(-1).status, 'not_completed');
  assert.equal(answer.state, 'conditional');
  assert.ok(answer.unknowns.some(text => /than one override check can read/.test(text)));
});

test('S1 review: the pre-call guard catches a payload over the limit as a coded defect', async () => {
  const clauses = policy(30);
  await assert.rejects(ask(clauses, gatewayCall(2_000), { limits: { payloadMarginBytes: -5_000 }, search: ({ kinds }) => clauses.filter(clause => !kinds || kinds.includes(clause.kind)) }), { code: 'INVESTIGATION_BUDGET_EXCEEDED' });
});

test('S1 review: an empty retrieved context makes no model call and is insufficient evidence', async () => {
  const clauses = policy(20);
  const sizes = [];
  const { answer, contextPath } = await ask(clauses, gatewayCall(2_000, { sizes }), { search: () => [] });
  assert.equal(contextPath, 'retrieved');
  assert.equal(sizes.length, 0);
  assert.equal(answer.state, 'insufficient_evidence');
  assert.equal(answer.overrides_checked.at(-1).status, 'not_completed', 'nothing was read, so nothing was checked');
  assert.deepEqual(validateAnswer(answer), []);
});

test('S1 review: a document whose clauses were all withheld is reported, so read plus excluded equals authorised', async () => {
  const restricted = buildClauses({ pages: [{ page: 1, status: 'stored', blocks: [
    { tag: 'section-title', text: 'Billing' }, { tag: 'paragraph', text: 'Credit card number 4111 1111 1111 1111 is on file for cataract premium.' },
  ] }] }, { documentId: 'doc-2', sourceVersion: 'v1' }).clauses;
  const { answer } = await ask([...policy(2), ...restricted], gatewayCall(64_000));
  assert.equal(answer.completeness.clausesWithheld, restricted.length, 'fixture premise: every doc-2 clause is withheld');
  const { documentsAuthorised, documentsRead, documentsExcluded } = answer.completeness;
  assert.deepEqual(documentsExcluded, [{ reason: 'not_in_context', count: 1 }]);
  assert.equal(documentsRead + documentsExcluded.reduce((sum, entry) => sum + entry.count, 0), documentsAuthorised);
  assert.equal(answer.state, 'conditional');
});

test('S1 review: a consent refusal during the first pass keeps its code', async () => {
  const revoked = async () => { throw Object.assign(new Error('revoked'), { code: 'CONSENT_REVOKED' }); };
  await assert.rejects(investigate({ question: QUESTION, clauses: policy(2), call: gatewayCall(64_000), consentCheck: revoked }), { code: 'CONSENT_REVOKED' });
});

test('S2 review: clauses stored under an older classifier are reclassified at read time', async () => {
  const stale = buildClauses({ pages: [{ page: 1, status: 'stored', blocks: [
    { tag: 'section-title', text: 'Approvals' }, { tag: 'paragraph', text: 'Cataract surgery is payable subject to prior approval.' },
  ] }] }, { documentId: 'doc-1', sourceVersion: 'v1' }).clauses.map(clause => ({ ...clause, kind: 'other' }));
  const { answer } = await ask(stale, gatewayCall(64_000));
  assert.ok(answer.overrides_checked.find(entry => entry.kind === 'condition').clauseIds.length === 1);
  assert.ok(!answer.unknowns.some(text => /No condition clause/.test(text)));
});
