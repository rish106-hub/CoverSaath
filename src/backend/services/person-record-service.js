import { createSharedWindowLimiter } from './shared-window-limiter.js';
import { captureSchema, parseRecordBody, parseRecordType, parseSlot } from '../../contracts/capture-registry.js';
import { parseIfMatch } from './user-data-service.js';

// Service for person records (ADR 0026): validates the registry shape on the plaintext, then hands off to the repository, which
// proves household ownership, the subject, the guardian rule and consent again inside the write transaction. Writes are limited to
// 60 per adult per minute, shared by every API machine through `limitStore` (ADR 0014 D9).
const WRITES_PER_MINUTE = 60;
const WRITE_ROLES = ['owner', 'member'];

function fail(code, message, statusCode) { throw Object.assign(new Error(message), { code, statusCode }); }
const invalid = message => fail('INVALID_REQUEST', message, 400);

export function createPersonRecordService({ access, repository, clock = () => new Date(), writesPerMinute = WRITES_PER_MINUTE, limitStore = null }) {
  const limiter = createSharedWindowLimiter({ limit: writesPerMinute, store: limitStore, clock: () => clock().getTime() });
  const throttle = async adultId => {
    try { await limiter.check(`person-records:${adultId}`); } catch {
      fail('USER_DATA_RATE_LIMITED', 'Too many changes. Wait a moment and try again.', 429);
    }
  };
  const memberIdOf = value => {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,100}$/.test(value)) invalid('memberId is not valid.');
    return value;
  };
  const shared = async (principal, householdId) => {
    const { role } = await access.requireHousehold(principal, householdId);
    if (!WRITE_ROLES.includes(role.role)) fail('HOUSEHOLD_WRITE_FORBIDDEN', 'Your role in this household can read but not change it.', 403);
  };

  return {
    schema() { return captureSchema(); },

    async list(principal, householdId, query = {}) {
      await access.requireHousehold(principal, householdId);
      const type = query.type === undefined || query.type === '' ? null : parseRecordType(query.type);
      const result = await repository.list({ householdId, adultId: principal.adultId, type, memberId: memberIdOf(query.memberId) });
      return { householdId, ...result };
    },

    async get(principal, householdId, type, slot, query = {}) {
      await access.requireHousehold(principal, householdId);
      parseRecordType(type);
      const record = await repository.get({ householdId, adultId: principal.adultId, type, slot: parseSlot(type, slot), memberId: memberIdOf(query.memberId) });
      return { householdId, ...record };
    },

    async set(principal, householdId, type, slot, query, body, ifMatchHeader, { now = clock() } = {}) {
      await shared(principal, householdId);
      parseRecordType(type);
      const cleanSlot = parseSlot(type, slot);
      const memberId = memberIdOf(query?.memberId);
      const parsed = parseRecordBody(type, body, { now });
      const ifMatch = parseIfMatch(ifMatchHeader);
      await throttle(principal.adultId);
      const record = await repository.set({ householdId, adultId: principal.adultId, type, slot: cleanSlot, memberId, parsed, ifMatch });
      return { householdId, ...record };
    },

    async remove(principal, householdId, type, slot, query, ifMatchHeader) {
      await shared(principal, householdId);
      parseRecordType(type);
      const cleanSlot = parseSlot(type, slot);
      const memberId = memberIdOf(query?.memberId);
      const ifMatch = parseIfMatch(ifMatchHeader);
      await throttle(principal.adultId);
      await repository.delete({ householdId, adultId: principal.adultId, type, slot: cleanSlot, memberId, ifMatch });
      return { status: 'removed', type, slot: cleanSlot };
    },
  };
}
