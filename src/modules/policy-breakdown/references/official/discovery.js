// Contract for official documents whose exact URL is discovered at run time (for example a PDF link read from a
// regulator's product listing). This module performs no I/O.
//
// Trust model: an operator reviews a discovery source once (hosts, path prefixes, query keys, MIME, size). Page
// text can then only *choose among* URLs that rule already allows; it can never widen the host, path or query
// space, and it can never carry private data out in a query string.
import {
  OFFICIAL_DOCUMENT_TYPES,
  OFFICIAL_MIME_TYPES,
  OFFICIAL_SOURCE_CLASSES,
  OfficialSourceContractError,
  validateOfficialSourceUrl,
} from './contracts.js';

const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{1,127}$/;
const HOST_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
// A path prefix ending in "/" matches any non-empty remainder; any other prefix must equal the pathname exactly.
const PATH_PREFIX_PATTERN = /^\/[A-Za-z0-9._~!$&'()*+,;=:@/-]{0,239}$/;
const QUERY_KEY_PATTERN = /^[A-Za-z0-9_.-]{1,120}$/;
const QUERY_VALUE_PATTERN = /^[\x21-\x7e]{1,200}$/;
const UNSAFE_QUERY_VALUE = /["'<>\\`]/;
// Mirrors the private-data signal in contracts.js (not exported there): public lookups never carry these.
const PRIVATE_QUERY_SIGNAL = /\b(?:patient|member|diagnos(?:is|ed)?|disease|condition|symptom|surgery|procedure|treatment|claim|policy[ _-]?number|date[ _-]?of[ _-]?birth|dob|phone|email|aadhaar|pan)\b/i;
const MAX_URL_LENGTH = 2_048;

const fail = (code, message) => { throw new OfficialSourceContractError(code, message); };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function exactKeys(value, allowed, at) {
  if (!isObject(value)) fail('OFFICIAL_SOURCE_INVALID', `${at} must be an object.`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail('OFFICIAL_SOURCE_INVALID', `${at}.${key} is not a permitted field.`);
  }
}

function text(value, at, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail('OFFICIAL_SOURCE_INVALID', `${at} must be a non-empty string of at most ${max} characters.`);
  return value.trim();
}

function enumValue(value, allowed, at) {
  if (!allowed.includes(value)) fail('OFFICIAL_SOURCE_INVALID', `${at} must be one of: ${allowed.join(', ')}.`);
  return value;
}

function integer(value, at, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail('OFFICIAL_SOURCE_INVALID', `${at} must be an integer from ${min} to ${max}.`);
  return value;
}

function list(value, at, normalize, { min, max }) {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail('OFFICIAL_SOURCE_INVALID', `${at} must contain ${min}-${max} items.`);
  return Object.freeze([...new Set(value.map((item, index) => normalize(item, `${at}[${index}]`)))]);
}

function publicHost(value, at) {
  const normalized = text(value, at, 253).toLowerCase().replace(/\.$/, '');
  if (!HOST_PATTERN.test(normalized) || normalized.endsWith('.local') || normalized.endsWith('.localhost') || normalized.endsWith('.internal')) {
    fail('OFFICIAL_SOURCE_HOST_NOT_ALLOWED', `${at} must be a public DNS host.`);
  }
  return normalized;
}

function pathPrefix(value, at) {
  const prefix = text(value, at, 240);
  if (!PATH_PREFIX_PATTERN.test(prefix) || prefix.includes('//') || /(^|\/)\.{1,2}(\/|$)/.test(prefix) || /%/.test(prefix)) {
    fail('OFFICIAL_SOURCE_INVALID', `${at} must be an absolute, normalised path prefix.`);
  }
  return prefix;
}

function queryKey(value, at) {
  if (typeof value !== 'string' || !QUERY_KEY_PATTERN.test(value)) fail('OFFICIAL_SOURCE_INVALID', `${at} must be a plain query key.`);
  return value;
}

/**
 * @typedef {Object} DiscoverySource
 * @property {string} id
 * @property {string} publisher
 * @property {string} sourceClass
 * @property {string} documentType
 * @property {string} indexUrl          page on which links are discovered (operator-reviewed)
 * @property {string[]} allowedHosts
 * @property {string[]} documentPathPrefixes  "/a/b/" = any child path; "/a/b" = exactly that path
 * @property {string[]} allowedQueryKeys      case-sensitive; [] means discovered URLs carry no query
 * @property {string[]} expectedMimeTypes
 * @property {number} maxBytes
 * @property {number|null} freshnessDays
 * @property {string} owner
 */

/** Validate and freeze one operator-reviewed discovery source. */
export function defineDiscoverySource(raw) {
  exactKeys(raw, ['id', 'publisher', 'sourceClass', 'documentType', 'indexUrl', 'allowedHosts', 'documentPathPrefixes', 'allowedQueryKeys', 'expectedMimeTypes', 'maxBytes', 'freshnessDays', 'owner'], 'discoverySource');
  const id = text(raw.id, 'discoverySource.id', 128);
  if (!ID_PATTERN.test(id)) fail('OFFICIAL_SOURCE_INVALID', 'discoverySource.id must be a lowercase stable identifier.');
  const allowedHosts = list(raw.allowedHosts, 'discoverySource.allowedHosts', publicHost, { min: 1, max: 5 });
  const documentPathPrefixes = list(raw.documentPathPrefixes, 'discoverySource.documentPathPrefixes', pathPrefix, { min: 1, max: 10 });
  const allowedQueryKeys = list(raw.allowedQueryKeys ?? [], 'discoverySource.allowedQueryKeys', queryKey, { min: 0, max: 20 });
  const expectedMimeTypes = list(raw.expectedMimeTypes, 'discoverySource.expectedMimeTypes', (item, at) => enumValue(item, OFFICIAL_MIME_TYPES, at), { min: 1, max: 4 });
  // The index URL itself carries no query, so the stricter registry URL rule applies to it unchanged.
  const indexUrl = validateOfficialSourceUrl(raw.indexUrl, 'discoverySource.indexUrl', allowedHosts);
  return Object.freeze({
    id,
    publisher: text(raw.publisher, 'discoverySource.publisher', 240),
    sourceClass: enumValue(raw.sourceClass, OFFICIAL_SOURCE_CLASSES, 'discoverySource.sourceClass'),
    documentType: enumValue(raw.documentType, OFFICIAL_DOCUMENT_TYPES, 'discoverySource.documentType'),
    indexUrl,
    allowedHosts,
    documentPathPrefixes,
    allowedQueryKeys,
    expectedMimeTypes,
    maxBytes: integer(raw.maxBytes, 'discoverySource.maxBytes', 1, MAX_SOURCE_BYTES),
    freshnessDays: raw.freshnessDays == null ? null : integer(raw.freshnessDays, 'discoverySource.freshnessDays', 1, 3_650),
    owner: text(raw.owner, 'discoverySource.owner', 160),
  });
}

const pathAllowed = (pathname, prefixes) => prefixes.some(prefix => (prefix.endsWith('/')
  ? pathname.startsWith(prefix) && pathname.length > prefix.length
  : pathname === prefix));

/**
 * Validate a page-derived (or code-built) URL against a discovery source. Returns the normalised URL string or
 * throws OfficialSourceContractError. Only URLs this rule allows can ever reach the network.
 */
export function validateDiscoveredUrl(url, discoverySource, at = 'discoveredUrl') {
  const source = defineDiscoverySource(discoverySource);
  if (typeof url !== 'string' || !url || url.length > MAX_URL_LENGTH) fail('OFFICIAL_SOURCE_URL_INVALID', `${at} must be a URL of at most ${MAX_URL_LENGTH} characters.`);
  let parsed;
  try { parsed = new URL(url); } catch { fail('OFFICIAL_SOURCE_URL_INVALID', `${at} must be an absolute URL.`); }
  if (parsed.protocol !== 'https:') fail('OFFICIAL_SOURCE_HTTPS_REQUIRED', `${at} must use HTTPS.`);
  if (parsed.port && parsed.port !== '443') fail('OFFICIAL_SOURCE_URL_INVALID', `${at} must use the standard HTTPS port.`);
  if (parsed.username || parsed.password || parsed.hash || url.includes('#')) fail('OFFICIAL_SOURCE_URL_INVALID', `${at} must not contain credentials or a fragment.`);
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!source.allowedHosts.includes(hostname)) fail('OFFICIAL_SOURCE_HOST_NOT_ALLOWED', `${at} host is not allowlisted.`);
  const { pathname } = parsed;
  if (/%2e|%2f|%5c|%00/i.test(pathname) || pathname.includes('\\') || pathname.includes('//')) {
    fail('OFFICIAL_SOURCE_PATH_NOT_ALLOWED', `${at} path contains an encoded separator or traversal.`);
  }
  if (!pathAllowed(pathname, source.documentPathPrefixes)) fail('OFFICIAL_SOURCE_PATH_NOT_ALLOWED', `${at} path is outside the discovery source's allowed prefixes.`);
  const seen = new Set();
  for (const [key, value] of parsed.searchParams.entries()) {
    if (!source.allowedQueryKeys.includes(key)) fail('OFFICIAL_SOURCE_PRIVATE_QUERY', `${at} query parameter ${key.slice(0, 40)} is not allowlisted for ${source.id}.`);
    if (seen.has(key)) fail('OFFICIAL_SOURCE_PRIVATE_QUERY', `${at} query parameter ${key} must not be repeated.`);
    seen.add(key);
    if (!QUERY_VALUE_PATTERN.test(value) || UNSAFE_QUERY_VALUE.test(value) || PRIVATE_QUERY_SIGNAL.test(value)) {
      fail('OFFICIAL_SOURCE_PRIVATE_QUERY', `${at}.${key} contains free text or a private-data signal.`);
    }
  }
  parsed.hostname = hostname;
  return parsed.toString();
}

/** URL safe to record in attempts/logs: origin + path, never the query. */
export function discoveredAttemptUrl(url) {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}`;
}

function isoTimestamp(value, at) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) fail('OFFICIAL_SOURCE_INVALID', `${at} must be an ISO timestamp.`);
  return new Date(value).toISOString();
}

/**
 * Validate a discovered fetch request against its discovery source. Authority (MIME, size) always comes from the
 * source; a request that differs from it is rejected rather than trusted.
 */
export function validateDiscoveredFetchRequest(raw, discoverySource) {
  const source = defineDiscoverySource(discoverySource);
  exactKeys(raw, ['requestId', 'discoverySourceId', 'url', 'expectedMimeTypes', 'maxBytes', 'timeoutMs', 'requestedAt'], 'discoveredFetchRequest');
  if (raw.discoverySourceId !== source.id) fail('OFFICIAL_SOURCE_REQUEST_MISMATCH', 'discoveredFetchRequest.discoverySourceId does not match the discovery source.');
  const expectedMimeTypes = Array.isArray(raw.expectedMimeTypes) ? [...new Set(raw.expectedMimeTypes)] : [];
  const sameMime = expectedMimeTypes.length === source.expectedMimeTypes.length && expectedMimeTypes.every(item => source.expectedMimeTypes.includes(item));
  if (!sameMime || raw.maxBytes !== source.maxBytes) fail('OFFICIAL_SOURCE_REQUEST_MISMATCH', 'discoveredFetchRequest authority must exactly match its discovery source.');
  return Object.freeze({
    requestId: text(raw.requestId, 'discoveredFetchRequest.requestId', 128),
    discoverySourceId: source.id,
    url: validateDiscoveredUrl(raw.url, source, 'discoveredFetchRequest.url'),
    expectedMimeTypes: source.expectedMimeTypes,
    maxBytes: source.maxBytes,
    timeoutMs: integer(raw.timeoutMs, 'discoveredFetchRequest.timeoutMs', 100, 30_000),
    requestedAt: isoTimestamp(raw.requestedAt, 'discoveredFetchRequest.requestedAt'),
  });
}

/** Build the only fetch request a discovered URL is allowed to produce. */
export function buildDiscoveredFetchRequest({ requestId, discoverySource, url, requestedAt, timeoutMs = 10_000 } = {}) {
  const source = defineDiscoverySource(discoverySource);
  return validateDiscoveredFetchRequest({
    requestId,
    discoverySourceId: source.id,
    url,
    expectedMimeTypes: source.expectedMimeTypes,
    maxBytes: source.maxBytes,
    timeoutMs,
    requestedAt,
  }, source);
}

/** Freeze the operator-reviewed discovery sources an adapter may use, keyed by id. Used by the live and fake adapters. */
export function configureDiscoverySources(discoverySources) {
  const byId = new Map();
  for (const raw of discoverySources) {
    const source = defineDiscoverySource(raw);
    if (byId.has(source.id)) throw new OfficialSourceContractError('OFFICIAL_SOURCE_REGISTRY_DUPLICATE', `duplicate discovery source ${source.id}.`);
    byId.set(source.id, source);
  }
  return byId;
}

/** A caller-supplied discovery source must be exactly one the adapter was configured with; it cannot widen rules. */
export function configuredDiscoverySource(discoveryById, rawDiscoverySource) {
  const configured = discoveryById.get(rawDiscoverySource?.id);
  if (!configured) throw new OfficialSourceContractError('OFFICIAL_SOURCE_DISCOVERY_NOT_CONFIGURED', 'discovery source is not configured on this adapter.');
  if (JSON.stringify(defineDiscoverySource(rawDiscoverySource)) !== JSON.stringify(configured)) {
    throw new OfficialSourceContractError('OFFICIAL_SOURCE_REQUEST_MISMATCH', 'discovery source differs from the configured one.');
  }
  return configured;
}
