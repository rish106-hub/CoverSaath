import { createHash } from 'node:crypto';
import { createInsuranceDataClient, REFERENCE_ENDPOINTS } from '../../integrations/index.js';
import { cacheKeyFor, signatureFor } from './reference-data-port.js';

// Reference-data import (ADR 0021, option d): loads PUBLIC reference responses from a local JSON file straight into the
// D3 reference cache (migration 033), so the ReferenceDataPort can serve them with no second service running. The file
// holds responses in the insurance-data-api shape, keyed by an allow-listed endpoint and its parameters:
//   { "format": "reference-import-v1", "data_class": "synthetic", "entries": [
//       { "endpoint": "products.search", "params": { "uin": "SYNTHETIC-TEST-ONLY/01" }, "response": { ... } } ] }
// Fail closed: every entry is normalised by the client allow-list and validated by the pinned response parsers before
// anything is written; one bad entry writes nothing. No network call is possible here (the client gets a fetch that throws).
// data_class "synthetic" may not carry verified-looking data: products must be synthetic_test and fact headers must be
// version_synthetic=true, so every imported fact stays `unknown`. "owner_approved" needs a rights reference and an explicit
// opt-in; it is for data whose source rights the owner has recorded. FOR LEGAL REVIEW before any non-synthetic import.

export const IMPORT_FORMAT = 'reference-import-v1';
export const MAX_IMPORT_ENTRIES = 1000;
export const DEFAULT_IMPORT_TTL_DAYS = 30;
const MAX_IMPORT_TTL_DAYS = 3650;
const DATA_CLASSES = new Set(['synthetic', 'owner_approved']);

const importError = (message, entry = null) => Object.assign(new Error(entry === null ? message : `${message} (entry ${entry}).`), {
  code: 'REFERENCE_IMPORT_INVALID', entry,
});

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const noNetwork = async () => { throw new Error('Reference import never calls the network.'); };

function assertSyntheticOnly(endpoint, raw, index) {
  const list = Array.isArray(raw.data) ? raw.data : [];
  const products = endpoint === 'products.search' ? list : endpoint === 'products.get' ? [raw] : [];
  if (products.some(product => product?.verification_status !== 'synthetic_test')) {
    throw importError('Synthetic import products must be synthetic_test', index);
  }
  if (endpoint === 'versions.facts' && raw.version_synthetic !== true) {
    throw importError('Synthetic import fact headers must be version_synthetic', index);
  }
  if (endpoint === 'products.versions' && list.some(version => version?.freshness !== 'test_fixture')) {
    throw importError('Synthetic import versions must be test_fixture', index);
  }
}

export function assertNoVerifiedFacts(body, index) {
  if (Array.isArray(body?.facts) && body.facts.some(fact => fact?.outcome === 'verified')) {
    throw importError('Synthetic import must not contain verified facts', index);
  }
}

/**
 * Validates an import document. Returns the cache rows it would write ({ key, endpoint, body, signature }) and writes nothing.
 * Throws REFERENCE_IMPORT_INVALID (messages carry an entry index, never a value) or the parser's coded error.
 */
export function prepareReferenceImport(document, { allowOwnerApproved = false } = {}) {
  if (!isObject(document) || document.format !== IMPORT_FORMAT) throw importError(`Import file must have format "${IMPORT_FORMAT}"`);
  if (!DATA_CLASSES.has(document.data_class)) throw importError('Import file data_class must be "synthetic" or "owner_approved"');
  if (document.data_class === 'owner_approved') {
    if (!allowOwnerApproved) throw importError('owner_approved data needs the explicit owner-approved option');
    if (typeof document.rights_reference !== 'string' || !/^[\x21-\x7e][\x20-\x7e]{0,199}$/.test(document.rights_reference)) {
      throw importError('owner_approved data needs a rights_reference');
    }
  }
  const { entries } = document;
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > MAX_IMPORT_ENTRIES) {
    throw importError(`Import file needs 1 to ${MAX_IMPORT_ENTRIES} entries`);
  }
  const client = createInsuranceDataClient({ env: {}, fetchImpl: noNetwork });
  const seen = new Set();
  return entries.map((entry, index) => {
    if (!isObject(entry) || Object.keys(entry).some(key => !['endpoint', 'params', 'response'].includes(key))) {
      throw importError('Entry must have only endpoint, params and response', index);
    }
    const { endpoint } = entry;
    if (typeof endpoint !== 'string' || !Object.hasOwn(REFERENCE_ENDPOINTS, endpoint)) throw importError('Endpoint is not allowed', index);
    let params;
    try { params = client.normalizeParams(endpoint, entry.params ?? {}); } catch { throw importError('Params are invalid', index); }
    if (!isObject(entry.response)) throw importError('Response must be a JSON object', index);
    if (document.data_class === 'synthetic') assertSyntheticOnly(endpoint, entry.response, index);
    let body;
    try { body = REFERENCE_ENDPOINTS[endpoint].parse(entry.response); } catch { throw importError('Response does not match the pinned shape', index); }
    // Defence in depth: a synthetic import must never yield a verified fact, whatever the pre-parse checks let through.
    if (document.data_class === 'synthetic') assertNoVerifiedFacts(body, index);
    const key = cacheKeyFor(endpoint, params);
    if (seen.has(key)) throw importError('Duplicate endpoint and params', index);
    seen.add(key);
    return { key, endpoint, body, signature: signatureFor(body) };
  });
}

/**
 * Validates then writes every entry into the reference cache in one transaction. Returns counts only.
 * `ttlDays` sets stale_after; once stale the port serves the copy labelled stale until the next import.
 */
export async function importReferenceData({ database, repository, document, ttlDays = DEFAULT_IMPORT_TTL_DAYS, allowOwnerApproved = false, dryRun = false }) {
  if (!Number.isInteger(ttlDays) || ttlDays < 1 || ttlDays > MAX_IMPORT_TTL_DAYS) throw importError(`ttlDays must be 1 to ${MAX_IMPORT_TTL_DAYS}`);
  const rows = prepareReferenceImport(document, { allowOwnerApproved });
  const byEndpoint = {};
  for (const row of rows) byEndpoint[row.endpoint] = (byEndpoint[row.endpoint] ?? 0) + 1;
  const summary = { dataClass: document.data_class, entries: rows.length, byEndpoint, dryRun };
  // rights_reference is printed only when it is short and printable (prepareReferenceImport already enforced that).
  if (document.data_class === 'owner_approved') summary.rightsReference = document.rights_reference;
  if (dryRun) return summary;
  // The etag column records which import wrote the row (data class plus a short digest of the file's entries), for audit
  // only. It keeps the `import-` prefix that the rollback SQL matches. The owner_approved opt-in is a placeholder gate
  // until the legal rights register exists (FOR LEGAL REVIEW); the marker makes the class visible in the data.
  const marker = `import-${document.data_class}-${createHash('sha256').update(rows.map(row => `${row.key}:${row.signature}`).join('\n')).digest('hex').slice(0, 16)}`;
  const ttlMs = ttlDays * 24 * 60 * 60 * 1000;
  await database.transaction(async () => {
    for (const row of rows) await repository.put({ key: row.key, etag: marker, body: row.body, signature: row.signature, ttlMs });
  });
  return { ...summary, marker };
}
