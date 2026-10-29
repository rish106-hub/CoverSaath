import { randomUUID } from 'node:crypto';
import { AuditRepository } from './audit-repository.js';
import { CoverageParameterRepository } from './coverage-parameter-repository.js';
import { isDatabaseInterface } from '../database/postgres/db.js';
import { PostgresDatabaseError, classifyDatabaseError } from '../database/postgres/errors.js';
import { householdLock } from '../database/postgres/locks.js';
import {
  getPolicyParameterDefinition,
  getPolicyParameterRegistry,
} from '../../features/coverage-analysis/policy-parameter-registry.js';

// Storage for policy document structuring (ADR 0006, PostgreSQL migrations 007 and 010) on the async
// PostgreSQL interface (S3.2).
// Models propose, deterministic code decides: this repository only records decisions already
// made by deterministic code, never above `extracted_unverified` / `conflicting`, and proposals
// for keys outside the registry as `pending_review`. Every read and write is household-scoped.

const id = prefix => `${prefix}-${randomUUID()}`;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const parameterKeyPattern = /^[a-k]\.[a-z0-9_]+$/;
const proposedKeyPattern = /^[a-z][a-z0-9_]{2,63}$/;
const pipelineVersionPattern = /^[a-z0-9/._+:-]{3,128}$/;
const PROPOSAL_CATEGORIES = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'unassigned']);
// The authority ceiling: structuring never records anything stronger than these states.
const DECISION_STATES = new Set(['extracted_unverified', 'conflicting']);
const DECISION_REASONS = new Set([
  'model_extracted_unverified', 'model_observations_conflict', 'reconciler_conflict', 'per_subject_values',
  'context_differs', 'model_selected_from_conflict',
]);
// Same rules as CoverageParameterRepository.recordModelExtraction.
const MODEL_REPLACEABLE_STATES = new Set(['unknown', 'extracted_unverified', 'conflicting']);
const MODEL_REPLACEABLE_AUTHORITIES = new Set(['model', 'deterministic']);
const USABLE_REVIEW_STATUSES = new Set(['not_reviewed', 'accepted']);

export const STRUCTURING_ERASURE_REASONS = Object.freeze([
  'consent_revoked', 'document_erasure', 'source_consent_not_current', 'retention_expired', 'data_subject_request',
]);
const erasureReasons = new Set(STRUCTURING_ERASURE_REASONS);

const MAX_DECISIONS = 500;
const MAX_OBSERVATIONS_PER_DECISION = 50;
const MAX_PROPOSALS = 1000;
const MAX_TEXT = 500;
const MAX_SUBJECT = 120;
const MAX_LABEL = 120;
const defaultProposalLimit = 100;
const maximumProposalLimit = 500;
const maximumRunParameters = 1000;
const maximumObservations = 500;

const MAX_SKIPPED_CHUNKS = 40;
const reasonPattern = /^[a-z][a-z0-9_]{0,47}$/;
const COVERAGE_CHUNK_KEYS = ['total', 'stored', 'proposed', 'skipped', 'unaccounted'];

function coded(code, message, statusCode) {
  return Object.assign(new Error(message), { code, statusCode });
}

const invalid = message => coded('STRUCTURING_INPUT_INVALID', message, 400);
const decisionInvalid = message => coded('STRUCTURING_DECISION_INVALID', message, 422);
// One error for every scope failure (unknown run, unknown document, other household, inactive
// document) so a caller cannot probe another household's identifiers.
// Coded application errors (STRUCTURING_*, CONSENT_*, ...) pass through; driver, trigger and runtime
// failures become one generic code with the original kept only as `cause` for server-side logs.
// A PostgreSQL SQLSTATE such as P0001 (trigger abort) looks like an application code, so database
// errors are classified first: a transient condition becomes 503 DATABASE_UNAVAILABLE (decision 2,
// no driver text) and every other database or interface error becomes the generic code.
const UNIQUE_VIOLATION = '23505';
function clientSafe(error) {
  const database = classifyDatabaseError(error);
  if (database?.code === 'DATABASE_UNAVAILABLE') return database;
  if (!database && !(error instanceof PostgresDatabaseError)
    && typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(error.code) && !error.code.startsWith('ERR_')) return error;
  return Object.assign(new Error('The structuring result could not be stored.'), {
    code: 'STRUCTURING_COMMIT_FAILED', statusCode: 500, cause: error,
  });
}

const scopeNotFound = () => coded('STRUCTURING_SCOPE_NOT_FOUND', 'The structuring scope was not found.', 404);

function requireBounded(value, name, { max = 128, pattern = identifierPattern } = {}) {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || (pattern && !pattern.test(value))) {
    throw invalid(`${name} must be a valid string of at most ${max} characters.`);
  }
  return value;
}

function requireTimestamp(value, name) {
  requireBounded(value, name, { max: 40, pattern: null });
  if (!Number.isFinite(Date.parse(value))) throw invalid(`${name} must be an ISO timestamp.`);
  return value;
}

function requireLimit(value, fallback, maximum) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw invalid(`limit must be an integer between 1 and ${maximum}.`);
  }
  return value;
}

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isPage = value => Number.isSafeInteger(value) && value > 0;
const isBlockIndex = value => Number.isSafeInteger(value) && value >= 0;

// Value shape produced by the validator: { text, normalized, subject }. Only these fields are kept.
function requireValue(value, name, fail) {
  if (!isPlainObject(value)) throw fail(`${name} must be an object.`);
  const { text, normalized = null, subject = 'policy' } = value;
  if (typeof text !== 'string' || text.trim().length < 1 || text.length > MAX_TEXT) throw fail(`${name}.text is invalid.`);
  if (normalized !== null && !isPlainObject(normalized)) throw fail(`${name}.normalized must be an object or null.`);
  if (typeof subject !== 'string' || subject.length < 1 || subject.length > MAX_SUBJECT) throw fail(`${name}.subject is invalid.`);
  return { text, normalized, subject };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (isPlainObject(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

const squash = text => String(text).toLowerCase().replace(/[\s,]+/g, ' ').trim();

// Deterministic comparison key for an observation value: the normalised value when present, else
// the squashed text, plus the subject. Values of other shapes compare by canonical JSON.
function valueKey(value) {
  if (isPlainObject(value) && typeof value.text === 'string') {
    return JSON.stringify([value.normalized == null ? squash(value.text) : canonical(value.normalized), squash(value.subject ?? 'policy')]);
  }
  return JSON.stringify(canonical(value));
}

function validateDecisions(decisions) {
  if (!Array.isArray(decisions) || decisions.length > MAX_DECISIONS) throw invalid(`decisions must be an array of at most ${MAX_DECISIONS} items.`);
  const seen = new Set();
  return decisions.map((decision, index) => {
    const name = `decisions[${index}]`;
    if (!isPlainObject(decision)) throw decisionInvalid(`${name} must be an object.`);
    const { parameterKey, state, reasonCode, observations } = decision;
    if (typeof parameterKey !== 'string' || parameterKey.length > 128 || !parameterKeyPattern.test(parameterKey)) {
      throw decisionInvalid(`${name}.parameterKey is invalid.`);
    }
    if (seen.has(parameterKey)) throw decisionInvalid(`${name}.parameterKey is repeated.`);
    seen.add(parameterKey);
    if (!DECISION_STATES.has(state)) throw decisionInvalid(`${name}.state exceeds the model authority ceiling.`);
    if (!DECISION_REASONS.has(reasonCode)) throw decisionInvalid(`${name}.reasonCode is not supported.`);
    if (!Array.isArray(observations) || observations.length < 1 || observations.length > MAX_OBSERVATIONS_PER_DECISION) {
      throw decisionInvalid(`${name}.observations must list between 1 and ${MAX_OBSERVATIONS_PER_DECISION} observations.`);
    }
    if (state === 'conflicting' && observations.length < 2) {
      throw decisionInvalid(`${name}: a conflicting decision needs at least two observations.`);
    }
    // A model selection among differing readings (owner decision, ADR 0006) stays extracted_unverified and
    // must name one of the decision's own quotes; every reading is still stored.
    const { selectedQuote } = decision;
    const selecting = reasonCode === 'model_selected_from_conflict';
    if (selecting !== (selectedQuote !== undefined)) throw decisionInvalid(`${name}.selectedQuote must come with model_selected_from_conflict.`);
    if (selecting && (state !== 'extracted_unverified' || observations.length < 2
      || !observations.some(observation => isPlainObject(observation) && observation.evidenceQuote === selectedQuote))) {
      throw decisionInvalid(`${name}.selectedQuote must name one of at least two observations.`);
    }
    return Object.freeze({
      parameterKey,
      state,
      reasonCode,
      selectedQuote: selecting ? selectedQuote : null,
      observations: observations.map((observation, observationIndex) => {
        const label = `${name}.observations[${observationIndex}]`;
        if (!isPlainObject(observation)) throw decisionInvalid(`${label} must be an object.`);
        if (!isPage(observation.page)) throw decisionInvalid(`${label}.page is invalid.`);
        if (observation.blockIndex !== undefined && !isBlockIndex(observation.blockIndex)) throw decisionInvalid(`${label}.blockIndex is invalid.`);
        const { evidenceQuote } = observation;
        if (evidenceQuote !== undefined && (typeof evidenceQuote !== 'string' || evidenceQuote.trim().length < 1 || evidenceQuote.length > MAX_TEXT)) {
          throw decisionInvalid(`${label}.evidenceQuote is invalid.`);
        }
        // The quote and block travel with the value so a reviewer can check one against the other;
        // the whole value is nulled on redaction.
        const evidence = {
          ...(evidenceQuote === undefined ? {} : { evidenceQuote }),
          ...(observation.blockIndex === undefined ? {} : { blockIndex: observation.blockIndex }),
        };
        return { value: { ...requireValue(observation.value, `${label}.value`, decisionInvalid), ...evidence }, page: observation.page };
      }),
    });
  });
}

function validateProposals(proposals) {
  if (!Array.isArray(proposals) || proposals.length > MAX_PROPOSALS) throw invalid(`proposals must be an array of at most ${MAX_PROPOSALS} items.`);
  return proposals.map((proposal, index) => {
    const name = `proposals[${index}]`;
    if (!isPlainObject(proposal)) throw invalid(`${name} must be an object.`);
    const { proposedKey, category, label, evidenceQuote, page, blockIndex } = proposal;
    if (typeof proposedKey !== 'string' || !proposedKeyPattern.test(proposedKey)) throw invalid(`${name}.proposedKey is invalid.`);
    if (!PROPOSAL_CATEGORIES.has(category)) throw invalid(`${name}.category is invalid.`);
    if (typeof label !== 'string' || label.trim().length < 1 || label.length > MAX_LABEL) throw invalid(`${name}.label is invalid.`);
    if (typeof evidenceQuote !== 'string' || evidenceQuote.trim().length < 1 || evidenceQuote.length > MAX_TEXT) {
      throw invalid(`${name}.evidenceQuote is invalid.`);
    }
    if (!isPage(page)) throw invalid(`${name}.page is invalid.`);
    if (!isBlockIndex(blockIndex)) throw invalid(`${name}.blockIndex is invalid.`);
    const value = requireValue(proposal.value, `${name}.value`, invalid);
    return Object.freeze({ proposedKey, category, label, page, blockIndex, valueJson: JSON.stringify({ ...value, evidenceQuote }) });
  });
}

function mapProposal(row) {
  const value = row.value_json == null ? null : JSON.parse(row.value_json);
  return Object.freeze({
    id: row.id,
    structuringRunId: row.structuring_run_id,
    documentId: row.document_id,
    sourcePageId: row.source_page_id,
    registryVersion: row.registry_version,
    proposedKey: row.proposed_key,
    category: row.category,
    label: row.label,
    value,
    page: row.page,
    blockIndex: row.block_index,
    status: row.status,
    createdAt: row.created_at,
  });
}

const JOB_FINISHED_STATUSES = new Set(['committed', 'failed', 'interrupted']);
const JOB_OUTCOMES = new Set(['complete', 'partial_review_required', 'failed']);
const errorCodePattern = /^[A-Z][A-Z0-9_]{1,63}$/;
const MAX_JOB_ATTEMPTS = 1000;

function mapJob(row) {
  if (!row) return null;
  return Object.freeze({
    id: row.id,
    householdId: row.household_id,
    workflowRunId: row.workflow_run_id,
    documentId: row.document_id,
    sourceVersion: row.source_version,
    pipelineVersion: row.pipeline_version,
    status: row.status,
    evidenceOutcome: row.evidence_outcome,
    errorCode: row.error_code,
    attempt: Number(row.attempt),
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
    structuringRunId: row.structuring_run_id,
    erasedAt: row.erased_at,
  });
}

function mapRun(row) {
  if (!row) return null;
  return Object.freeze({
    id: row.id,
    workflowRunId: row.workflow_run_id,
    documentId: row.document_id,
    sourceVersion: row.source_version,
    pipelineVersion: row.pipeline_version,
    counts: Object.freeze(JSON.parse(row.counts_json)),
    createdAt: row.created_at,
    erasedAt: row.erased_at,
    erasureReasonCode: row.erasure_reason_code,
  });
}

const count = (value, name) => {
  if (!Number.isInteger(value) || value < 0 || value > 1_000_000_000) throw invalid(`${name} must be a count.`);
  return value;
};

// Counts-only coverage of one structuring run, stored with the run so skipped chunks stay visible after
// the in-process run ends. Reasons are codes, never document text; the skipped list is bounded.
function validateCoverage(coverage) {
  if (coverage === null || coverage === undefined) return null;
  if (!isPlainObject(coverage) || !isPlainObject(coverage.chunks) || !isPlainObject(coverage.usage)) throw invalid('coverage is invalid.');
  const chunks = Object.fromEntries(COVERAGE_CHUNK_KEYS.map(key => [key, count(coverage.chunks[key], `coverage.chunks.${key}`)]));
  const skipped = Array.isArray(coverage.skippedChunks) ? coverage.skippedChunks : [];
  const skippedChunks = skipped.slice(0, MAX_SKIPPED_CHUNKS).map((entry, index) => {
    if (!isPlainObject(entry) || typeof entry.reason !== 'string' || !reasonPattern.test(entry.reason)) throw invalid(`coverage.skippedChunks[${index}] is invalid.`);
    if (!Number.isInteger(entry.page) || entry.page < 1 || entry.page > 10_000) throw invalid(`coverage.skippedChunks[${index}].page is invalid.`);
    return { page: entry.page, reason: entry.reason };
  });
  const reasons = coverage.rejectedReasons ?? {};
  if (!isPlainObject(reasons) || Object.keys(reasons).length > 20) throw invalid('coverage.rejectedReasons is invalid.');
  const rejectedReasons = Object.fromEntries(Object.entries(reasons).map(([reason, value]) => {
    if (!reasonPattern.test(reason)) throw invalid('coverage.rejectedReasons is invalid.');
    return [reason, count(value, `coverage.rejectedReasons.${reason}`)];
  }));
  const costUsd = coverage.costUsd ?? 0;
  if (!Number.isFinite(costUsd) || costUsd < 0 || costUsd > 1_000) throw invalid('coverage.costUsd is invalid.');
  return {
    chunks,
    skippedChunks,
    skippedTruncated: skipped.length > MAX_SKIPPED_CHUNKS,
    rejectedReasons,
    calls: count(coverage.calls, 'coverage.calls'),
    usage: { inputTokens: count(coverage.usage.inputTokens, 'coverage.usage.inputTokens'), outputTokens: count(coverage.usage.outputTokens, 'coverage.usage.outputTokens') },
    costUsd: Math.round(costUsd * 1e6) / 1e6,
  };
}

// Stored evidence outcome (counts and codes only). A failed outcome is never committed.
const STORED_OUTCOMES = new Set(['complete', 'partial_review_required']);
const MAX_OUTCOME_REASONS = 10;
function validateOutcome(outcome) {
  if (outcome === null || outcome === undefined) return null;
  if (!isPlainObject(outcome) || !STORED_OUTCOMES.has(outcome.evidenceOutcome)) throw invalid('outcome is invalid.');
  const { reasons = [], missingCriticalKeys = [] } = outcome;
  if (!Array.isArray(reasons) || reasons.length > MAX_OUTCOME_REASONS || reasons.some(reason => typeof reason !== 'string' || !reasonPattern.test(reason))) {
    throw invalid('outcome.reasons is invalid.');
  }
  if (!Array.isArray(missingCriticalKeys) || missingCriticalKeys.length > 40
    || missingCriticalKeys.some(key => typeof key !== 'string' || !parameterKeyPattern.test(key))) {
    throw invalid('outcome.missingCriticalKeys is invalid.');
  }
  return { evidenceOutcome: outcome.evidenceOutcome, reasons: [...reasons], missingCriticalKeys: [...missingCriticalKeys] };
}

export class PolicyStructuringRepository {
  constructor(database, { clock = () => new Date(), audit = null, coverageParameters = null } = {}) {
    if (!isDatabaseInterface(database)) throw new TypeError('A database is required.');
    this.database = database;
    this.clock = clock;
    this.audit = audit ?? new AuditRepository(database, { clock });
    this.coverageParameters = coverageParameters ?? new CoverageParameterRepository(database, { clock, audit: this.audit });
  }

  // One transaction (a savepoint inside a caller's transaction) that takes the household advisory
  // lock first (lock order, design section 3). It serialises commits, attempts and erasure of one
  // household, so a replayed or concurrent commit sees the first one's run row.
  #atomic(householdId, work) {
    return this.database.transaction(work, { locks: [householdLock(householdId)] });
  }

  // Run and document must both belong to the household and the run's case; the document must be
  // active. Any failure is the same coded error.
  async #scope({ householdId, workflowRunId, documentId, requireActive }) {
    const row = await this.database.one(`SELECT run.case_id, run.status AS run_status,
        document.lifecycle_state, document.case_id AS document_case_id
      FROM workflow_runs run
      JOIN service_cases service_case ON service_case.id = run.case_id
      JOIN document_uploads document ON document.id = ?
      WHERE run.id = ? AND service_case.household_id = ? AND document.household_id = ?`,
    [documentId, workflowRunId, householdId, householdId]);
    if (!row || row.document_case_id !== row.case_id) throw scopeNotFound();
    if (requireActive && row.lifecycle_state !== 'active') throw scopeNotFound();
    return row;
  }

  async #requireDocumentInHousehold(householdId, documentId) {
    const row = await this.database.one('SELECT 1 AS found FROM document_uploads WHERE id = ? AND household_id = ?', [documentId, householdId]);
    if (!row) throw scopeNotFound();
  }

  /**
   * Commits one document's structuring result for one run in a single transaction:
   * scope check, caller consent re-check, idempotent replay, page resolution, model observations
   * and resolutions for registry keys (never above extracted_unverified / conflicting), proposals
   * for keys outside the registry, the counts-only run row and one counts-only audit event.
   * Any failure rolls everything back. Returns counts; a replay returns the stored counts.
   * consentCheck may be synchronous or async; it is awaited inside the transaction and a throw or
   * rejection writes nothing.
   */
  async commitStructuring({
    householdId, workflowRunId, documentId, sourceVersion, pipelineVersion, registryVersion, recordedBy,
    decisions = [], proposals = [], coverage = null, outcome = null, consentCheck, at = this.clock().toISOString(),
  } = {}) {
    requireBounded(householdId, 'householdId');
    requireBounded(workflowRunId, 'workflowRunId');
    requireBounded(documentId, 'documentId');
    requireBounded(sourceVersion, 'sourceVersion', { pattern: null });
    if (typeof pipelineVersion !== 'string' || !pipelineVersionPattern.test(pipelineVersion)) throw invalid('pipelineVersion is invalid.');
    requireBounded(registryVersion, 'registryVersion', { max: 64, pattern: null });
    try { getPolicyParameterRegistry(registryVersion); } catch { throw invalid('registryVersion is not supported.'); }
    requireBounded(recordedBy, 'recordedBy');
    requireTimestamp(at, 'at');
    if (typeof consentCheck !== 'function') throw invalid('consentCheck is required.');
    const checkedDecisions = validateDecisions(decisions);
    const checkedProposals = validateProposals(proposals);
    const checkedCoverage = validateCoverage(coverage);
    const checkedOutcome = validateOutcome(outcome);

    try {
      return await this.#commit({
        householdId, workflowRunId, documentId, sourceVersion, pipelineVersion, registryVersion, recordedBy,
        decisions: checkedDecisions, proposals: checkedProposals, coverage: checkedCoverage, outcome: checkedOutcome, consentCheck, at,
      });
    } catch (error) {
      throw clientSafe(error);
    }
  }

  #commit({
    householdId, workflowRunId, documentId, sourceVersion, pipelineVersion, registryVersion, recordedBy,
    decisions: checkedDecisions, proposals: checkedProposals, coverage, outcome, consentCheck, at,
  }) {
    return this.#atomic(householdId, async () => {
      const scope = await this.#scope({ householdId, workflowRunId, documentId, requireActive: true });
      // Consent is re-checked inside the transaction, immediately before anything is written.
      await consentCheck();
      const existing = await this.database.one(`SELECT * FROM policy_structuring_runs
        WHERE workflow_run_id = ? AND document_id = ? AND source_version = ? AND pipeline_version = ?
          AND erased_at IS NULL`, [workflowRunId, documentId, sourceVersion, pipelineVersion]);
      if (existing) return Object.freeze({ replayed: true, structuringRunId: existing.id, ...JSON.parse(existing.counts_json) });
      if (!['queued', 'running', 'completed'].includes(scope.run_status)) {
        throw coded('STRUCTURING_RUN_NOT_ACTIVE', 'The run no longer accepts structuring results.', 409);
      }
      const pin = await this.coverageParameters.getRegistryPin(workflowRunId);
      if (pin && pin.registryVersion !== registryVersion) {
        throw coded('STRUCTURING_REGISTRY_MISMATCH', 'The registry version does not match the run.', 409);
      }

      const pages = new Map();
      const pageNumbers = [
        ...checkedDecisions.flatMap(decision => decision.observations.map(observation => observation.page)),
        ...checkedProposals.map(proposal => proposal.page),
      ];
      for (const page of new Set(pageNumbers)) {
        const row = await this.database.one(`SELECT id, page_sha256 FROM source_pages
          WHERE document_upload_id = ? AND source_version = ? AND page_number = ?`, [documentId, sourceVersion, page]);
        if (!row) throw coded('STRUCTURING_PAGE_NOT_FOUND', 'A cited page was not found for the document version.', 422);
        pages.set(page, row);
      }

      const listed = await this.coverageParameters.listForRun(workflowRunId, { limit: maximumRunParameters });
      const records = new Map(listed.map(record => [record.parameterKey, record]));
      let observations = 0;
      let parameters = 0;
      let conflicting = 0;
      let skippedKeys = 0;
      for (const decision of checkedDecisions) {
        const record = records.get(decision.parameterKey);
        if (!record) { skippedKeys += 1; continue; }
        const definition = getPolicyParameterDefinition(record.registryVersion, record.parameterKey);
        if (!definition.modelExtraction.allowed || !MODEL_REPLACEABLE_STATES.has(record.resolutionState)
          || !MODEL_REPLACEABLE_AUTHORITIES.has(record.authority)) {
          skippedKeys += 1;
          continue;
        }
        const prior = (await this.coverageParameters.listObservations(record.id, { limit: maximumObservations }))
          .filter(observation => !observation.redactedAt && USABLE_REVIEW_STATUSES.has(observation.reviewStatus));
        let latestObservationId = null;
        let selectedObservationId = null;
        for (const observation of decision.observations) {
          const page = pages.get(observation.page);
          latestObservationId = (await this.coverageParameters.appendObservation({
            parameterRecordId: record.id,
            sourceId: page.id,
            documentId,
            version: sourceVersion,
            page: observation.page,
            extractionMethod: 'document_extraction',
            reviewStatus: 'not_reviewed',
            value: observation.value,
            sourceDigest: page.page_sha256,
            observedAt: at,
            recordedBy,
          })).id;
          if (decision.selectedQuote !== null && selectedObservationId === null && observation.value.evidenceQuote === decision.selectedQuote) {
            selectedObservationId = latestObservationId;
          }
          observations += 1;
        }
        parameters += 1;
        // A value already recorded for this parameter from another source that disagrees with
        // this decision makes the parameter conflicting; the model never silently wins.
        const keys = new Set([...prior.map(observation => valueKey(observation.value)), ...decision.observations.map(observation => valueKey(observation.value))]);
        const disagreesWithPrior = decision.state === 'extracted_unverified' && prior.length > 0 && keys.size > 1;
        if (decision.state === 'conflicting' || disagreesWithPrior) {
          conflicting += 1;
          await this.coverageParameters.setResolution({
            parameterRecordId: record.id, state: 'conflicting', authority: 'model',
            reasonCode: disagreesWithPrior ? 'model_observations_conflict' : decision.reasonCode, updatedBy: recordedBy, at,
          });
        } else {
          await this.coverageParameters.setResolution({
            parameterRecordId: record.id, state: 'extracted_unverified', observationId: selectedObservationId ?? latestObservationId,
            reasonCode: decision.reasonCode, updatedBy: recordedBy, at,
          });
        }
      }

      const counts = Object.freeze({ observations, parameters, conflicting, skippedKeys, proposals: checkedProposals.length });
      const structuringRunId = id('structuring');
      await this.database.run(`INSERT INTO policy_structuring_runs
        (id, household_id, case_id, workflow_run_id, document_id, source_version, pipeline_version, counts_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        structuringRunId, householdId, scope.case_id, workflowRunId, documentId, sourceVersion, pipelineVersion,
        JSON.stringify({ ...counts, ...(coverage ? { coverage } : {}), ...(outcome ? { outcome } : {}) }), at,
      ]);
      for (const proposal of checkedProposals) {
        await this.database.run(`INSERT INTO proposed_parameters
          (id, structuring_run_id, household_id, document_id, source_page_id, registry_version, proposed_key,
           category, label, value_json, page, block_index, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_review', ?)`, [
          id('proposal'), structuringRunId, householdId, documentId, pages.get(proposal.page).id, registryVersion,
          proposal.proposedKey, proposal.category, proposal.label, proposal.valueJson, proposal.page, proposal.blockIndex, at,
        ]);
      }
      await this.audit.append({
        householdId,
        caseId: scope.case_id,
        action: 'policy_structuring.committed',
        resourceType: 'document',
        resourceId: documentId,
        payload: { structuringRunId, ...counts },
      });
      return Object.freeze({ replayed: false, structuringRunId, ...counts });
    });
  }

  /**
   * Unredacted proposals of one structuring run of one document, household-scoped and bounded.
   * The run id is required: another run on the same document never contributes proposals.
   */
  async listProposals({ householdId, documentId, structuringRunId, limit } = {}) {
    requireBounded(householdId, 'householdId');
    requireBounded(documentId, 'documentId');
    requireBounded(structuringRunId, 'structuringRunId');
    const bound = requireLimit(limit, defaultProposalLimit, maximumProposalLimit);
    await this.#requireDocumentInHousehold(householdId, documentId);
    return (await this.database.many(`SELECT * FROM proposed_parameters
      WHERE structuring_run_id = ? AND document_id = ? AND household_id = ? AND redacted_at IS NULL
      ORDER BY page, block_index, id LIMIT ?`, [structuringRunId, documentId, householdId, bound])).map(mapProposal);
  }

  /** The most recent structuring run (counts only) of one document for one run, or null. */
  async getStructuringRun({ householdId, workflowRunId, documentId } = {}) {
    requireBounded(householdId, 'householdId');
    requireBounded(workflowRunId, 'workflowRunId');
    requireBounded(documentId, 'documentId');
    await this.#scope({ householdId, workflowRunId, documentId, requireActive: false });
    return mapRun(await this.database.one(`SELECT * FROM policy_structuring_runs
      WHERE workflow_run_id = ? AND document_id = ? AND household_id = ?
      ORDER BY created_at DESC, id DESC LIMIT 1`, [workflowRunId, documentId, householdId]));
  }

  /**
   * Durable job state (PostgreSQL 010): records a new running attempt for one document and one run,
   * numbered after the previous attempt. Identifiers and codes only. A second active attempt for the
   * same key is refused by the partial unique index and reported as STRUCTURING_ALREADY_RUNNING.
   */
  async startJob({ householdId, workflowRunId, documentId, sourceVersion, pipelineVersion, consentGrantId, at = this.clock().toISOString() } = {}) {
    requireBounded(householdId, 'householdId');
    requireBounded(workflowRunId, 'workflowRunId');
    requireBounded(documentId, 'documentId');
    requireBounded(sourceVersion, 'sourceVersion', { pattern: null });
    if (typeof pipelineVersion !== 'string' || !pipelineVersionPattern.test(pipelineVersion)) throw invalid('pipelineVersion is invalid.');
    requireBounded(consentGrantId, 'consentGrantId');
    requireTimestamp(at, 'at');
    try {
      return await this.#atomic(householdId, async () => {
        const scope = await this.#scope({ householdId, workflowRunId, documentId, requireActive: true });
        const previous = (await this.database.one(`SELECT max(attempt) AS attempt FROM policy_structuring_jobs
          WHERE workflow_run_id = ? AND document_id = ?`, [workflowRunId, documentId]))?.attempt;
        const attempt = Number(previous ?? 0) + 1;
        if (attempt > MAX_JOB_ATTEMPTS) throw coded('STRUCTURING_ATTEMPTS_EXHAUSTED', 'Too many structuring attempts for this document.', 409);
        const jobId = id('structuring-job');
        await this.database.run(`INSERT INTO policy_structuring_jobs
          (id, household_id, case_id, workflow_run_id, document_id, source_version, pipeline_version, status, attempt,
           consent_grant_id, started_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)`, [
          jobId, householdId, scope.case_id, workflowRunId, documentId, sourceVersion, pipelineVersion, attempt, consentGrantId, at, at,
        ]);
        return mapJob(await this.database.one('SELECT * FROM policy_structuring_jobs WHERE id = ?', [jobId]));
      });
    } catch (error) {
      if (error?.code === UNIQUE_VIOLATION) {
        throw coded('STRUCTURING_ALREADY_RUNNING', 'A structuring attempt is already running.', 409);
      }
      throw clientSafe(error);
    }
  }

  /** Finishes a running attempt with codes only. A finished attempt is final (database guard). */
  async finishJob({ jobId, status, evidenceOutcome = null, errorCode = null, structuringRunId = null, at = this.clock().toISOString() } = {}) {
    requireBounded(jobId, 'jobId');
    if (!JOB_FINISHED_STATUSES.has(status)) throw invalid('status is invalid.');
    if (evidenceOutcome !== null && !JOB_OUTCOMES.has(evidenceOutcome)) throw invalid('evidenceOutcome is invalid.');
    if (errorCode !== null && (typeof errorCode !== 'string' || !errorCodePattern.test(errorCode))) throw invalid('errorCode is invalid.');
    if (structuringRunId !== null) requireBounded(structuringRunId, 'structuringRunId');
    requireTimestamp(at, 'at');
    const { changes } = await this.database.run(`UPDATE policy_structuring_jobs
      SET status = ?, evidence_outcome = ?, error_code = ?, structuring_run_id = ?, finished_at = ?, updated_at = ?
      WHERE id = ? AND status IN ('queued', 'running')`, [status, evidenceOutcome, errorCode, structuringRunId, at, at, jobId]);
    return changes === 1;
  }

  /**
   * Lease heartbeat: the owning process refreshes `updated_at` of its active attempt. An attempt whose
   * `updated_at` is older than the lease is treated as abandoned by interruptRunningJobs. Returns false
   * when the attempt is no longer active (finished, interrupted).
   */
  async heartbeatJob({ jobId, at = this.clock().toISOString() } = {}) {
    requireBounded(jobId, 'jobId');
    requireTimestamp(at, 'at');
    const { changes } = await this.database.run(`UPDATE policy_structuring_jobs SET updated_at = ?
      WHERE id = ? AND status IN ('queued', 'running')`, [at, jobId]);
    return changes === 1;
  }

  /**
   * Recovery: active attempts become interrupted. Nothing is re-dispatched; a new paid attempt needs an
   * explicit restart request. One counts-only audit event.
   *
   * With `leaseMs` (a non-negative integer) only attempts whose lease expired are interrupted: those with
   * `updated_at` at or before `at - leaseMs`. A live process on a shared database refreshes `updated_at`
   * through heartbeatJob, so its attempts survive another instance's recovery. Without `leaseMs`, every
   * active attempt is interrupted (single-process takeover; the old behaviour).
   */
  async interruptRunningJobs({ at = this.clock().toISOString(), leaseMs = null } = {}) {
    requireTimestamp(at, 'at');
    if (leaseMs !== null && (!Number.isSafeInteger(leaseMs) || leaseMs < 0)) throw invalid('leaseMs is invalid.');
    // Timestamps are fixed-width UTC ISO text, so text comparison is time order.
    const cutoff = leaseMs === null ? '9999-12-31T23:59:59.999Z' : new Date(Date.parse(at) - leaseMs).toISOString();
    return this.#atomic(null, async () => {
      const jobs = (await this.database.run(`UPDATE policy_structuring_jobs
        SET status = 'interrupted', error_code = 'STRUCTURING_INTERRUPTED', finished_at = ?, updated_at = ?
        WHERE status IN ('queued', 'running') AND updated_at <= ?`, [at, at, cutoff])).changes;
      if (jobs > 0) {
        await this.audit.append({
          action: 'policy_structuring.jobs_interrupted', resourceType: 'policy_structuring_jobs', resourceId: 'process_start',
          actorId: 'policy-structuring-repository', payload: { jobs },
        });
      }
      return jobs;
    });
  }

  /** The latest attempt of one document for one run (household-scoped), or null. */
  async latestJob({ householdId, workflowRunId, documentId } = {}) {
    requireBounded(householdId, 'householdId');
    requireBounded(workflowRunId, 'workflowRunId');
    requireBounded(documentId, 'documentId');
    await this.#scope({ householdId, workflowRunId, documentId, requireActive: false });
    return mapJob(await this.database.one(`SELECT * FROM policy_structuring_jobs
      WHERE workflow_run_id = ? AND document_id = ? AND household_id = ?
      ORDER BY attempt DESC LIMIT 1`, [workflowRunId, documentId, householdId]));
  }

  /**
   * Erasure path for structuring output. For the given documents (household-scoped when
   * `householdId` is given) and workflow runs: proposals are redacted (label and value nulled),
   * observations written by those structuring runs are redacted, and the structuring runs and jobs
   * are stamped erased. One counts-only audit event. Idempotent. Joins the caller's transaction
   * (savepoint) and takes the household lock first.
   */
  async eraseDerived({
    householdId = null, documentIds = [], workflowRunIds = [], reasonCode, caseId = null,
    resourceType = 'document', resourceId = null, actorType = 'system', actorId = 'policy-structuring-repository',
    at = this.clock().toISOString(),
  } = {}) {
    if (!erasureReasons.has(reasonCode)) throw invalid('reasonCode is not supported.');
    if (!Array.isArray(documentIds) || !Array.isArray(workflowRunIds)) throw invalid('documentIds and workflowRunIds must be arrays.');
    requireTimestamp(at, 'at');
    // A NULL household erases by document id across households, as before; it is never a filter value.
    const householdFilter = householdId !== null ? ' AND household_id = ?' : '';
    const householdParams = householdId !== null ? [householdId] : [];
    return this.#atomic(householdId, async () => {
      const runIds = new Set();
      for (const documentId of new Set(documentIds)) {
        const rows = await this.database.many(`SELECT id FROM policy_structuring_runs WHERE document_id = ?${householdFilter}`,
          [documentId, ...householdParams]);
        for (const row of rows) runIds.add(row.id);
      }
      for (const workflowRunId of new Set(workflowRunIds)) {
        const rows = await this.database.many('SELECT id FROM policy_structuring_runs WHERE workflow_run_id = ?', [workflowRunId]);
        for (const row of rows) runIds.add(row.id);
      }
      let proposals = 0;
      let observations = 0;
      let runs = 0;
      let jobs = 0;
      // Jobs hold identifiers and codes only; they are stamped erased (status kept) so an erased attempt
      // never asks for a restart.
      for (const documentId of new Set(documentIds)) {
        jobs += (await this.database.run(`UPDATE policy_structuring_jobs
          SET erased_at = ?, erasure_reason_code = ? WHERE document_id = ? AND erased_at IS NULL${householdFilter}`,
        [at, reasonCode, documentId, ...householdParams])).changes;
      }
      for (const workflowRunId of new Set(workflowRunIds)) {
        jobs += (await this.database.run(`UPDATE policy_structuring_jobs
          SET erased_at = ?, erasure_reason_code = ? WHERE workflow_run_id = ? AND erased_at IS NULL`,
        [at, reasonCode, workflowRunId])).changes;
      }
      for (const documentId of new Set(documentIds)) {
        proposals += (await this.database.run(`UPDATE proposed_parameters
          SET label = NULL, value_json = NULL, redacted_at = ?, redaction_reason_code = ?
          WHERE document_id = ? AND redacted_at IS NULL${householdFilter}`, [at, reasonCode, documentId, ...householdParams])).changes;
      }
      for (const runId of runIds) {
        proposals += (await this.database.run(`UPDATE proposed_parameters
          SET label = NULL, value_json = NULL, redacted_at = ?, redaction_reason_code = ?
          WHERE structuring_run_id = ? AND redacted_at IS NULL`, [at, reasonCode, runId])).changes;
        // Observations a structuring run wrote: its document's observations on its run's parameters.
        observations += (await this.database.run(`UPDATE coverage_parameter_observations
          SET value_json = NULL, redacted_at = ?, redaction_reason_code = ?
          WHERE redacted_at IS NULL AND extraction_method = 'document_extraction'
            AND document_id = (SELECT document_id FROM policy_structuring_runs WHERE id = ?)
            AND parameter_record_id IN (SELECT id FROM coverage_parameter_records WHERE workflow_run_id =
              (SELECT workflow_run_id FROM policy_structuring_runs WHERE id = ?))`, [at, reasonCode, runId, runId])).changes;
        runs += (await this.database.run(`UPDATE policy_structuring_runs
          SET erased_at = ?, erasure_reason_code = ? WHERE id = ? AND erased_at IS NULL`, [at, reasonCode, runId])).changes;
      }
      const counts = Object.freeze({ proposals, observations, runs, jobs });
      if (proposals > 0 || observations > 0 || runs > 0 || jobs > 0) {
        await this.audit.append({
          householdId,
          caseId,
          actorType,
          actorId,
          action: 'policy_structuring.erased',
          resourceType,
          resourceId: resourceId ?? documentIds[0] ?? workflowRunIds[0] ?? 'policy_structuring',
          payload: { reasonCode, ...counts, documents: new Set(documentIds).size, workflowRuns: new Set(workflowRunIds).size },
        });
      }
      return counts;
    });
  }
}
