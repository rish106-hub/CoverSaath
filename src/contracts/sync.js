// Sync contract (ADR 0017, migration 031): pull by cursor, snapshot, batched idempotent push. No personal data lives here.
//
//   GET  /api/v1/households/{id}/changes?since=<seq>&limit=<1..200>[&include=data]
//        -> { items: [{ seq, entity, id, op, revision, at, data? }], next, hasMore }
//   GET  /api/v1/households/{id}/snapshot[?cursor=<opaque>]
//        -> { seq, items: [{ entity, id, revision, data }], cursor, hasMore }       use `seq` as `since` once hasMore is false
//   POST /api/v1/households/{id}/sync/push   { items: [{ mutationId, entity, id, op, baseRevision, data, baseData? }] } (1..50)
//        -> { results: [{ mutationId, entity, id, status, revision?, code?, message?, serverCopy?, data?, replayed? }] }
//
// Push item shapes (`data` is the body of the matching PUT route; `id` is the server id, or the natural key for a first write):
//   places       data { kind, memberId?, ...PUT /places/{kind} body }      op upsert | delete (id = the place id for delete)
//   preferences  data { prefs }                                            id = your adult id
//   onboarding   data { state, completed? }                                id = your adult id
//   scenarios    data { tool, inputs }                                     id = the tool name or the scenario id
//   permissions  data { permission, state, surface, wordingVersion? }      id = the permission name or the permission id
// `baseRevision` is the revision the client last saw (0 = it believes the row does not exist). `baseData` (optional, preferences and
// scenarios only) is the document the client last saw; with it a stale write whose changed keys do not overlap the server's is merged.
// Result status: applied | merged | conflict (code REVISION_CONFLICT or DELETED, serverCopy for the first) | rejected (code).

export const SYNC_LIMITS = Object.freeze({
  changesDefault: 100,
  changesMax: 200,
  pushMax: 50,
  responseBytes: 256 * 1024,
  retentionDays: 30,
  mutationTtlDays: 7,
  readsPerMinute: 240,
  pushesPerMinute: 30,
  pushBodyBytes: 1024 * 1024,
});

/** Entities the change feed and snapshot serve. cases and documents are logged but not served until they have readers. */
export const SYNC_FEED_ENTITIES = Object.freeze(['members', 'policies', 'places', 'preferences', 'onboarding', 'scenarios', 'permissions']);
export const SYNC_PUSH_ENTITIES = Object.freeze(['places', 'preferences', 'onboarding', 'scenarios', 'permissions']);
export const SYNC_PUSH_OPS = Object.freeze(['upsert', 'delete']);
/** Entities whose disjoint keys may merge automatically. Money, policy and member entities never do. */
export const SYNC_MERGE_ENTITIES = Object.freeze(['preferences', 'scenarios']);

export const SYNC_ERROR_CODES = Object.freeze({
  INVALID_REQUEST: 400,
  CURSOR_EXPIRED: 410,
  SYNC_RATE_LIMITED: 429,
  PAYLOAD_TOO_LARGE: 413,
});

const MUTATION_ID = /^[A-Za-z0-9_.:-]{8,100}$/;
const ITEM_ID = /^[A-Za-z0-9_.:-]{1,100}$/;
const ITEM_KEYS = ['mutationId', 'entity', 'id', 'op', 'baseRevision', 'data', 'baseData'];

function fail(code, message, statusCode) { throw Object.assign(new Error(message), { code, statusCode }); }
const invalid = message => fail('INVALID_REQUEST', message, 400);

export const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** JSON with sorted keys, so equal documents have equal text whatever order a client sent them in. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function wholeNumber(raw, field, { min, max }) {
  if (typeof raw !== 'string' || !/^[0-9]{1,15}$/.test(raw)) invalid(`${field} must be a whole number.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) invalid(`${field} must be a whole number from ${min} to ${max}.`);
  return value;
}

/** Query of GET /changes. Unknown parameters are refused. */
export function parseChangesQuery(query) {
  for (const key of Object.keys(query)) if (!['since', 'limit', 'include'].includes(key)) invalid('Unknown query parameter.');
  const since = query.since === undefined ? 0 : wholeNumber(query.since, 'since', { min: 0, max: Number.MAX_SAFE_INTEGER });
  const limit = query.limit === undefined ? SYNC_LIMITS.changesDefault : wholeNumber(query.limit, 'limit', { min: 1, max: SYNC_LIMITS.changesMax });
  if (query.include !== undefined && query.include !== 'data') invalid('include must be data.');
  return { since, limit, includeData: query.include === 'data' };
}

/** Snapshot cursor: opaque to clients, bound to the household and to the seq the snapshot started at. */
export function encodeSnapshotCursor({ householdId, seq, entityIndex, after }) {
  return Buffer.from(JSON.stringify({ v: 1, h: householdId, s: seq, e: entityIndex, a: after }), 'utf8').toString('base64url');
}

export function decodeSnapshotCursor(cursor, householdId) {
  let value;
  try {
    if (typeof cursor !== 'string' || cursor.length > 400 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch { return invalid('cursor is not valid.'); }
  const ok = isPlainObject(value) && value.v === 1 && value.h === householdId && Number.isSafeInteger(value.s) && value.s >= 0
    && Number.isInteger(value.e) && value.e >= 0 && value.e < SYNC_FEED_ENTITIES.length && (value.a === null || (typeof value.a === 'string' && value.a.length <= 100));
  if (!ok) invalid('cursor is not valid.');
  return { seq: value.s, entityIndex: value.e, after: value.a };
}

export function parseSnapshotQuery(query) {
  for (const key of Object.keys(query)) if (key !== 'cursor') invalid('Unknown query parameter.');
  return { cursor: query.cursor ?? null };
}

/** Envelope of POST /sync/push: { items: [...] } with 1 to 50 objects. Each item is judged on its own by parsePushItem. */
export function parsePushBody(body) {
  if (!isPlainObject(body)) invalid('The body must be a JSON object.');
  for (const key of Object.keys(body)) if (key !== 'items') invalid('The body has an unknown field.');
  if (!Array.isArray(body.items) || body.items.length < 1) invalid('items must hold at least one mutation.');
  if (body.items.length > SYNC_LIMITS.pushMax) fail('INVALID_REQUEST', `items holds more than ${SYNC_LIMITS.pushMax} mutations.`, 400);
  return body.items;
}

const rejected = (mutationId, entity, id, code, message) => ({ ok: false, result: { mutationId, entity, id, status: 'rejected', code, message } });

/**
 * Judges one push item: { ok: true, item } or { ok: false, result } (a per-item rejection, never an exception). An unknown entity
 * or operation is a rejection of that item alone.
 */
export function parsePushItem(raw) {
  if (!isPlainObject(raw)) return rejected(null, null, null, 'INVALID_REQUEST', 'A mutation must be a JSON object.');
  const mutationId = typeof raw.mutationId === 'string' && MUTATION_ID.test(raw.mutationId) ? raw.mutationId : null;
  const entity = typeof raw.entity === 'string' && raw.entity.length <= 40 ? raw.entity : null;
  const id = typeof raw.id === 'string' && ITEM_ID.test(raw.id) ? raw.id : null;
  if (!mutationId) return rejected(null, entity, id, 'INVALID_REQUEST', 'mutationId must be 8 to 100 letters, digits or . _ : -.');
  if (Object.keys(raw).some(key => !ITEM_KEYS.includes(key))) return rejected(mutationId, entity, id, 'INVALID_REQUEST', 'The mutation has an unknown field.');
  if (!SYNC_PUSH_ENTITIES.includes(entity)) return rejected(mutationId, entity, id, 'SYNC_ENTITY_UNSUPPORTED', 'This entity cannot be pushed.');
  if (!id) return rejected(mutationId, entity, null, 'INVALID_REQUEST', 'id is required.');
  if (!SYNC_PUSH_OPS.includes(raw.op)) return rejected(mutationId, entity, id, 'INVALID_REQUEST', 'op must be upsert or delete.');
  if (raw.op === 'delete' && entity !== 'places') return rejected(mutationId, entity, id, 'SYNC_OPERATION_UNSUPPORTED', 'This entity cannot be deleted.');
  if (!Number.isInteger(raw.baseRevision) || raw.baseRevision < 0 || raw.baseRevision > 999_999_999) {
    return rejected(mutationId, entity, id, 'INVALID_REQUEST', 'baseRevision must be a whole number from 0.');
  }
  if (raw.op === 'upsert' && !isPlainObject(raw.data)) return rejected(mutationId, entity, id, 'INVALID_REQUEST', 'data must be a JSON object.');
  if (raw.op === 'delete' && raw.data !== undefined && !isPlainObject(raw.data)) return rejected(mutationId, entity, id, 'INVALID_REQUEST', 'data must be a JSON object.');
  if (raw.baseData !== undefined && !isPlainObject(raw.baseData)) return rejected(mutationId, entity, id, 'INVALID_REQUEST', 'baseData must be a JSON object.');
  return { ok: true, item: { mutationId, entity, id, op: raw.op, baseRevision: raw.baseRevision, data: raw.data ?? null, baseData: raw.baseData ?? null } };
}
