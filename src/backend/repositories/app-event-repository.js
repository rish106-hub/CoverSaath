import { createHmac } from 'node:crypto';

// Append-only application activity events (migration 022, ADR 0014). Plain columns hold queryable metadata only; every
// other detail is sealed into payload_enc (enc1 envelope, AAD app_events.payload_enc.<row id>). Payload keys and values
// are restricted to short identifiers and numbers, so free text (e-mail, query text, document text, tokens) cannot be
// stored even by mistake.

export const APP_EVENT_NAMES = Object.freeze([
  'http_request', 'rate_limit_hit', 'provider_call', 'server_error', 'worker_event', 'consent_view', 'upload_attempt', 'readback_query', 'sign_in',
]);
const NAME_SET = new Set(APP_EVENT_NAMES);
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const ID = /^[A-Za-z0-9_.:-]{1,100}$/;
const WORD = /^[a-z0-9_.-]{1,64}$/;
const CODE = /^[A-Za-z0-9_.-]{1,64}$/;
const PAYLOAD_KEY = /^[a-z][A-Za-z0-9]{0,39}$/;
const PAYLOAD_TEXT = /^[A-Za-z0-9_.:-]{1,64}$/;
const MAX_PAYLOAD_KEYS = 20;
const MAX_PAYLOAD_BYTES = 1500;

const pick = (value, pattern) => (typeof value === 'string' && pattern.test(value) ? value : null);

/** Keeps scalar numbers, booleans and short identifier strings; drops everything else (never throws). */
export function sanitizePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const clean = {};
  for (const [key, value] of Object.entries(payload).slice(0, MAX_PAYLOAD_KEYS)) {
    if (!PAYLOAD_KEY.test(key)) continue;
    if (typeof value === 'number' && Number.isFinite(value)) clean[key] = value;
    else if (typeof value === 'boolean') clean[key] = value;
    else if (typeof value === 'string' && PAYLOAD_TEXT.test(value)) clean[key] = value;
  }
  if (Object.keys(clean).length === 0) return null;
  return JSON.stringify(clean).length <= MAX_PAYLOAD_BYTES ? clean : null;
}

/** Validated event row fields, or null when the event name is unknown. */
export function normalizeEvent(event = {}) {
  if (!NAME_SET.has(event.name)) return null;
  const status = Number.isInteger(event.status) && event.status >= 100 && event.status <= 599 ? event.status : null;
  const duration = Number.isFinite(event.durationMs) && event.durationMs >= 0 ? Math.min(Math.round(event.durationMs), 2_147_483_647) : null;
  return {
    name: event.name,
    requestId: pick(event.requestId, /^[A-Za-z0-9_.:-]{1,64}$/),
    householdId: pick(event.householdId, ID),
    adultUserId: pick(event.adultUserId, ID),
    caseId: pick(event.caseId, ID),
    consentGrantId: pick(event.consentGrantId, ID),
    route: typeof event.route === 'string' && event.route.length > 0 && event.route.length <= 120 && /^[\x21-\x7e]+$/.test(event.route) ? event.route : null,
    method: METHODS.has(event.method) ? event.method : null,
    status,
    durationMs: duration,
    provider: pick(event.provider, WORD),
    outcome: pick(event.outcome, WORD),
    code: pick(event.code, CODE),
    clientHash: pick(event.clientHash, /^[0-9a-f]{16}$/),
    payload: sanitizePayload(event.payload),
  };
}

/** Keyed hash of a client address: stable for rate analysis, useless without the key. 16 hex characters. */
export function hashClient(hmacKey, clientKey) {
  return createHmac('sha256', hmacKey).update(String(clientKey)).digest('hex').slice(0, 16);
}

const COLUMNS = ['id', 'occurred_at', 'expires_at', 'event_name', 'request_id', 'household_id', 'adult_user_id', 'case_id', 'consent_grant_id',
  'route', 'method', 'status', 'duration_ms', 'provider', 'outcome', 'code', 'client_hash', 'payload_enc'];

export class AppEventRepository {
  // columnCrypto is needed only to write or read payloads; redaction, erasure and purge work without it.
  constructor(database, { columnCrypto = null, clock = () => new Date() } = {}) {
    this.database = database;
    this.columnCrypto = columnCrypto;
    this.clock = clock;
  }

  get crypto() {
    if (!this.columnCrypto) throw Object.assign(new Error('Application events need a column crypto.'), { code: 'COLUMN_ENCRYPTION_NOT_CONFIGURED' });
    return this.columnCrypto;
  }

  /** Inserts normalized events in one statement. `retentionMs` sets expires_at. Returns the number written. */
  async insertBatch(events, { retentionMs }) {
    if (events.length === 0) return 0;
    const db = this.database;
    const { rows: ids } = await db.query(
      "SELECT nextval(pg_get_serial_sequence('app_events', 'id')) AS id FROM generate_series(1, CAST(? AS integer))", [events.length],
    );
    const params = [];
    const tuples = events.map((event, index) => {
      const id = String(ids[index].id);
      const occurredAt = event.at ?? this.clock();
      const row = [
        id, occurredAt.toISOString(), new Date(occurredAt.getTime() + retentionMs).toISOString(), event.name, event.requestId, event.householdId,
        event.adultUserId, event.caseId, event.consentGrantId, event.route, event.method, event.status, event.durationMs, event.provider,
        event.outcome, event.code, event.clientHash, event.payload ? this.crypto.sealJson('app_events', 'payload_enc', id, event.payload) : null,
      ];
      params.push(...row);
      return '(CAST(? AS bigint), CAST(? AS timestamptz), CAST(? AS timestamptz), ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS smallint), CAST(? AS integer), ?, ?, ?, ?, ?)';
    });
    const result = await db.run(`INSERT INTO app_events (${COLUMNS.join(', ')}) OVERRIDING SYSTEM VALUE VALUES ${tuples.join(', ')}`, params);
    return result.changes;
  }

  /** Decrypted events, newest first, for one household. Operator/test read; payloads open here and nowhere else. */
  async listForHousehold(householdId, { limit = 100 } = {}) {
    const rows = await this.database.many('SELECT * FROM app_events WHERE household_id = ? ORDER BY id DESC LIMIT ?', [householdId, Math.min(Math.max(limit, 1), 1000)]);
    return rows.map(row => ({ ...row, payload: row.payload_enc ? this.crypto.openJson('app_events', 'payload_enc', String(row.id), row.payload_enc) : null }));
  }

  /** Consent revocation: payloads of events tied to the grant are erased; the metadata row stays. */
  async redactForGrant(grantId) {
    return (await this.database.run(
      'UPDATE app_events SET payload_enc = NULL, redacted_at = now() WHERE consent_grant_id = ? AND payload_enc IS NOT NULL', [grantId],
    )).changes;
  }

  async eraseForHousehold(householdId) {
    return (await this.database.run('DELETE FROM app_events WHERE household_id = ?', [householdId])).changes;
  }

  async eraseForAdult(adultUserId) {
    return (await this.database.run('DELETE FROM app_events WHERE adult_user_id = ?', [adultUserId])).changes;
  }

  /** Retention: deletes events past expires_at, at most `limit` per call so a purge never holds long locks. */
  async purgeExpired({ limit = 5000 } = {}) {
    return (await this.database.run(
      'DELETE FROM app_events WHERE id IN (SELECT id FROM app_events WHERE expires_at < now() ORDER BY expires_at LIMIT ?)', [limit],
    )).changes;
  }
}
