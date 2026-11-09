// IDA export v2 -> CoverSaath reference-import-v1 (offline admin tooling, ADR 0021). Pure functions; no I/O, no network.
// Input is the JSON written by IDA's `npm run export:product` (docs/contracts/export-v2.md in the IDA repo). Output is the
// file scripts/reference-import.mjs loads. Fail closed with coded errors; messages never carry a value from the export.
// Source text in the export is untrusted data: it is copied as inert strings and never interpreted.
// The importer has no place for quote text, so quotes are never carried: evidence keeps document id, page and sha256 only.
// data_class: "synthetic" maps to synthetic_test / test_fixture / version_synthetic=true; "owner_approved" needs a
// rights_reference and is mapped to the least-trusted real labels (source_observed / unknown / candidate), so no fact
// becomes `verified` by conversion. Rights and data-class handling is FOR LEGAL REVIEW.
import { IMPORT_FORMAT, prepareReferenceImport } from '../../src/backend/services/reference-data-import.js';

export const SUPPORTED_EXPORT_SCHEMA_VERSION = 2;
const RIGHTS_REFERENCE = /^[\x21-\x7e][\x20-\x7e]{0,199}$/;
const CLASSES = new Set(['synthetic', 'owner_approved']);

const fail = (code, message) => Object.assign(new Error(message), { code });
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const need = (condition, message = 'Export is not valid export-v2.') => { if (!condition) throw fail('IDA_EXPORT_INVALID', message); };
const str = value => typeof value === 'string' && value.length > 0;
const strOrNull = value => value === null || value === undefined || str(value);
const nul = value => (value === undefined ? null : value);

export function convertIdaExport(exp) {
  need(isObject(exp));
  if (exp.export_schema_version !== SUPPORTED_EXPORT_SCHEMA_VERSION) {
    throw fail('IDA_EXPORT_SCHEMA_UNSUPPORTED', `Only export_schema_version ${SUPPORTED_EXPORT_SCHEMA_VERSION} is supported.`);
  }
  need(isObject(exp.product) && isObject(exp.insurer) && Array.isArray(exp.versions) && Array.isArray(exp.identifiers));
  need(str(exp.product.id) && str(exp.product.display_name) && str(exp.product.line_of_business));
  need(str(exp.insurer.id) && str(exp.insurer.canonical_name) && (exp.insurer.aliases === undefined || (Array.isArray(exp.insurer.aliases) && exp.insurer.aliases.every(str))));

  const dataClass = exp.data_class;
  if (!CLASSES.has(dataClass)) throw fail('IDA_EXPORT_DATA_CLASS_REFUSED', 'Export data_class must be "synthetic" or "owner_approved".');
  if (exp.product.data_class !== dataClass) throw fail('IDA_EXPORT_DATA_CLASS_REFUSED', 'Product data_class differs from the export data_class.');
  const synthetic = dataClass === 'synthetic';
  if (!synthetic && !(typeof exp.rights_reference === 'string' && RIGHTS_REFERENCE.test(exp.rights_reference))) {
    throw fail('IDA_EXPORT_RIGHTS_REFERENCE_INVALID', 'owner_approved export needs a printable rights_reference of at most 200 characters (never truncated).');
  }

  const uins = [...new Set(exp.identifiers.filter(item => {
    need(isObject(item) && str(item.id_type));
    return item.id_type === 'uin';
  }).map(item => { need(str(item.raw_value)); return item.raw_value; }))];
  if (uins.length === 0) throw fail('IDA_EXPORT_IDENTIFIER_MISSING', 'Export has no uin identifier.');

  const primaryUin = uins[0];
  const insurer = { id: exp.insurer.id, canonical_name: exp.insurer.canonical_name, aliases: [...(exp.insurer.aliases ?? [])] };
  const stats = { versions: 0, facts: 0, factsSkippedOlderSnapshot: 0, quotesDropped: 0 };
  const versionRows = [];
  const factEntries = [];
  let lastObservedAt = null;

  for (const version of exp.versions) {
    need(isObject(version) && str(version.version_id) && str(version.wording_version) && str(version.status));
    need(strOrNull(version.approval_date) && strOrNull(version.effective_from) && strOrNull(version.effective_to) && str(version.source_observed_at));
    if (version.data_class !== dataClass) throw fail('IDA_EXPORT_DATA_CLASS_REFUSED', 'Version data_class differs from the export data_class.');
    need(str(version.latest_snapshot_id) && Array.isArray(version.facts));
    if (lastObservedAt === null || Date.parse(version.source_observed_at) > Date.parse(lastObservedAt)) lastObservedAt = version.source_observed_at;
    versionRows.push({
      version_id: version.version_id, product_id: exp.product.id, wording_version: version.wording_version,
      approved_at: nul(version.approval_date), effective_from: nul(version.effective_from), effective_to: nul(version.effective_to),
      version_status: version.status, version_synthetic: synthetic, freshness: synthetic ? 'test_fixture' : 'unknown',
      source_observed_at: version.source_observed_at,
    });
    stats.versions += 1;

    const facts = [];
    for (const fact of version.facts) {
      need(isObject(fact) && str(fact.fact_id) && str(fact.fact_type) && str(fact.snapshot_id));
      if (fact.snapshot_id !== version.latest_snapshot_id) { stats.factsSkippedOlderSnapshot += 1; continue; }
      if (fact.data_class !== dataClass) throw fail('IDA_EXPORT_DATA_CLASS_REFUSED', 'Fact data_class differs from the export data_class.');
      need(Array.isArray(fact.conditions) && fact.conditions.every(str) && Array.isArray(fact.exceptions) && fact.exceptions.every(str) && Array.isArray(fact.evidence));
      const evidence = fact.evidence.map(item => {
        need(isObject(item) && str(item.source_document_id) && Number.isInteger(item.page_number) && str(item.document_sha256) && typeof item.quote_included === 'boolean');
        // Quote text without quote_included:true is an inconsistent export (rights flag unclear): refuse, never carry it.
        need(item.quote_included === true || item.quote === undefined);
        if (item.quote_included === true) stats.quotesDropped += 1;
        return { document_id: item.source_document_id, page_number: item.page_number, sha256: item.document_sha256 };
      });
      const text = isObject(fact.value_json) && typeof fact.value_json.text === 'string' && fact.value_json.text.length > 0 ? fact.value_json.text : null;
      facts.push({
        fact_id: fact.fact_id, fact_type: fact.fact_type, value: text === null ? null : { text },
        conditions: [...fact.conditions], exceptions: [...fact.exceptions],
        verification_status: synthetic ? 'synthetic_test' : 'candidate',
        taxonomy_version: nul(fact.taxonomy_version), review_id: nul(fact.provenance?.review_decision_id),
        evidence,
      });
      stats.facts += 1;
    }
    factEntries.push({
      endpoint: 'versions.facts', params: { versionId: version.version_id },
      response: {
        version_id: version.version_id, product_id: exp.product.id, product_name: exp.product.display_name,
        insurer_name: insurer.canonical_name, uin_raw: primaryUin, wording_version: version.wording_version,
        approved_at: nul(version.approval_date), source_observed_at: version.source_observed_at, version_synthetic: synthetic,
        facts, coverage: {}, next_cursor: null,
      },
    });
  }

  const product = {
    product_id: exp.product.id, insurer_id: insurer.id, product_name: exp.product.display_name,
    line_of_business: exp.product.line_of_business, uin_raw: primaryUin, data_coverage: 'not_observed',
    last_observed_at: lastObservedAt, verification_status: synthetic ? 'synthetic_test' : 'source_observed',
  };
  const entries = [
    { endpoint: 'insurers.resolve', params: { q: insurer.canonical_name }, response: { status: 'resolved', insurer, candidates: [insurer] } },
    ...uins.map(uin => ({ endpoint: 'products.search', params: { uin }, response: { data: [product], next_cursor: null, dataset_snapshot: 'ida-export-v2' } })),
    { endpoint: 'products.versions', params: { productId: exp.product.id }, response: { data: versionRows, next_cursor: null } },
    ...factEntries,
  ];
  const document = { format: IMPORT_FORMAT, data_class: dataClass };
  if (!synthetic) document.rights_reference = exp.rights_reference;
  document.entries = entries;
  return { document, stats };
}

/** Runs the converted document through the importer's own validator (no database). Throws a coded error when invalid. */
export function selfCheckImportDocument(document) {
  try {
    return prepareReferenceImport(document, { allowOwnerApproved: true }).length;
  } catch (error) {
    // Importer messages carry an entry index only, never a value.
    const detail = error?.code === 'REFERENCE_IMPORT_INVALID' ? `: ${error.message}` : '';
    throw fail('IDA_EXPORT_SELF_CHECK_FAILED', `Converted file failed the importer validator (${error?.code ?? 'UNKNOWN'}${detail}).`);
  }
}

/** Convert, self-check, and return the document with counts only. */
export function convertAndCheck(exp) {
  const { document, stats } = convertIdaExport(exp);
  const checked = selfCheckImportDocument(document);
  const byEndpoint = {};
  for (const entry of document.entries) byEndpoint[entry.endpoint] = (byEndpoint[entry.endpoint] ?? 0) + 1;
  return { document, summary: { dataClass: document.data_class, entries: checked, byEndpoint, ...stats } };
}
