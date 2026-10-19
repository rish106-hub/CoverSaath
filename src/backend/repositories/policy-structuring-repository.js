import { randomUUID } from 'node:crypto';
import { AuditRepository } from './audit-repository.js';
import { CoverageParameterRepository } from './coverage-parameter-repository.js';
import {
  getPolicyParameterDefinition,
  getPolicyParameterRegistry,
} from '../../modules/coverage-analysis/policy-parameter-registry.js';

// Storage for policy document structuring (ADR 0006, SQLite migration 011, PostgreSQL 007).
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
function clientSafe(error) {
  if (typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(error.code) && !error.code.startsWith('ERR_')) return error;
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

export class PolicyStructuringRepository {
  constructor(database, { clock = () => new Date(), audit = null, coverageParameters = null } = {}) {
    if (!database?.prepare || !database?.exec) throw new TypeError('A database is required.');
    this.database = database;
    this.clock = clock;
    this.audit = audit ?? new AuditRepository(database, { clock });
    this.coverageParameters = coverageParameters ?? new CoverageParameterRepository(database, { clock, audit: this.audit });
  }

  // Same transaction model as CoverageParameterRepository: joins an open transaction through a
  // savepoint, otherwise opens BEGIN IMMEDIATE (which also serialises concurrent commits).
  #atomic(work) {
    const savepoint = `policy_structuring_${randomUUID().replaceAll('-', '')}`;
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

  // Run and document must both belong to the household and the run's case; the document must be
  // active. Any failure is the same coded error.
  #scope({ householdId, workflowRunId, documentId, requireActive }) {
    const row = this.database.prepare(`SELECT run.case_id, run.status AS run_status,
        document.lifecycle_state, document.case_id AS document_case_id
      FROM workflow_runs run
      JOIN service_cases service_case ON service_case.id = run.case_id
      JOIN document_uploads document ON document.id = ?
      WHERE run.id = ? AND service_case.household_id = ? AND document.household_id = ?`)
      .get(documentId, workflowRunId, householdId, householdId);
    if (!row || row.document_case_id !== row.case_id) throw scopeNotFound();
    if (requireActive && row.lifecycle_state !== 'active') throw scopeNotFound();
    return row;
  }

  #requireDocumentInHousehold(householdId, documentId) {
    const row = this.database.prepare('SELECT 1 FROM document_uploads WHERE id = ? AND household_id = ?').get(documentId, householdId);
    if (!row) throw scopeNotFound();
  }

  /**
   * Commits one document's structuring result for one run in a single transaction:
   * scope check, caller consent re-check, idempotent replay, page resolution, model observations
   * and resolutions for registry keys (never above extracted_unverified / conflicting), proposals
   * for keys outside the registry, the counts-only run row and one counts-only audit event.
   * Any failure rolls everything back. Returns counts; a replay returns the stored counts.
   */
  commitStructuring({
    householdId, workflowRunId, documentId, sourceVersion, pipelineVersion, registryVersion, recordedBy,
    decisions = [], proposals = [], coverage = null, consentCheck, at = this.clock().toISOString(),
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

    try {
      return this.#commit({
        householdId, workflowRunId, documentId, sourceVersion, pipelineVersion, registryVersion, recordedBy,
        decisions: checkedDecisions, proposals: checkedProposals, coverage: checkedCoverage, consentCheck, at,
      });
    } catch (error) {
      throw clientSafe(error);
    }
  }

  #commit({
    householdId, workflowRunId, documentId, sourceVersion, pipelineVersion, registryVersion, recordedBy,
    decisions: checkedDecisions, proposals: checkedProposals, coverage, consentCheck, at,
  }) {
    return this.#atomic(() => {
      const scope = this.#scope({ householdId, workflowRunId, documentId, requireActive: true });
      // Consent is re-checked inside the transaction, immediately before anything is written.
      const pending = consentCheck();
      if (pending && typeof pending.then === 'function') {
        Promise.resolve(pending).catch(() => {});
        throw invalid('consentCheck must be synchronous.');
      }
      const existing = this.database.prepare(`SELECT * FROM policy_structuring_runs
        WHERE workflow_run_id = ? AND document_id = ? AND source_version = ? AND pipeline_version = ?
          AND erased_at IS NULL`).get(workflowRunId, documentId, sourceVersion, pipelineVersion);
      if (existing) return Object.freeze({ replayed: true, structuringRunId: existing.id, ...JSON.parse(existing.counts_json) });
      if (!['queued', 'running', 'completed'].includes(scope.run_status)) {
        throw coded('STRUCTURING_RUN_NOT_ACTIVE', 'The run no longer accepts structuring results.', 409);
      }
      const pin = this.coverageParameters.getRegistryPin(workflowRunId);
      if (pin && pin.registryVersion !== registryVersion) {
        throw coded('STRUCTURING_REGISTRY_MISMATCH', 'The registry version does not match the run.', 409);
      }

      const pageLookup = this.database.prepare(`SELECT id, page_sha256 FROM source_pages
        WHERE document_upload_id = ? AND source_version = ? AND page_number = ?`);
      const pages = new Map();
      const pageNumbers = [
        ...checkedDecisions.flatMap(decision => decision.observations.map(observation => observation.page)),
        ...checkedProposals.map(proposal => proposal.page),
      ];
      for (const page of new Set(pageNumbers)) {
        const row = pageLookup.get(documentId, sourceVersion, page);
        if (!row) throw coded('STRUCTURING_PAGE_NOT_FOUND', 'A cited page was not found for the document version.', 422);
        pages.set(page, row);
      }

      const records = new Map(this.coverageParameters.listForRun(workflowRunId, { limit: maximumRunParameters })
        .map(record => [record.parameterKey, record]));
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
        const prior = this.coverageParameters.listObservations(record.id, { limit: maximumObservations })
          .filter(observation => !observation.redactedAt && USABLE_REVIEW_STATUSES.has(observation.reviewStatus));
        let latestObservationId = null;
        let selectedObservationId = null;
        for (const observation of decision.observations) {
          const page = pages.get(observation.page);
          latestObservationId = this.coverageParameters.appendObservation({
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
          }).id;
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
          this.coverageParameters.setResolution({
            parameterRecordId: record.id, state: 'conflicting', authority: 'model',
            reasonCode: disagreesWithPrior ? 'model_observations_conflict' : decision.reasonCode, updatedBy: recordedBy, at,
          });
        } else {
          this.coverageParameters.setResolution({
            parameterRecordId: record.id, state: 'extracted_unverified', observationId: selectedObservationId ?? latestObservationId,
            reasonCode: decision.reasonCode, updatedBy: recordedBy, at,
          });
        }
      }

      const counts = Object.freeze({ observations, parameters, conflicting, skippedKeys, proposals: checkedProposals.length });
      const structuringRunId = id('structuring');
      this.database.prepare(`INSERT INTO policy_structuring_runs
        (id, household_id, case_id, workflow_run_id, document_id, source_version, pipeline_version, counts_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        structuringRunId, householdId, scope.case_id, workflowRunId, documentId, sourceVersion, pipelineVersion,
        JSON.stringify(coverage ? { ...counts, coverage } : counts), at,
      );
      const insertProposal = this.database.prepare(`INSERT INTO proposed_parameters
        (id, structuring_run_id, household_id, document_id, source_page_id, registry_version, proposed_key,
         category, label, value_json, page, block_index, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_review', ?)`);
      for (const proposal of checkedProposals) {
        insertProposal.run(
          id('proposal'), structuringRunId, householdId, documentId, pages.get(proposal.page).id, registryVersion,
          proposal.proposedKey, proposal.category, proposal.label, proposal.valueJson, proposal.page, proposal.blockIndex, at,
        );
      }
      this.audit.append({
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

  /** Unredacted proposals of one document, household-scoped and bounded. */
  listProposals({ householdId, documentId, limit } = {}) {
    requireBounded(householdId, 'householdId');
    requireBounded(documentId, 'documentId');
    const bound = requireLimit(limit, defaultProposalLimit, maximumProposalLimit);
    this.#requireDocumentInHousehold(householdId, documentId);
    return this.database.prepare(`SELECT * FROM proposed_parameters
      WHERE document_id = ? AND household_id = ? AND redacted_at IS NULL
      ORDER BY page, block_index, id LIMIT ?`).all(documentId, householdId, bound).map(mapProposal);
  }

  /** The most recent structuring run (counts only) of one document for one run, or null. */
  getStructuringRun({ householdId, workflowRunId, documentId } = {}) {
    requireBounded(householdId, 'householdId');
    requireBounded(workflowRunId, 'workflowRunId');
    requireBounded(documentId, 'documentId');
    this.#scope({ householdId, workflowRunId, documentId, requireActive: false });
    return mapRun(this.database.prepare(`SELECT * FROM policy_structuring_runs
      WHERE workflow_run_id = ? AND document_id = ? AND household_id = ?
      ORDER BY created_at DESC, id DESC LIMIT 1`).get(workflowRunId, documentId, householdId));
  }

  /**
   * Erasure path for structuring output. For the given documents (household-scoped when
   * `householdId` is given) and workflow runs: proposals are redacted (label and value nulled),
   * observations written by those structuring runs are redacted, and the structuring runs are
   * stamped erased. One counts-only audit event. Idempotent. Joins the caller's transaction.
   */
  eraseDerived({
    householdId = null, documentIds = [], workflowRunIds = [], reasonCode, caseId = null,
    resourceType = 'document', resourceId = null, actorType = 'system', actorId = 'policy-structuring-repository',
    at = this.clock().toISOString(),
  } = {}) {
    if (!erasureReasons.has(reasonCode)) throw invalid('reasonCode is not supported.');
    if (!Array.isArray(documentIds) || !Array.isArray(workflowRunIds)) throw invalid('documentIds and workflowRunIds must be arrays.');
    requireTimestamp(at, 'at');
    return this.#atomic(() => {
      const runIds = new Set();
      const byDocument = this.database.prepare(`SELECT id FROM policy_structuring_runs
        WHERE document_id = ? AND (? IS NULL OR household_id = ?)`);
      const byWorkflowRun = this.database.prepare('SELECT id FROM policy_structuring_runs WHERE workflow_run_id = ?');
      for (const documentId of new Set(documentIds)) {
        for (const row of byDocument.all(documentId, householdId, householdId)) runIds.add(row.id);
      }
      for (const workflowRunId of new Set(workflowRunIds)) {
        for (const row of byWorkflowRun.all(workflowRunId)) runIds.add(row.id);
      }
      let proposals = 0;
      let observations = 0;
      let runs = 0;
      const redactProposalsOfRun = this.database.prepare(`UPDATE proposed_parameters
        SET label = NULL, value_json = NULL, redacted_at = ?, redaction_reason_code = ?
        WHERE structuring_run_id = ? AND redacted_at IS NULL`);
      const redactProposalsOfDocument = this.database.prepare(`UPDATE proposed_parameters
        SET label = NULL, value_json = NULL, redacted_at = ?, redaction_reason_code = ?
        WHERE document_id = ? AND redacted_at IS NULL AND (? IS NULL OR household_id = ?)`);
      // Observations a structuring run wrote: its document's observations on its run's parameters.
      const redactObservations = this.database.prepare(`UPDATE coverage_parameter_observations
        SET value_json = NULL, redacted_at = ?, redaction_reason_code = ?
        WHERE redacted_at IS NULL AND extraction_method = 'document_extraction'
          AND document_id = (SELECT document_id FROM policy_structuring_runs WHERE id = ?)
          AND parameter_record_id IN (SELECT id FROM coverage_parameter_records WHERE workflow_run_id =
            (SELECT workflow_run_id FROM policy_structuring_runs WHERE id = ?))`);
      const stampRun = this.database.prepare(`UPDATE policy_structuring_runs
        SET erased_at = ?, erasure_reason_code = ? WHERE id = ? AND erased_at IS NULL`);
      for (const documentId of new Set(documentIds)) {
        proposals += Number(redactProposalsOfDocument.run(at, reasonCode, documentId, householdId, householdId).changes);
      }
      for (const runId of runIds) {
        proposals += Number(redactProposalsOfRun.run(at, reasonCode, runId).changes);
        observations += Number(redactObservations.run(at, reasonCode, runId, runId).changes);
        runs += Number(stampRun.run(at, reasonCode, runId).changes);
      }
      const counts = Object.freeze({ proposals, observations, runs });
      if (proposals > 0 || observations > 0 || runs > 0) {
        this.audit.append({
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
