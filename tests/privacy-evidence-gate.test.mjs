import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiCoverageRegistryFactory } from '../src/modules/ai-analysis/live-coverage-runtime.js';
import {
  PRIVACY_EVIDENCE_GATE_VERSION,
  sanitizeEvidenceForModel,
  sanitizeEvidenceTextForStorage,
} from '../src/modules/ai-analysis/privacy-evidence-gate.js';

const policy = (overrides = {}) => ({
  dataClass: 'CONFIDENTIAL',
  modelExtraction: { allowed: true, maximumResolutionState: 'extracted_unverified' },
  registryVersion: 'policy-parameters/v1',
  ...overrides,
});

const rawInput = (overrides = {}) => ({
  context: {
    caseId: 'case-private-123',
    subjectId: 'adult-private-456',
    purpose: 'Extract requested policy facts.',
    requestedFields: ['d.room_rent_limit'],
  },
  sources: [{
    id: 'page-private-789',
    version: 'v1',
    page: 3,
    text: 'Patient name: Asha Example; email asha@example.test; phone +91 9876543210; PAN ABCDE1234F; Aadhaar 1234 5678 9012. Room limit is 5000.',
    status: 'known',
  }],
  upstream: [{ sourceId: 'page-private-789', reviewerEmail: 'reviewer@example.test' }],
  ...overrides,
});

test('privacy gate tokenizes direct identifiers and exposes only digest-based audit metadata', () => {
  const result = sanitizeEvidenceForModel(rawInput(), { task: 'group_cover_extraction', resolveParameterPolicy: () => policy() });
  const modelBody = JSON.stringify(result.input);
  const auditBody = JSON.stringify(result.audit);

  for (const prohibited of ['case-private-123', 'adult-private-456', 'page-private-789', 'Asha Example', 'asha@example.test', '9876543210', 'ABCDE1234F', '1234 5678 9012', 'reviewer@example.test']) {
    assert.doesNotMatch(modelBody, new RegExp(prohibited.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(auditBody, new RegExp(prohibited.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.equal(result.audit.gateVersion, PRIVACY_EVIDENCE_GATE_VERSION);
  assert.equal(result.audit.decision, 'allowed');
  assert.match(result.input.context.caseId, /^case_[a-f0-9]{24}$/);
  assert.match(result.input.context.subjectId, /^subject_[a-f0-9]{24}$/);
  assert.match(result.input.sources[0].id, /^source_[a-f0-9]{24}$/);
  assert.match(result.audit.sources[0].digest, /^[a-f0-9]{64}$/);
  assert.ok(result.audit.redactionReasonCodes.includes('DIRECT_IDENTIFIER_EMAIL'));
  assert.ok(result.audit.redactionReasonCodes.includes('DIRECT_IDENTIFIER_PHONE'));
  assert.ok(result.audit.redactionReasonCodes.includes('DIRECT_IDENTIFIER_STRUCTURED_ID'));
});

test('storage sanitizer removes deterministic identifiers before persistence and rejects restricted text', () => {
  const raw = 'Member name: Asha Example; asha@example.test; +91 9876543210; policy number: POL-12345. ' + 'X'.repeat(80);
  const result = sanitizeEvidenceTextForStorage(raw, { maxBytes: 96 });
  assert.doesNotMatch(result.text, /Asha Example|asha@example\.test|9876543210|POL-12345/);
  assert.match(result.digest, /^[a-f0-9]{64}$/);
  assert.ok(result.reasonCodes.includes('DIRECT_IDENTIFIER_EMAIL'));
  assert.equal(result.truncated, true);
  assert.equal(Object.hasOwn(result, 'sourceId'), false);
  assert.throws(() => sanitizeEvidenceTextForStorage('password=not-a-real-secret-value'), { code: 'RESTRICTED_EVIDENCE' });
  assert.throws(() => sanitizeEvidenceTextForStorage(null), { code: 'PRIVACY_GATE_MALFORMED' });
});

test('privacy gate rejects restricted classification, credentials, payment cards, and model-disallowed parameters', () => {
  assert.throws(
    () => sanitizeEvidenceForModel(rawInput(), { resolveParameterPolicy: () => policy({ dataClass: 'RESTRICTED' }) }),
    { code: 'RESTRICTED_EVIDENCE' },
  );
  assert.throws(
    () => sanitizeEvidenceForModel(rawInput({ sources: [{ ...rawInput().sources[0], text: 'client_secret=not-a-real-secret-value' }] }), { resolveParameterPolicy: () => policy() }),
    { code: 'RESTRICTED_EVIDENCE' },
  );
  assert.throws(
    () => sanitizeEvidenceForModel(rawInput({ sources: [{ ...rawInput().sources[0], text: 'Payment card 4111 1111 1111 1111' }] }), { resolveParameterPolicy: () => policy() }),
    { code: 'RESTRICTED_EVIDENCE' },
  );
  assert.throws(
    () => sanitizeEvidenceForModel(rawInput(), { resolveParameterPolicy: () => policy({ modelExtraction: { allowed: false } }) }),
    { code: 'PARAMETER_MODEL_DISALLOWED' },
  );
  assert.throws(
    () => sanitizeEvidenceForModel(rawInput(), { resolveParameterPolicy: () => null }),
    { code: 'PARAMETER_NOT_CLASSIFIED' },
  );
  assert.throws(
    () => sanitizeEvidenceForModel(rawInput()),
    { code: 'PARAMETER_POLICY_REQUIRED' },
  );
});

test('privacy gate bounds excerpts and rejects source, upstream, and total byte overflow', () => {
  const truncated = sanitizeEvidenceForModel(rawInput({
    sources: [{ ...rawInput().sources[0], text: 'A'.repeat(100) }],
  }), {
    resolveParameterPolicy: () => policy(),
    limits: { maxSourceBytes: 24 },
  });
  assert.equal(Buffer.byteLength(truncated.input.sources[0].text, 'utf8'), 24);
  assert.ok(truncated.audit.sources[0].redactionReasonCodes.includes('TEXT_TRUNCATED'));

  assert.throws(() => sanitizeEvidenceForModel(rawInput({ sources: [rawInput().sources[0], { ...rawInput().sources[0], id: 'page-2' }] }), {
    resolveParameterPolicy: () => policy(),
    limits: { maxSources: 1 },
  }), { code: 'EVIDENCE_SOURCE_LIMIT' });
  assert.throws(() => sanitizeEvidenceForModel(rawInput({ sources: [{ ...rawInput().sources[0], text: 'C'.repeat(100) }] }), {
    resolveParameterPolicy: () => policy(),
    limits: { maxRawSourceBytes: 32 },
  }), { code: 'EVIDENCE_SOURCE_LIMIT' });
  assert.throws(() => sanitizeEvidenceForModel(rawInput({ upstream: [{ note: 'B'.repeat(200) }] }), {
    resolveParameterPolicy: () => policy(),
    limits: { maxUpstreamBytes: 32 },
  }), { code: 'EVIDENCE_UPSTREAM_LIMIT' });
  assert.throws(() => sanitizeEvidenceForModel(rawInput(), {
    resolveParameterPolicy: () => policy(),
    limits: { maxTotalBytes: 128 },
  }), { code: 'EVIDENCE_TOTAL_LIMIT' });
});

test('privacy gate fails closed for malformed inputs and unsupported fields', () => {
  assert.throws(() => sanitizeEvidenceForModel(null, { resolveParameterPolicy: () => policy() }), { code: 'PRIVACY_GATE_MALFORMED' });
  assert.throws(() => sanitizeEvidenceForModel(rawInput({ sources: [{ ...rawInput().sources[0], rawMetadata: 'not allowed' }] }), { resolveParameterPolicy: () => policy() }), { code: 'PRIVACY_GATE_MALFORMED' });
  assert.throws(() => sanitizeEvidenceForModel(rawInput({ sources: [{ ...rawInput().sources[0], status: 'withheld' }] }), { resolveParameterPolicy: () => policy() }), { code: 'PRIVACY_GATE_MALFORMED' });
  assert.throws(() => sanitizeEvidenceForModel(rawInput({ context: { ...rawInput().context, requestedFields: ['invalid field'] } }), { resolveParameterPolicy: () => policy() }), { code: 'PRIVACY_GATE_MALFORMED' });
});

const liveEnv = {
  LLM_PROVIDER: 'google',
  GEMINI_API_KEY: 'test-only-not-a-real-key',
  LLM_MODEL: 'mock-gemini',
  LLM_MODEL_VERSION: 'mock-gemini-v1',
  LLM_INPUT_USD_PER_MILLION: '0.75',
  LLM_OUTPUT_USD_PER_MILLION: '4.50',
  ORCHESTRATION_RUN_BUDGET_USD: '0.25',
  ORCHESTRATION_PROJECT_BUDGET_USD: '5',
};

const liveRuntime = () => ({
  run: { id: 'run-sensitive-1', caseId: 'case-sensitive-1', workflowVersion: '4' },
  input: {
    authorizedSourceIds: ['page-sensitive-1'],
    profilePacket: {
      subjectId: 'adult-sensitive-1',
      source: { id: 'page-sensitive-1', version: 'v1' },
      requestedFields: ['d.room_rent_limit'],
      data: { roomRentLimit: '5000', memberName: 'Asha Example', contactEmail: 'asha@example.test' },
      consent: { status: 'granted' },
    },
  },
  upstream: {},
});

test('live runtime dispatches only sanitized evidence and runs the injected authorization check immediately before the provider', async () => {
  let providerInput;
  let validationInput;
  const factory = createGeminiCoverageRegistryFactory({
    env: liveEnv,
    resolveParameterPolicy: () => policy(),
    preDispatchValidator: async value => { validationInput = value; return true; },
    loadModel: async () => ({ mocked: true }),
    createAgent: () => ({
      generate: async ({ prompt }) => {
        providerInput = JSON.parse(prompt);
        return {
          output: { facts: [{ id: 'fact-1', field: 'd.room_rent_limit', value: '5000', status: 'known', citations: [providerInput.sources[0].id] }], summary: 'A source-linked limit was extracted.' },
          totalUsage: { inputTokens: 10, outputTokens: 5 },
        };
      },
    }),
  });
  const result = await factory().profile(liveRuntime());
  const providerBody = JSON.stringify(providerInput);
  assert.doesNotMatch(providerBody, /Asha Example|asha@example\.test|adult-sensitive-1|page-sensitive-1|case-sensitive-1/);
  assert.equal(validationInput.task, 'profile_extraction');
  assert.deepEqual(validationInput.authorizedSourceIds, ['page-sensitive-1']);
  assert.equal(Object.hasOwn(validationInput, 'text'), false);
  assert.match(validationInput.sourceDigests[0].digest, /^[a-f0-9]{64}$/);
  assert.match(result.profile['d.room_rent_limit'].source.id, /^source_[a-f0-9]{24}$/);

  let modelCalls = 0;
  const deniedFactory = createGeminiCoverageRegistryFactory({
    env: liveEnv,
    resolveParameterPolicy: () => policy(),
    preDispatchValidator: async () => false,
    loadModel: async () => ({ mocked: true }),
    createAgent: () => ({ generate: async () => { modelCalls += 1; } }),
  });
  await assert.rejects(deniedFactory().profile(liveRuntime()), { code: 'MODEL_DISPATCH_AUTHORIZATION_FAILED' });
  assert.equal(modelCalls, 0);
});
