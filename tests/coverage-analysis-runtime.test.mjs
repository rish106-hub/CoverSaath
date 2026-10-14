import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_CONTRACT_VERSION,
  COVERAGE_ANALYSIS_WORKFLOW,
  POLICY_DECOMPOSITION,
  createCoverageAnalysisRuntime,
  createFixtureTaskRegistry,
  createPersistentCoverageAnalysisService,
  decomposePolicySection,
  validateTaskOutputEnvelope,
} from '../src/modules/coverage-analysis/index.js';
import { sanitizeEvidenceForModel } from '../src/modules/ai-analysis/privacy-evidence-gate.js';
import { ANALYSIS_DAG } from '../src/server/routes/v1-backend-routes.js';

const clone = value => structuredClone(value);

class MemoryCoverageAnalysisPort {
  constructor(snapshot = []) { this.records = new Map(snapshot.map(run => [run.id, clone(run)])); }
  async createRun(run) {
    if (this.records.has(run.id)) throw new Error('Run already exists.');
    this.records.set(run.id, clone(run));
    return clone(run);
  }
  async loadRun(id) { return this.records.has(id) ? clone(this.records.get(id)) : null; }
  async replaceRun(run, { expectedRevision }) {
    const current = this.records.get(run.id);
    if (!current || current.revision !== expectedRevision) throw new Error('Stale run revision.');
    this.records.set(run.id, clone(run));
    return clone(run);
  }
  snapshot() { return [...this.records.values()].map(clone); }
  async revoke(id) {
    const run = this.records.get(id);
    run.status = 'revoked';
    run.revision += 1;
  }
}

const input = ({ authorizedSourceIds = ['profile-source', 'group-source', 'personal-source'] } = {}) => ({
  consent: true,
  trigger: 'renewal',
  statedEstimate: 0,
  authorizedSourceIds,
  profilePacket: {
    subjectId: 'adult-1',
    source: { type: 'manual', id: 'profile-source', reporterId: 'adult-1', version: 'fixture-v1', location: 'intake' },
    requestedFields: ['displayName'],
    consent: { id: 'consent-1', subjectId: 'adult-1', status: 'granted', purpose: 'profile_intake', sources: ['manual'], fields: ['displayName'] },
    data: { displayName: 'Fixture Adult' },
  },
  groupPolicies: [{ policyId: 'FIXTURE-GROUP', evidence: [{ fact: 'room_rent_limit', value: 5000, sourceId: 'group-source', page: 3, version: 'fixture-v1', evidenceStatus: 'document-backed' }] }],
  personalPacket: { synthetic: true, consent: true, evidence: [{ id: 'personal-copay', policyId: 'FIXTURE-PERSONAL', dimension: 'constraints', field: 'copay', value: '10% of eligible expenses', status: 'document_backed', source: { id: 'personal-source', page: 5, version: 'fixture-v1' } }] },
});

async function setup(options = {}) {
  const port = new MemoryCoverageAnalysisPort();
  const runtime = createCoverageAnalysisRuntime({ port, ...options });
  const run = await runtime.createRun({ id: 'run-1', caseId: 'case-1', input: input() });
  return { port, runtime, run };
}

test('canonical workflow names every executable task with explicit versioned contracts and dependencies', () => {
  assert.equal(COVERAGE_ANALYSIS_WORKFLOW.tasks.length, 22);
  assert.equal(COVERAGE_ANALYSIS_WORKFLOW.version, '5');
  assert.deepEqual(COVERAGE_ANALYSIS_WORKFLOW.tasks.find(task => task.key === 'coverage').dependsOn, ['profile', 'group', 'personal']);
  assert.deepEqual(COVERAGE_ANALYSIS_WORKFLOW.tasks.find(task => task.key === 'primary').dependsOn, ['decision', 'householdAction', 'evidence', 'privacy', 'safety', 'questions']);
  assert.ok(COVERAGE_ANALYSIS_WORKFLOW.tasks.every(task => task.inputSchema.endsWith('/input/v1') && task.outputSchema.endsWith('/output/v1')));
  const registry = createFixtureTaskRegistry();
  assert.ok(COVERAGE_ANALYSIS_WORKFLOW.tasks.every(task => typeof registry[task.key] === 'function'));
  assert.deepEqual(
    Object.fromEntries(COVERAGE_ANALYSIS_WORKFLOW.tasks.map(task => [task.key, task.owner])),
    Object.fromEntries(COVERAGE_ANALYSIS_WORKFLOW.tasks.map(task => [task.key, ['profile', 'group', 'personal', 'questions', 'primary'].includes(task.key) ? 'model_assist' : 'deterministic'])),
  );
});

test('persisted API DAG derives from canonical workflow definition', () => {
  assert.deepEqual(
    ANALYSIS_DAG.map(task => ({ key: task.key, taskKind: task.taskKind, dependsOn: task.dependsOn })),
    COVERAGE_ANALYSIS_WORKFLOW.tasks.map(task => ({ key: task.key, taskKind: task.kind, dependsOn: task.dependsOn })),
  );
  assert.ok(ANALYSIS_DAG.every(task => task.agentName && task.inputSchema && task.outputSchema));
});

test('policy decomposition preserves the full coverage inventory and surfaces absent criteria as gaps', () => {
  const coverage = {
    facts: [
      { id: 'room-rule', field: 'room_rent_limit', value: 'single private room', status: 'document_backed', source: { id: 'schedule', page: 3, version: 'v1' } },
      { id: 'ped-rule', field: 'PED_waiting_period', value: '36 months', status: 'document_backed', source: { id: 'wording', page: 12, version: 'v1' } },
      { id: 'network', field: 'dated_network_status', value: 'listed', status: 'institution_confirmed', source: { id: 'network-result', page: '2026-10-02', version: 'current' } },
    ],
  };

  const financial = decomposePolicySection('financialRules', coverage);
  const exclusions = decomposePolicySection('exclusions', coverage);
  const access = decomposePolicySection('hospitalAccess', coverage);

  assert.equal(financial.facts.find(fact => fact.field === 'room_rent_limit')?.value, 'single private room');
  assert.equal(exclusions.facts.find(fact => fact.field === 'PED_waiting_period')?.value, '36 months');
  assert.equal(access.facts.find(fact => fact.field === 'dated_network_status')?.value, 'listed');
  assert.ok(financial.facts.some(fact => fact.field === 'restoration_rules' && fact.evidenceState === 'Unknown'));
  assert.ok(exclusions.facts.some(fact => fact.field === 'disclosure_and_misrepresentation' && fact.evidenceState === 'Unknown'));
  assert.ok(access.facts.some(fact => fact.field === 'estimate_and_deposit' && fact.evidenceState === 'Unknown'));
  assert.ok(Object.entries(POLICY_DECOMPOSITION)
    .filter(([key]) => key !== 'householdAction')
    .every(([, definition]) => Array.isArray(definition.criteria) && definition.criteria.length > 0));
});

test('policy decomposition matches structured field names exactly and rejects withheld facts before analysis', () => {
  const coverage = {
    facts: [{ id: 'billing-note', field: 'capped_charge', value: 'not a PED rule', status: 'document_backed', source: { id: 'estimate', page: 1, version: 'v1' } }],
  };
  const exclusions = decomposePolicySection('exclusions', coverage);
  assert.ok(exclusions.facts.some(fact => fact.field === 'ped_waiting_period' && fact.evidenceState === 'Unknown'));
  assert.ok(!exclusions.facts.some(fact => fact.field === 'capped_charge'));

  assert.throws(
    () => decomposePolicySection('financialRules', {
      facts: [{ id: 'restricted', field: 'copay', value: '20%', status: 'withheld', source: { id: 'protected-schedule', page: 2, version: 'v1' } }],
    }),
    /Permission-restricted facts must not enter coverage decomposition/,
  );
});

test('persistent coverage worker scopes every claim to its requested run and workflow', async () => {
  const claims = [];
  const job = {
    id: 'run-requested',
    status: 'queued',
    workflow_name: COVERAGE_ANALYSIS_WORKFLOW.name,
    consent_grant_id: 'consent-1',
  };
  const port = {
    getCase: async () => null,
    requireCoverageConsent: async () => null,
    findIdempotency: async () => null,
    recordIdempotency: async () => null,
    createRunWithTasks: async () => null,
    getCoverageSourcePages: async () => [],
    getJob: async runId => runId === job.id ? job : null,
    getTask: async () => null,
    claimNext: async claim => { claims.push(claim); return null; },
    dependencyOutputs: async () => ({}),
    completeTask: async () => null,
    failTask: async () => null,
    recoverExpiredLeases: async () => null,
    isConsentActive: async () => true,
    stopForRevocation: async () => null,
    persistTaskArtifact: async () => null,
  };
  const service = createPersistentCoverageAnalysisService({ port, workerId: 'coverage-worker' });

  await service.runUntilSettled(job.id);

  assert.deepEqual(claims, [{
    workerId: 'coverage-worker',
    runId: job.id,
    workflowName: COVERAGE_ANALYSIS_WORKFLOW.name,
  }]);
});

test('multi-parent tasks wait and receive upstream outputs', async () => {
  const events = [];
  const base = createFixtureTaskRegistry();
  const registry = Object.fromEntries(Object.entries(base).map(([key, execute]) => [key, async context => {
    events.push({ key, upstream: Object.keys(context.upstream) });
    return execute(context);
  }]));
  const { runtime } = await setup({ registry });
  await runtime.runUntilSettled('run-1');
  const coverage = events.find(event => event.key === 'coverage');
  const primary = events.find(event => event.key === 'primary');
  assert.deepEqual(coverage.upstream.sort(), ['group', 'personal', 'profile']);
  assert.deepEqual(primary.upstream.sort(), ['decision', 'evidence', 'householdAction', 'privacy', 'questions', 'safety']);
  assert.ok(events.findIndex(event => event.key === 'coverage') > events.findIndex(event => event.key === 'personal'));
  assert.ok(events.findIndex(event => event.key === 'primary') > events.findIndex(event => event.key === 'safety'));
});

test('deterministic evidence review blocks release for an unauthorised source', async () => {
  const port = new MemoryCoverageAnalysisPort();
  const runtime = createCoverageAnalysisRuntime({ port });
  await runtime.createRun({ id: 'blocked-run', caseId: 'case-1', input: input({ authorizedSourceIds: ['profile-source', 'personal-source'] }) });
  const run = await runtime.runUntilSettled('blocked-run');
  assert.equal(run.status, 'blocked');
  assert.equal(run.tasks.evidence.output.payload.status, 'blocked');
  assert.equal(run.tasks.release.output.payload.status, 'blocked');
  assert.equal(run.result.externalActionsAuthorized, false);
});

test('revocation stops all unclaimed work without executing a task', async () => {
  let executions = 0;
  const base = createFixtureTaskRegistry();
  const registry = Object.fromEntries(Object.entries(base).map(([key, execute]) => [key, context => { executions += 1; return execute(context); }]));
  const { port, runtime } = await setup({ registry });
  await port.revoke('run-1');
  const run = await runtime.tick('run-1');
  assert.equal(run.status, 'revoked');
  assert.equal(executions, 0);
  assert.ok(Object.values(run.tasks).every(task => task.status === 'cancelled'));
});

test('a new runtime reconstructs and completes a partially persisted run', async () => {
  const { port, runtime } = await setup();
  const partial = await runtime.tick('run-1');
  assert.equal(partial.tasks.profile.status, 'completed');
  assert.equal(partial.tasks.coverage.status, 'pending');

  const restartedPort = new MemoryCoverageAnalysisPort(port.snapshot());
  const restartedRuntime = createCoverageAnalysisRuntime({ port: restartedPort });
  const complete = await restartedRuntime.runUntilSettled('run-1');
  assert.equal(complete.status, 'completed');
  assert.equal(complete.tasks.release.output.payload.status, 'released');
  assert.ok(complete.tasks.coverage.output.payload.facts.length > 0);
});

test('a claimed fixture task is recovered once after process interruption', async () => {
  const { port } = await setup();
  const persisted = await port.loadRun('run-1');
  persisted.status = 'running';
  persisted.tasks.profile.status = 'running';
  persisted.tasks.profile.attempts = 1;
  persisted.revision += 1;
  port.records.set(persisted.id, clone(persisted));

  const runtime = createCoverageAnalysisRuntime({ port });
  const settled = await runtime.runUntilSettled('run-1');
  assert.equal(settled.status, 'completed');
  assert.equal(settled.tasks.profile.attempts, 2);
});

test('every canonical agent emits a validated handoff envelope with provenance and one evidence state', async () => {
  const { runtime } = await setup();
  const run = await runtime.runUntilSettled('run-1');
  assert.equal(run.status, 'completed');
  for (const definition of COVERAGE_ANALYSIS_WORKFLOW.tasks) {
    const envelope = run.tasks[definition.key].output;
    assert.equal(envelope.contractVersion, AGENT_CONTRACT_VERSION);
    assert.equal(envelope.schemas.input, definition.inputSchema);
    assert.equal(envelope.schemas.output, definition.outputSchema);
    assert.equal(envelope.provenance.runId, run.id);
    assert.equal(envelope.provenance.caseId, run.caseId);
    assert.ok(Array.isArray(envelope.provenance.sourceRefs));
    assert.doesNotThrow(() => validateTaskOutputEnvelope(definition.key, envelope));
  }
  assert.ok(run.tasks.questions.output.payload.questions.length > 0);
  assert.ok(run.tasks.primary.output.payload.questions.length > 0);
  assert.equal(run.tasks.release.output.payload.externalActionsAuthorized, false);
});

test('invalid agent output fails closed before any downstream task can consume it', async () => {
  const registry = { ...createFixtureTaskRegistry(), group: () => ({ unstructured: true }) };
  const { runtime } = await setup({ registry });
  const run = await runtime.runUntilSettled('run-1');
  assert.equal(run.status, 'blocked');
  assert.equal(run.tasks.group.status, 'blocked');
  assert.match(run.tasks.group.error, /Group output must be an array/);
  assert.equal(run.tasks.coverage.status, 'pending');
  assert.equal(run.result.blockers[0].code, 'TASK_FAILED');
});

// Independent derivation of the opaque id the privacy gate shows the model.
const opaqueSourceId = rawId => sanitizeEvidenceForModel({
  context: { caseId: 'review-case', subjectId: 'review-subject', purpose: 'Derive opaque id.', requestedFields: [] },
  sources: [{ id: rawId, version: 'v1', page: null, text: 'synthetic', status: 'known' }],
  upstream: [],
}).input.sources[0].id;

const citedFact = sourceId => ({ id: 'fact-1', field: 'd.room_rent_limit', status: 'document-backed', sources: [{ id: sourceId, page: 1, version: '1' }] });
const reviewContext = (sourceId, inputOverrides = {}) => ({
  input: {
    consent: true,
    authorizedSourceIds: ['page-authorised'],
    authorizedSources: [{ sourceId: 'page-authorised', documentId: 'document-authorised' }],
    ...inputOverrides,
  },
  upstream: { coverage: { facts: [citedFact(sourceId)] } },
});
const reviewCodes = outcome => outcome.findings.map(finding => finding.code);

test('deterministic review maps opaque citation ids back to exactly the run authorised sources', () => {
  const registry = createFixtureTaskRegistry();
  const opaque = opaqueSourceId('page-authorised');
  assert.match(opaque, /^source_[a-f0-9]{24}$/);
  for (const key of ['evidence', 'privacy']) {
    assert.deepEqual(registry[key](reviewContext(opaque)), { status: 'passed', findings: [] }, `${key} accepts the exact opaque id`);
    assert.equal(registry[key](reviewContext('page-authorised')).status, 'passed', `${key} still accepts the raw authorised id`);
  }
});

test('deterministic review fails closed for unmapped, foreign, denied, look-alike and unpaired citation ids', () => {
  const registry = createFixtureTaskRegistry();
  const authorised = opaqueSourceId('page-authorised');
  const cases = {
    'unmapped opaque id': `source_${'0'.repeat(24)}`,
    'id from another run or case': opaqueSourceId('page-other-run'),
    'denied document page': opaqueSourceId('page-denied'),
    'raw id of a denied document': 'page-denied',
    'truncated look-alike': authorised.slice(0, -1),
    'extended look-alike': `${authorised}0`,
    'case-changed look-alike': authorised.toUpperCase(),
    'prefix-swapped look-alike': authorised.replace('source_', 'Source_'),
    'padded look-alike': ` ${authorised}`,
    'empty id': '',
  };
  for (const [label, sourceId] of Object.entries(cases)) {
    const evidence = registry.evidence(reviewContext(sourceId));
    assert.equal(evidence.status, 'blocked', label);
    assert.ok(reviewCodes(evidence).includes('SOURCE_NOT_AUTHORIZED'), label);
    const privacy = registry.privacy(reviewContext(sourceId));
    assert.equal(privacy.status, 'blocked', label);
    assert.ok(reviewCodes(privacy).includes('UNSCOPED_SOURCE'), label);
  }
  // A run that did not persist authorised source pairs (fixture runs) never gets opaque-id mapping.
  const { authorizedSources, ...withoutPairs } = reviewContext(authorised).input;
  assert.ok(reviewCodes(registry.evidence({ ...reviewContext(authorised), input: withoutPairs })).includes('SOURCE_NOT_AUTHORIZED'));
  // A source that is authorised by id but not paired to a document is not mapped either.
  const unpaired = reviewContext(authorised, { authorizedSources: [{ sourceId: 'page-denied', documentId: 'document-denied' }] });
  assert.ok(reviewCodes(registry.evidence(unpaired)).includes('SOURCE_NOT_AUTHORIZED'));
  assert.ok(reviewCodes(registry.privacy(unpaired)).includes('UNSCOPED_SOURCE'));
  // Nothing authorised means nothing is accepted.
  assert.ok(reviewCodes(registry.evidence(reviewContext(authorised, { authorizedSourceIds: [], authorizedSources: [] }))).includes('SOURCE_NOT_AUTHORIZED'));
});

test('deterministic evidence review requires human review for model-extracted facts and reports excluded or unsent sources', () => {
  const registry = createFixtureTaskRegistry();
  const withFact = (status, inputOverrides = {}) => ({
    ...reviewContext('page-authorised', inputOverrides),
    upstream: { coverage: { facts: [{ id: 'fact-1', field: 'd.room_rent_limit', status, sources: [{ id: 'page-authorised', page: 1, version: '1' }] }] } },
  });
  // Model-extracted facts are unverified candidates: review-required, not releasable.
  const unverified = registry.evidence(withFact('model_extracted_unverified'));
  assert.equal(unverified.status, 'blocked');
  assert.deepEqual(unverified.findings, [{ code: 'HUMAN_REVIEW_REQUIRED', reasonCode: 'model_extracted_unverified', factId: 'fact-1' }]);
  // Source authorisation is a separate, independent check and still passes.
  assert.equal(registry.privacy(withFact('model_extracted_unverified')).status, 'passed');
  // Deterministic document-backed evidence is not affected.
  assert.deepEqual(registry.evidence(withFact('document-backed')), { status: 'passed', findings: [] });
  // Excluded and unsent sources surface as findings with opaque ids and reason codes only.
  const blockers = [
    { code: 'SOURCE_EXCLUDED', reasonCode: 'RESTRICTED_EVIDENCE', documentId: 'opaque-document-1', pageCount: 2 },
    { code: 'SOURCE_NOT_SENT', reasonCode: 'REQUEST_BUDGET_EXCEEDED', documentId: 'opaque-document-2', pageCount: 9 },
  ];
  const reported = registry.evidence(withFact('document-backed', { sourceBlockers: blockers }));
  assert.equal(reported.status, 'blocked');
  assert.deepEqual(reported.findings, blockers.map(({ code, reasonCode, documentId }) => ({ code, reasonCode, documentId })));
});

test('the coverage graph keeps every model-extracted fact as an explicit unknown', () => {
  const registry = createFixtureTaskRegistry();
  const graph = registry.coverage({
    input: {},
    upstream: {
      profile: { profile: {} },
      group: [{ policyId: 'policy-1', unresolved: [], coverageGraph: { nodes: [{ id: 'n-1', type: 'coverage_fact', fact: 'd.room_rent_limit', value: '5000', status: 'model_extracted_unverified', citations: [{ sourceId: 'page-authorised', page: 1, version: '1' }] }] } }],
      personal: { dimensions: { suitability: { evidenceGaps: [] }, protection: { assertions: [] }, constraints: { assertions: [] }, economics: { assertions: [] } } },
    },
  });
  assert.deepEqual(graph.unknowns, ['d.room_rent_limit is model-extracted and awaits review.']);
});
