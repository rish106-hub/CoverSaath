import { randomUUID } from 'node:crypto';

const id = prefix => `${prefix}-${randomUUID()}`;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const parameterKeyPattern = /^[a-k]\.[a-z0-9_]+$/;
const registryVersions = new Set(['policy-parameters/v1']);

const acquisitionStates = new Set(['not_requested', 'requested', 'received', 'rejected', 'not_permitted']);
const resolutionStates = new Set([
  'unknown', 'reported', 'extracted_unverified', 'proven', 'calculated', 'dynamic',
  'conflicting', 'not_permitted',
]);
const extractionMethods = new Set([
  'deterministic_calculation', 'document_extraction', 'human_report', 'human_review',
  'official_source_lookup',
]);
const reviewStatuses = new Set(['not_reviewed', 'accepted', 'rejected', 'superseded']);
const transitionAuthorities = new Set(['deterministic', 'human_reviewer', 'model', 'official_source']);

const acquisitionTransitions = Object.freeze({
  not_requested: new Set(['requested', 'not_permitted']),
  requested: new Set(['received', 'rejected', 'not_permitted']),
  received: new Set(['requested', 'rejected', 'not_permitted']),
  rejected: new Set(['requested', 'not_permitted']),
  not_permitted: new Set(['requested']),
});

const resolutionTransitions = Object.freeze({
  unknown: new Set(['reported', 'extracted_unverified', 'proven', 'calculated', 'dynamic', 'conflicting', 'not_permitted']),
  reported: new Set(['unknown', 'extracted_unverified', 'proven', 'calculated', 'dynamic', 'conflicting', 'not_permitted']),
  extracted_unverified: new Set(['unknown', 'reported', 'proven', 'calculated', 'dynamic', 'conflicting', 'not_permitted']),
  proven: new Set(['unknown', 'reported', 'extracted_unverified', 'calculated', 'dynamic', 'conflicting', 'not_permitted']),
  calculated: new Set(['unknown', 'reported', 'extracted_unverified', 'proven', 'dynamic', 'conflicting', 'not_permitted']),
  dynamic: new Set(['unknown', 'reported', 'extracted_unverified', 'proven', 'calculated', 'conflicting', 'not_permitted']),
  conflicting: new Set(['unknown', 'reported', 'extracted_unverified', 'proven', 'calculated', 'dynamic', 'not_permitted']),
  not_permitted: new Set(['unknown']),
});

const modelResolutionStates = new Set(['unknown', 'extracted_unverified', 'conflicting']);

function requireBounded(value, name, { max = 128, pattern = identifierPattern } = {}) {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || (pattern && !pattern.test(value))) {
    throw new TypeError(`${name} must be a valid string of at most ${max} characters.`);
  }
  return value;
}

function optionalBounded(value, name, options) {
  return value == null ? null : requireBounded(value, name, options);
}

function requireTimestamp(value, name) {
  requireBounded(value, name, { max: 40, pattern: null });
  if (!Number.isFinite(Date.parse(value))) throw new TypeError(`${name} must be an ISO timestamp.`);
  return value;
}

function requireEnum(value, name, allowed) {
  if (!allowed.has(value)) throw new TypeError(`${name} is not supported.`);
  return value;
}

function serialize(value, name) {
  if (value === undefined) throw new TypeError(`${name} is required.`);
  const json = JSON.stringify(value);
  if (json === undefined || json.length > 65_536) throw new TypeError(`${name} must be valid JSON no larger than 65536 characters.`);
  return json;
}

function parse(value) {
  return value == null ? null : JSON.parse(value);
}

function mapParameter(row) {
  if (!row) return null;
  return Object.freeze({
    id: row.id,
    workflowRunId: row.workflow_run_id,
    registryVersion: row.registry_version,
    parameterKey: row.parameter_key,
    householdId: row.household_id,
    caseId: row.case_id,
    subjectId: row.subject_id,
    policyId: row.policy_id,
    applicable: Boolean(row.applicable),
    acquisitionState: row.acquisition_state,
    acquisitionReasonCode: row.acquisition_reason_code,
    requestedAt: row.requested_at,
    receivedAt: row.received_at,
    resolutionState: row.resolution_state,
    resolvedValue: parse(row.resolved_value_json),
    resolvedObservationId: row.resolved_observation_id,
    resolutionReasonCode: row.resolution_reason_code,
    authority: row.transition_authority,
    updatedAt: row.updated_at,
  });
}

function mapObservation(row) {
  if (!row) return null;
  return Object.freeze({
    id: row.id,
    parameterRecordId: row.parameter_record_id,
    sourceId: row.source_id,
    documentId: row.document_id,
    version: row.version,
    page: row.page,
    extractionMethod: row.extraction_method,
    reviewStatus: row.review_status,
    value: parse(row.value_json),
    sourceDigest: row.source_digest,
    observedAt: row.observed_at,
    recordedBy: row.recorded_by,
    createdAt: row.created_at,
  });
}

export class CoverageParameterRepository {
  constructor(database, { clock = () => new Date() } = {}) {
    if (!database?.prepare || !database?.exec) throw new TypeError('A database is required.');
    this.database = database;
    this.clock = clock;
  }

  pinRegistry({ workflowRunId, registryVersion, pinnedAt = this.clock().toISOString() }) {
    requireBounded(workflowRunId, 'workflowRunId');
    requireEnum(registryVersion, 'registryVersion', registryVersions);
    requireTimestamp(pinnedAt, 'pinnedAt');
    this.database.prepare(`INSERT INTO coverage_parameter_registry_pins
      (workflow_run_id, registry_version, pinned_at, created_at) VALUES (?, ?, ?, ?)`)
      .run(workflowRunId, registryVersion, pinnedAt, pinnedAt);
    return this.getRegistryPin(workflowRunId);
  }

  getRegistryPin(workflowRunId) {
    requireBounded(workflowRunId, 'workflowRunId');
    return this.database.prepare(`SELECT workflow_run_id AS workflowRunId,
      registry_version AS registryVersion, pinned_at AS pinnedAt, created_at AS createdAt
      FROM coverage_parameter_registry_pins WHERE workflow_run_id = ?`).get(workflowRunId) ?? null;
  }

  createParameter({
    id: parameterRecordId = id('parameter'), workflowRunId, registryVersion, parameterKey,
    householdId, caseId, subjectId, policyId, applicable = true,
    acquisitionState = applicable ? 'not_requested' : 'not_permitted',
    resolutionState = applicable ? 'unknown' : 'not_permitted', reasonCode = null,
    updatedBy = 'coverage-parameter-repository',
  }) {
    requireBounded(parameterRecordId, 'id');
    requireBounded(workflowRunId, 'workflowRunId');
    requireEnum(registryVersion, 'registryVersion', registryVersions);
    requireBounded(parameterKey, 'parameterKey', { max: 128, pattern: parameterKeyPattern });
    requireBounded(householdId, 'householdId');
    requireBounded(caseId, 'caseId');
    requireBounded(subjectId, 'subjectId');
    requireBounded(policyId, 'policyId');
    requireEnum(acquisitionState, 'acquisitionState', acquisitionStates);
    requireEnum(resolutionState, 'resolutionState', resolutionStates);
    optionalBounded(reasonCode, 'reasonCode');
    requireBounded(updatedBy, 'updatedBy');
    if (typeof applicable !== 'boolean') throw new TypeError('applicable must be a boolean.');
    if (!applicable && (acquisitionState !== 'not_permitted' || resolutionState !== 'not_permitted')) {
      throw new TypeError('A non-applicable parameter must be not_permitted.');
    }
    if (!['not_requested', 'not_permitted'].includes(acquisitionState)) {
      throw new TypeError('A new parameter must start as not_requested or not_permitted.');
    }
    if (!['unknown', 'not_permitted'].includes(resolutionState)) {
      throw new TypeError('A new parameter cannot start with a resolved value.');
    }
    if ((acquisitionState === 'not_permitted') !== (resolutionState === 'not_permitted')) {
      throw new TypeError('Not-permitted acquisition and resolution states must be set together.');
    }
    const at = this.clock().toISOString();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`INSERT INTO coverage_parameter_records
        (id, workflow_run_id, registry_version, parameter_key, household_id, case_id,
         subject_id, policy_id, applicable, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        parameterRecordId, workflowRunId, registryVersion, parameterKey, householdId, caseId,
        subjectId, policyId, applicable ? 1 : 0, at, at,
      );
      this.database.prepare(`INSERT INTO coverage_parameter_acquisitions
        (parameter_record_id, acquisition_state, reason_code, requested_at, received_at,
         updated_by, updated_at) VALUES (?, ?, ?, NULL, NULL, ?, ?)`)
        .run(parameterRecordId, acquisitionState, reasonCode, updatedBy, at);
      this.database.prepare(`INSERT INTO coverage_parameter_resolutions
        (parameter_record_id, resolution_state, resolved_value_json, resolved_observation_id,
         reason_code, transition_authority, updated_by, updated_at)
        VALUES (?, ?, NULL, NULL, ?, 'deterministic', ?, ?)`).run(
        parameterRecordId, resolutionState, reasonCode, updatedBy, at,
      );
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return this.getParameter(parameterRecordId);
  }

  getParameter(parameterRecordId) {
    requireBounded(parameterRecordId, 'parameterRecordId');
    return mapParameter(this.database.prepare(`SELECT parameter.*,
        acquisition.acquisition_state, acquisition.reason_code AS acquisition_reason_code,
        acquisition.requested_at, acquisition.received_at,
        resolution.resolution_state, resolution.resolved_value_json,
        resolution.resolved_observation_id, resolution.reason_code AS resolution_reason_code,
        resolution.transition_authority, resolution.updated_at
      FROM coverage_parameter_records parameter
      JOIN coverage_parameter_acquisitions acquisition ON acquisition.parameter_record_id = parameter.id
      JOIN coverage_parameter_resolutions resolution ON resolution.parameter_record_id = parameter.id
      WHERE parameter.id = ?`).get(parameterRecordId));
  }

  listForRun(workflowRunId) {
    requireBounded(workflowRunId, 'workflowRunId');
    return this.database.prepare(`SELECT parameter.*,
        acquisition.acquisition_state, acquisition.reason_code AS acquisition_reason_code,
        acquisition.requested_at, acquisition.received_at,
        resolution.resolution_state, resolution.resolved_value_json,
        resolution.resolved_observation_id, resolution.reason_code AS resolution_reason_code,
        resolution.transition_authority, resolution.updated_at
      FROM coverage_parameter_records parameter
      JOIN coverage_parameter_acquisitions acquisition ON acquisition.parameter_record_id = parameter.id
      JOIN coverage_parameter_resolutions resolution ON resolution.parameter_record_id = parameter.id
      WHERE parameter.workflow_run_id = ? ORDER BY parameter.parameter_key`).all(workflowRunId).map(mapParameter);
  }

  setAcquisitionState({ parameterRecordId, state, reasonCode = null, updatedBy, at = this.clock().toISOString() }) {
    requireBounded(parameterRecordId, 'parameterRecordId');
    requireEnum(state, 'state', acquisitionStates);
    optionalBounded(reasonCode, 'reasonCode');
    requireBounded(updatedBy, 'updatedBy');
    requireTimestamp(at, 'at');
    const current = this.database.prepare(`SELECT acquisition_state FROM coverage_parameter_acquisitions
      WHERE parameter_record_id = ?`).get(parameterRecordId);
    if (!current) throw new Error('Coverage parameter acquisition was not found.');
    if (current.acquisition_state !== state && !acquisitionTransitions[current.acquisition_state].has(state)) {
      throw new Error(`Invalid acquisition transition: ${current.acquisition_state} -> ${state}`);
    }
    const requestedAt = state === 'requested' ? at : null;
    const receivedAt = state === 'received' ? at : null;
    this.database.prepare(`UPDATE coverage_parameter_acquisitions SET
      acquisition_state = ?, reason_code = ?,
      requested_at = COALESCE(?, requested_at), received_at = COALESCE(?, received_at),
      updated_by = ?, updated_at = ? WHERE parameter_record_id = ?`)
      .run(state, reasonCode, requestedAt, receivedAt, updatedBy, at, parameterRecordId);
    this.database.prepare('UPDATE coverage_parameter_records SET updated_at = ? WHERE id = ?').run(at, parameterRecordId);
    return this.getParameter(parameterRecordId);
  }

  appendObservation({
    id: observationId = id('observation'), parameterRecordId, sourceId, documentId,
    version, page, extractionMethod, reviewStatus = 'not_reviewed', value,
    sourceDigest, observedAt = this.clock().toISOString(), recordedBy,
  }) {
    requireBounded(observationId, 'id');
    requireBounded(parameterRecordId, 'parameterRecordId');
    requireBounded(sourceId, 'sourceId');
    requireBounded(documentId, 'documentId');
    requireBounded(version, 'version');
    const normalizedPage = typeof page === 'number' && Number.isSafeInteger(page) && page > 0
      ? String(page)
      : requireBounded(page, 'page', { max: 64, pattern: null });
    requireEnum(extractionMethod, 'extractionMethod', extractionMethods);
    requireEnum(reviewStatus, 'reviewStatus', reviewStatuses);
    if (typeof sourceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(sourceDigest)) {
      throw new TypeError('sourceDigest must be a lowercase SHA-256 digest.');
    }
    requireTimestamp(observedAt, 'observedAt');
    requireBounded(recordedBy, 'recordedBy');
    const valueJson = serialize(value, 'value');
    const createdAt = this.clock().toISOString();
    this.database.prepare(`INSERT INTO coverage_parameter_observations
      (id, parameter_record_id, source_id, document_id, version, page,
       extraction_method, review_status, value_json, source_digest, observed_at,
       recorded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        observationId, parameterRecordId, sourceId, documentId, version, normalizedPage,
        extractionMethod, reviewStatus, valueJson, sourceDigest, observedAt, recordedBy, createdAt,
      );
    return mapObservation(this.database.prepare('SELECT * FROM coverage_parameter_observations WHERE id = ?').get(observationId));
  }

  listObservations(parameterRecordId) {
    requireBounded(parameterRecordId, 'parameterRecordId');
    return this.database.prepare(`SELECT * FROM coverage_parameter_observations
      WHERE parameter_record_id = ? ORDER BY observed_at, id`).all(parameterRecordId).map(mapObservation);
  }

  setResolution({
    parameterRecordId, state, resolvedValue = null, observationId = null, reasonCode = null,
    authority, updatedBy, at = this.clock().toISOString(),
  }) {
    requireBounded(parameterRecordId, 'parameterRecordId');
    requireEnum(state, 'state', resolutionStates);
    requireEnum(authority, 'authority', transitionAuthorities);
    requireBounded(updatedBy, 'updatedBy');
    requireTimestamp(at, 'at');
    optionalBounded(observationId, 'observationId');
    optionalBounded(reasonCode, 'reasonCode');
    if (authority === 'model' && !modelResolutionStates.has(state)) {
      throw new Error(`model authority cannot set resolution state ${state}.`);
    }
    const current = this.database.prepare(`SELECT resolution_state FROM coverage_parameter_resolutions
      WHERE parameter_record_id = ?`).get(parameterRecordId);
    if (!current) throw new Error('Coverage parameter resolution was not found.');
    if (current.resolution_state !== state && !resolutionTransitions[current.resolution_state].has(state)) {
      throw new Error(`Invalid resolution transition: ${current.resolution_state} -> ${state}`);
    }
    if (state === 'conflicting') {
      const observationCount = this.database.prepare(`SELECT count(*) AS count
        FROM coverage_parameter_observations WHERE parameter_record_id = ?`).get(parameterRecordId).count;
      if (observationCount < 2) throw new Error('Conflicting resolution requires at least two observations.');
    }
    const carriesValue = !['unknown', 'conflicting', 'not_permitted'].includes(state);
    if (carriesValue !== (observationId !== null) || carriesValue !== (resolvedValue !== null)) {
      throw new TypeError('Resolved values require an observation; unknown, conflicting and not_permitted states cannot select one.');
    }
    const valueJson = carriesValue ? serialize(resolvedValue, 'resolvedValue') : null;
    this.database.prepare(`UPDATE coverage_parameter_resolutions SET resolution_state = ?,
      resolved_value_json = ?, resolved_observation_id = ?, reason_code = ?, transition_authority = ?,
      updated_by = ?, updated_at = ? WHERE parameter_record_id = ?`).run(
      state, valueJson, observationId, reasonCode, authority, updatedBy, at, parameterRecordId,
    );
    this.database.prepare('UPDATE coverage_parameter_records SET updated_at = ? WHERE id = ?').run(at, parameterRecordId);
    return this.getParameter(parameterRecordId);
  }
}
