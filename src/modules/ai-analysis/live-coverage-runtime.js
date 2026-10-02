import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createAiSdkRunner } from './ai-sdk-runner.js';
import { createAiEnhancedTaskRegistry, createAiTaskExecutors } from './runtime-adapter.js';
import { createModelGateway } from './model-gateway.js';
import { RUNTIME_AI_TASK_KEYS } from './responsibility-matrix.js';
import { createFixtureTaskRegistry } from '../coverage-analysis/task-registry.js';

const KNOWN_STATUSES = new Set(['known', 'document-backed', 'document_backed', 'institution-confirmed', 'institution_confirmed']);

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
    current.entries.push(item);
    if (sourceStatus(item.status ?? item.evidenceStatus) !== 'known') current.status = sourceStatus(item.status ?? item.evidenceStatus);
    grouped.set(source.id, current);
  }
  return [...grouped.values()].map(({ entries, ...source }) => ({ ...source, text: JSON.stringify(entries).slice(0, 4000) }));
}

const context = (runtime, purpose, requestedFields) => ({
  caseId: runtime.run.id,
  subjectId: runtime.input.profilePacket.subjectId,
  purpose,
  requestedFields: [...new Set(requestedFields)].slice(0, 40),
});

export const LIVE_REQUEST_BUILDERS = Object.freeze({
  profile(runtime) {
    const packet = runtime.input.profilePacket;
    return {
      context: context(runtime, 'Extract only requested household profile fields.', packet.requestedFields),
      sources: [{ id: packet.source.id, version: packet.source.version ?? 'unknown', page: null, text: JSON.stringify(packet.data).slice(0, 4000), status: 'known' }],
      upstream: [],
    };
  },
  group(runtime) {
    const evidence = runtime.input.groupPolicies.flatMap(policy => policy.evidence.map(item => ({ ...item, policyId: policy.policyId })));
    return { context: context(runtime, 'Extract cited group cover wording.', evidence.map(item => item.fact)), sources: groupBySource(evidence), upstream: [] };
  },
  personal(runtime) {
    const evidence = runtime.input.personalPacket.evidence;
    return { context: context(runtime, 'Extract cited personal cover wording.', evidence.map(item => item.field)), sources: groupBySource(evidence), upstream: [] };
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

export const LIVE_RESULT_ADAPTERS = Object.freeze({
  profile(output, modelMetadata, runtime) {
    const sourceById = new Map(LIVE_REQUEST_BUILDERS.profile(runtime).sources.map(source => [source.id, source]));
    return {
      subjectId: runtime.input.profilePacket.subjectId,
      profile: Object.fromEntries(output.facts.map(fact => [fact.field, { value: fact.value ?? 'UNKNOWN', status: fact.status === 'known' ? 'known' : fact.status === 'conflict' ? 'conflicting' : 'unknown', verificationStatus: 'model_extracted_unverified', source: sourceById.get(fact.citations[0]) }])),
      affordability: null,
      provenance: { profileSource: runtime.input.profilePacket.source },
      consent: structuredClone(runtime.input.profilePacket.consent),
      rejectedFields: [],
      boundaries: { policyTermsVerified: false, medicalFactsInferred: false, affordabilityAffectsCoverageTruth: false },
      ...metadata(modelMetadata),
    };
  },
  group(output, modelMetadata, runtime) {
    const request = LIVE_REQUEST_BUILDERS.group(runtime);
    const sources = new Map(request.sources.map(source => [source.id, source]));
    const policyId = runtime.input.groupPolicies[0].policyId;
    const nodes = output.facts.map(fact => ({
      id: `model-group:${fact.id}`, type: 'coverage_fact', fact: fact.field, value: fact.value, status: fact.status === 'known' ? 'document-backed' : fact.status === 'conflict' ? 'conflicting' : 'unresolved',
      citations: fact.citations.map(id => ({ sourceId: id, page: sources.get(id)?.page, version: sources.get(id)?.version })),
    }));
    return [{ agent: 'group-health-cover-agent', policyId, syntheticOnly: true, buckets: [], coverageGraph: { nodes, edges: [] }, unresolved: nodes.filter(node => node.status !== 'document-backed').map(node => node.id), issues: [], boundaries: ['Model extraction is unverified and cannot establish claim approval.'], ...metadata(modelMetadata) }];
  },
  personal(output, modelMetadata, runtime) {
    const request = LIVE_REQUEST_BUILDERS.personal(runtime);
    const sources = new Map(request.sources.map(source => [source.id, source]));
    const sections = { protection: [], constraints: [], economics: [], suitability: [] };
    for (const fact of output.facts) {
      const original = runtime.input.personalPacket.evidence.find(item => item.field === fact.field);
      const dimension = original?.dimension ?? 'suitability';
      sections[dimension].push({ id: fact.id, policyId: original?.policyId ?? 'unknown', field: fact.field, value: fact.value, status: fact.status === 'known' ? 'document_backed' : fact.status === 'conflict' ? 'conflicting' : 'unresolved', source: { id: fact.citations[0], page: sources.get(fact.citations[0])?.page, version: sources.get(fact.citations[0])?.version } });
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

export function createGeminiCoverageRegistryFactory({ env = process.env, loadModel, createAgent } = {}) {
  let project;
  return () => {
    const config = readConfig(env);
    project ||= createBudgetScope(config.projectBudgetUsd);
    const runner = createAiSdkRunner({
      loadModel: loadModel ?? (async () => createGoogleGenerativeAI({ apiKey: config.apiKey })(config.model)),
      provider: 'google', model: config.model, modelVersion: config.modelVersion,
      inputUsdPerMillion: config.inputRate, outputUsdPerMillion: config.outputRate, createAgent,
    });
    const gateway = createModelGateway({
      mode: 'live', liveRunner: runner, budget: createRunBudget(config.runBudgetUsd, project),
      limits: { maxInputBytes: config.maxInputBytes, maxOutputTokens: config.maxOutputTokens, timeoutMs: config.timeoutMs, maxRetries: 0, maxReservationUsd: config.reservationUsd, maxConcurrentCalls: config.maxConcurrentCalls },
    });
    const executors = createAiTaskExecutors({ gateway, requestBuilders: LIVE_REQUEST_BUILDERS, resultAdapters: LIVE_RESULT_ADAPTERS, reservationUsd: config.reservationUsd });
    return createAiEnhancedTaskRegistry({ baseRegistry: createFixtureTaskRegistry(), aiExecutors: executors, enabledTaskKeys: RUNTIME_AI_TASK_KEYS });
  };
}
