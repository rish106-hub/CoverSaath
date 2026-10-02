import { createHash } from 'node:crypto';
import { taskDefinition } from './workflow-definition.js';
import { inputSchemaId, outputSchemaId } from './contract-ids.js';

export const AGENT_CONTRACT_VERSION = 'knowvia-agent-contract-v1';
export const EVIDENCE_STATES = Object.freeze(['Proven', 'Calculated', 'Reported', 'Dynamic', 'Unknown', 'Conflicting']);

const clone = value => structuredClone(value);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function fail(message) {
  throw Object.assign(new TypeError(message), { code: 'AGENT_CONTRACT_INVALID' });
}

function requireObject(value, label) {
  if (!isObject(value)) fail(`${label} must be an object.`);
}

function requireArray(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array.`);
}

const payloadValidators = Object.freeze({
  profile(output) {
    requireObject(output, 'Profile output');
    requireObject(output.profile, 'Profile facts');
    requireObject(output.provenance, 'Profile provenance');
    requireObject(output.consent, 'Profile consent');
  },
  group(output) {
    requireArray(output, 'Group output');
    if (output.length === 0) fail('Group output must contain at least one policy analysis.');
    output.forEach(item => {
      requireObject(item, 'Group policy analysis');
      requireObject(item.coverageGraph, 'Group coverage graph');
      requireArray(item.coverageGraph.nodes, 'Group coverage nodes');
      requireArray(item.unresolved, 'Group unresolved facts');
    });
  },
  personal(output) {
    requireObject(output, 'Personal output');
    requireObject(output.dimensions, 'Personal dimensions');
    for (const key of ['protection', 'constraints', 'economics', 'suitability']) requireObject(output.dimensions[key], `Personal ${key}`);
  },
  coverage(output) {
    requireObject(output, 'Coverage graph output');
    if (output.kind !== 'source_linked_household_coverage_graph') fail('Coverage graph kind is invalid.');
    requireArray(output.facts, 'Coverage facts');
    requireArray(output.unknowns, 'Coverage unknowns');
    requireArray(output.boundaries, 'Coverage boundaries');
  },
  documentIdentity: validateDecomposition,
  continuity: validateDecomposition,
  enrolment: validateDecomposition,
  financialRules: validateDecomposition,
  benefits: validateDecomposition,
  exclusions: validateDecomposition,
  hospitalAccess: validateDecomposition,
  claimsProcess: validateDecomposition,
  renewalChange: validateDecomposition,
  serviceResearch: validateDecomposition,
  decision(output) {
    requireObject(output, 'Decision output');
    if (output.kind !== 'deterministic_routing_classification' || output.probabilityOfApproval !== null) fail('Decision authority boundary is invalid.');
    requireObject(output.dimensions, 'Decision dimensions');
    requireArray(output.unknowns, 'Decision unknowns');
  },
  evidence: validateReview,
  privacy: validateReview,
  safety: validateReview,
  questions(output) {
    requireObject(output, 'Question output');
    requireArray(output.questions, 'Questions');
    requireArray(output.unresolvedSourceIds, 'Unresolved source ids');
    for (const question of output.questions) {
      requireObject(question, 'Question');
      if (typeof question.text !== 'string' || !question.text.endsWith('?')) fail('Every drafted question must be explicit and answerable.');
      if (typeof question.authorityOwner !== 'string' || !question.authorityOwner) fail('Every drafted question needs an authority owner.');
      requireArray(question.citations, 'Question citations');
    }
  },
  householdAction(output) {
    validateDecomposition(output);
    requireObject(output.recommendation, 'Household action recommendation');
    if (output.recommendation.authority !== 'human_household_decision_required' || output.recommendation.externalActionsAuthorized !== false) {
      fail('Household action authority boundary is invalid.');
    }
    requireArray(output.recommendation.unresolved, 'Household action unresolved facts');
  },
  primary(output) {
    requireObject(output, 'Primary output');
    if (!['ready', 'blocked'].includes(output.status)) fail('Primary status is invalid.');
    requireArray(output.unknowns, 'Primary unknowns');
    requireArray(output.blockers, 'Primary blockers');
    requireArray(output.questions, 'Primary questions');
    requireObject(output.householdAction, 'Primary household action');
  },
  release(output) {
    requireObject(output, 'Release output');
    if (!['released', 'blocked'].includes(output.status) || output.externalActionsAuthorized !== false) fail('Release authority boundary is invalid.');
    requireArray(output.blockers, 'Release blockers');
  },
});

function validateReview(output) {
  requireObject(output, 'Review output');
  if (!['passed', 'blocked'].includes(output.status)) fail('Review status is invalid.');
  requireArray(output.findings, 'Review findings');
}

function validateDecomposition(output) {
  requireObject(output, 'Policy decomposition output');
  if (!/^[A-K]$/.test(output.section) || typeof output.responsibility !== 'string' || !output.responsibility) fail('Policy decomposition identity is invalid.');
  requireArray(output.facts, 'Policy decomposition facts');
  if (output.facts.length === 0) fail('Policy decomposition must preserve an explicit evidence gap.');
  requireArray(output.boundaries, 'Policy decomposition boundaries');
  for (const fact of output.facts) {
    requireObject(fact, 'Policy decomposition fact');
    if (typeof fact.id !== 'string' || !fact.id || typeof fact.field !== 'string' || !fact.field) fail('Policy decomposition fact identity is invalid.');
    if (!Object.prototype.hasOwnProperty.call(fact, 'value') || !EVIDENCE_STATES.includes(fact.evidenceState)) fail('Policy decomposition fact evidence state is invalid.');
    requireObject(fact.provenance, 'Policy decomposition fact provenance');
    const required = ['sourceId', 'document', 'version', 'page', 'clause', 'confidence', 'effectiveDate', 'humanCorrected'];
    if (required.some(key => !Object.prototype.hasOwnProperty.call(fact.provenance, key))) fail('Policy decomposition fact provenance is incomplete.');
    if (fact.provenance.confidence !== null && (!Number.isFinite(fact.provenance.confidence) || fact.provenance.confidence < 0 || fact.provenance.confidence > 1)) fail('Policy decomposition fact confidence is invalid.');
    if (typeof fact.provenance.humanCorrected !== 'boolean') fail('Policy decomposition correction marker is invalid.');
    if (fact.evidenceState !== 'Unknown' && !fact.provenance.sourceId && fact.evidenceState !== 'Calculated') fail('Source evidence is required for a supported policy fact.');
  }
}

function collectSourceRefs(value, refs = new Map(), parentKey = '') {
  if (Array.isArray(value)) {
    value.forEach(item => collectSourceRefs(item, refs, parentKey));
    return refs;
  }
  if (!isObject(value)) return refs;
  const sourceId = typeof value.sourceId === 'string'
    ? value.sourceId
    : ['source', 'sources', 'citations', 'provenance'].includes(parentKey) && typeof value.id === 'string'
      ? value.id
      : null;
  if (sourceId) {
    const reference = {
      id: sourceId,
      version: typeof value.version === 'string' ? value.version : null,
      page: value.page ?? value.location ?? null,
      clause: value.clause ?? null,
      confidence: Number.isFinite(value.confidence) ? value.confidence : null,
      effectiveDate: value.effectiveDate ?? null,
      humanCorrected: value.humanCorrected === true,
    };
    refs.set(JSON.stringify(reference), reference);
  }
  for (const [key, child] of Object.entries(value)) collectSourceRefs(child, refs, key);
  return refs;
}

function evidenceStateFor(key, payload) {
  if (['decision', 'documentIdentity', 'continuity', 'enrolment', 'financialRules', 'benefits', 'exclusions', 'hospitalAccess', 'claimsProcess', 'renewalChange', 'serviceResearch', 'householdAction', 'evidence', 'privacy', 'safety', 'questions', 'primary', 'release'].includes(key)) return 'Calculated';
  const body = JSON.stringify(payload).toLowerCase();
  if (/conflict/.test(body)) return 'Conflicting';
  if (/unknown|unresolved|unverified/.test(body)) return 'Unknown';
  if (/user.stated|proxy.reported|reported/.test(body)) return 'Reported';
  if (/institution.confirmed|dynamic/.test(body)) return 'Dynamic';
  return 'Proven';
}

export function validateTaskInvocation(key, { input, upstream }) {
  const definition = taskDefinition(key);
  if (!definition) fail(`Unknown workflow task: ${key}.`);
  requireObject(input, `${key} root input`);
  requireObject(upstream, `${key} upstream input`);
  const actual = Object.keys(upstream).sort();
  const expected = [...definition.dependsOn].sort();
  if (actual.length !== expected.length || actual.some((item, index) => item !== expected[index])) {
    fail(`${key} received incompatible upstream dependencies.`);
  }
  return { inputSchema: definition.inputSchema, outputSchema: definition.outputSchema };
}

export function createTaskOutputEnvelope({ key, payload, run }) {
  const definition = taskDefinition(key);
  if (!definition) fail(`Unknown workflow task: ${key}.`);
  payloadValidators[key](payload);
  const evidenceState = evidenceStateFor(key, payload);
  if (!EVIDENCE_STATES.includes(evidenceState)) fail(`Invalid evidence state for ${key}.`);
  const modelMetadata = payload?.modelMetadata
    ?? (Array.isArray(payload) ? payload.find(item => item?.modelMetadata)?.modelMetadata : null);
  return {
    contractVersion: AGENT_CONTRACT_VERSION,
    taskKey: key,
    taskKind: definition.kind,
    schemas: { input: definition.inputSchema, output: definition.outputSchema },
    producer: {
      owner: definition.owner,
      modelTask: definition.modelTask,
      execution: modelMetadata ? clone(modelMetadata) : null,
    },
    provenance: {
      runId: run.id,
      caseId: run.caseId ?? run.case_id,
      workflowName: run.workflowName ?? run.workflow_name,
      workflowVersion: run.workflowVersion ?? run.workflow_version,
      inputDigest: digest(run.input ?? run.input_json ?? null),
      sourceRefs: [...collectSourceRefs(payload).values()],
    },
    evidenceState,
    payload: clone(payload),
  };
}

export function validateTaskOutputEnvelope(key, envelope) {
  const definition = taskDefinition(key);
  requireObject(envelope, `${key} output envelope`);
  if (!definition || envelope.contractVersion !== AGENT_CONTRACT_VERSION || envelope.taskKey !== key || envelope.taskKind !== definition.kind) {
    fail(`${key} output envelope identity is invalid.`);
  }
  if (envelope.schemas?.input !== definition.inputSchema || envelope.schemas?.output !== definition.outputSchema) fail(`${key} schema version is invalid.`);
  if (envelope.producer?.owner !== definition.owner || envelope.producer?.modelTask !== definition.modelTask) fail(`${key} producer authority is invalid.`);
  if (envelope.producer.execution !== null) {
    const execution = envelope.producer.execution;
    if (definition.owner !== 'model_assist' || execution.mode !== 'live' || execution.calls < 1 || !Number.isInteger(execution.totalTokens) || !Number.isFinite(execution.costUsd)) {
      fail(`${key} model execution metadata is invalid.`);
    }
  }
  if (!EVIDENCE_STATES.includes(envelope.evidenceState)) fail(`${key} evidence state is invalid.`);
  requireObject(envelope.provenance, `${key} provenance`);
  requireArray(envelope.provenance.sourceRefs, `${key} source references`);
  payloadValidators[key](envelope.payload);
  return envelope;
}

export function unwrapTaskOutput(key, envelope) {
  return clone(validateTaskOutputEnvelope(key, envelope).payload);
}

export function unwrapDependencyOutputs(definition, upstream) {
  requireObject(upstream, `${definition.key} dependency outputs`);
  return Object.fromEntries(definition.dependsOn.map(key => [key, unwrapTaskOutput(key, upstream[key])]));
}
