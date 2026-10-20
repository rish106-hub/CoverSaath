// Evidence outcome of one structuring run, decided by deterministic counts only (never by model output).
// Processing status says whether the run finished; the evidence outcome says how complete the stored
// readings are. A run with skipped chunks or missing critical keys is never `complete`.
import { getPolicyParameterDefinition } from '../coverage-analysis/policy-parameter-registry.js';
import { CRITICAL_FIELD_KEYS } from './coverage-report.js';

export const PROCESSING_STATUSES = Object.freeze(['running', 'finished', 'failed_processing', 'interrupted']);
export const EVIDENCE_OUTCOMES = Object.freeze(['complete', 'partial_review_required', 'failed']);

// Provisional and unmeasured: no golden-set evidence supports these numbers yet. Not an accuracy claim.
export const MIN_ACCEPTED_ITEMS = 1;
export const MAX_SKIPPED_SHARE = 0.5;
export const OUTCOME_THRESHOLDS = Object.freeze({ minAcceptedItems: MIN_ACCEPTED_ITEMS, maxSkippedShare: MAX_SKIPPED_SHARE });

// Critical eval fields the model may read under this registry (identifiers and named members stay unknown).
export function structuringCriticalKeys(registryVersion) {
  const keys = new Set(Object.values(CRITICAL_FIELD_KEYS));
  return Object.freeze([...keys].filter(key => {
    try { return getPolicyParameterDefinition(registryVersion, key).modelExtraction.allowed === true; } catch { return false; }
  }).sort());
}

const count = value => (Number.isInteger(value) && value > 0 ? value : 0);

/**
 * report: buildCoverageReport output (chunks, skippedReasons, items). presentKeys: registry keys with at
 * least one decided reading. Returns { evidenceOutcome, reasons, missingCriticalKeys }; reasons are codes.
 */
export function decideOutcome(report, { criticalKeys = [], presentKeys = [], thresholds = OUTCOME_THRESHOLDS } = {}) {
  const { minAcceptedItems, maxSkippedShare } = { ...OUTCOME_THRESHOLDS, ...thresholds };
  const total = count(report?.chunks?.total);
  // An unaccounted chunk counts as skipped: nothing proves it was read.
  const skipped = count(report?.chunks?.skipped) + count(report?.chunks?.unaccounted);
  const accepted = count(report?.items?.accepted);
  const budgetStopped = count(report?.skippedReasons?.budget_stop);
  const present = new Set(presentKeys);
  const missingCriticalKeys = Object.freeze([...new Set(criticalKeys)].filter(key => !present.has(key)).sort());
  const share = total ? skipped / total : 1;

  const reasons = [];
  if (accepted < minAcceptedItems) reasons.push('accepted_items_below_minimum');
  if (budgetStopped * 2 > total) reasons.push('budget_stop_before_half');
  if (share > maxSkippedShare) reasons.push('skipped_share_above_maximum');
  const failed = reasons.length > 0;
  if (skipped > 0) reasons.push('chunks_skipped');
  if (missingCriticalKeys.length) reasons.push('critical_keys_missing');
  const evidenceOutcome = failed ? 'failed' : reasons.length ? 'partial_review_required' : 'complete';
  return Object.freeze({ evidenceOutcome, reasons: Object.freeze(reasons), missingCriticalKeys });
}

// A stored run from before outcomes were recorded is never shown as complete.
export function storedOutcome(counts) {
  const outcome = counts?.outcome;
  if (outcome && ['complete', 'partial_review_required'].includes(outcome.evidenceOutcome)) {
    return Object.freeze({
      evidenceOutcome: outcome.evidenceOutcome,
      reasons: Object.freeze([...(outcome.reasons ?? [])]),
      missingCriticalKeys: Object.freeze([...(outcome.missingCriticalKeys ?? [])]),
    });
  }
  return Object.freeze({ evidenceOutcome: 'partial_review_required', reasons: Object.freeze(['outcome_not_recorded']), missingCriticalKeys: Object.freeze([]) });
}
