import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiCoverageRegistryFactory } from '../src/features/ai-analysis/live-coverage-runtime.js';
import {
  PRIVACY_EVIDENCE_GATE_VERSION,
  sanitizeEvidenceForModel,
  sanitizeEvidenceTextForStorage,
} from '../src/features/ai-analysis/privacy-evidence-gate.js';
import { RESTRICTED_PROBES, TOKENIZED_PROBES } from './support/privacy-probes.mjs';

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
    parameterRegistryVersion: 'policy-parameters/v1',
    authorizedSourceIds: ['page-sensitive-1'],
    sourcePages: [{ sourceId: 'page-sensitive-1', version: 'v1', page: 1, text: 'Room rent limit is 5000. Insured name: Asha Example; write to asha@example.test.' }],
    profilePacket: {
      subjectId: 'adult-sensitive-1',
      source: { id: 'page-sensitive-1', version: 'v1', page: 1 },
      requestedFields: ['d.room_rent_limit'],
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
    knownIdentifierLoader: () => [], preDispatchValidator: async value => { validationInput = value; return true; },
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
    knownIdentifierLoader: () => [], preDispatchValidator: async () => false,
    loadModel: async () => ({ mocked: true }),
    createAgent: () => ({ generate: async () => { modelCalls += 1; } }),
  });
  await assert.rejects(deniedFactory().profile(liveRuntime()), { code: 'MODEL_DISPATCH_AUTHORIZATION_FAILED' });
  assert.equal(modelCalls, 0);
});

const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('every direct-identifier class is tokenized out of model input and audit metadata', () => {
  const text = `${Object.values(TOKENIZED_PROBES).map(([phrase]) => phrase).join('; ')}; Room rent limit is 5000.`;
  const result = sanitizeEvidenceForModel(rawInput({ sources: [{ ...rawInput().sources[0], text }] }), { task: 'group_cover_extraction', resolveParameterPolicy: () => policy() });
  const modelBody = JSON.stringify(result.input);
  const auditBody = JSON.stringify(result.audit);
  for (const [label, [, raw, reason]] of Object.entries(TOKENIZED_PROBES)) {
    assert.doesNotMatch(modelBody, new RegExp(escapeRegExp(raw)), `${label} must not reach the model`);
    assert.doesNotMatch(auditBody, new RegExp(escapeRegExp(raw)), `${label} must not reach the audit`);
    assert.ok(result.audit.redactionReasonCodes.includes(reason), `${label} must record ${reason}`);
  }
  assert.match(modelBody, /Room rent limit is 5000/);
  assert.equal(result.audit.sources[0].dataClass, 'CONFIDENTIAL');
});

test('each direct-identifier probe is tokenized on its own, in storage and in structured upstream values', () => {
  for (const [label, [phrase, raw]] of Object.entries(TOKENIZED_PROBES)) {
    const stored = sanitizeEvidenceTextForStorage(`${phrase}. Room rent limit is 5000.`);
    assert.ok(!stored.text.includes(raw), `${label} must be removed before storage`);
    assert.ok(stored.reasonCodes.length > 0, label);
    // Re-sanitising stored text is idempotent: tokens are never re-tokenized.
    assert.equal(sanitizeEvidenceTextForStorage(stored.text).text, stored.text, `${label} must be idempotent`);
  }
  const structured = sanitizeEvidenceForModel(rawInput({
    upstream: [{ patientName: 'Ravi Synthetic', diagnosis: 'synthetic asthma', passportNumber: 'K1234567', ifscCode: 'SBIN0001234', mobile: '9876543210', note: 'Name: Meera Testcase', factId: 'UNCLASSIFIED:case-raw-123' }],
  }), { resolveParameterPolicy: () => policy() });
  const upstreamBody = JSON.stringify(structured.input.upstream);
  for (const raw of ['Ravi Synthetic', 'synthetic asthma', 'K1234567', 'SBIN0001234', '9876543210', 'Meera Testcase', 'case-raw-123']) {
    assert.ok(!upstreamBody.includes(raw), `${raw} must not reach the model from structured upstream`);
  }
});

test('policy wording that resembles identity labels stays usable for analysis', () => {
  const wording = 'Plan name: Gold Synthetic. Sum insured: 500000. In-patient: covered after admission. Pre-existing disease waiting period: 36 months. Critical illness rider is optional. Room rent limit is 5000.';
  const stored = sanitizeEvidenceTextForStorage(wording);
  assert.equal(stored.text, wording);
  assert.deepEqual(stored.reasonCodes, []);
});

test('restricted credentials, secrets and payment cards are rejected without echoing the value', () => {
  for (const [label, probe] of Object.entries(RESTRICTED_PROBES)) {
    for (const run of [
      () => sanitizeEvidenceTextForStorage(`Synthetic schedule. ${probe}. Room rent limit is 5000.`),
      () => sanitizeEvidenceForModel(rawInput({ sources: [{ ...rawInput().sources[0], text: `Synthetic schedule. ${probe}.` }] }), { resolveParameterPolicy: () => policy() }),
      () => sanitizeEvidenceForModel(rawInput({ upstream: [{ note: probe }] }), { resolveParameterPolicy: () => policy() }),
    ]) {
      assert.throws(run, error => {
        assert.equal(error.code, 'RESTRICTED_EVIDENCE', label);
        assert.equal(error.message, 'Restricted evidence cannot be sent to a model.');
        assert.ok(!JSON.stringify({ message: error.message, stack: error.stack }).includes(probe), `${label} must not be echoed`);
        return true;
      });
    }
  }
  // A Luhn-invalid 16-digit number is not treated as a card; it is tokenized instead.
  const notCard = sanitizeEvidenceTextForStorage('Reference 1234 5678 9012 3456 noted.');
  assert.ok(!notCard.text.includes('1234 5678 9012 3456'));
});

test('restricted evidence reaching the live runtime makes zero provider calls and leaks nothing', async () => {
  for (const [label, probe] of Object.entries(RESTRICTED_PROBES)) {
    let providerCalls = 0;
    let validatorCalls = 0;
    const factory = createGeminiCoverageRegistryFactory({
      env: liveEnv,
      resolveParameterPolicy: () => policy(),
      knownIdentifierLoader: () => [], preDispatchValidator: async () => { validatorCalls += 1; return true; },
      loadModel: async () => ({ mocked: true }),
      createAgent: () => ({ generate: async () => { providerCalls += 1; return {}; } }),
    });
    const runtime = liveRuntime();
    runtime.input.sourcePages[0].text = `Room rent limit is 5000 ${probe}`;
    await assert.rejects(factory().profile(runtime), error => {
      assert.equal(error.code, 'RESTRICTED_EVIDENCE', label);
      assert.ok(!String(error.message).includes(probe));
      return true;
    });
    assert.equal(providerCalls, 0, label);
    assert.equal(validatorCalls, 0, label);
  }
});
