import {
  getPolicyParameterDefinition,
  getPolicyParameterRegistry,
} from './policy-parameter-registry.js';

export const PARAMETER_ACQUISITION_STATES = Object.freeze([
  'not_requested', 'requested', 'received', 'rejected', 'not_permitted',
]);

export const PARAMETER_RESOLUTION_STATES = Object.freeze([
  'unknown', 'reported', 'extracted_unverified', 'proven', 'calculated', 'dynamic',
  'conflicting', 'not_permitted',
]);

export const PARAMETER_OBSERVATION_METHODS = Object.freeze([
  'deterministic_calculation', 'document_extraction', 'human_report', 'human_review',
  'official_source_lookup',
]);

export const PARAMETER_REVIEW_STATUSES = Object.freeze([
  'not_reviewed', 'accepted', 'rejected', 'superseded',
]);

export const PARAMETER_TRANSITION_AUTHORITIES = Object.freeze([
  'deterministic', 'human_reviewer', 'model', 'official_source',
]);

const ACQUISITION_TRANSITIONS = Object.freeze({
  not_requested: Object.freeze(['requested', 'not_permitted']),
  requested: Object.freeze(['received', 'rejected', 'not_permitted']),
  received: Object.freeze(['requested', 'rejected', 'not_permitted']),
  rejected: Object.freeze(['requested', 'not_permitted']),
  not_permitted: Object.freeze(['requested']),
});

const RESOLUTION_TRANSITIONS = Object.freeze({
  unknown: Object.freeze(['reported', 'extracted_unverified', 'proven', 'calculated', 'dynamic', 'conflicting', 'not_permitted']),
  reported: Object.freeze(['unknown', 'extracted_unverified', 'proven', 'calculated', 'dynamic', 'conflicting', 'not_permitted']),
  extracted_unverified: Object.freeze(['unknown', 'reported', 'proven', 'calculated', 'dynamic', 'conflicting', 'not_permitted']),
  proven: Object.freeze(['unknown', 'reported', 'extracted_unverified', 'calculated', 'dynamic', 'conflicting', 'not_permitted']),
  calculated: Object.freeze(['unknown', 'reported', 'extracted_unverified', 'proven', 'dynamic', 'conflicting', 'not_permitted']),
  dynamic: Object.freeze(['unknown', 'reported', 'extracted_unverified', 'proven', 'calculated', 'conflicting', 'not_permitted']),
  conflicting: Object.freeze(['unknown', 'reported', 'extracted_unverified', 'proven', 'calculated', 'dynamic', 'not_permitted']),
  not_permitted: Object.freeze(['unknown']),
});

const MODEL_AUTHORITY = 'model';
const MODEL_ALLOWED_RESOLUTION_STATES = Object.freeze(['unknown', 'extracted_unverified', 'conflicting']);

const isNonEmptyString = value => typeof value === 'string' && value.trim().length > 0;
const hasValue = value => value !== null && value !== undefined;

export function assertAcquisitionTransition(fromState, toState) {
  if (!PARAMETER_ACQUISITION_STATES.includes(fromState) || !PARAMETER_ACQUISITION_STATES.includes(toState)) throw new TypeError('Unsupported parameter acquisition state.');
  if (fromState !== toState && !ACQUISITION_TRANSITIONS[fromState].includes(toState)) throw new TypeError(`Invalid acquisition transition: ${fromState} -> ${toState}.`);
  return toState;
}

export function assertResolutionTransition(fromState, toState, { authority = 'deterministic' } = {}) {
  if (!PARAMETER_RESOLUTION_STATES.includes(fromState) || !PARAMETER_RESOLUTION_STATES.includes(toState)) throw new TypeError('Unsupported parameter resolution state.');
  if (!PARAMETER_TRANSITION_AUTHORITIES.includes(authority)) throw new TypeError(`Unsupported parameter transition authority: ${authority}.`);
  if (authority === MODEL_AUTHORITY && !MODEL_ALLOWED_RESOLUTION_STATES.includes(toState)) throw new TypeError(`Model authority cannot create resolution state: ${toState}.`);
  if (fromState !== toState && !RESOLUTION_TRANSITIONS[fromState].includes(toState)) throw new TypeError(`Invalid resolution transition: ${fromState} -> ${toState}.`);
  return toState;
}

export function validateParameterObservation(observation) {
  if (!observation || typeof observation !== 'object') throw new TypeError('Parameter observation is required.');
  const requiredStrings = ['id', 'sourceId', 'documentId', 'version', 'extractionMethod', 'reviewStatus'];
  for (const field of requiredStrings) if (!isNonEmptyString(observation[field])) throw new TypeError(`Parameter observation ${field} is required.`);
  if (!(isNonEmptyString(observation.page) || Number.isInteger(observation.page))) throw new TypeError('Parameter observation page is required.');
  if (!PARAMETER_OBSERVATION_METHODS.includes(observation.extractionMethod)) throw new TypeError(`Unsupported parameter observation extraction method: ${observation.extractionMethod}.`);
  if (!PARAMETER_REVIEW_STATUSES.includes(observation.reviewStatus)) throw new TypeError(`Unsupported parameter observation review status: ${observation.reviewStatus}.`);
  if (!Object.prototype.hasOwnProperty.call(observation, 'value')) throw new TypeError('Parameter observation value is required.');
  return observation;
}

function validateScope(scope) {
  if (!scope || typeof scope !== 'object' || !isNonEmptyString(scope.subjectId) || !isNonEmptyString(scope.policyId)) throw new TypeError('Parameter record scope requires subjectId and policyId.');
}

export function validateParameterRecord(record) {
  if (!record || typeof record !== 'object') throw new TypeError('Parameter record is required.');
  getPolicyParameterRegistry(record.registryVersion);
  const definition = getPolicyParameterDefinition(record.registryVersion, record.parameterKey);
  validateScope(record.scope);
  if (!PARAMETER_ACQUISITION_STATES.includes(record.acquisitionState)) throw new TypeError(`Unsupported parameter acquisition state: ${record.acquisitionState}.`);
  if (!PARAMETER_RESOLUTION_STATES.includes(record.resolutionState)) throw new TypeError(`Unsupported parameter resolution state: ${record.resolutionState}.`);
  if (!definition.permittedResolutionStates.includes(record.resolutionState)) throw new TypeError(`Resolution state is not permitted for parameter: ${record.parameterKey}.`);
  if (!Array.isArray(record.observations)) throw new TypeError('Parameter record observations are required.');
  record.observations.forEach(validateParameterObservation);
  if (!isNonEmptyString(record.updatedAt) || Number.isNaN(Date.parse(record.updatedAt))) throw new TypeError('Parameter record updatedAt must be an ISO date-time string.');

  const resolvesValue = !['unknown', 'conflicting', 'not_permitted'].includes(record.resolutionState);
  if (resolvesValue && !hasValue(record.resolvedValue)) throw new TypeError(`Resolved value is required for state: ${record.resolutionState}.`);
  if (resolvesValue && record.observations.length === 0) throw new TypeError(`Provenance observation is required for state: ${record.resolutionState}.`);
  if (['unknown', 'not_permitted'].includes(record.resolutionState) && hasValue(record.resolvedValue)) throw new TypeError(`Resolved value must be null for state: ${record.resolutionState}.`);
  if (record.resolutionState === 'not_permitted' && record.acquisitionState !== 'not_permitted') throw new TypeError('Not-permitted resolution requires not-permitted acquisition.');
  if (record.acquisitionState === 'not_permitted' && record.resolutionState !== 'not_permitted') throw new TypeError('Not-permitted acquisition requires not-permitted resolution.');
  if (record.resolutionState === 'conflicting' && record.observations.length < 2) throw new TypeError('Conflicting parameter records must preserve at least two observations.');
  return record;
}

export function createParameterRecord({ registryVersion, parameterKey, subjectId, policyId, updatedAt }) {
  getPolicyParameterDefinition(registryVersion, parameterKey);
  return validateParameterRecord({
    registryVersion,
    parameterKey,
    scope: { subjectId, policyId },
    acquisitionState: 'not_requested',
    resolutionState: 'unknown',
    observations: [],
    resolvedValue: null,
    reasonCode: null,
    updatedAt,
  });
}

export function transitionParameterRecord(record, changes, { authority = 'deterministic' } = {}) {
  validateParameterRecord(record);
  const definition = getPolicyParameterDefinition(record.registryVersion, record.parameterKey);
  const next = structuredClone(record);
  next.acquisitionState = changes.acquisitionState ?? record.acquisitionState;
  next.resolutionState = changes.resolutionState ?? record.resolutionState;
  assertAcquisitionTransition(record.acquisitionState, next.acquisitionState);
  assertResolutionTransition(record.resolutionState, next.resolutionState, { authority });
  if (authority === MODEL_AUTHORITY && !definition.modelExtraction.allowed && next.resolutionState !== 'unknown') {
    throw new TypeError(`Model extraction is not permitted for parameter: ${record.parameterKey}.`);
  }
  if (Object.prototype.hasOwnProperty.call(changes, 'observations')) next.observations = structuredClone(changes.observations);
  if (Object.prototype.hasOwnProperty.call(changes, 'resolvedValue')) next.resolvedValue = structuredClone(changes.resolvedValue);
  if (Object.prototype.hasOwnProperty.call(changes, 'reasonCode')) next.reasonCode = changes.reasonCode;
  next.updatedAt = changes.updatedAt;
  return validateParameterRecord(next);
}
