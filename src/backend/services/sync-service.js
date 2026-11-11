import { createRateLimiter } from '../../shared/http/index.js';
import { householdLock } from '../database/postgres/locks.js';
import { setSyncActor } from '../repositories/sync-actor.js';
import { parsePlaceKind, parseScenarioTool, parsePermissionName, assertBodySize } from '../../contracts/user-data.js';
import {
  SYNC_FEED_ENTITIES, SYNC_LIMITS, SYNC_MERGE_ENTITIES, canonicalJson, decodeSnapshotCursor, encodeSnapshotCursor, isPlainObject,
  parseChangesQuery, parsePushBody, parsePushItem, parseSnapshotQuery,
} from '../../contracts/sync.js';

// Pull, snapshot and push over the per-household change log (ADR 0028). Every call proves the session adult belongs to the household
// first (the same check, in the same transaction for push, that the user-data routes make), reads data only through the existing
// readers, and writes only through the existing user-data service methods, so validation, ownership, roles, sealing, revisions and
// audit are exactly those of the PUT routes. Nothing here opens a sealed column.

function fail(code, message, statusCode) { throw Object.assign(new Error(message), { code, statusCode }); }
const coded = error => typeof error?.code === 'string' && Number.isInteger(error.statusCode) && error.statusCode < 500;
const sizeOf = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const changedKeys = (base, next) => [...new Set([...Object.keys(base), ...Object.keys(next)])]
  .filter(key => canonicalJson(base[key] ?? null) !== canonicalJson(next[key] ?? null) || (key in base) !== (key in next));

export function createSyncService({ database, access, userData, userDataRepository, app, repository, audit, columnCrypto, clock = () => new Date(), limits = {} }) {
  const bounds = { ...SYNC_LIMITS, ...limits };
  const readLimiter = createRateLimiter({ limit: bounds.readsPerMinute, windowMs: 60_000, clock: () => clock().getTime() });
  const pushLimiter = createRateLimiter({ limit: bounds.pushesPerMinute, windowMs: 60_000, clock: () => clock().getTime() });
  const throttle = (limiter, scope, adultId) => {
    try { limiter.check(`${scope}:${adultId}`); } catch { fail('SYNC_RATE_LIMITED', 'Too many sync requests. Wait a moment and try again.', 429); }
  };
  const SKIP = { skipThrottle: true };

  // ---- Readers: entity id (as the log names it) -> the DTO the existing routes return ---------------------------------------

  const readers = {
    members: async (principal, householdId) => new Map((await app.listMembers(principal, householdId)).members.map(row => [row.id, row])),
    policies: async (principal, householdId) => new Map((await app.listPolicies(principal, householdId)).policies.map(row => [row.id, row])),
    places: async (principal, householdId) => new Map((await userDataRepository.listPlaces({ householdId, adultId: principal.adultId })).map(row => [row.id, row])),
    preferences: async (principal, householdId) => {
      const row = await userDataRepository.getPreferences({ householdId, adultId: principal.adultId });
      return row.revision === 0 ? new Map() : new Map([[principal.adultId, row]]);
    },
    onboarding: async (principal, householdId) => {
      const row = await userDataRepository.getOnboarding({ householdId, adultId: principal.adultId });
      return row.revision === 0 ? new Map() : new Map([[principal.adultId, row]]);
    },
    scenarios: async (principal, householdId) => {
      const byTool = new Map((await userDataRepository.listScenarios({ householdId, adultId: principal.adultId })).map(row => [row.tool, row]));
      const rows = await repository.scenarioRows(householdId, principal.adultId);
      return new Map(rows.filter(row => byTool.has(row.tool)).map(row => [row.id, byTool.get(row.tool)]));
    },
    permissions: async (principal, householdId) => {
      const byName = new Map((await userDataRepository.listPermissions({ householdId, adultId: principal.adultId })).map(row => [row.permission, row]));
      const rows = await repository.permissionRows(householdId, principal.adultId);
      return new Map(rows.filter(row => byName.has(row.permission)).map(row => [row.id, byName.get(row.permission)]));
    },
  };

  // ---- Pull ------------------------------------------------------------------------------------------------------------------

  async function assertCursor(householdId, since) {
    const min = await repository.minSeq(householdId);
    const top = await repository.maxSeq(householdId);
    if (since < min || since > Math.max(top, min)) fail('CURSOR_EXPIRED', 'This cursor is too old. Take a snapshot and continue from it.', 410);
    return min;
  }

  async function changes(principal, householdId, query) {
    await access.requireHousehold(principal, householdId);
    const { since, limit, includeData } = parseChangesQuery(query);
    throttle(readLimiter, 'sync-read', principal.adultId);
    await assertCursor(householdId, since);
    const rows = await repository.listChanges({ householdId, adultId: principal.adultId, since, limit: limit + 1 });
    // A trim between the check and the read could have removed entries after `since`; check the floor again.
    if (since < await repository.minSeq(householdId)) fail('CURSOR_EXPIRED', 'This cursor is too old. Take a snapshot and continue from it.', 410);
    const hasMoreRows = rows.length > limit;
    const page = rows.slice(0, limit);
    const needsPlaces = page.some(row => row.entity === 'places' && row.op === 'upsert');
    // A place only some members may see (another adult's own address) is hidden from the others; its delete shows an id only.
    const visiblePlaces = needsPlaces ? await readers.places(principal, householdId) : null;
    const shown = page.filter(row => row.entity !== 'places' || row.op === 'delete' || visiblePlaces.has(row.entity_id));
    const loaded = new Map();
    if (includeData) {
      for (const entity of new Set(shown.filter(row => row.op === 'upsert').map(row => row.entity))) loaded.set(entity, entity === 'places' ? visiblePlaces : await readers[entity](principal, householdId));
    }
    const items = [];
    let bytes = 0;
    let trimmed = false;
    for (const row of shown) {
      const item = { seq: row.seq, entity: row.entity, id: row.entity_id, op: row.op, revision: row.revision, at: row.at };
      if (includeData && row.op === 'upsert') item.data = loaded.get(row.entity)?.get(row.entity_id) ?? null;
      const size = sizeOf(item);
      if (includeData && items.length > 0 && bytes + size > bounds.responseBytes) { trimmed = true; break; }
      bytes += size;
      items.push(item);
    }
    const next = trimmed ? items.at(-1).seq : (page.at(-1)?.seq ?? since);
    return { householdId, items, next, hasMore: trimmed || hasMoreRows };
  }

  // ---- Snapshot --------------------------------------------------------------------------------------------------------------

  // Pages every readable entity. `seq` is read before any entity, so replaying `changes?since=seq` over the snapshot converges: an
  // entity edited after `seq` may appear in its newer state, and its log entry (seq' > seq) re-delivers that same state.
  async function snapshot(principal, householdId, query) {
    await access.requireHousehold(principal, householdId);
    const { cursor } = parseSnapshotQuery(query);
    throttle(readLimiter, 'sync-read', principal.adultId);
    let seq; let entityIndex = 0; let after = null;
    if (cursor) {
      ({ seq, entityIndex, after } = decodeSnapshotCursor(cursor, householdId));
      if (seq < await repository.minSeq(householdId)) fail('CURSOR_EXPIRED', 'This snapshot is too old. Start again.', 410);
    } else {
      seq = Math.max(await repository.maxSeq(householdId), await repository.minSeq(householdId));
      await audit?.append({ householdId, actorType: 'adult_user', actorId: principal.adultId, action: 'sync.snapshot', resourceType: 'household', resourceId: householdId, payload: { seq } });
    }
    const items = [];
    let bytes = 0;
    let last = null;
    let hasMore = false;
    scan: for (let index = entityIndex; index < SYNC_FEED_ENTITIES.length; index += 1) {
      const entity = SYNC_FEED_ENTITIES[index];
      const rows = await readers[entity](principal, householdId);
      for (const id of [...rows.keys()].sort()) {
        if (index === entityIndex && after !== null && id <= after) continue;
        const data = rows.get(id);
        const item = { entity, id, revision: data.revision ?? 1, data };
        const size = sizeOf(item);
        if (items.length >= bounds.changesMax || (items.length > 0 && bytes + size > bounds.responseBytes)) { hasMore = true; break scan; }
        bytes += size;
        items.push(item);
        last = { index, id };
      }
    }
    return {
      householdId, seq, items, hasMore,
      cursor: hasMore ? encodeSnapshotCursor({ householdId, seq, entityIndex: last.index, after: last.id }) : null,
    };
  }

  // ---- Push ------------------------------------------------------------------------------------------------------------------

  // The row a mutation names, in the shape the feed uses: { id, dto }, or null when it does not exist. { id, dto: null } is a row
  // this adult may not read.
  async function current(entity, principal, householdId, item) {
    const adultId = principal.adultId;
    if (entity === 'preferences' || entity === 'onboarding') {
      const dto = (await readers[entity](principal, householdId)).get(adultId);
      return dto ? { id: adultId, dto } : null;
    }
    if (entity === 'scenarios') {
      const row = (await repository.scenarioRows(householdId, adultId)).find(candidate => candidate.tool === item.data.tool);
      return row ? { id: row.id, dto: (await readers.scenarios(principal, householdId)).get(row.id) ?? null } : null;
    }
    if (entity === 'permissions') {
      const row = (await repository.permissionRows(householdId, adultId)).find(candidate => candidate.permission === item.data.permission);
      return row ? { id: row.id, dto: (await readers.permissions(principal, householdId)).get(row.id) ?? null } : null;
    }
    const { kind, memberId = null, slot = null } = item.data ?? {};
    const placeId = item.op === 'delete' ? item.id : await repository.placeId({ householdId, adultId, kind, memberId, slot });
    if (!placeId) return null;
    const row = await repository.placeById(householdId, placeId);
    if (!row) return null;
    return { id: placeId, dto: (await readers.places(principal, householdId)).get(placeId) ?? null };
  }

  // A document is a plain object; for review_state the document is its `items` map. Returns null when the shape does not allow merging.
  const docOf = (entity, tool, body) => {
    if (!isPlainObject(body)) return null;
    if (entity === 'preferences') return isPlainObject(body.prefs) ? body.prefs : null;
    if (tool === 'review_state') return isPlainObject(body.inputs) && isPlainObject(body.inputs.items ?? {}) ? (body.inputs.items ?? {}) : null;
    return isPlainObject(body.inputs) ? body.inputs : null;
  };

  const wrapDoc = (entity, tool, doc) => {
    if (entity === 'preferences') return { prefs: doc };
    return { tool, inputs: tool === 'review_state' ? { items: doc } : doc };
  };

  // Disjoint-key merge for preferences and scenarios: the client's changes since baseData (top-level keys; review_state items one
  // level down) are applied onto the server copy when the server did not change the same key to a different value. Otherwise null.
  function mergeBody(item, serverDto) {
    const tool = item.entity === 'scenarios' ? item.data.tool : null;
    const base = docOf(item.entity, tool, item.baseData);
    const client = docOf(item.entity, tool, item.data);
    const server = docOf(item.entity, tool, item.entity === 'preferences' ? { prefs: serverDto.prefs } : { inputs: serverDto.inputs });
    if (!base || !client || !server) return null;
    const mine = changedKeys(base, client);
    const theirs = new Set(changedKeys(base, server));
    for (const key of mine) {
      if (theirs.has(key) && canonicalJson(client[key] ?? null) !== canonicalJson(server[key] ?? null)) return null;
    }
    const merged = { ...server };
    for (const key of mine) { if (key in client) merged[key] = client[key]; else delete merged[key]; }
    return item.entity === 'preferences' ? wrapDoc('preferences', null, merged) : wrapDoc('scenarios', tool, merged);
  }

  const serverCopy = row => (row?.dto ? { id: row.id, revision: row.dto.revision ?? 1, data: row.dto } : null);
  const outcomeOf = result => ({ status: result.status, code: result.code, revision: result.revision });

  function target(entity, principal, item) {
    if (entity === 'preferences' || entity === 'onboarding') {
      if (item.id !== principal.adultId) fail('SYNC_ID_MISMATCH', 'This entity belongs to the signed-in adult.', 400);
    } else if (entity === 'scenarios') {
      parseScenarioTool(item.data?.tool);
    } else if (entity === 'permissions') {
      parsePermissionName(item.data?.permission);
    } else if (item.op === 'upsert') {
      parsePlaceKind(item.data?.kind);
    }
  }

  // Names the id the client used must be the natural key or the row id; anything else is a stale or foreign reference.
  async function checkId(entity, principal, householdId, item) {
    if (entity === 'scenarios' || entity === 'permissions') {
      const natural = entity === 'scenarios' ? item.data.tool : item.data.permission;
      if (item.id === natural) return;
      const row = await current(entity, principal, householdId, item);
      if (!row || row.id !== item.id) fail('SYNC_ID_MISMATCH', 'The id does not name this entity.', 400);
    }
  }

  async function write(entity, principal, householdId, item, data) {
    const ifMatch = String(item.baseRevision);
    switch (entity) {
      case 'preferences': return userData.setPreferences(principal, householdId, data, ifMatch, SKIP);
      case 'onboarding': return userData.setOnboarding(principal, householdId, data, ifMatch, SKIP);
      case 'scenarios': return userData.setScenario(principal, householdId, data.tool, { inputs: data.inputs }, ifMatch, SKIP);
      case 'permissions': {
        const { permission, ...body } = data;
        return userData.setPermission(principal, householdId, permission, body, ifMatch, SKIP);
      }
      default: {
        const { kind, memberId, ...body } = data;
        return userData.setPlace(principal, householdId, kind, memberId === undefined || memberId === null ? {} : { memberId }, body, ifMatch, SKIP);
      }
    }
  }

  async function apply(principal, householdId, item) {
    const { entity } = item;
    target(entity, principal, item);
    await checkId(entity, principal, householdId, item);
    if (item.op === 'delete') {
      const row = await repository.placeById(householdId, item.id);
      if (!row) return { status: 'applied', revision: item.baseRevision };
      try {
        await userData.deletePlace(principal, householdId, row.kind, { ...(row.member_id ? { memberId: row.member_id } : {}), ...(row.slot ? { slot: row.slot } : {}) }, String(item.baseRevision), SKIP);
        return { status: 'applied', revision: row.revision + 1 };
      } catch (error) {
        if (error?.code !== 'REVISION_CONFLICT') throw error;
        return conflict(principal, householdId, item);
      }
    }
    try {
      const result = await write(entity, principal, householdId, item, item.data);
      return { status: 'applied', revision: result.revision };
    } catch (error) {
      if (error?.code !== 'REVISION_CONFLICT') throw error;
      return resolve(principal, householdId, item);
    }
  }

  async function conflict(principal, householdId, item) {
    const row = await current(item.entity, principal, householdId, item);
    if (!row && item.baseRevision > 0) return { status: 'conflict', code: 'DELETED' };
    return { status: 'conflict', code: 'REVISION_CONFLICT', revision: row?.dto?.revision, serverCopy: serverCopy(row) };
  }

  async function resolve(principal, householdId, item) {
    const row = await current(item.entity, principal, householdId, item);
    if (!row) return conflict(principal, householdId, item);
    if (SYNC_MERGE_ENTITIES.includes(item.entity) && item.baseData && row.dto && item.baseRevision > 0 && row.dto.revision > item.baseRevision) {
      const merged = mergeBody(item, row.dto);
      if (merged) {
        try {
          const result = await write(item.entity, principal, householdId, { ...item, baseRevision: row.dto.revision }, merged);
          const { householdId: _household, ...data } = result;
          return { status: 'merged', revision: result.revision, data };
        } catch (error) {
          if (error?.code !== 'REVISION_CONFLICT') throw error;
        }
      }
    }
    return { status: 'conflict', code: 'REVISION_CONFLICT', revision: row.dto?.revision, serverCopy: serverCopy(row) };
  }

  async function replay(principal, householdId, item, outcome) {
    const result = { status: outcome.status, ...(outcome.code ? { code: outcome.code } : {}), ...(outcome.revision !== undefined ? { revision: outcome.revision } : {}), replayed: true };
    if (outcome.status === 'conflict' && outcome.code === 'REVISION_CONFLICT') {
      const row = await current(item.entity, principal, householdId, item).catch(() => null);
      result.serverCopy = serverCopy(row);
    }
    return result;
  }

  async function processItem(principal, householdId, raw) {
    const parsed = parsePushItem(raw);
    if (!parsed.ok) return parsed.result;
    const { item } = parsed;
    const label = { mutationId: item.mutationId, entity: item.entity, id: item.id };
    try {
      for (const body of [item.data, item.baseData]) if (body) assertBodySize(body);
      const requestDigest = columnCrypto.blindIndex('sync_mutation', canonicalJson({ entity: item.entity, id: item.id, op: item.op, baseRevision: item.baseRevision, data: item.data, baseData: item.baseData }));
      const stored = await repository.findMutation({ adultId: principal.adultId, householdId, mutationId: item.mutationId });
      if (stored) {
        if (stored.requestDigest !== requestDigest) return { ...label, status: 'rejected', code: 'MUTATION_ID_REUSED', message: 'This mutationId was used for a different change.' };
        return { ...label, ...await replay(principal, householdId, item, stored.outcome) };
      }
      // Its own savepoint: a failed item rolls back alone, and the dedupe record commits (or not) with the change it describes.
      const result = await database.transaction(async () => {
        const outcome = await apply(principal, householdId, item);
        if (['applied', 'merged', 'conflict'].includes(outcome.status)) {
          await repository.storeMutation({ adultId: principal.adultId, householdId, mutationId: item.mutationId, requestDigest, outcome: outcomeOf(outcome) });
        }
        return outcome;
      });
      return { ...label, ...result };
    } catch (error) {
      if (!coded(error)) throw error;
      return { ...label, status: 'rejected', code: error.code, message: error.message };
    }
  }

  async function push(principal, householdId, body) {
    await access.requireHousehold(principal, householdId);
    const items = parsePushBody(body);
    throttle(pushLimiter, 'sync-push', principal.adultId);
    // One transaction under the household lock: the items run one after another, each in its own savepoint, and the household
    // advisory lock (also taken by the log trigger) keeps the change log in commit order. A retry of the whole call after an
    // unexpected failure is safe because every item carries its mutationId.
    const results = await database.transaction(async () => {
      await setSyncActor(database, principal.adultId);
      const out = [];
      for (const raw of items) out.push(await processItem(principal, householdId, raw));
      const counts = { items: out.length, applied: 0, merged: 0, conflict: 0, rejected: 0, replayed: 0 };
      for (const result of out) { counts[result.status] += 1; if (result.replayed) counts.replayed += 1; }
      await audit?.append({ householdId, actorType: 'adult_user', actorId: principal.adultId, action: 'sync.push', resourceType: 'household', resourceId: householdId, payload: counts });
      return out;
    }, { locks: [householdLock(householdId)] });
    return { householdId, results };
  }

  return { changes, snapshot, push };
}
