// Live official-source acquisition adapter. Same fetch(request) contract as fake-adapter.js, plus contentSha256.
// Network is used only when `enabled === true`; the caller maps OFFICIAL_SOURCE_FETCH_ENABLED onto that flag.
import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';

import {
  OfficialSourceContractError,
  defineOfficialSource,
  validateOfficialSourceUrl,
  validateRegistryBoundFetchRequest,
  validateSourceAttempt,
} from './contracts.js';
import {
  configureDiscoverySources,
  configuredDiscoverySource,
  discoveredAttemptUrl,
  validateDiscoveredFetchRequest,
  validateDiscoveredUrl,
} from './discovery.js';

const MAX_REDIRECTS = 3;
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const USER_AGENT = 'KnowviaSourceFetcher/1.0';
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const PDF_MAGIC = Buffer.from('%PDF-', 'latin1');

const blockedV4 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blockedV4.addSubnet(network, prefix, 'ipv4');

const blockedV6 = new BlockList();
for (const [network, prefix] of [
  ['::', 96], // unspecified, loopback and deprecated IPv4-compatible addresses
  ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
]) blockedV6.addSubnet(network, prefix, 'ipv6');

function expandIpv6(address) {
  let value = address.toLowerCase().split('%', 1)[0];
  const dotted = value.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) {
    const octets = dotted[1].split('.').map(Number);
    const tail = `${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
    value = value.slice(0, -dotted[1].length) + tail;
  }
  const [head, rest] = value.split('::');
  const left = head ? head.split(':') : [];
  const right = rest ? rest.split(':') : [];
  const missing = value.includes('::') ? 8 - left.length - right.length : 0;
  const groups = [...left, ...Array(Math.max(missing, 0)).fill('0'), ...right].map(group => Number.parseInt(group || '0', 16));
  return groups.length === 8 && groups.every(group => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? groups : null;
}

const embeddedIpv4 = groups => [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join('.');

/**
 * Classify a resolved address. Anything that is not a publicly routable unicast address (or does not parse)
 * is blocked. IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::/96) addresses are judged by their IPv4 part.
 */
export function classifyIpAddress(address) {
  const family = isIP(String(address ?? '').split('%', 1)[0]);
  if (family === 4) {
    return blockedV4.check(address, 'ipv4') || address === '255.255.255.255'
      ? Object.freeze({ allowed: false, family: 4, reason: 'non_public_ipv4' })
      : Object.freeze({ allowed: true, family: 4, reason: null });
  }
  if (family === 6) {
    const groups = expandIpv6(address);
    if (!groups) return Object.freeze({ allowed: false, family: 6, reason: 'unparseable_address' });
    const mapped = groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xffff;
    const nat64 = groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every(group => group === 0);
    if (mapped || nat64) {
      const inner = classifyIpAddress(embeddedIpv4(groups));
      return Object.freeze({ ...inner, family: 6, reason: inner.allowed ? null : 'non_public_embedded_ipv4' });
    }
    const canonical = groups.map(group => group.toString(16)).join(':');
    return blockedV6.check(canonical, 'ipv6')
      ? Object.freeze({ allowed: false, family: 6, reason: 'non_public_ipv6' })
      : Object.freeze({ allowed: true, family: 6, reason: null });
  }
  return Object.freeze({ allowed: false, family: null, reason: 'unparseable_address' });
}

function blockedAddressError() {
  const error = new Error('resolved address is not a public unicast address.');
  error.code = 'SOURCE_ADDRESS_BLOCKED';
  return error;
}

/**
 * Build a `lookup` for https.request that resolves every address and refuses the connection if ANY address
 * is non-public. Because the socket connects to what this lookup returns, the check covers DNS rebinding.
 */
export function createGuardedLookup({ resolve = dnsLookup } = {}) {
  return function guardedLookup(hostname, options, callback) {
    const done = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'object' && options !== null ? options : { family: typeof options === 'number' ? options : 0 };
    resolve(hostname, { all: true, family: opts.family ?? 0 }, (error, addresses) => {
      if (error) return done(error);
      const list = Array.isArray(addresses) ? addresses : [];
      if (list.length === 0 || list.some(entry => !classifyIpAddress(entry?.address).allowed)) return done(blockedAddressError());
      if (opts.all) return done(null, list.map(({ address, family }) => ({ address, family })));
      return done(null, list[0].address, list[0].family);
    });
  };
}

/** Default transport: one HTTPS GET, no body, no cookies, no auth, no compression negotiation. */
function httpsTransport(url, { lookup, signal }) {
  return new Promise((resolve, reject) => {
    const hostname = new URL(url).hostname.replace(/^\[|\]$/g, '');
    // Node skips `lookup` for IP literals; the registry allowlist already forbids them, this is defence in depth.
    if (isIP(hostname)) return reject(blockedAddressError());
    const req = httpsRequest(url, {
      method: 'GET',
      headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
      lookup,
      signal,
      agent: false,
    }, response => resolve({ status: response.statusCode, headers: response.headers, body: response }));
    req.on('error', reject);
    req.end();
  });
}

const headerValue = (headers, name) => {
  if (!headers) return '';
  const value = typeof headers.get === 'function' ? headers.get(name) : headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '');
};

function discard(body) {
  try { body?.destroy?.(); } catch { /* best effort */ }
}

function stableFailure(request, attemptedAt, code, outcome, httpStatus = null) {
  // Failure attempts always carry the registry URL so redirect targets never reach logs or storage.
  const attempt = validateSourceAttempt({ registryEntryId: request.registryEntryId, attemptedAt, url: request.url, outcome, code, httpStatus });
  return Object.freeze({ ok: false, requestId: request.requestId, error: Object.freeze({ code }), attempts: Object.freeze([attempt]) });
}

class FetchFailure extends Error {
  constructor(code, outcome, httpStatus = null) {
    super(code);
    this.code = code;
    this.outcome = outcome;
    this.httpStatus = httpStatus;
  }
}

async function readCappedBody(body, cap, sizeState) {
  const hash = createHash('sha256');
  const chunks = [];
  let total = 0;
  for await (const chunk of body) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > cap) {
      sizeState.exceeded = true;
      discard(body);
      throw new FetchFailure('SOURCE_TOO_LARGE', 'rejected');
    }
    hash.update(buffer);
    chunks.push(buffer);
  }
  return { bytes: new Uint8Array(Buffer.concat(chunks, total)), contentSha256: hash.digest('hex') };
}

/**
 * One guarded acquisition: HTTPS GET via the guarded lookup, bounded redirects (each re-validated by
 * `validateRedirect`), status/encoding/MIME/size checks, PDF magic, SHA-256. Never throws for upstream problems;
 * returns { ok:true, status, url, redirects, mimeType, bytes, contentSha256 } or { ok:false, code, outcome, httpStatus }.
 */
async function guardedAcquire({ startUrl, validateRedirect, expectedMimeTypes, cap, timeoutMs, transport, lookup }) {
  const controller = new AbortController();
  const sizeState = { exceeded: false };
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  let body = null;
  const aborted = new Promise((_, reject) => {
    controller.signal.addEventListener('abort', () => { discard(body); reject(new Error('aborted')); }, { once: true });
  });
  aborted.catch(() => {});
  const failed = (code, outcome, httpStatus = null) => ({ ok: false, code, outcome, httpStatus });
  try {
    let currentUrl = startUrl;
    const redirects = [];
    let response;
    for (;;) {
      response = await Promise.race([transport(currentUrl, { lookup, signal: controller.signal }), aborted]);
      body = response?.body ?? null;
      const status = response?.status;
      if (!Number.isInteger(status) || status < 100 || status > 599) throw new FetchFailure('SOURCE_UPSTREAM_ERROR', 'unavailable');
      if (!REDIRECT_STATUSES.has(status)) break;
      discard(body);
      body = null;
      if (redirects.length >= MAX_REDIRECTS) throw new FetchFailure('SOURCE_REDIRECT_LIMIT', 'rejected', status);
      const location = headerValue(response.headers, 'location');
      let nextUrl;
      try {
        nextUrl = validateRedirect(new URL(location, currentUrl).toString(), `redirects[${redirects.length}]`);
      } catch {
        throw new FetchFailure('SOURCE_REDIRECT_REJECTED', 'rejected', status);
      }
      redirects.push(nextUrl);
      currentUrl = nextUrl;
    }

    const status = response.status;
    if (status === 404) throw new FetchFailure('SOURCE_NOT_FOUND', 'not_found', 404);
    if (status < 200 || status >= 300) throw new FetchFailure('SOURCE_UPSTREAM_ERROR', 'unavailable', status);
    const encoding = headerValue(response.headers, 'content-encoding').trim().toLowerCase();
    if (encoding && encoding !== 'identity') throw new FetchFailure('SOURCE_ENCODING_REJECTED', 'rejected', status);
    const mimeType = headerValue(response.headers, 'content-type').split(';', 1)[0].trim().toLowerCase();
    if (!expectedMimeTypes.includes(mimeType)) throw new FetchFailure('SOURCE_MIME_REJECTED', 'rejected', status);
    const declaredLength = Number(headerValue(response.headers, 'content-length') || Number.NaN);
    if (Number.isFinite(declaredLength) && declaredLength > cap) throw new FetchFailure('SOURCE_TOO_LARGE', 'rejected', status);
    if (!body || typeof body[Symbol.asyncIterator] !== 'function') throw new FetchFailure('SOURCE_UPSTREAM_ERROR', 'unavailable', status);

    let read;
    try {
      read = await Promise.race([readCappedBody(body, cap, sizeState), aborted]);
    } catch (error) {
      if (error instanceof FetchFailure) throw new FetchFailure(error.code, error.outcome, status);
      throw error;
    }
    if (mimeType === 'application/pdf' && !Buffer.from(read.bytes.subarray(0, PDF_MAGIC.length)).equals(PDF_MAGIC)) {
      throw new FetchFailure('SOURCE_CONTENT_MISMATCH', 'mismatch', status);
    }
    return { ok: true, status, url: currentUrl, redirects, mimeType, bytes: read.bytes, contentSha256: read.contentSha256 };
  } catch (error) {
    discard(body);
    if (error instanceof FetchFailure) return failed(error.code, error.outcome, error.httpStatus);
    if (sizeState.exceeded) return failed('SOURCE_TOO_LARGE', 'rejected');
    if (timedOut) return failed('SOURCE_TIMEOUT', 'unavailable');
    if (error?.code === 'SOURCE_ADDRESS_BLOCKED' || error?.cause?.code === 'SOURCE_ADDRESS_BLOCKED') return failed('SOURCE_ADDRESS_BLOCKED', 'rejected');
    return failed('SOURCE_UNAVAILABLE', 'unavailable');
  } finally {
    clearTimeout(timer);
  }
}

function discoveredFailure(request, attemptedAt, code, outcome, httpStatus = null) {
  // Attempts record origin + path of the requested URL only: no query string, no redirect targets.
  const attempt = validateSourceAttempt({
    registryEntryId: request.discoverySourceId, attemptedAt, url: discoveredAttemptUrl(request.url), outcome, code, httpStatus,
  });
  return Object.freeze({ ok: false, requestId: request.requestId, error: Object.freeze({ code }), attempts: Object.freeze([attempt]) });
}

/**
 * Live adapter. Fetch result on success:
 * { ok, requestId, registryEntryId, url (final), mimeType, byteLength, bytes, contentSha256, retrievedAt, redirects, attempts }.
 * Failures: { ok:false, requestId, error:{code}, attempts:[attempt] }. Invalid or registry-mismatched requests throw,
 * exactly like the fake; upstream/network problems never throw.
 *
 * fetchDiscovered(request, discoverySource) fetches a run-time discovered URL. The discovery source must be one the
 * adapter was configured with (`discoverySources`), the URL and every redirect must pass validateDiscoveredUrl,
 * and MIME/size authority comes from the configured source. Success adds `discoverySourceId` instead of
 * `registryEntryId`; attempts carry origin + path only.
 */
export function createLiveOfficialSourceAdapter({
  registry = [],
  discoverySources = [],
  enabled = false,
  transport = httpsTransport,
  now = () => new Date(),
  maxBytes = DEFAULT_MAX_BYTES,
  timeoutMs = null,
  resolveHost = dnsLookup,
} = {}) {
  if (!Array.isArray(registry) || !Array.isArray(discoverySources) || registry.length + discoverySources.length === 0) {
    throw new TypeError('registry must contain at least one operator-reviewed source.');
  }
  if (typeof transport !== 'function') throw new TypeError('transport must be a function.');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('maxBytes must be a positive integer.');
  if (timeoutMs != null && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)) throw new TypeError('timeoutMs must be a positive integer.');
  const sourceById = new Map();
  for (const rawSource of registry) {
    const source = defineOfficialSource(rawSource);
    if (sourceById.has(source.id)) throw new OfficialSourceContractError('OFFICIAL_SOURCE_REGISTRY_DUPLICATE', `duplicate registry source ${source.id}.`);
    sourceById.set(source.id, source);
  }
  const discoveryById = configureDiscoverySources(discoverySources);
  const networkEnabled = enabled === true;
  const lookup = createGuardedLookup({ resolve: resolveHost });
  const timestamp = () => new Date(now()).toISOString();

  return Object.freeze({
    kind: 'live_official_source_adapter',
    networkEnabled,
    async fetch(rawRequest) {
      const source = sourceById.get(rawRequest?.registryEntryId);
      if (!source) throw new OfficialSourceContractError('OFFICIAL_SOURCE_REGISTRY_NOT_FOUND', 'fetchRequest registry entry is not configured.');
      const request = validateRegistryBoundFetchRequest(rawRequest, source);
      const attemptedAt = timestamp();
      if (!networkEnabled) return stableFailure(request, attemptedAt, 'SOURCE_FETCH_DISABLED', 'unavailable');

      const result = await guardedAcquire({
        startUrl: request.url,
        validateRedirect: (url, at) => validateOfficialSourceUrl(url, at, request.allowedHosts),
        expectedMimeTypes: request.expectedMimeTypes,
        cap: Math.min(maxBytes, request.maxBytes),
        timeoutMs: timeoutMs ?? request.timeoutMs,
        transport,
        lookup,
      });
      if (!result.ok) return stableFailure(request, attemptedAt, result.code, result.outcome, result.httpStatus);
      const retrievedAt = timestamp();
      const attempt = validateSourceAttempt({
        registryEntryId: request.registryEntryId,
        attemptedAt,
        url: result.url,
        outcome: 'fetched',
        code: null,
        httpStatus: result.status,
      });
      return Object.freeze({
        ok: true,
        requestId: request.requestId,
        registryEntryId: request.registryEntryId,
        url: result.url,
        mimeType: result.mimeType,
        byteLength: result.bytes.byteLength,
        bytes: result.bytes,
        contentSha256: result.contentSha256,
        retrievedAt,
        redirects: Object.freeze([...result.redirects]),
        attempts: Object.freeze([attempt]),
      });
    },
    async fetchDiscovered(rawRequest, rawDiscoverySource) {
      const discoverySource = configuredDiscoverySource(discoveryById, rawDiscoverySource);
      const request = validateDiscoveredFetchRequest(rawRequest, discoverySource);
      const attemptedAt = timestamp();
      if (!networkEnabled) return discoveredFailure(request, attemptedAt, 'SOURCE_FETCH_DISABLED', 'unavailable');

      const result = await guardedAcquire({
        startUrl: request.url,
        validateRedirect: (url, at) => validateDiscoveredUrl(url, discoverySource, at),
        expectedMimeTypes: request.expectedMimeTypes,
        cap: Math.min(maxBytes, request.maxBytes),
        timeoutMs: timeoutMs ?? request.timeoutMs,
        transport,
        lookup,
      });
      if (!result.ok) return discoveredFailure(request, attemptedAt, result.code, result.outcome, result.httpStatus);
      const attempt = validateSourceAttempt({
        registryEntryId: request.discoverySourceId,
        attemptedAt,
        url: discoveredAttemptUrl(result.url),
        outcome: 'fetched',
        code: null,
        httpStatus: result.status,
      });
      return Object.freeze({
        ok: true,
        requestId: request.requestId,
        discoverySourceId: request.discoverySourceId,
        url: result.url,
        mimeType: result.mimeType,
        byteLength: result.bytes.byteLength,
        bytes: result.bytes,
        contentSha256: result.contentSha256,
        retrievedAt: timestamp(),
        redirects: Object.freeze([...result.redirects]),
        attempts: Object.freeze([attempt]),
      });
    },
  });
}
