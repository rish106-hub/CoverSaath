import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createHash } from 'node:crypto';
import { createAiSdkRunner } from './ai-sdk-runner.js';
import { createAiEnhancedTaskRegistry, createAiTaskExecutors } from './runtime-adapter.js';
import { createModelGateway } from './model-gateway.js';
import { GEMINI_MODEL_RECIPIENT, sanitizeEvidenceForModel } from './privacy-evidence-gate.js';
import { RUNTIME_AI_TASK_KEYS } from './responsibility-matrix.js';
import { createFixtureTaskRegistry } from '../coverage-analysis/task-registry.js';
import { MODEL_EXTRACTED_UNVERIFIED } from '../coverage-analysis/agent-contracts.js';
import { getPolicyParameterDefinition, getPolicyParameterRegistry } from '../coverage-analysis/policy-parameter-registry.js';

export { GEMINI_MODEL_RECIPIENT };

const KNOWN_STATUSES = new Set(['known', 'document-backed', 'document_backed', 'institution-confirmed', 'institution_confirmed']);
const RUNTIME_TASK_NAMES = Object.freeze({
  profile: 'profile_extraction',
  group: 'group_cover_extraction',
  personal: 'personal_cover_extraction',
  questions: 'question_drafting',
  primary: 'evidence_synthesis',
});

function fail(code, message) {
  throw Object.assign(new Error(message), { code, statusCode: 503 });
}

function positive(value, name, { max = Infinity, integer = false } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > max || (integer && !Number.isInteger(parsed))) fail('LIVE_AI_CONFIG_INVALID', `${name} must be configured within its safety bound.`);
  return parsed;
}

function readConfig(env) {
  if (!['google', 'gemini'].includes(env.LLM_PROVIDER)) fail('LIVE_AI_CONFIG_INVALID', 'Persistent live analysis requires LLM_PROVIDER=google.');
  const apiKey = env.GOOGLE_GENERATIVE_AI_API_KEY ?? env.GEMINI_API_KEY;
  if (typeof apiKey !== 'string' || !apiKey.trim()) fail('LIVE_AI_CONFIG_INVALID', 'A server-only Gemini API key is required.');
  if (typeof env.LLM_MODEL !== 'string' || !env.LLM_MODEL.trim()) fail('LIVE_AI_CONFIG_INVALID', 'LLM_MODEL is required.');
  const config = {
    apiKey,
    model: env.LLM_MODEL.trim(),
    modelVersion: (env.LLM_MODEL_VERSION || env.LLM_MODEL).trim(),
    inputRate: positive(env.LLM_INPUT_USD_PER_MILLION, 'LLM_INPUT_USD_PER_MILLION'),
    outputRate: positive(env.LLM_OUTPUT_USD_PER_MILLION, 'LLM_OUTPUT_USD_PER_MILLION'),
    runBudgetUsd: positive(env.ORCHESTRATION_RUN_BUDGET_USD, 'ORCHESTRATION_RUN_BUDGET_USD', { max: 1 }),
    projectBudgetUsd: positive(env.ORCHESTRATION_PROJECT_BUDGET_USD, 'ORCHESTRATION_PROJECT_BUDGET_USD'),
    maxInputBytes: positive(env.LLM_MAX_INPUT_BYTES ?? 48_000, 'LLM_MAX_INPUT_BYTES', { max: 96_000, integer: true }),
    maxOutputTokens: positive(env.LLM_MAX_OUTPUT_TOKENS ?? 1_500, 'LLM_MAX_OUTPUT_TOKENS', { max: 4_000, integer: true }),
    timeoutMs: positive(env.LLM_TIMEOUT_MS ?? 30_000, 'LLM_TIMEOUT_MS', { max: 60_000, integer: true }),
    maxConcurrentCalls: positive(env.LLM_MAX_CONCURRENT_CALLS ?? 2, 'LLM_MAX_CONCURRENT_CALLS', { max: 4, integer: true }),
  };
  config.reservationUsd = ((config.maxInputBytes * config.inputRate) + (config.maxOutputTokens * config.outputRate)) / 1_000_000;
  if (config.reservationUsd > config.runBudgetUsd) fail('LIVE_AI_CONFIG_INVALID', 'Per-call reservation exceeds the run budget.');
  return Object.freeze(config);
}

function createBudgetScope(maxUsd) {
  let reservedUsd = 0;
  let spentUsd = 0;
  let sequence = 0;
  return {
    canReserve(amount) { return spentUsd + reservedUsd + amount <= maxUsd; },
    reserve(amount, metadata) {
      if (!this.canReserve(amount)) return null;
      reservedUsd += amount;
      sequence += 1;
      return { id: `budget-${sequence}`, amountUsd: amount, metadata: structuredClone(metadata) };
    },
    settle(reservation, actualCostUsd, { failed = false } = {}) {
      if (failed || actualCostUsd === null) return;
      reservedUsd -= reservation.amountUsd;
      spentUsd += actualCostUsd;
    },
    snapshot() { return { maxUsd, reservedUsd, spentUsd, availableUsd: maxUsd - reservedUsd - spentUsd }; },
  };
}

function createRunBudget(runMaxUsd, project) {
  const run = createBudgetScope(runMaxUsd);
  return Object.freeze({
    async reserve(amount, metadata) {
      if (!run.canReserve(amount) || !project.canReserve(amount)) return null;
      const runReservation = run.reserve(amount, metadata);
      const projectReservation = project.reserve(amount, metadata);
      return { id: runReservation.id, amountUsd: amount, runReservation, projectReservation };
    },
    async settle(reservation, actualCostUsd, options = {}) {
      run.settle(reservation.runReservation, actualCostUsd, options);
      project.settle(reservation.projectReservation, actualCostUsd, options);
    },
    snapshot: () => run.snapshot(),
  });
}

function sourceStatus(status) {
  if (/conflict/i.test(status ?? '')) return 'conflict';
  return KNOWN_STATUSES.has(status) ? 'known' : 'unknown';
}

function groupBySource(items) {
  const grouped = new Map();
  for (const item of items) {
    const source = item.source ?? { id: item.id ?? item.sourceId, version: item.version, page: item.page };
    if (!source?.id) continue;
    const current = grouped.get(source.id) ?? { id: source.id, version: source.version ?? 'unknown', page: Number.isInteger(source.page) ? source.page : null, entries: [], status: 'known' };
    current.entries.push({
      field: item.field ?? item.fact,
      value: item.value,
      status: item.status ?? item.evidenceStatus,
    });
    if (sourceStatus(item.status ?? item.evidenceStatus) !== 'known') current.status = sourceStatus(item.status ?? item.evidenceStatus);
    grouped.set(source.id, current);
  }
  return [...grouped.values()].map(({ entries, ...source }) => ({ ...source, text: JSON.stringify(entries).slice(0, 4000) }));
}

// Default parameter policy: the registry version pinned by the run is the only
// authority. Unknown versions, unknown or legacy-alias keys resolve to null so the
// privacy gate fails closed (PARAMETER_NOT_CLASSIFIED). RESTRICTED /
// modelExtraction-denied parameters are returned as-is so the gate rejects them.
export function resolveCanonicalParameterPolicy(key, registryVersion) {
  if (typeof key !== 'string' || typeof registryVersion !== 'string') return null;
  let parameter;
  try {
    parameter = getPolicyParameterDefinition(registryVersion, key);
  } catch {
    return null;
  }
  return { modelExtraction: parameter.modelExtraction, dataClass: parameter.dataClass, registryVersion };
}

// The registry version is pinned in the run input at creation time. A run whose
// pin is missing or unknown cannot be dispatched to a model.
function pinnedRegistryVersion(runtime) {
  const version = runtime?.input?.parameterRegistryVersion;
  try {
    if (typeof version !== 'string') throw new TypeError('missing');
    getPolicyParameterRegistry(version);
  } catch {
    fail('PARAMETER_REGISTRY_VERSION_UNKNOWN', 'The run does not pin a known parameter registry version.');
  }
  return version;
}

const context = (runtime, purpose, requestedFields) => ({
  caseId: runtime.run.id,
  subjectId: runtime.input.profilePacket.subjectId,
  purpose,
  requestedFields: [...new Set(requestedFields)].slice(0, 40),
});

// One model source per sent OCR page, each with its own id, version and page
// number, so a citation always resolves to the page (and document) it came from.
// Page text is stored once on the run (sourcePages); evidence descriptors only
// name parameters, so text is never repeated per parameter.
function pageSources(runtime) {
  const pages = runtime.input.sourcePages;
  if (!Array.isArray(pages) || pages.length === 0) fail('SOURCE_PAGES_REQUIRED', 'The run does not carry any sanitised source pages.');
  return pages.map(page => ({
    id: page.sourceId,
    version: page.version ?? 'unknown',
    page: Number.isInteger(page.page) ? page.page : null,
    text: page.text,
    status: 'known',
  }));
}

export const LIVE_REQUEST_BUILDERS = Object.freeze({
  profile(runtime) {
    const packet = runtime.input.profilePacket;
    return {
      context: context(runtime, 'Extract only requested household profile fields.', packet.requestedFields),
      sources: pageSources(runtime),
      upstream: [],
    };
  },
  group(runtime) {
    const evidence = runtime.input.groupPolicies.flatMap(policy => policy.evidence);
    return { context: context(runtime, 'Extract cited group cover wording.', evidence.map(item => item.fact)), sources: pageSources(runtime), upstream: [] };
  },
  personal(runtime) {
    const evidence = runtime.input.personalPacket.evidence;
    return { context: context(runtime, 'Extract cited personal cover wording.', evidence.map(item => item.field)), sources: pageSources(runtime), upstream: [] };
  },
  questions(runtime) {
    const sources = groupBySource(runtime.upstream.coverage.facts.flatMap(fact => (fact.sources ?? []).map(source => ({ ...source, status: fact.status, fact: fact.field ?? fact.fact, value: fact.value }))));
    return { context: context(runtime, 'Draft questions for the institution with authority.', []), sources, upstream: [runtime.upstream.decision] };
  },
  primary(runtime) {
    const entries = Object.entries(runtime.upstream).map(([key, value]) => ({
      id: `upstream:${key}`,
      version: runtime.run.workflow_version ?? runtime.run.workflowVersion,
      page: null,
      text: JSON.stringify(value).slice(0, 4000),
      status: 'known',
    }));
    return { context: context(runtime, 'Summarise reviewed evidence without changing deterministic decisions.', []), sources: entries, upstream: [] };
  },
});

const metadata = value => ({ modelMetadata: structuredClone(value) });

// Criteria 6 and 11: whatever the model reports as 'known' is only a candidate.
// It is carried as model_extracted_unverified (evidence state Unknown) and is never
// mapped to document-backed / Proven. Model-reported conflicts stay conflicting.
function modelFactStatus(modelStatus, unresolvedStatus) {
  if (modelStatus === 'known') return MODEL_EXTRACTED_UNVERIFIED;
  return modelStatus === 'conflict' ? 'conflicting' : unresolvedStatus;
}

// Every cited source, resolved to the sanitized request entry it came from.
function citedSources(citations, sourceById) {
  return citations.map(id => ({ id, page: sourceById.get(id)?.page ?? null, version: sourceById.get(id)?.version }));
}

export const LIVE_RESULT_ADAPTERS = Object.freeze({
  profile(output, modelMetadata, runtime, safeRequest) {
    const sourceById = new Map((safeRequest ?? LIVE_REQUEST_BUILDERS.profile(runtime)).sources.map(source => [source.id, source]));
    return {
      subjectId: runtime.input.profilePacket.subjectId,
      // A model-extracted value is never 'known' or document-backed: it stays
      // unverified until deterministic code or a human reviewer resolves it.
      profile: Object.fromEntries(output.facts.map(fact => {
        const sources = citedSources(fact.citations, sourceById);
        return [fact.field, { value: fact.value ?? 'UNKNOWN', status: modelFactStatus(fact.status, 'unknown'), verificationStatus: MODEL_EXTRACTED_UNVERIFIED, source: sources[0], sources }];
      })),
      affordability: null,
      provenance: { profileSource: runtime.input.profilePacket.source },
      consent: structuredClone(runtime.input.profilePacket.consent),
      rejectedFields: [],
      boundaries: { policyTermsVerified: false, medicalFactsInferred: false, affordabilityAffectsCoverageTruth: false },
      ...metadata(modelMetadata),
    };
  },
  group(output, modelMetadata, runtime, safeRequest) {
    const request = safeRequest ?? LIVE_REQUEST_BUILDERS.group(runtime);
    const sources = new Map(request.sources.map(source => [source.id, source]));
    const policyId = runtime.input.groupPolicies[0].policyId;
    const nodes = output.facts.map(fact => ({
      id: `model-group:${fact.id}`, type: 'coverage_fact', fact: fact.field, value: fact.value, status: modelFactStatus(fact.status, 'unresolved'), verificationStatus: MODEL_EXTRACTED_UNVERIFIED,
      citations: fact.citations.map(id => ({ sourceId: id, page: sources.get(id)?.page, version: sources.get(id)?.version })),
    }));
    return [{ agent: 'group-health-cover-agent', policyId, syntheticOnly: true, buckets: [], coverageGraph: { nodes, edges: [] }, unresolved: nodes.filter(node => node.status !== MODEL_EXTRACTED_UNVERIFIED).map(node => node.id), issues: [], boundaries: ['Model extraction is unverified and cannot establish claim approval.'], ...metadata(modelMetadata) }];
  },
  personal(output, modelMetadata, runtime, safeRequest) {
    const request = safeRequest ?? LIVE_REQUEST_BUILDERS.personal(runtime);
    const sources = new Map(request.sources.map(source => [source.id, source]));
    const sections = { protection: [], constraints: [], economics: [], suitability: [] };
    for (const fact of output.facts) {
      const original = runtime.input.personalPacket.evidence.find(item => item.field === fact.field);
      const dimension = original?.dimension ?? 'suitability';
      const cited = citedSources(fact.citations, sources);
      sections[dimension].push({ id: fact.id, policyId: original?.policyId ?? 'unknown', field: fact.field, value: fact.value, status: modelFactStatus(fact.status, 'unresolved'), verificationStatus: MODEL_EXTRACTED_UNVERIFIED, source: cited[0], sources: cited });
    }
    return {
      agent: 'personal-health-cover-agent', version: 'personal-health-agent-v1', scope: 'model-assisted synthetic evidence extraction',
      dimensions: {
        protection: { assertions: sections.protection }, constraints: { assertions: sections.constraints },
        economics: { assertions: sections.economics, affordabilityConclusion: null },
        suitability: { classification: 'evidence_gaps_and_questions', assertions: sections.suitability, evidenceGaps: output.facts.filter(fact => fact.status !== 'known').map(fact => ({ field: fact.field, reason: `${fact.field} remains unresolved.`, question: `What authoritative record confirms ${fact.field}?` })), questions: [], ignoredCriticalEvidence: [], regulatedProductRecommendation: null },
      }, boundaries: ['No product recommendation is issued.'], ...metadata(modelMetadata),
    };
  },
  questions(output, modelMetadata) { return { ...structuredClone(output), ...metadata(modelMetadata) }; },
  primary(output, modelMetadata, runtime) {
    const reviews = ['evidence', 'privacy', 'safety'].map(key => runtime.upstream[key]);
    const blockers = reviews.flatMap(review => review.status === 'blocked' ? review.findings : []);
    return {
      status: blockers.length ? 'blocked' : 'ready', route: runtime.upstream.decision.route,
      unknowns: [...runtime.upstream.decision.unknowns], blockers,
      questions: structuredClone(runtime.upstream.questions.questions), summary: output.summary,
      householdAction: structuredClone(runtime.upstream.householdAction),
      modelStatements: structuredClone(output.statements), modelUnknowns: structuredClone(output.unknowns),
      ...metadata(modelMetadata),
    };
  },
});

function evidenceRequestKey(task, input) {
  return createHash('sha256').update(`${task}\n${JSON.stringify(input)}`, 'utf8').digest('hex');
}

function createPreDispatchAuthorization(preDispatchValidator) {
  // Live dispatch without a current-consent re-check is never allowed.
  if (typeof preDispatchValidator !== 'function') fail('LIVE_AI_CONFIG_INVALID', 'A pre-dispatch consent validator is required for live model dispatch.');
  const pending = new Map();
  return Object.freeze({
    register(task, input, runtime, audit) {
      const key = evidenceRequestKey(task, input);
      pending.delete(key);
      pending.set(key, {
        task,
        runId: runtime.run.id,
        caseId: runtime.run.case_id ?? runtime.run.caseId ?? runtime.run.id,
        subjectId: runtime.input.profilePacket.subjectId,
        authorizedSourceIds: [...new Set(runtime.input.authorizedSourceIds ?? [])],
        authorizedSources: (runtime.input.authorizedSources ?? []).map(source => ({ sourceId: source?.sourceId, documentId: source?.documentId })),
        modelRecipient: GEMINI_MODEL_RECIPIENT,
        sourceDigests: audit.sources.map(source => ({ sourceId: source.sourceId, digest: source.digest })),
      });
      if (pending.size > 1_000) pending.delete(pending.keys().next().value);
    },
    async validate(request) {
      const key = evidenceRequestKey(request.task, request.input);
      const authorization = pending.get(key);
      pending.delete(key);
      if (!authorization) fail('MODEL_DISPATCH_AUTHORIZATION_FAILED', 'Current evidence authorization could not be verified before model dispatch.');
      let decision;
      try {
        decision = await preDispatchValidator(structuredClone(authorization));
      } catch {
        fail('MODEL_DISPATCH_AUTHORIZATION_FAILED', 'Current evidence authorization could not be verified before model dispatch.');
      }
      if (!(decision === true || decision?.allowed === true)) {
        fail('MODEL_DISPATCH_AUTHORIZATION_FAILED', 'Current evidence authorization could not be verified before model dispatch.');
      }
    },
  });
}

// Defence in depth after schema validation: every source id a model cites must
// exactly equal an opaque id from the sanitized request for this task. No
// trimming, case folding or prefix matching, so look-alike ids, ids of denied
// documents and ids from another case never resolve to a source.
function assertExactSourceCitations(output, safeRequest) {
  const allowed = new Set(safeRequest.sources.map(source => source.id));
  const cited = [
    ...(output?.facts ?? []).flatMap(item => item?.citations ?? []),
    ...(output?.statements ?? []).flatMap(item => item?.citations ?? []),
    ...(output?.unknowns ?? []).flatMap(item => item?.citations ?? []),
    ...(output?.questions ?? []).flatMap(item => item?.citations ?? []),
    ...(output?.unresolvedSourceIds ?? []),
  ];
  if (cited.some(id => typeof id !== 'string' || !allowed.has(id))) {
    fail('SOURCE_ALIAS_REJECTED', 'A model citation does not match an authorized source.');
  }
}

function privacySafeAdapters({ resolveParameterPolicy, preDispatchAuthorization, privacyLimits } = {}) {
  const requestCache = new WeakMap();
  const resolver = resolveParameterPolicy ?? resolveCanonicalParameterPolicy;
  const requestBuilders = Object.fromEntries(Object.entries(LIVE_REQUEST_BUILDERS).map(([runtimeKey, build]) => [runtimeKey, async runtime => {
    const task = RUNTIME_TASK_NAMES[runtimeKey];
    // Parameters resolve against the registry version this run pinned at creation.
    const registryVersion = pinnedRegistryVersion(runtime);
    const safe = sanitizeEvidenceForModel(build(runtime), { task, resolveParameterPolicy: key => resolver(key, registryVersion), limits: privacyLimits });
    preDispatchAuthorization.register(task, safe.input, runtime, safe.audit);
    const current = requestCache.get(runtime) ?? new Map();
    current.set(runtimeKey, safe.input);
    requestCache.set(runtime, current);
    return safe.input;
  }]));
  const resultAdapters = Object.fromEntries(Object.entries(LIVE_RESULT_ADAPTERS).map(([runtimeKey, adapt]) => [runtimeKey, (output, modelMetadata, runtime) => {
    const safeRequest = requestCache.get(runtime)?.get(runtimeKey);
    if (!safeRequest) fail('PRIVACY_GATE_MALFORMED', 'Sanitized evidence is missing from the live model boundary.');
    assertExactSourceCitations(output, safeRequest);
    return adapt(output, modelMetadata, runtime, safeRequest);
  }]));
  return { requestBuilders: Object.freeze(requestBuilders), resultAdapters: Object.freeze(resultAdapters) };
}

export function createGeminiCoverageRegistryFactory({ env = process.env, loadModel, createAgent, resolveParameterPolicy, preDispatchValidator, privacyLimits } = {}) {
  let project;
  return () => {
    const config = readConfig(env);
    project ||= createBudgetScope(config.projectBudgetUsd);
    const preDispatchAuthorization = createPreDispatchAuthorization(preDispatchValidator);
    const modelRunner = createAiSdkRunner({
      loadModel: loadModel ?? (async () => createGoogleGenerativeAI({ apiKey: config.apiKey })(config.model)),
      provider: 'google', model: config.model, modelVersion: config.modelVersion,
      inputUsdPerMillion: config.inputRate, outputUsdPerMillion: config.outputRate, createAgent,
    });
    // Every provider call is preceded by a fresh current-consent check.
    // Known limit: the check happens once, immediately before the provider call.
    // A revocation that lands while that call is in flight cannot be prevented
    // (the request has already left the process). The late result is not
    // committed: the persistent worker re-checks the run's coverage consent grant
    // after the call returns and before completing any task, and stops the run if
    // it was revoked. That commit-time check covers the run-level grant only, not
    // per-document document_processing grants (see handoff).
    const runner = async request => {
      await preDispatchAuthorization.validate(request);
      return modelRunner(request);
    };
    const gateway = createModelGateway({
      mode: 'live', liveRunner: runner, budget: createRunBudget(config.runBudgetUsd, project),
      limits: { maxInputBytes: config.maxInputBytes, maxOutputTokens: config.maxOutputTokens, timeoutMs: config.timeoutMs, maxRetries: 0, maxReservationUsd: config.reservationUsd, maxConcurrentCalls: config.maxConcurrentCalls },
    });
    const adapters = privacySafeAdapters({ resolveParameterPolicy, preDispatchAuthorization, privacyLimits });
    const executors = createAiTaskExecutors({ gateway, requestBuilders: adapters.requestBuilders, resultAdapters: adapters.resultAdapters, reservationUsd: config.reservationUsd });
    return createAiEnhancedTaskRegistry({ baseRegistry: createFixtureTaskRegistry(), aiExecutors: executors, enabledTaskKeys: RUNTIME_AI_TASK_KEYS });
  };
}
