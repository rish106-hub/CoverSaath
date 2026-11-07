// Row helpers for the columns sealed by migration 030 (ADR 0013 addendum D2), shared by the repositories and by the few services that read
// these tables with their own SQL. Every function takes the column crypto (ADR 0013) and works on one row; none of them logs or
// throws a stored value. A value without the `enc` prefix is legacy plaintext and passes through until the backfill seals it.

// workflow_runs and workflow_tasks: the JSON a run or task carries (source excerpts, task input and output, error text).
export const WORKFLOW_RUN_SEALED = Object.freeze(['input_json']);
export const WORKFLOW_TASK_SEALED = Object.freeze(['input_json', 'output_json', 'last_error_message']);

export const openWorkflowRun = (crypto, row) => crypto.openRow('workflow_runs', row, WORKFLOW_RUN_SEALED);
export const openWorkflowTask = (crypto, row) => crypto.openRow('workflow_tasks', row, WORKFLOW_TASK_SEALED);

/** Seals a JSON text for a workflow column; null stays null. */
export const sealWorkflowText = (crypto, table, column, rowId, text) => (text === null || text === undefined ? null : crypto.seal(table, column, rowId, text));

// Row ids that join several key parts are length-prefixed ("5:abcde3:xyz"), so no pair of different parts gives the same
// additional authenticated data (a bare separator could appear inside a part).
export const compositeRowId = (...parts) => parts.map(part => `${String(part).length}:${part}`).join('');

// idempotency_keys has a composite key (scope, idempotency_key).
export const idempotencyRowId = (scope, key) => compositeRowId(scope, key);

/** Sealed response text for an idempotency record. */
export const sealIdempotencyResponse = (crypto, scope, key, responseText) => (
  responseText === null || responseText === undefined ? null : crypto.seal('idempotency_keys', 'response_json', idempotencyRowId(scope, key), responseText));

/** Copy of an idempotency_keys row with response_json opened (plain text, as it was before sealing). */
export function openIdempotencyRow(crypto, row) {
  if (!row) return row;
  return { ...row, response_json: crypto.open('idempotency_keys', 'response_json', idempotencyRowId(row.scope, row.idempotency_key), row.response_json) };
}

/** Keyed lookup value for "the idempotency record of this document" (see ADR 0013 addendum D2). Never reveals the document id. */
export const documentIdempotencyIndex = (crypto, documentId) => crypto.blindIndex('idempotency_keys.document', documentId);

/** The same index under every key of the ring, for erasure lookups (see column-crypto blindIndexes). */
export const documentIdempotencyIndexes = (crypto, documentId) => crypto.blindIndexes('idempotency_keys.document', documentId);

/** The document id inside a plain upload response (JSON text), or null. */
export function documentIdOfUploadResponse(responseText) {
  try {
    const id = JSON.parse(responseText)?.document?.id;
    return typeof id === 'string' && id !== '' ? id : null;
  } catch { return null; }
}

// service_cases.stated_estimate_minor is a user-stated amount. New rows keep it only as a padded sealed text in
// stated_estimate_ciphertext (fixed size, so the amount's digit count is not visible); the bigint column stays NULL.
// Rows written before migration 030 keep the bigint until the backfill moves it.
const ESTIMATE_SEAL = Object.freeze({ fixedSize: 64 });

export const sealStatedEstimate = (crypto, caseId, minor) => (
  minor === null || minor === undefined ? null : crypto.seal('service_cases', 'stated_estimate_ciphertext', caseId, String(minor), ESTIMATE_SEAL));

/**
 * Copy of a service_cases row whose stated_estimate_minor holds the amount (sealed or legacy) and without the ciphertext.
 * An amount that cannot be decrypted throws (money is never read as zero). Erasure paths pass `tolerateUnreadable`: they do
 * not use the amount, so it comes back as null with statedEstimateUnreadable set and the erasure can go on.
 */
export function openCaseRecord(crypto, row, { tolerateUnreadable = false } = {}) {
  if (!row) return row;
  const { stated_estimate_ciphertext: sealed, ...rest } = row;
  if (sealed === null || sealed === undefined) return rest;
  try {
    const minor = Number(crypto.open('service_cases', 'stated_estimate_ciphertext', row.id, sealed));
    if (!Number.isSafeInteger(minor) || minor < 0) throw Object.assign(new Error('A stored value could not be decrypted.'), { code: 'COLUMN_DECRYPTION_FAILED', statusCode: 500 });
    return { ...rest, stated_estimate_minor: minor };
  } catch (error) {
    if (!tolerateUnreadable || error?.code !== 'COLUMN_DECRYPTION_FAILED') throw error;
    return { ...rest, stated_estimate_minor: null, statedEstimateUnreadable: true };
  }
}
