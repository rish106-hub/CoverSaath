// Contracts for deterministic official-source discovery. This module performs no I/O.

export const OFFICIAL_SOURCE_CLASSES = Object.freeze([
  'regulator_product_repository',
  'insurer_policy_wording',
  'insurer_customer_information_sheet',
  'insurer_disclosure',
  'regulator_statistics',
  'regulator_circular',
  'insurer_network_list',
  'tpa_network_list',
  'ombudsman_report',
  'government_cost_benchmark',
]);

export const OFFICIAL_DOCUMENT_TYPES = Object.freeze([
  'policy_wording',
  'customer_information_sheet',
  'product_index',
  'regulatory_disclosure',
  'statistics',
  'circular',
  'network_hospital_list',
  'excluded_provider_list',
  'ombudsman_report',
  'cost_benchmark',
]);

export const OFFICIAL_IDENTITY_SCOPES = Object.freeze(['policy_versioned', 'insurer', 'market']);
export const OFFICIAL_MIME_TYPES = Object.freeze(['application/pdf', 'application/json', 'text/html', 'text/csv']);
export const SOURCE_ATTEMPT_OUTCOMES = Object.freeze([
  'fetched', 'not_found', 'unavailable', 'rejected', 'mismatch', 'stale', 'ambiguous', 'incompatible',
]);
export const FRESHNESS_STATUSES = Object.freeze(['current', 'stale', 'not_applicable', 'unknown']);

const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{1,127}$/;
const RULE_PATTERN = /^[a-z0-9][a-z0-9._:-]{2,127}$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const HOST_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,119}$/;
const PUBLIC_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;
const PUBLIC_PRODUCT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/+&()-]{0,119}$/;
const PUBLIC_CITY_PATTERN = /^[A-Za-z][A-Za-z .'-]{1,59}$/;
const PRIVATE_QUERY_SIGNAL = /\b(?:patient|member|diagnos(?:is|ed)?|disease|condition|symptom|surgery|procedure|treatment|claim|policy[ _-]?number|date[ _-]?of[ _-]?birth|dob|phone|email|aadhaar|pan)\b/i;

// Only public document identifiers may be put in an official-source URL. Patient, policy and scenario data
// have no legitimate role in this boundary.
export const PUBLIC_SOURCE_QUERY_KEYS = Object.freeze([
  'uin', 'product', 'version', 'effective_date', 'source_id', 'period', 'city', 'pin', 'hospital_id', 'page',
]);

export class OfficialSourceContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OfficialSourceContractError';
    this.code = code;
  }
}

const fail = (code, message) => { throw new OfficialSourceContractError(code, message); };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function exactKeys(value, allowed, at) {
  if (!isObject(value)) fail('OFFICIAL_SOURCE_INVALID', `${at} must be an object.`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail('OFFICIAL_SOURCE_PRIVATE_DATA', `${at}.${key} is not permitted at the public-source boundary.`);
  }
}

function text(value, at, max = 500) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail('OFFICIAL_SOURCE_INVALID', `${at} must be a non-empty string of at most ${max} characters.`);
  return value.trim();
}

function nullableText(value, at, max = 500) {
  return value == null ? null : text(value, at, max);
}

function isoDate(value, at, { nullable = false } = {}) {
  if (nullable && value == null) return null;
  const parsed = typeof value === 'string' && ISO_DATE_PATTERN.test(value) ? new Date(`${value}T00:00:00Z`) : null;
  if (!parsed || Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    fail('OFFICIAL_SOURCE_INVALID', `${at} must be an ISO date (yyyy-mm-dd).`);
  }
  return value;
}

function isoTimestamp(value, at) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) fail('OFFICIAL_SOURCE_INVALID', `${at} must be an ISO timestamp.`);
  return new Date(value).toISOString();
}

function enumValue(value, allowed, at) {
  if (!allowed.includes(value)) fail('OFFICIAL_SOURCE_INVALID', `${at} must be one of: ${allowed.join(', ')}.`);
  return value;
}

function nullableInteger(value, at, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value < min || value > max) fail('OFFICIAL_SOURCE_INVALID', `${at} must be an integer from ${min} to ${max}.`);
  return value;
}

function host(value, at) {
  const normalized = text(value, at, 253).toLowerCase().replace(/\.$/, '');
  if (!HOST_PATTERN.test(normalized) || normalized === 'localhost' || normalized.endsWith('.local')) {
    fail('OFFICIAL_SOURCE_HOST_NOT_ALLOWED', `${at} must be a public DNS host.`);
  }
  return normalized;
}

function publicQueryValue(key, value, at) {
  if (!value || value.length > 120 || PRIVATE_QUERY_SIGNAL.test(value)) {
    fail('OFFICIAL_SOURCE_PRIVATE_QUERY', `${at} contains free text or a private-data signal.`);
  }
  switch (key) {
    case 'effective_date':
      isoDate(value, at);
      break;
    case 'pin':
      if (!/^\d{6}$/.test(value)) fail('OFFICIAL_SOURCE_PRIVATE_QUERY', `${at} must be a six-digit public PIN code.`);
      break;
    case 'page':
      if (!/^[1-9]\d{0,4}$/.test(value)) fail('OFFICIAL_SOURCE_PRIVATE_QUERY', `${at} must be a positive page number.`);
      break;
    case 'city':
      if (!PUBLIC_CITY_PATTERN.test(value) || value.trim().split(/\s+/).length > 4) fail('OFFICIAL_SOURCE_PRIVATE_QUERY', `${at} must be a bounded city name.`);
      break;
    case 'product':
      if (!PUBLIC_PRODUCT_PATTERN.test(value)) fail('OFFICIAL_SOURCE_PRIVATE_QUERY', `${at} must be a stable product slug, not free text.`);
      break;
    default:
      if (!PUBLIC_TOKEN_PATTERN.test(value)) fail('OFFICIAL_SOURCE_PRIVATE_QUERY', `${at} must be a stable public identifier.`);
  }
}

function safeUrl(value, at, allowedHosts = null) {
  let url;
  try { url = new URL(text(value, at, 2_048)); } catch { fail('OFFICIAL_SOURCE_URL_INVALID', `${at} must be an absolute URL.`); }
  if (url.protocol !== 'https:') fail('OFFICIAL_SOURCE_HTTPS_REQUIRED', `${at} must use HTTPS.`);
  if (url.port && url.port !== '443') fail('OFFICIAL_SOURCE_URL_INVALID', `${at} must use the standard HTTPS port.`);
  if (url.username || url.password || url.hash) fail('OFFICIAL_SOURCE_URL_INVALID', `${at} must not contain credentials or a fragment.`);
  const normalizedHost = url.hostname.toLowerCase().replace(/\.$/, '');
  if (allowedHosts && !allowedHosts.includes(normalizedHost)) fail('OFFICIAL_SOURCE_HOST_NOT_ALLOWED', `${at} host is not allowlisted.`);
  const seenQueryKeys = new Set();
  for (const [rawKey, value] of url.searchParams.entries()) {
    const key = rawKey.toLowerCase();
    if (!PUBLIC_SOURCE_QUERY_KEYS.includes(key)) {
      fail('OFFICIAL_SOURCE_PRIVATE_QUERY', `${at} query parameter ${rawKey} is not an allowlisted public identifier.`);
    }
    if (seenQueryKeys.has(key)) fail('OFFICIAL_SOURCE_PRIVATE_QUERY', `${at} query parameter ${rawKey} must not be repeated.`);
    seenQueryKeys.add(key);
    publicQueryValue(key, value, `${at}.${rawKey}`);
  }
  return url.toString();
}

function frozenList(value, at, normalize, { min = 1, max = 20 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail('OFFICIAL_SOURCE_INVALID', `${at} must contain ${min}-${max} items.`);
  return Object.freeze([...new Set(value.map((item, index) => normalize(item, `${at}[${index}]`)))]);
}

function validateIdentity(identity, at = 'identity') {
  exactKeys(identity, ['scope', 'legalInsurerName', 'uin', 'productName', 'version', 'effectiveFrom', 'effectiveTo'], at);
  const scope = enumValue(identity.scope, OFFICIAL_IDENTITY_SCOPES, `${at}.scope`);
  const normalized = {
    scope,
    legalInsurerName: nullableText(identity.legalInsurerName, `${at}.legalInsurerName`, 240),
    uin: nullableText(identity.uin, `${at}.uin`, 120),
    productName: nullableText(identity.productName, `${at}.productName`, 240),
    version: nullableText(identity.version, `${at}.version`, 120),
    effectiveFrom: isoDate(identity.effectiveFrom, `${at}.effectiveFrom`, { nullable: true }),
    effectiveTo: isoDate(identity.effectiveTo, `${at}.effectiveTo`, { nullable: true }),
  };
  if (scope === 'policy_versioned' && Object.entries(normalized).some(([key, value]) => key !== 'scope' && key !== 'effectiveTo' && value == null)) {
    fail('OFFICIAL_SOURCE_IDENTITY_INCOMPLETE', `${at} requires legal insurer, UIN, product, version and effective-from for policy-versioned sources.`);
  }
  if (scope === 'insurer' && !normalized.legalInsurerName) fail('OFFICIAL_SOURCE_IDENTITY_INCOMPLETE', `${at}.legalInsurerName is required for insurer sources.`);
  if (scope === 'market' && Object.entries(normalized).some(([key, value]) => key !== 'scope' && value != null)) {
    fail('OFFICIAL_SOURCE_IDENTITY_INCOMPATIBLE', `${at} market sources must not claim an insurer or policy identity.`);
  }
  if (normalized.effectiveTo && normalized.effectiveFrom && normalized.effectiveTo < normalized.effectiveFrom) {
    fail('OFFICIAL_SOURCE_IDENTITY_INCOMPATIBLE', `${at}.effectiveTo cannot precede effectiveFrom.`);
  }
  return Object.freeze(normalized);
}

/**
 * @typedef {Object} OfficialSourceRegistryEntry
 * @property {string} id
 * @property {string} sourceClass
 * @property {string} documentType
 * @property {string} publisher
 * @property {Object} identity
 * @property {string} canonicalUrl
 * @property {string[]} allowedHosts
 * @property {string[]} expectedMimeTypes
 * @property {number} maxBytes
 * @property {number|null} freshnessDays
 * @property {string} owner
 */

/** Validate and freeze one operator-reviewed source registry entry. */
export function defineOfficialSource(raw) {
  exactKeys(raw, ['id', 'sourceClass', 'documentType', 'publisher', 'identity', 'canonicalUrl', 'allowedHosts', 'expectedMimeTypes', 'maxBytes', 'freshnessDays', 'owner'], 'officialSource');
  const id = text(raw.id, 'officialSource.id', 128);
  if (!ID_PATTERN.test(id)) fail('OFFICIAL_SOURCE_INVALID', 'officialSource.id must be a lowercase stable identifier.');
  const allowedHosts = frozenList(raw.allowedHosts, 'officialSource.allowedHosts', host, { max: 10 });
  const expectedMimeTypes = frozenList(raw.expectedMimeTypes, 'officialSource.expectedMimeTypes', (item, at) => enumValue(item, OFFICIAL_MIME_TYPES, at), { max: 4 });
  const maxBytes = nullableInteger(raw.maxBytes, 'officialSource.maxBytes', { min: 1, max: MAX_SOURCE_BYTES });
  if (maxBytes == null) fail('OFFICIAL_SOURCE_INVALID', 'officialSource.maxBytes is required.');
  return Object.freeze({
    id,
    sourceClass: enumValue(raw.sourceClass, OFFICIAL_SOURCE_CLASSES, 'officialSource.sourceClass'),
    documentType: enumValue(raw.documentType, OFFICIAL_DOCUMENT_TYPES, 'officialSource.documentType'),
    publisher: text(raw.publisher, 'officialSource.publisher', 240),
    identity: validateIdentity(raw.identity),
    canonicalUrl: safeUrl(raw.canonicalUrl, 'officialSource.canonicalUrl', allowedHosts),
    allowedHosts,
    expectedMimeTypes,
    maxBytes,
    freshnessDays: nullableInteger(raw.freshnessDays, 'officialSource.freshnessDays', { min: 1, max: 3_650 }),
    owner: text(raw.owner, 'officialSource.owner', 160),
  });
}

/** Validate request shape only. Authority still comes exclusively from a registry-bound comparison below. */
function validateFetchRequestShape(raw) {
  exactKeys(raw, ['requestId', 'registryEntryId', 'url', 'allowedHosts', 'expectedMimeTypes', 'maxBytes', 'timeoutMs', 'requestedAt'], 'fetchRequest');
  const allowedHosts = frozenList(raw.allowedHosts, 'fetchRequest.allowedHosts', host, { max: 10 });
  const expectedMimeTypes = frozenList(raw.expectedMimeTypes, 'fetchRequest.expectedMimeTypes', (item, at) => enumValue(item, OFFICIAL_MIME_TYPES, at), { max: 4 });
  const maxBytes = nullableInteger(raw.maxBytes, 'fetchRequest.maxBytes', { min: 1, max: MAX_SOURCE_BYTES });
  const timeoutMs = nullableInteger(raw.timeoutMs, 'fetchRequest.timeoutMs', { min: 100, max: 30_000 });
  if (maxBytes == null || timeoutMs == null) fail('OFFICIAL_SOURCE_INVALID', 'fetchRequest.maxBytes and timeoutMs are required.');
  return Object.freeze({
    requestId: text(raw.requestId, 'fetchRequest.requestId', 128),
    registryEntryId: text(raw.registryEntryId, 'fetchRequest.registryEntryId', 128),
    url: safeUrl(raw.url, 'fetchRequest.url', allowedHosts),
    allowedHosts,
    expectedMimeTypes,
    maxBytes,
    timeoutMs,
    requestedAt: isoTimestamp(raw.requestedAt, 'fetchRequest.requestedAt'),
  });
}

/** Build the only fetch request an exact registry match is allowed to produce. */
export function buildSafeFetchRequest({ requestId, source, requestedAt, timeoutMs = 5_000 } = {}) {
  const entry = defineOfficialSource(source);
  return validateRegistryBoundFetchRequest({
    requestId,
    registryEntryId: entry.id,
    url: entry.canonicalUrl,
    allowedHosts: entry.allowedHosts,
    expectedMimeTypes: entry.expectedMimeTypes,
    maxBytes: entry.maxBytes,
    timeoutMs,
    requestedAt,
  }, entry);
}

/** Validate a request against operator-reviewed registry authority rather than request-supplied hosts/limits. */
export function validateRegistryBoundFetchRequest(raw, expectedSource) {
  const source = defineOfficialSource(expectedSource);
  const request = validateFetchRequestShape(raw);
  const sameSet = (left, right) => left.length === right.length && left.every(item => right.includes(item));
  if (request.registryEntryId !== source.id
    || request.url !== source.canonicalUrl
    || !sameSet(request.allowedHosts, source.allowedHosts)
    || !sameSet(request.expectedMimeTypes, source.expectedMimeTypes)
    || request.maxBytes !== source.maxBytes) {
    fail('OFFICIAL_SOURCE_REQUEST_MISMATCH', 'fetchRequest authority must exactly match its registry entry.');
  }
  return request;
}

/** Public validation always requires operator-reviewed registry authority; unbound host/path/query data is unsafe. */
export function validateSafeFetchRequest(raw, expectedSource) {
  if (!expectedSource) fail('OFFICIAL_SOURCE_REGISTRY_REQUIRED', 'fetchRequest requires an operator-reviewed registry entry.');
  return validateRegistryBoundFetchRequest(raw, expectedSource);
}

export function validateSourceAttempt(raw, at = 'sourceAttempt') {
  exactKeys(raw, ['registryEntryId', 'attemptedAt', 'url', 'outcome', 'code', 'httpStatus'], at);
  const attempt = {
    registryEntryId: text(raw.registryEntryId, `${at}.registryEntryId`, 128),
    attemptedAt: isoTimestamp(raw.attemptedAt, `${at}.attemptedAt`),
    url: safeUrl(raw.url, `${at}.url`),
    outcome: enumValue(raw.outcome, SOURCE_ATTEMPT_OUTCOMES, `${at}.outcome`),
    code: nullableText(raw.code, `${at}.code`, 120),
    httpStatus: nullableInteger(raw.httpStatus, `${at}.httpStatus`, { min: 100, max: 599 }),
  };
  if (attempt.code != null && !CODE_PATTERN.test(attempt.code)) fail('OFFICIAL_SOURCE_INVALID', `${at}.code must be a stable machine-readable code.`);
  if (attempt.outcome === 'fetched' && (attempt.code != null || attempt.httpStatus == null || attempt.httpStatus < 200 || attempt.httpStatus >= 300)) {
    fail('OFFICIAL_SOURCE_INVALID', `${at} fetched outcome requires a successful HTTP status and no error code.`);
  }
  if (attempt.outcome !== 'fetched' && attempt.code == null) fail('OFFICIAL_SOURCE_INVALID', `${at} non-fetched outcomes require an error code.`);
  return Object.freeze(attempt);
}

/** Validate immutable provenance and bind it to the registry source that authorised acquisition. */
export function validateArtifactProvenance(raw, { expectedSource } = {}) {
  const source = defineOfficialSource(expectedSource);
  exactKeys(raw, ['registryEntryId', 'sourceClass', 'documentType', 'canonicalUrl', 'finalUrl', 'publisher', 'identity', 'publishedOn', 'retrievedAt', 'contentSha256', 'freshness', 'citation', 'sourceAttempts'], 'provenance');
  exactKeys(raw.freshness, ['status', 'checkedAt', 'expiresAt'], 'provenance.freshness');
  exactKeys(raw.citation, ['locator', 'quote'], 'provenance.citation');
  const sourceAttempts = frozenList(raw.sourceAttempts, 'provenance.sourceAttempts', validateSourceAttempt, { max: 50 });
  const finalUrl = safeUrl(raw.finalUrl, 'provenance.finalUrl', source.allowedHosts);
  if (!sourceAttempts.some(attempt => attempt.outcome === 'fetched' && attempt.registryEntryId === source.id && attempt.url === finalUrl)) {
    fail('OFFICIAL_SOURCE_PROVENANCE_MISMATCH', 'provenance must include a fetched attempt whose registry ID and final URL match the artifact.');
  }
  const contentSha256 = text(raw.contentSha256, 'provenance.contentSha256', 64).toLowerCase();
  if (!SHA256_PATTERN.test(contentSha256)) fail('OFFICIAL_SOURCE_INVALID', 'provenance.contentSha256 must be a SHA-256 hex digest.');
  const provenanceIdentity = validateIdentity(raw.identity, 'provenance.identity');
  const provenance = {
    registryEntryId: text(raw.registryEntryId, 'provenance.registryEntryId', 128),
    sourceClass: enumValue(raw.sourceClass, OFFICIAL_SOURCE_CLASSES, 'provenance.sourceClass'),
    documentType: enumValue(raw.documentType, OFFICIAL_DOCUMENT_TYPES, 'provenance.documentType'),
    canonicalUrl: safeUrl(raw.canonicalUrl, 'provenance.canonicalUrl', source.allowedHosts),
    finalUrl,
    publisher: text(raw.publisher, 'provenance.publisher', 240),
    identity: provenanceIdentity,
    publishedOn: isoDate(raw.publishedOn, 'provenance.publishedOn', { nullable: true }),
    retrievedAt: isoTimestamp(raw.retrievedAt, 'provenance.retrievedAt'),
    contentSha256,
    freshness: Object.freeze({
      status: enumValue(raw.freshness.status, FRESHNESS_STATUSES, 'provenance.freshness.status'),
      checkedAt: isoTimestamp(raw.freshness.checkedAt, 'provenance.freshness.checkedAt'),
      expiresAt: raw.freshness.expiresAt == null ? null : isoTimestamp(raw.freshness.expiresAt, 'provenance.freshness.expiresAt'),
    }),
    citation: Object.freeze({
      locator: text(raw.citation.locator, 'provenance.citation.locator', 240),
      quote: text(raw.citation.quote, 'provenance.citation.quote', 1_000),
    }),
    sourceAttempts,
  };
  const identityMatches = JSON.stringify(provenance.identity) === JSON.stringify(source.identity);
  if (provenance.registryEntryId !== source.id
    || provenance.sourceClass !== source.sourceClass
    || provenance.documentType !== source.documentType
    || provenance.canonicalUrl !== source.canonicalUrl
    || provenance.publisher !== source.publisher
    || !identityMatches) {
    fail('OFFICIAL_SOURCE_PROVENANCE_MISMATCH', 'artifact provenance does not match the expected registry source.');
  }
  return Object.freeze(provenance);
}

export const officialSourceRulePattern = RULE_PATTERN;
export const validateOfficialSourceUrl = safeUrl;
