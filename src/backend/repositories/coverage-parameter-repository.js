import { randomUUID } from 'node:crypto';
import { AuditRepository } from './audit-repository.js';
import {
  POLICY_PARAMETER_REGISTRY_VERSION,
  getPolicyParameterDefinition,
  getPolicyParameterRegistry,
} from '../../features/coverage-analysis/policy-parameter-registry.js';
import {
  PARAMETER_ACQUISITION_STATES,
  PARAMETER_OBSERVATION_METHODS,
  PARAMETER_RESOLUTION_STATES,
  PARAMETER_REVIEW_STATUSES,
  assertAcquisitionTransition,
  assertModelMayReplaceResolution,
  assertResolutionTransition,
  deriveResolutionAuthority,
  resolvesParameterValue,
} from '../../features/coverage-analysis/parameter-records.js';

const id = prefix => `${prefix}-${randomUUID()}`;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const parameterKeyPattern = /^[a-k]\.[a-z0-9_]+$/;

const acquisitionStates = new Set(PARAMETER_ACQUISITION_STATES);
const resolutionStates = new Set(PARAMETER_RESOLUTION_STATES);
const extractionMethods = new Set(PARAMETER_OBSERVATION_METHODS);
const reviewStatuses = new Set(PARAMETER_REVIEW_STATUSES);

// Reasons an observation's value may be erased. Extending the list needs no migration.
export const OBSERVATION_REDACTION_REASONS = Object.freeze([
  'consent_revoked', 'document_erasure', 'retention_expired', 'data_subject_request',
  'source_consent_not_current',
]);
const redactionReasons = new Set(OBSERVATION_REDACTION_REASONS);
// Resolution states a model observation may (re)establish, and the authorities that may have
// set them; a state set by a human reviewer or an official source is never replaced.
const MODEL_REPLACEABLE_STATES = new Set(['unknown', 'extracted_unverified', 'conflicting']);
const MODEL_REPLACEABLE_AUTHORITIES = new Set(['model', 'deterministic']);
const USABLE_REVIEW_STATUSES = new Set(['not_reviewed', 'accepted']);

const defaultObservationLimit = 100;
const maximumObservationLimit = 500;
const defaultRunLimit = 500;
const maximumRunLimit = 1000;

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

function requireLimit(value, name, fallback, maximum) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} must be an integer between 1 and ${maximum}.`);
  }
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

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

const sameJson = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));

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
    redactedAt: row.redacted_at,
    redactionReasonCode: row.redaction_reason_code,
  });
}

const parameterSelect = `SELECT parameter.*,
    acquisition.acquisition_state, acquisition.reason_code AS acquisition_reason_code,
    acquisition.requested_at, acquisition.received_at,
    resolution.resolution_state, resolution.resolved_value_json,
    resolution.resolved_observation_id, resolution.reason_code AS resolution_reason_code,
    resolution.transition_authority, resolution.updated_at
  FROM coverage_parameter_records parameter
  JOIN coverage_parameter_acquisitions acquisition ON acquisition.parameter_record_id = parameter.id
  JOIN coverage_parameter_resolutions resolution ON resolution.parameter_record_id = parameter.id`;

export class CoverageParameterRepository {
  constructor(database, { clock = () => new Date(), audit = null } = {}) {
    if (!database?.prepare || !database?.exec) throw new TypeError('A database is required.');
    this.database = database;
    this.clock = clock;
    this.audit = audit ?? new AuditRepository(database, { clock });
  }

  // Runs `work` atomically. Joins an open transaction through a savepoint so the
  // multi-step methods compose with callers that already hold a transaction.
  //
  // Whether a transaction is already open is read from DatabaseSync.isTransaction where the
  // runtime provides it. Some supported runtimes (engines >= 22.12.0) may not have that
  // property, and a manual BEGIN held by a caller cannot be seen by in-process depth tracking, so
  // there the outer transaction is probed by attempting it: SQLite refuses BEGIN inside an open
  // transaction with a "within a transaction" error, which selects the savepoint path. Any other
  // BEGIN failure (for example a busy database) is rethrown unchanged.
  #atomic(work) {
    const savepoint = `coverage_parameter_${randomUUID().replaceAll('-', '')}`;
    let nested;
    if (typeof this.database.isTransaction === 'boolean') {
      nested = this.database.isTransaction;
      if (!nested) this.database.exec('BEGIN IMMEDIATE');
    } else {
      try {
        this.database.exec('BEGIN IMMEDIATE');
        nested = false;
      } catch (error) {
        if (!/within a transaction/i.test(String(error?.message))) throw error;
        nested = true;
      }
    }
    if (nested) this.database.exec(`SAVEPOINT ${savepoint}`);
    try {
      const result = work();
      this.database.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
      return result;
    } catch (error) {
      this.database.exec(nested ? `ROLLBACK TO ${savepoint}` : 'ROLLBACK');
      if (nested) this.database.exec(`RELEASE ${savepoint}`);
      throw error;
    }
  }

  // Fails closed on a registry version that the application does not know. The database
  // additionally requires the version to be registered in coverage_parameter_registry_versions.
  #requireRegistryVersion(registryVersion) {
    requireBounded(registryVersion, 'registryVersion', { max: 64, pattern: null });
    try {
      getPolicyParameterRegistry(registryVersion);
    } catch {
      throw new TypeError('registryVersion is not supported.');
    }
    return registryVersion;
  }

  /**
   * Pins a run to one registry version. Idempotent for the same version; a run can never be
   * re-pinned to a different version.
   */
  pinRegistry({ workflowRunId, registryVersion, pinnedAt = this.clock().toISOString() }) {
    requireBounded(workflowRunId, 'workflowRunId');
    this.#requireRegistryVersion(registryVersion);
    requireTimestamp(pinnedAt, 'pinnedAt');
    const existing = this.getRegistryPin(workflowRunId);
    if (existing) {
      if (existing.registryVersion !== registryVersion) throw new Error('The run is already pinned to a different registry version.');
      return existing;
    }
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

  #insertParameter({
    id: parameterRecordId, workflowRunId, registryVersion, parameterKey, householdId, caseId,
    subjectId, policyId, applicable, acquisitionState, resolutionState, reasonCode, updatedBy,
  }) {
    const at = this.clock().toISOString();
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
    this.#requireRegistryVersion(registryVersion);
    requireBounded(parameterKey, 'parameterKey', { max: 128, pattern: parameterKeyPattern });
    getPolicyParameterDefinition(registryVersion, parameterKey);
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
    this.#atomic(() => this.#insertParameter({
      id: parameterRecordId, workflowRunId, registryVersion, parameterKey, householdId, caseId,
      subjectId, policyId, applicable, acquisitionState, resolutionState, reasonCode, updatedBy,
    }));
    return this.getParameter(parameterRecordId);
  }

  /**
   * Pins a run to a registry version and creates one explicit record per registry parameter
   * (acquisition not_requested, resolution unknown). Parameters listed in `notApplicableKeys`
   * are created not_permitted. Idempotent: existing records keep their state, and a record
   * whose scope differs from the requested one is rejected. Atomic.
   *
   * Intended for run creation (round 3); nothing calls it yet.
   * Returns { pin, registryVersion, created, existing, total }.
   */
  initializeRunParameters({
    workflowRunId, registryVersion = POLICY_PARAMETER_REGISTRY_VERSION, householdId, caseId,
    subjectId, policyId, notApplicableKeys = [], updatedBy = 'coverage-parameter-repository',
  }) {
    requireBounded(workflowRunId, 'workflowRunId');
    this.#requireRegistryVersion(registryVersion);
    requireBounded(householdId, 'householdId');
    requireBounded(caseId, 'caseId');
    requireBounded(subjectId, 'subjectId');
    requireBounded(policyId, 'policyId');
    requireBounded(updatedBy, 'updatedBy');
    if (!Array.isArray(notApplicableKeys) || notApplicableKeys.length > 1000) throw new TypeError('notApplicableKeys must be an array of registry keys.');
    const registry = getPolicyParameterRegistry(registryVersion);
    const known = new Set(registry.parameters.map(definition => definition.key));
    const notApplicable = new Set(notApplicableKeys);
    for (const key of notApplicable) {
      if (!known.has(key)) throw new TypeError(`Unknown policy parameter key: ${key}.`);
    }
    return this.#atomic(() => {
      const pin = this.pinRegistry({ workflowRunId, registryVersion });
      const present = new Map(this.database.prepare(`SELECT parameter_key, household_id, case_id,
        subject_id, policy_id FROM coverage_parameter_records WHERE workflow_run_id = ?`)
        .all(workflowRunId).map(row => [row.parameter_key, row]));
      let created = 0;
      let existing = 0;
      for (const definition of registry.parameters) {
        const current = present.get(definition.key);
        if (current) {
          if (current.household_id !== householdId || current.case_id !== caseId
            || current.subject_id !== subjectId || current.policy_id !== policyId) {
            throw new Error('Existing run parameters belong to a different scope.');
          }
          existing += 1;
          continue;
        }
        const applicable = !notApplicable.has(definition.key);
        this.#insertParameter({
          id: id('parameter'), workflowRunId, registryVersion, parameterKey: definition.key,
          householdId, caseId, subjectId, policyId, applicable,
          acquisitionState: applicable ? 'not_requested' : 'not_permitted',
          resolutionState: applicable ? 'unknown' : 'not_permitted',
          reasonCode: applicable ? null : 'NOT_APPLICABLE', updatedBy,
        });
        created += 1;
      }
      return Object.freeze({ pin, registryVersion, created, existing, total: created + existing });
    });
  }

  getParameter(parameterRecordId) {
    requireBounded(parameterRecordId, 'parameterRecordId');
    return mapParameter(this.database.prepare(`${parameterSelect} WHERE parameter.id = ?`).get(parameterRecordId));
  }

  listForRun(workflowRunId, { limit } = {}) {
    requireBounded(workflowRunId, 'workflowRunId');
    const bound = requireLimit(limit, 'limit', defaultRunLimit, maximumRunLimit);
    return this.database.prepare(`${parameterSelect}
      WHERE parameter.workflow_run_id = ? ORDER BY parameter.parameter_key LIMIT ?`)
      .all(workflowRunId, bound).map(mapParameter);
  }

  /**
   * Moves one parameter's acquisition state. `requested` is for keys actually sent and
   * `received` only follows `requested` (see ACQUISITION_TRANSITIONS). Setting the current
   * state again is a no-op, so retries never rewrite timestamps.
   */
  setAcquisitionState({ parameterRecordId, state, reasonCode = null, updatedBy, at = this.clock().toISOString() }) {
    requireBounded(parameterRecordId, 'parameterRecordId');
    requireEnum(state, 'state', acquisitionStates);
    optionalBounded(reasonCode, 'reasonCode');
    requireBounded(updatedBy, 'updatedBy');
    requireTimestamp(at, 'at');
    this.#atomic(() => this.#applyAcquisition({ parameterRecordId, state, reasonCode, updatedBy, at }));
    return this.getParameter(parameterRecordId);
  }

  /** Atomically moves several parameters of one run (for example the keys actually sent). */
  setAcquisitionStateForRun({ workflowRunId, parameterKeys, state, reasonCode = null, updatedBy, at = this.clock().toISOString() }) {
    requireBounded(workflowRunId, 'workflowRunId');
    requireEnum(state, 'state', acquisitionStates);
    optionalBounded(reasonCode, 'reasonCode');
    requireBounded(updatedBy, 'updatedBy');
    requireTimestamp(at, 'at');
    if (!Array.isArray(parameterKeys) || parameterKeys.length < 1 || parameterKeys.length > maximumRunLimit) {
      throw new TypeError(`parameterKeys must list between 1 and ${maximumRunLimit} keys.`);
    }
    const keys = [...new Set(parameterKeys.map(key => requireBounded(key, 'parameterKey', { max: 128, pattern: parameterKeyPattern })))];
    return this.#atomic(() => keys.map(parameterKey => {
      const row = this.database.prepare(`SELECT id FROM coverage_parameter_records
        WHERE workflow_run_id = ? AND parameter_key = ?`).get(workflowRunId, parameterKey);
      if (!row) throw new Error(`Coverage parameter was not found for the run: ${parameterKey}.`);
      this.#applyAcquisition({ parameterRecordId: row.id, state, reasonCode, updatedBy, at });
      return this.getParameter(row.id);
    }));
  }

  #applyAcquisition({ parameterRecordId, state, reasonCode, updatedBy, at }) {
    const current = this.database.prepare(`SELECT acquisition_state FROM coverage_parameter_acquisitions
      WHERE parameter_record_id = ?`).get(parameterRecordId);
    if (!current) throw new Error('Coverage parameter acquisition was not found.');
    if (current.acquisition_state === state) return;
    assertAcquisitionTransition(current.acquisition_state, state);
    // A new request clears the previous receipt; a receipt keeps the request time.
    this.database.prepare(`UPDATE coverage_parameter_acquisitions SET
      acquisition_state = ?, reason_code = ?,
      requested_at = CASE WHEN ? = 'requested' THEN ? ELSE requested_at END,
      received_at = CASE WHEN ? = 'received' THEN ? WHEN ? = 'requested' THEN NULL ELSE received_at END,
      updated_by = ?, updated_at = ? WHERE parameter_record_id = ?`)
      .run(state, reasonCode, state, at, state, at, state, updatedBy, at, parameterRecordId);
    this.database.prepare('UPDATE coverage_parameter_records SET updated_at = ? WHERE id = ?').run(at, parameterRecordId);
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
    if (extractionMethod === 'document_extraction') {
      // Model-derived values are only stored for parameters the registry allows a model to extract.
      const parameter = this.database.prepare(`SELECT registry_version, parameter_key
        FROM coverage_parameter_records WHERE id = ?`).get(parameterRecordId);
      if (parameter && !getPolicyParameterDefinition(parameter.registry_version, parameter.parameter_key).modelExtraction.allowed) {
        throw new Error('Model extraction is not permitted for this parameter.');
      }
    }
    // Migration 006 enforces both rules in the database; these checks give a stable error first.
    const document = this.database.prepare('SELECT lifecycle_state FROM document_uploads WHERE id = ?').get(documentId);
    if (document?.lifecycle_state !== 'active') {
      throw Object.assign(new Error('Parameter observations require an active document.'), { code: 'OBSERVATION_DOCUMENT_NOT_ACTIVE' });
    }
    if (extractionMethod === 'human_review') {
      const review = this.database.prepare(`SELECT 1 FROM coverage_parameter_records parameter
        JOIN human_reviews review ON review.case_id = parameter.case_id
        WHERE parameter.id = ?
          AND (review.workflow_run_id IS NULL OR review.workflow_run_id = parameter.workflow_run_id)
          AND review.status IN ('in_progress', 'completed') AND review.reviewer_adult_id = ?
        LIMIT 1`).get(parameterRecordId, recordedBy);
      if (!review) {
        throw Object.assign(new Error('Human review observations must be recorded by the assigned reviewer.'), { code: 'OBSERVATION_REVIEWER_REQUIRED' });
      }
    }
    const createdAt = this.clock().toISOString();
    this.database.prepare(`INSERT INTO coverage_parameter_observations
      (id, parameter_record_id, source_id, document_id, version, page,
       extraction_method, review_status, value_json, source_digest, observed_at,
       recorded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        observationId, parameterRecordId, sourceId, documentId, version, normalizedPage,
        extractionMethod, reviewStatus, valueJson, sourceDigest, observedAt, recordedBy, createdAt,
      );
    return this.getObservation(observationId);
  }

  getObservation(observationId) {
    requireBounded(observationId, 'observationId');
    return mapObservation(this.database.prepare('SELECT * FROM coverage_parameter_observations WHERE id = ?').get(observationId));
  }

  listObservations(parameterRecordId, { limit } = {}) {
    requireBounded(parameterRecordId, 'parameterRecordId');
    const bound = requireLimit(limit, 'limit', defaultObservationLimit, maximumObservationLimit);
    return this.database.prepare(`SELECT * FROM coverage_parameter_observations
      WHERE parameter_record_id = ? ORDER BY observed_at, id LIMIT ?`).all(parameterRecordId, bound).map(mapObservation);
  }

  /**
   * Moves a parameter's resolution. The transition authority is derived from the selected
   * observation (its extraction method and review status), not trusted from the caller:
   *   - a model-derived observation (document_extraction) can only yield extracted_unverified;
   *   - proven needs an accepted human_review or official_source_lookup observation;
   *   - calculated needs a deterministic_calculation observation;
   *   - rejected, superseded and redacted observations support nothing.
   * `authority` is optional; when given it is an assertion that must match the derived one.
   * Value-less states (unknown, conflicting, not_permitted) take the declared actor kind,
   * default deterministic, and a model actor is limited to unknown and conflicting there.
   * The resolved value is the observation's value; a different `resolvedValue` is rejected.
   */
  setResolution({
    parameterRecordId, state, resolvedValue, observationId = null, reasonCode = null,
    authority = null, updatedBy, at = this.clock().toISOString(),
  }) {
    requireBounded(parameterRecordId, 'parameterRecordId');
    requireEnum(state, 'state', resolutionStates);
    requireBounded(updatedBy, 'updatedBy');
    requireTimestamp(at, 'at');
    optionalBounded(observationId, 'observationId');
    optionalBounded(reasonCode, 'reasonCode');
    if (authority !== null) requireBounded(authority, 'authority', { max: 32, pattern: /^[a-z_]+$/ });
    return this.#atomic(() => {
      const parameter = this.database.prepare(`SELECT parameter.registry_version, parameter.parameter_key,
          resolution.resolution_state FROM coverage_parameter_records parameter
        JOIN coverage_parameter_resolutions resolution ON resolution.parameter_record_id = parameter.id
        WHERE parameter.id = ?`).get(parameterRecordId);
      if (!parameter) throw new Error('Coverage parameter resolution was not found.');
      const definition = getPolicyParameterDefinition(parameter.registry_version, parameter.parameter_key);
      if (!definition.permittedResolutionStates.includes(state)) {
        throw new Error(`Resolution state ${state} is not permitted for parameter: ${parameter.parameter_key}.`);
      }
      const carriesValue = resolvesParameterValue(state);
      if (carriesValue !== (observationId !== null)) {
        throw new TypeError('Resolved values require an observation; unknown, conflicting and not_permitted states cannot select one.');
      }
      const observation = carriesValue ? this.getObservation(observationId) : null;
      if (carriesValue && observation?.parameterRecordId !== parameterRecordId) {
        throw new Error('The resolved observation must belong to the parameter.');
      }
      const derivedAuthority = deriveResolutionAuthority({ state, observation, declaredAuthority: authority });
      if (derivedAuthority === 'model' && state !== 'unknown' && !definition.modelExtraction.allowed) {
        throw new Error(`Model extraction is not permitted for parameter: ${parameter.parameter_key}.`);
      }
      assertModelMayReplaceResolution(parameter.resolution_state, derivedAuthority);
      assertResolutionTransition(parameter.resolution_state, state, { authority: derivedAuthority });
      if (state === 'conflicting') {
        const observationCount = this.database.prepare(`SELECT count(*) AS count
          FROM coverage_parameter_observations
          WHERE parameter_record_id = ? AND redacted_at IS NULL`).get(parameterRecordId).count;
        if (observationCount < 2) throw new Error('Conflicting resolution requires at least two observations.');
      }
      if (carriesValue && resolvedValue !== undefined && resolvedValue !== null && !sameJson(resolvedValue, observation.value)) {
        throw new TypeError('The resolved value must equal the selected observation value.');
      }
      const valueJson = carriesValue ? serialize(observation.value, 'resolvedValue') : null;
      this.database.prepare(`UPDATE coverage_parameter_resolutions SET resolution_state = ?,
        resolved_value_json = ?, resolved_observation_id = ?, reason_code = ?, transition_authority = ?,
        updated_by = ?, updated_at = ? WHERE parameter_record_id = ?`).run(
        state, valueJson, observationId, reasonCode, derivedAuthority, updatedBy, at, parameterRecordId,
      );
      this.database.prepare('UPDATE coverage_parameter_records SET updated_at = ? WHERE id = ?').run(at, parameterRecordId);
      return this.getParameter(parameterRecordId);
    });
  }

  /**
   * Privileged erasure path. Redacts every not-yet-redacted observation of a document: the
   * extracted value is nulled and a redaction timestamp and reason code are stamped, while ids,
   * provenance and digests stay for audit. Resolutions that relied on a redacted observation
   * (and conflicts built from it) fall back to `unknown` through a database trigger. An audit
   * event records counts only, never values. Idempotent; the database also redacts on any
   * document deletion request (including consent revocation) as a safety net.
   */
  redactObservationsForDocument({
    documentId, reasonCode, actorType = 'system', actorId = 'coverage-parameter-repository',
    at = this.clock().toISOString(),
  }) {
    requireBounded(documentId, 'documentId');
    requireEnum(reasonCode, 'reasonCode', redactionReasons);
    requireTimestamp(at, 'at');
    requireBounded(actorId, 'actorId');
    return this.#atomic(() => {
      const document = this.database.prepare('SELECT household_id, case_id FROM document_uploads WHERE id = ?').get(documentId);
      if (!document) throw new Error('Document was not found.');
      const pending = this.database.prepare(`SELECT count(*) AS observations,
          count(DISTINCT parameter_record_id) AS parameters
        FROM coverage_parameter_observations WHERE document_id = ? AND redacted_at IS NULL`).get(documentId);
      if (pending.observations === 0) return Object.freeze({ documentId, redactedObservations: 0, affectedParameters: 0, resetResolutions: 0 });
      const resetResolutions = this.database.prepare(`SELECT count(*) AS count
        FROM coverage_parameter_resolutions resolution
        WHERE resolution.resolution_state NOT IN ('unknown', 'not_permitted')
          AND resolution.parameter_record_id IN (
            SELECT parameter_record_id FROM coverage_parameter_observations
            WHERE document_id = ? AND redacted_at IS NULL)
          AND (resolution.resolution_state = 'conflicting' OR resolution.resolved_observation_id IN (
            SELECT id FROM coverage_parameter_observations WHERE document_id = ? AND redacted_at IS NULL))`)
        .get(documentId, documentId).count;
      this.database.prepare(`UPDATE coverage_parameter_observations
        SET value_json = NULL, redacted_at = ?, redaction_reason_code = ?
        WHERE document_id = ? AND redacted_at IS NULL`).run(at, reasonCode, documentId);
      this.audit.append({
        householdId: document.household_id,
        caseId: document.case_id,
        actorType,
        actorId,
        action: 'coverage_parameter.observations_redacted',
        resourceType: 'document',
        resourceId: documentId,
        payload: {
          reasonCode,
          redactedObservations: pending.observations,
          affectedParameters: pending.parameters,
          resetResolutions,
        },
      });
      return Object.freeze({
        documentId,
        redactedObservations: pending.observations,
        affectedParameters: pending.parameters,
        resetResolutions,
      });
    });
  }

  /**
   * Records model-extracted values for one run as unverified evidence, in one transaction.
   * Each entry is one value cited from one sent source page. Observations are appended as
   * `document_extraction` / `not_reviewed`; then every touched parameter is resolved from all
   * of its usable observations: one distinct value gives `extracted_unverified` (model
   * authority), more than one gives `conflicting`. A parameter whose resolution is held by
   * other authority (reported, proven, calculated, dynamic, not_permitted), or whose registry
   * entry forbids model extraction, is left untouched and counted as skipped. Returns counts.
   *
   * `lease` ({ taskId, workerId }) binds the write to the task that produced the values: inside
   * the transaction the task must still be running under that worker and the run must still be
   * queued or running, otherwise TASK_LEASE_LOST is thrown and nothing is written. One
   * counts-only audit event (with `taskKey`) is appended in the same transaction.
   */
  recordModelExtraction({ workflowRunId, entries, recordedBy, lease = null, taskKey = null, at = this.clock().toISOString() }) {
    requireBounded(workflowRunId, 'workflowRunId');
    requireBounded(recordedBy, 'recordedBy');
    requireTimestamp(at, 'at');
    if (taskKey !== null) requireBounded(taskKey, 'taskKey', { max: 40, pattern: /^[a-zA-Z]+$/ });
    if (!Array.isArray(entries) || entries.length > maximumObservationLimit) {
      throw new TypeError(`entries must be an array of at most ${maximumObservationLimit} items.`);
    }
    if (lease !== null) {
      requireBounded(lease?.taskId, 'lease.taskId');
      requireBounded(lease?.workerId, 'lease.workerId', { max: 200, pattern: null });
    }
    return this.#atomic(() => {
      const scope = this.database.prepare(`SELECT run.status, run.case_id, service_case.household_id FROM workflow_runs run
        JOIN service_cases service_case ON service_case.id = run.case_id WHERE run.id = ?`).get(workflowRunId);
      if (lease !== null) {
        const task = this.database.prepare('SELECT status, lease_owner, workflow_run_id FROM workflow_tasks WHERE id = ?').get(lease.taskId);
        if (!scope || !['queued', 'running'].includes(scope.status) || task?.workflow_run_id !== workflowRunId
          || task.status !== 'running' || task.lease_owner !== lease.workerId) {
          throw Object.assign(new Error('The task lease is no longer held; model values were not recorded.'), { code: 'TASK_LEASE_LOST' });
        }
      }
      const records = new Map(this.listForRun(workflowRunId, { limit: maximumRunLimit }).map(record => [record.parameterKey, record]));
      const touched = new Map();
      const skipped = new Set();
      let observations = 0;
      for (const entry of entries) {
        const record = records.get(entry?.parameterKey);
        if (!record) { skipped.add(String(entry?.parameterKey)); continue; }
        const definition = getPolicyParameterDefinition(record.registryVersion, record.parameterKey);
        if (!definition.modelExtraction.allowed || !MODEL_REPLACEABLE_STATES.has(record.resolutionState)
          || !MODEL_REPLACEABLE_AUTHORITIES.has(record.authority)) {
          skipped.add(record.parameterKey);
          continue;
        }
        const observation = this.appendObservation({
          parameterRecordId: record.id,
          sourceId: entry.sourceId,
          documentId: entry.documentId,
          version: entry.version,
          page: entry.page,
          extractionMethod: 'document_extraction',
          reviewStatus: 'not_reviewed',
          value: entry.value,
          sourceDigest: entry.sourceDigest,
          observedAt: at,
          recordedBy,
        });
        observations += 1;
        touched.set(record.id, observation.id);
      }
      let conflicting = 0;
      for (const [parameterRecordId, latestObservationId] of touched) {
        const usable = this.listObservations(parameterRecordId, { limit: maximumObservationLimit })
          .filter(observation => !observation.redactedAt && USABLE_REVIEW_STATUSES.has(observation.reviewStatus));
        const values = new Set(usable.map(observation => JSON.stringify(canonical(observation.value))));
        if (values.size > 1) {
          conflicting += 1;
          this.setResolution({ parameterRecordId, state: 'conflicting', authority: 'model', reasonCode: 'model_observations_conflict', updatedBy: recordedBy, at });
        } else {
          this.setResolution({ parameterRecordId, state: 'extracted_unverified', observationId: latestObservationId, reasonCode: 'model_extracted_unverified', updatedBy: recordedBy, at });
        }
      }
      const counts = Object.freeze({ observations, parameters: touched.size, conflicting, skipped: skipped.size });
      if (observations > 0 && scope) {
        this.audit.append({
          householdId: scope.household_id,
          caseId: scope.case_id,
          action: 'coverage_parameter.model_observations_recorded',
          resourceType: 'workflow_run',
          resourceId: workflowRunId,
          payload: { ...(taskKey ? { taskKey } : {}), ...counts },
        });
      }
      return counts;
    });
  }

  /**
   * Redacts every not-yet-redacted observation recorded for one run (all documents). Used
   * when a run's derived data is erased because its coverage consent or a source's consent
   * is gone. Resolutions built on them fall back to `unknown` through the database trigger.
   * Must run inside the caller's transaction or opens its own. Counts-only audit event.
   */
  redactObservationsForRun({
    workflowRunId, reasonCode, actorType = 'system', actorId = 'coverage-parameter-repository',
    at = this.clock().toISOString(),
  }) {
    requireBounded(workflowRunId, 'workflowRunId');
    requireEnum(reasonCode, 'reasonCode', redactionReasons);
    requireTimestamp(at, 'at');
    requireBounded(actorId, 'actorId');
    return this.#atomic(() => {
      const scope = this.database.prepare(`SELECT run.case_id, service_case.household_id FROM workflow_runs run
        JOIN service_cases service_case ON service_case.id = run.case_id WHERE run.id = ?`).get(workflowRunId);
      if (!scope) return Object.freeze({ workflowRunId, redactedObservations: 0, affectedParameters: 0 });
      const pending = this.database.prepare(`SELECT count(*) AS observations, count(DISTINCT observation.parameter_record_id) AS parameters
        FROM coverage_parameter_observations observation
        JOIN coverage_parameter_records parameter ON parameter.id = observation.parameter_record_id
        WHERE parameter.workflow_run_id = ? AND observation.redacted_at IS NULL`).get(workflowRunId);
      if (pending.observations === 0) return Object.freeze({ workflowRunId, redactedObservations: 0, affectedParameters: 0 });
      this.database.prepare(`UPDATE coverage_parameter_observations
        SET value_json = NULL, redacted_at = ?, redaction_reason_code = ?
        WHERE redacted_at IS NULL AND parameter_record_id IN (
          SELECT id FROM coverage_parameter_records WHERE workflow_run_id = ?)`).run(at, reasonCode, workflowRunId);
      this.audit.append({
        householdId: scope.household_id,
        caseId: scope.case_id,
        actorType,
        actorId,
        action: 'coverage_parameter.run_observations_redacted',
        resourceType: 'workflow_run',
        resourceId: workflowRunId,
        payload: { reasonCode, redactedObservations: pending.observations, affectedParameters: pending.parameters },
      });
      return Object.freeze({ workflowRunId, redactedObservations: pending.observations, affectedParameters: pending.parameters });
    });
  }
}
