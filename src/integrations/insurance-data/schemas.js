// Strict, pinned response validators for the insurance-data-api read endpoints (X1 audit section 5, pinned to code
// behaviour). Every function takes untrusted JSON and returns a new, minimal, length-capped object, or throws
// REFERENCE_DATA_RESPONSE_INVALID. Unknown enum values, missing required fields and wrong types fail closed; extra
// fields are dropped. Returned text is untrusted evidence: never use it as instructions.
import { referenceError } from './errors.js';

const MAX_TEXT = 500;
const MAX_LONG_TEXT = 2000;
const MAX_ITEMS = 100;
const SHA256 = /^[a-f0-9]{64}$/;

const PRODUCT_VERIFICATION = new Set(['synthetic_test', 'source_observed', 'candidate', 'independently_verified']);
const FRESHNESS = new Set(['current_as_observed', 'stale_review', 'superseded', 'withdrawn', 'access_blocked', 'test_fixture', 'unknown']);
const COVERAGE_STATUS = new Set(['verified', 'partial', 'conflicting_evidence', 'awaiting_review', 'not_permitted', 'not_observed']);
const RESOLVE_STATUS = new Set(['resolved', 'ambiguous', 'unmatched']);

const invalid = () => referenceError('REFERENCE_DATA_RESPONSE_INVALID', 'Reference data response did not match the expected shape.', { statusCode: 502 });
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const object = value => { if (!isObject(value)) throw invalid(); return value; };
const array = (value, max = MAX_ITEMS) => { if (!Array.isArray(value) || value.length > max) throw invalid(); return value; };
const text = (value, max = MAX_TEXT) => {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) throw invalid();
  return value;
};
const optionalText = (value, max = MAX_TEXT) => (value === undefined || value === null ? null : text(value, max));
// Required but nullable (openapi `type: [string, 'null']` in a `required` list): absent fails closed, null is allowed.
const nullableText = (value, max = MAX_TEXT) => { if (value === undefined) throw invalid(); return value === null ? null : text(value, max); };
const oneOf = (value, allowed) => { if (typeof value !== 'string' || !allowed.has(value)) throw invalid(); return value; };
const bool = value => { if (typeof value !== 'boolean') throw invalid(); return value; };
const optionalDate = value => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > 40 || Number.isNaN(Date.parse(value))) throw invalid();
  return value;
};

// openapi.yaml VerifiedFact: conditions and exceptions are arrays of strings. A bare string (older pinned shape) is
// accepted as a one-item list; anything else fails closed.
const textList = value => {
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') return [text(value, MAX_LONG_TEXT)];
  return array(value, 20).map(item => text(item, MAX_LONG_TEXT));
};

export function parseInsurer(raw) {
  const value = object(raw);
  return {
    id: text(value.id, 100),
    canonicalName: text(value.canonical_name),
    aliases: value.aliases === undefined ? [] : array(value.aliases, 50).map(alias => text(alias)),
  };
}

export const parseInsurerList = raw => ({ data: array(object(raw).data).map(parseInsurer) });

export function parseInsurerResolve(raw) {
  const value = object(raw);
  const status = oneOf(value.status, RESOLVE_STATUS);
  // Fail closed: only an explicit single match yields an insurer. Ambiguous or unmatched never picks a candidate.
  const insurer = status === 'resolved' ? parseInsurer(value.insurer) : null;
  return { status, insurer };
}

export function parseProduct(raw) {
  const value = object(raw);
  return {
    productId: text(value.product_id, 100),
    insurerId: text(value.insurer_id, 100),
    productName: text(value.product_name),
    lineOfBusiness: text(value.line_of_business, 100),
    // openapi.yaml: uin_raw is required but nullable (a product may have no recorded UIN).
    uinRaw: nullableText(value.uin_raw, 100),
    verificationStatus: oneOf(value.verification_status, PRODUCT_VERIFICATION),
    dataCoverage: optionalText(value.data_coverage, 100),
    lastObservedAt: optionalDate(value.last_observed_at),
  };
}

export function parseProductSearch(raw) {
  const products = array(object(raw).data).map(parseProduct);
  // A UIN or name search that matches more than one product is ambiguous: report it, never choose.
  return { products, ambiguous: products.length > 1 };
}

export function parseVersion(raw) {
  const value = object(raw);
  return {
    versionId: text(value.version_id, 100),
    productId: text(value.product_id, 100),
    wordingVersion: text(value.wording_version, 100),
    versionStatus: text(value.version_status, 100),
    freshness: oneOf(value.freshness, FRESHNESS),
    effectiveFrom: optionalDate(value.effective_from),
    effectiveTo: optionalDate(value.effective_to),
    sourceObservedAt: optionalDate(value.source_observed_at),
  };
}

export const parseVersionList = raw => ({ data: array(object(raw).data).map(parseVersion) });

function parseEvidence(raw) {
  const value = object(raw);
  const sha256 = text(value.sha256, 64);
  if (!SHA256.test(sha256)) throw invalid();
  if (!Number.isInteger(value.page_number) || value.page_number < 1) throw invalid();
  return { documentId: text(value.document_id, 100), pageNumber: value.page_number, sha256 };
}

function parseFact(raw, versionSynthetic, coverageByFamily) {
  const value = object(raw);
  const fact = {
    factId: text(value.fact_id, 100),
    factType: text(value.fact_type, 100),
    valueText: optionalText(isObject(value.value) ? value.value.text : null, MAX_LONG_TEXT),
    conditions: textList(value.conditions),
    exceptions: textList(value.exceptions),
    verificationStatus: text(value.verification_status, 100),
    taxonomyVersion: optionalText(value.taxonomy_version, 100),
    reviewId: optionalText(value.review_id, 100),
    sourceFreshness: optionalText(value.source_freshness, 100),
    evidence: array(value.evidence ?? [], 20).map(parseEvidence),
  };
  // X1 rule 4: usable only when independently verified, non-synthetic, evidenced and the family coverage is verified.
  const family = coverageByFamily.get(fact.factType) ?? null;
  const usable = fact.verificationStatus === 'independently_verified' && versionSynthetic === false
    && fact.evidence.length > 0 && family === 'verified';
  const outcome = usable ? 'verified' : family === 'conflicting_evidence' ? 'conflicting' : 'unknown';
  // Never carry the value forward unless usable: a non-usable fact is `unknown`/`conflicting`, not a decided value.
  // Conditions and exceptions qualify a value, so they are dropped with it.
  if (!usable) return { ...fact, valueText: null, conditions: [], exceptions: [], outcome };
  return { ...fact, outcome };
}

export function parseFacts(raw) {
  const value = object(raw);
  const versionSynthetic = bool(value.version_synthetic);
  const coverageRaw = object(value.coverage ?? {});
  const coverage = {};
  const coverageByFamily = new Map();
  for (const [family, status] of Object.entries(coverageRaw).slice(0, 50)) {
    if (!/^[a-z_]{1,64}$/.test(family)) throw invalid();
    coverage[family] = oneOf(isObject(status) ? status.status : status, COVERAGE_STATUS);
    coverageByFamily.set(family, coverage[family]);
  }
  return {
    versionId: text(value.version_id, 100),
    uinRaw: nullableText(value.uin_raw, 100),
    wordingVersion: text(value.wording_version, 100),
    versionSynthetic,
    coverage,
    facts: array(value.facts ?? []).map(fact => parseFact(fact, versionSynthetic, coverageByFamily)),
  };
}
