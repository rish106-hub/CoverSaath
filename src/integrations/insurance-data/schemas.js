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
  const pageSha256 = value.page_sha256 === undefined || value.page_sha256 === null ? null : text(value.page_sha256, 64);
  if (pageSha256 !== null && !SHA256.test(pageSha256)) throw invalid();
  return { documentId: text(value.document_id, 100), pageNumber: value.page_number, sha256, pageSha256 };
}

// FSS fact type -> coverage family. Mirrors insurance-data-api apps/api/src/products.routes.ts (the `families` CTE and
// `familyTypes`); coverage is reported per family, never per fact type. Types outside the map have no family and stay unknown.
export const FSS_FACT_FAMILY = Object.freeze({
  room_rent_limit: 'room_rent_limit',
  copay: 'copay',
  initial_waiting_period: 'waiting_periods',
  pre_existing_disease_waiting_period: 'waiting_periods',
  specific_disease_waiting_period: 'waiting_periods',
  excluded_conditions: 'exclusions',
});
export const familyForFactType = factType => (Object.hasOwn(FSS_FACT_FAMILY, factType) ? FSS_FACT_FAMILY[factType] : null);
// A family is usable when FSS reports it verified or partial; anything else (awaiting_review, not_permitted,
// not_observed, conflicting_evidence) never yields a decided value.
const USABLE_FAMILY_STATUS = new Set(['verified', 'partial']);
export const MAX_FACT_PAGES = 5;

const optionalNumber = value => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw invalid();
  return value;
};
// openapi FactValue. Structured fields are kept (bounded); unknown keys are dropped. `kind` is tolerated when absent.
function parseValue(raw) {
  if (raw === undefined || raw === null) return null;
  const value = object(raw);
  const duration = value.duration === undefined || value.duration === null ? null : (() => {
    const d = object(value.duration);
    return { value: optionalNumber(d.value), unit: text(d.unit, 20) };
  })();
  return {
    kind: optionalText(value.kind, 40),
    number: optionalNumber(value.number),
    amount: optionalNumber(value.amount),
    percentage: optionalNumber(value.percentage),
    unit: optionalText(value.unit, 40),
    currency: optionalText(value.currency, 10),
    denominator: optionalText(value.denominator, 100),
    text: optionalText(value.text, MAX_LONG_TEXT),
    limitType: optionalText(value.limit_type, 60),
    appliesTo: optionalText(value.applies_to, 20),
    period: optionalText(value.period, 20),
    periodType: optionalText(value.period_type, 60),
    duration,
    roomCategories: value.room_categories === undefined ? [] : array(value.room_categories, 20).map(c => text(c, 100)),
    applicableCondition: optionalText(value.applicable_condition, MAX_LONG_TEXT),
    exclusionCategory: optionalText(value.exclusion_category, 60),
    scope: optionalText(value.scope, MAX_LONG_TEXT),
  };
}

function parseFact(raw, versionSynthetic, coverageByFamily) {
  const value = object(raw);
  const fact = {
    factId: text(value.fact_id, 100),
    factType: text(value.fact_type, 100),
    valueText: optionalText(isObject(value.value) ? value.value.text : null, MAX_LONG_TEXT),
    value: parseValue(value.value),
    conditions: textList(value.conditions),
    exceptions: textList(value.exceptions),
    verificationStatus: text(value.verification_status, 100),
    taxonomyVersion: optionalText(value.taxonomy_version, 100),
    reviewId: optionalText(value.review_id, 100),
    reviewerId: optionalText(value.reviewer_id, 100),
    sourceFreshness: optionalText(value.source_freshness, 100),
    evidence: array(value.evidence ?? [], 20).map(parseEvidence),
  };
  // X1 rule 4: usable only when independently verified, non-synthetic, evidenced and its FAMILY coverage is verified or
  // partial. Coverage is keyed by family (FSS_FACT_FAMILY), not by fact type.
  const familyName = familyForFactType(fact.factType);
  const family = familyName === null ? null : coverageByFamily.get(familyName) ?? null;
  const usable = fact.verificationStatus === 'independently_verified' && versionSynthetic === false
    && fact.evidence.length > 0 && USABLE_FAMILY_STATUS.has(family);
  const outcome = usable ? 'verified' : family === 'conflicting_evidence' ? 'conflicting' : 'unknown';
  // Never carry the value forward unless usable: a non-usable fact is `unknown`/`conflicting`, not a decided value.
  // Conditions and exceptions qualify a value, so they are dropped with it.
  if (!usable) return { ...fact, valueText: null, value: null, conditions: [], exceptions: [], outcome, family: familyName };
  return { ...fact, outcome, family: familyName };
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
    nextCursor: nextCursor(value.next_cursor),
  };
}

/** Reads every facts page through `readPage(cursor)` (resolving to parsed facts), at most MAX_FACT_PAGES pages. Merges
 * facts; coverage and version fields come from the first page. `truncated` is true when more pages remained. */
export async function collectFactPages(readPage, { maxPages = MAX_FACT_PAGES } = {}) {
  const limit = Math.min(maxPages, MAX_FACT_PAGES);
  let merged = null;
  let cursor;
  for (let page = 0; page < limit; page += 1) {
    const current = await readPage(cursor);
    merged = merged === null ? { ...current, facts: [...current.facts] } : { ...merged, facts: [...merged.facts, ...current.facts] };
    cursor = current.nextCursor ?? null;
    if (cursor === null) return { ...merged, nextCursor: null, pages: page + 1, truncated: false };
  }
  return { ...merged, nextCursor: cursor, pages: limit, truncated: true };
}

// ---- Service-only endpoints (registry listing, name search, export by UIN) ---------------------------------------------
// These feed the backend's own detection and reference import. Their results carry the UIN, so they are never passed to a
// response body: backend code keeps them in server-side rows only.
const CURSOR = /^[A-Za-z0-9_-]{1,200}$/;
const MAX_PAGES_PER_DOCUMENT = 500;
const MAX_PAGE_TEXT = 40_000;
const MAX_DOCUMENTS = 20;
const MAX_TABLES_JSON_CHARS = 100_000;

const nextCursor = value => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !CURSOR.test(value)) throw invalid();
  return value;
};

export const parseRegistryInsurers = raw => {
  const value = object(raw);
  return { insurers: array(value.data).map(parseInsurer), nextCursor: nextCursor(value.next_cursor) };
};

export const parseRegistryProducts = raw => {
  const value = object(raw);
  return { products: array(value.data).map(parseProduct), nextCursor: nextCursor(value.next_cursor) };
};

const PINCODE = /^[0-9]{6}$/;
// Network hospital export page (service-only). Public directory fields only; invalid rows fail the whole page closed.
export function parseNetworkHospitalsExport(raw) {
  const value = object(raw);
  const hospitals = array(value.data, 500).map(item => {
    const row = object(item);
    const pincode = text(row.pincode, 6);
    if (!PINCODE.test(pincode)) throw invalid();
    const coordinate = (v, limit) => {
      if (v === undefined || v === null) return null;
      const n = Number(v);
      if (!Number.isFinite(n) || Math.abs(n) > limit) throw invalid();
      return n;
    };
    return {
      id: text(row.id, 100),
      insurerId: optionalText(row.insurer_id, 100),
      tpaId: optionalText(row.tpa_id, 100),
      name: text(row.name, 200),
      address: row.address === undefined || row.address === null || row.address === '' ? '' : text(row.address, 400),
      city: text(row.city, 100),
      pincode,
      lat: coordinate(row.lat, 90),
      lng: coordinate(row.lng, 180),
      cashless: bool(row.cashless),
      sourceRef: text(row.source_ref, 200),
      validFrom: optionalDate(row.valid_from),
      validTo: optionalDate(row.valid_to),
    };
  });
  return { hospitals, nextCursor: nextCursor(value.next_cursor) };
}

export function parseProductNameSearch(raw) {
  const rows = array(object(raw).data, 20).map(item => {
    const value = object(item);
    return {
      productId: text(value.product_id, 100),
      productName: text(value.product_name),
      insurerId: text(value.insurer_id, 100),
      insurerName: text(value.insurer_name),
      lineOfBusiness: text(value.line_of_business, 100),
      uinRaw: value.uin_raw === undefined ? null : nullableText(value.uin_raw, 100),
    };
  });
  return { products: rows };
}

function parseExportPage(raw) {
  const value = object(raw);
  if (!Number.isInteger(value.page_number) || value.page_number < 1) throw invalid();
  if (typeof value.text !== 'string' || value.text.length > MAX_PAGE_TEXT) throw invalid();
  const contentSha256 = value.content_sha256 === undefined || value.content_sha256 === null ? null : text(value.content_sha256, 64);
  if (contentSha256 !== null && !SHA256.test(contentSha256)) throw invalid();
  const tables = value.tables_json === undefined || value.tables_json === null ? [] : value.tables_json;
  if (!Array.isArray(tables) || JSON.stringify(tables).length > MAX_TABLES_JSON_CHARS) throw invalid();
  return {
    pageNumber: value.page_number,
    text: value.text,
    contentSha256,
    parserVersion: text(value.parser_version, 100),
    extractionStatus: text(value.extraction_status, 100),
    tablesJson: tables,
  };
}

export function parseProductExport(raw) {
  const value = object(raw);
  const exportVersion = text(value.export_version, 64);
  if (!SHA256.test(exportVersion)) throw invalid();
  const product = object(value.product);
  const documents = array(value.documents, MAX_DOCUMENTS).map(item => {
    const doc = object(item);
    const sha256 = doc.sha256 === undefined || doc.sha256 === null ? null : text(doc.sha256, 64);
    if (sha256 !== null && !SHA256.test(sha256)) throw invalid();
    return {
      documentId: text(doc.document_id, 100),
      versionId: text(doc.version_id, 100),
      wordingVersion: text(doc.wording_version, 100),
      sha256,
      mediaType: optionalText(doc.media_type, 100),
      synthetic: bool(doc.synthetic),
      sourceObservedAt: optionalDate(doc.source_observed_at),
      sourcePages: array(doc.source_pages, MAX_PAGES_PER_DOCUMENT).map(parseExportPage),
    };
  });
  return {
    exportVersion,
    product: {
      productId: text(product.product_id, 100),
      productName: text(product.product_name),
      insurerId: text(product.insurer_id, 100),
      insurerName: text(product.insurer_name),
      lineOfBusiness: text(product.line_of_business, 100),
    },
    documents,
  };
}
