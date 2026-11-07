// Read-only client for the insurance-data-api reference service (X1 audit). Off unless REFERENCE_DATA_ENABLED is
// exactly "true". Only the allow-listed GET endpoints below exist; POST /v1/customer-mappings/resolve is deliberately
// absent (it takes a raw policy-schedule reference, which must never leave CoverSaath). The only request inputs are an
// insurer alias, a UIN, or opaque ids returned by earlier calls. No household or personal data can be expressed here.
import { ReferenceDataError, errorForStatus, referenceError } from './errors.js';
import * as schemas from './schemas.js';

export const DEFAULT_TIMEOUT_MS = 2000;
export const MAX_TIMEOUT_MS = 5000;
export const DEFAULT_MAX_RESPONSE_BYTES = 262_144;
const BREAKER_THRESHOLD = 3;
const BREAKER_OPEN_MS = 30_000;
const MAX_RETRY_AFTER_MS = 60_000;

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/;
const FACT_TYPE = /^[a-z][a-z0-9_]{0,63}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

const normalizeText = value => {
  if (typeof value !== 'string') throw invalidRequest();
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (collapsed.length < 1 || collapsed.length > 100 || CONTROL.test(collapsed)) throw invalidRequest();
  return collapsed;
};
// Same normalisation the service applies to UINs (trim, collapse spaces, upper-case).
const normalizeUin = value => {
  const uin = normalizeText(value).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9 ./_-]{2,63}$/.test(uin)) throw invalidRequest();
  return uin;
};
const normalizeId = value => { if (typeof value !== 'string' || !ID.test(value)) throw invalidRequest(); return value; };
const invalidRequest = () => referenceError('REFERENCE_DATA_REQUEST_INVALID', 'Reference data request was invalid.', { statusCode: 400 });

// The allow-list. Each entry fixes the path template, the permitted parameters and the response validator.
export const REFERENCE_ENDPOINTS = Object.freeze({
  'insurers.search': {
    normalize: p => ({ q: normalizeText(p.q) }),
    request: p => ({ path: '/v1/insurers', query: { q: p.q, limit: '20' } }),
    parse: schemas.parseInsurerList,
  },
  'insurers.resolve': {
    normalize: p => ({ q: normalizeText(p.q) }),
    request: p => ({ path: '/v1/insurers/resolve', query: { q: p.q } }),
    parse: schemas.parseInsurerResolve,
  },
  'products.search': {
    normalize: p => {
      const out = {};
      if (p.uin !== undefined) out.uin = normalizeUin(p.uin);
      if (p.insurerId !== undefined) out.insurerId = normalizeId(p.insurerId);
      if (p.q !== undefined) out.q = normalizeText(p.q);
      if (Object.keys(out).length === 0) throw invalidRequest();
      return out;
    },
    request: p => ({ path: '/v1/products', query: { uin: p.uin, insurer_id: p.insurerId, q: p.q, limit: '20' } }),
    parse: schemas.parseProductSearch,
  },
  'products.get': {
    normalize: p => ({ productId: normalizeId(p.productId) }),
    request: p => ({ path: `/v1/products/${encodeURIComponent(p.productId)}`, query: {} }),
    parse: schemas.parseProduct,
  },
  'products.versions': {
    normalize: p => ({ productId: normalizeId(p.productId) }),
    request: p => ({ path: `/v1/products/${encodeURIComponent(p.productId)}/versions`, query: { limit: '50' } }),
    parse: schemas.parseVersionList,
  },
  'versions.facts': {
    normalize: p => {
      const out = { versionId: normalizeId(p.versionId) };
      if (p.factType !== undefined) {
        if (typeof p.factType !== 'string' || !FACT_TYPE.test(p.factType)) throw invalidRequest();
        out.factType = p.factType;
      }
      return out;
    },
    request: p => ({ path: `/v1/versions/${encodeURIComponent(p.versionId)}/facts`, query: { fact_type: p.factType } }),
    parse: schemas.parseFacts,
  },
});

export const referenceDataEnabled = (env = process.env) => env?.REFERENCE_DATA_ENABLED === 'true';

function readConfig(env) {
  if (!referenceDataEnabled(env)) return { enabled: false };
  const apiKey = env.REFERENCE_DATA_API_KEY;
  let base;
  try { base = new URL(env.REFERENCE_DATA_BASE_URL); } catch { base = null; }
  const loopback = base && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname);
  if (!base || !apiKey || (base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback))
    || base.username || base.password || base.search || base.hash) {
    throw referenceError('REFERENCE_DATA_NOT_CONFIGURED', 'Reference data is not configured.', { statusCode: 503 });
  }
  const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(100, Number(env.REFERENCE_DATA_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS));
  const maxBytes = Math.min(2_097_152, Math.max(1024, Number(env.REFERENCE_DATA_MAX_RESPONSE_BYTES) || DEFAULT_MAX_RESPONSE_BYTES));
  return { enabled: true, apiKey, origin: base.origin, basePath: base.pathname.replace(/\/+$/, ''), timeoutMs, maxBytes };
}

async function readBounded(response, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel().catch(() => {}); throw tooLarge(); }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > maxBytes) throw tooLarge();
  return text;
}
const tooLarge = () => referenceError('REFERENCE_DATA_RESPONSE_TOO_LARGE', 'Reference data response is too large.', { statusCode: 502 });

function retryAfter(response) {
  const seconds = Number(response.headers?.get?.('retry-after'));
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS) : null;
}

/** Builds the client. `fetchImpl` is injectable so tests use a local stub and never reach a live service. */
export function createInsuranceDataClient({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  let config;
  let failures = 0;
  let openUntil = 0;

  const ensure = () => {
    config ??= readConfig(env);
    if (!config.enabled) throw referenceError('REFERENCE_DATA_DISABLED', 'Reference data is disabled.', { statusCode: 503 });
    return config;
  };
  const definition = endpoint => {
    const found = Object.hasOwn(REFERENCE_ENDPOINTS, endpoint) ? REFERENCE_ENDPOINTS[endpoint] : null;
    if (!found) throw referenceError('REFERENCE_DATA_ENDPOINT_NOT_ALLOWED', 'Reference data endpoint is not allowed.', { statusCode: 400 });
    return found;
  };

  return {
    enabled: referenceDataEnabled(env),
    /** Validates and normalises params for an allow-listed endpoint. Throws on unknown endpoint or any unexpected input. */
    normalizeParams(endpoint, params = {}) {
      const def = definition(endpoint);
      if (params === null || typeof params !== 'object') throw invalidRequest();
      const allowed = new Set(['q', 'uin', 'insurerId', 'productId', 'versionId', 'factType']);
      if (Object.keys(params).some(key => !allowed.has(key))) throw invalidRequest();
      return def.normalize(params);
    },
    async read(endpoint, rawParams = {}) {
      const def = definition(endpoint);
      const cfg = ensure();
      const params = this.normalizeParams(endpoint, rawParams);
      if (now() < openUntil) throw referenceError('REFERENCE_DATA_UNAVAILABLE', 'Reference data is unavailable.', { retryable: true, statusCode: 503 });
      const { path, query } = def.request(params);
      const url = new URL(`${cfg.origin}${cfg.basePath}${path}`);
      for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, value);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
      try {
        let response;
        try {
          response = await fetchImpl(url, {
            method: 'GET', redirect: 'error', signal: controller.signal,
            headers: { accept: 'application/json', authorization: `Bearer ${cfg.apiKey}` },
          });
        } catch {
          throw referenceError('REFERENCE_DATA_UNAVAILABLE', 'Reference data is unavailable.', { retryable: true, statusCode: 503 });
        }
        if (!response.ok) throw errorForStatus(response.status, response.status === 429 ? retryAfter(response) : null);
        let text;
        try { text = await readBounded(response, cfg.maxBytes); } catch (error) {
          if (error instanceof ReferenceDataError) throw error;
          throw referenceError('REFERENCE_DATA_UNAVAILABLE', 'Reference data is unavailable.', { retryable: true, statusCode: 503 });
        }
        let json;
        try { json = JSON.parse(text); } catch { throw referenceError('REFERENCE_DATA_RESPONSE_INVALID', 'Reference data response did not match the expected shape.', { statusCode: 502 }); }
        const data = def.parse(json);
        failures = 0;
        const etag = response.headers?.get?.('etag');
        return { data, etag: typeof etag === 'string' && etag.length <= 200 ? etag : null };
      } catch (error) {
        // Only availability faults trip the breaker; auth, not-found and shape errors are not outages.
        if (error instanceof ReferenceDataError && error.retryable && error.code !== 'REFERENCE_DATA_RATE_LIMITED') {
          failures += 1;
          if (failures >= BREAKER_THRESHOLD) openUntil = now() + BREAKER_OPEN_MS;
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
