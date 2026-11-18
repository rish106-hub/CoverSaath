// FSS handoff v1 (ADR 0037): the backend hands the insurer lookup to the reference service as a task and gets the result back later, by a
// signed notice. This module is the contract and nothing else: request and response validators, the notice signature, and a small client.
// Identifiers only. No household, person, policy number or document text can be expressed in a request. The UIN never appears in a notice.
// Off unless REFERENCE_DATA_ENABLED is "true" (same switch and credential as the read client) and FSS_HANDOFF_ENABLED is "true".
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ReferenceDataError, errorForStatus, referenceError } from './errors.js';

export const HANDOFF_STATES = Object.freeze(['accepted', 'working', 'matched', 'no_match', 'needs_review', 'unavailable', 'rights_blocked']);
/** A state FSS will not change again. The notice is sent when a handoff reaches one of these. */
export const HANDOFF_FINAL_STATES = Object.freeze(['matched', 'no_match', 'needs_review', 'unavailable', 'rights_blocked']);
export const NOTICE_REPLAY_WINDOW_MS = 5 * 60_000;
export const SIGNATURE_HEADER = 'x-fss-signature';

const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,99}$/;
const HANDOFF_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/;
const VERSION_ID = HANDOFF_ID;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const invalid = () => referenceError('REFERENCE_DATA_REQUEST_INVALID', 'Handoff request was invalid.', { statusCode: 400 });
const badShape = () => referenceError('REFERENCE_DATA_RESPONSE_INVALID', 'Handoff response did not match the expected shape.', { statusCode: 502 });

function name(value, max = 100) {
  if (typeof value !== 'string') throw invalid();
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length < 1 || text.length > max || CONTROL.test(text)) throw invalid();
  return text;
}

/** The only fields a handoff request may carry. `uin` is optional and goes only to FSS, never into a notice or a page. */
export function normalizeHandoffRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid();
  const allowed = new Set(['requestId', 'insurerName', 'productName', 'uin']);
  if (Object.keys(input).some(key => !allowed.has(key))) throw invalid();
  if (typeof input.requestId !== 'string' || !REQUEST_ID.test(input.requestId)) throw invalid();
  const out = { requestId: input.requestId, insurerName: name(input.insurerName), productName: name(input.productName) };
  if (input.uin !== undefined) {
    const uin = name(input.uin, 64).toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9 ./_-]{2,63}$/.test(uin)) throw invalid();
    out.uin = uin;
  }
  return out;
}

/** FSS answer to a create or a get: { handoffId, requestId, state, versionId? }. Anything else is refused. */
export function parseHandoff(json) {
  if (!json || typeof json !== 'object') throw badShape();
  const body = json.handoff ?? json;
  const handoffId = body.handoff_id ?? body.handoffId;
  const requestId = body.request_id ?? body.requestId;
  const versionId = body.version_id ?? body.versionId ?? null;
  if (typeof handoffId !== 'string' || !HANDOFF_ID.test(handoffId) || typeof requestId !== 'string' || !REQUEST_ID.test(requestId)
    || !HANDOFF_STATES.includes(body.state) || (versionId !== null && (typeof versionId !== 'string' || !VERSION_ID.test(versionId)))) throw badShape();
  return Object.freeze({ handoffId, requestId, state: body.state, versionId });
}

/** `t=<unix ms>,v1=<hex hmac-sha256 over "<t>.<raw body>">`. */
export function signNotice(rawBody, secret, timestampMs = Date.now()) {
  const mac = createHmac('sha256', secret).update(`${timestampMs}.${rawBody}`).digest('hex');
  return `t=${timestampMs},v1=${mac}`;
}

/**
 * Checks a notice before it is read: a header of the form above, a timestamp inside the replay window, and a matching HMAC (constant time).
 * Returns the parsed notice `{ handoffId, requestId, state, versionId }` for a final state only; throws a coded error otherwise.
 * The body is parsed only after the signature holds, and only the fields of `parseHandoff` survive.
 */
export function verifyNotice({ rawBody, header, secret, now = Date.now() }) {
  const bad = code => referenceError(code, 'The notice was refused.', { statusCode: 401 });
  if (typeof secret !== 'string' || secret.length < 16) throw referenceError('REFERENCE_DATA_NOT_CONFIGURED', 'Handoff notices are not configured.', { statusCode: 503 });
  const match = /^t=(\d{10,16}),v1=([0-9a-f]{64})$/.exec(String(header ?? ''));
  if (!match || typeof rawBody !== 'string') throw bad('FSS_NOTICE_SIGNATURE_INVALID');
  const at = Number(match[1]);
  if (Math.abs(now - at) > NOTICE_REPLAY_WINDOW_MS) throw bad('FSS_NOTICE_STALE');
  const expected = Buffer.from(createHmac('sha256', secret).update(`${at}.${rawBody}`).digest('hex'), 'hex');
  const given = Buffer.from(match[2], 'hex');
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw bad('FSS_NOTICE_SIGNATURE_INVALID');
  let json;
  try { json = JSON.parse(rawBody); } catch { throw bad('FSS_NOTICE_SIGNATURE_INVALID'); }
  const notice = parseHandoff(json);
  if (!HANDOFF_FINAL_STATES.includes(notice.state)) throw bad('FSS_NOTICE_NOT_FINAL');
  return notice;
}

export const handoffEnabled = (env = process.env) => env?.REFERENCE_DATA_ENABLED === 'true' && env?.FSS_HANDOFF_ENABLED === 'true';

/** Create and get over the same base URL, key, timeout and redirect rule as the read client. `fetchImpl` is injectable for tests. */
export function createHandoffClient({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const config = () => {
    if (!handoffEnabled(env)) throw referenceError('REFERENCE_DATA_DISABLED', 'Handoff is disabled.', { statusCode: 503 });
    let base;
    try { base = new URL(env.REFERENCE_DATA_BASE_URL); } catch { base = null; }
    const loopback = base && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname);
    const allowedBaseUrls = String(env.REFERENCE_DATA_ALLOWED_BASE_URLS || '')
      .split(',')
      .map(v => v.trim())
      .filter(Boolean);
    const baseUrl = base ? base.toString() : '';
    const isAllowedBaseUrl = allowedBaseUrls.includes(baseUrl);
    if (!base || !env.REFERENCE_DATA_API_KEY || (base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback)) || base.username || base.password || base.search || base.hash || !isAllowedBaseUrl) {
      throw referenceError('REFERENCE_DATA_NOT_CONFIGURED', 'Reference data is not configured.', { statusCode: 503 });
    }
    return { origin: base.origin, basePath: base.pathname.replace(/\/+$/, ''), key: env.REFERENCE_DATA_API_KEY, timeoutMs: Math.min(5000, Math.max(100, Number(env.REFERENCE_DATA_TIMEOUT_MS) || 2000)) };
  };
  async function send(method, path, body, headers = {}) {
    const cfg = config();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
      let response;
      try {
        response = await fetchImpl(new URL(`${cfg.origin}${cfg.basePath}${path}`), {
          method, redirect: 'error', signal: controller.signal, body: body === undefined ? undefined : JSON.stringify(body),
          headers: { accept: 'application/json', authorization: `Bearer ${cfg.key}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
        });
      } catch { throw referenceError('REFERENCE_DATA_UNAVAILABLE', 'Reference data is unavailable.', { retryable: true, statusCode: 503 }); }
      if (!response.ok) throw errorForStatus(response.status);
      let json;
      try { json = JSON.parse(await response.text()); } catch { throw badShape(); }
      return parseHandoff(json);
    } finally { clearTimeout(timer); }
  }
  return Object.freeze({
    /** Idempotent on `requestId`: the same id returns the same handoff. */
    create: request => { const body = normalizeHandoffRequest(request); return send('POST', '/v1/handoffs', { request_id: body.requestId, insurer_name: body.insurerName, product_name: body.productName, ...(body.uin ? { uin: body.uin } : {}) }, { 'idempotency-key': body.requestId }); },
    get: handoffId => { if (typeof handoffId !== 'string' || !HANDOFF_ID.test(handoffId)) throw invalid(); return send('GET', `/v1/handoffs/${encodeURIComponent(handoffId)}`); },
  });
}
export { ReferenceDataError };
