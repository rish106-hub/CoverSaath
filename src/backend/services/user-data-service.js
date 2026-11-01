import { createRateLimiter } from '../../shared/http/index.js';
import {
  parseAccessBody, parsePermissionBody, parsePermissionName, parsePlaceBody, parsePlaceKind, parsePreferencesBody, parseOnboardingBody,
  parseScenarioBody, parseScenarioTool, PLACE_SLOTS,
} from '../../contracts/user-data.js';

// Service for the data the app collects from a person (spec user-data-store-spec.md, ADR 0015). Authorisation lives in two
// places: here, before any work (every call proves the session adult belongs to the household, and household-wide places need
// the owner or member role), and again inside each repository transaction. Validation runs on the plaintext before sealing.
// Writes are limited to 60 per adult per minute in this process (the limiter is per process, like the request limiter).
const WRITE_ROLES = ['owner', 'member'];
const WRITES_PER_MINUTE = 60;

function fail(code, message, statusCode) { throw Object.assign(new Error(message), { code, statusCode }); }
const invalid = message => fail('INVALID_REQUEST', message, 400);

// If-Match carries the revision the caller last saw: 3, "3" or W/"3". Absent means "replace whatever is there".
export function parseIfMatch(header) {
  if (header === undefined || header === null || header === '') return null;
  const match = typeof header === 'string' && /^(?:W\/)?"?(0|[1-9][0-9]{0,8})"?$/.exec(header.trim());
  if (!match) invalid('If-Match must be a revision number.');
  return Number(match[1]);
}

export function createUserDataService({ access, repository, clock = () => new Date(), writesPerMinute = WRITES_PER_MINUTE }) {
  const limiter = createRateLimiter({ limit: writesPerMinute, windowMs: 60_000, clock: () => clock().getTime() });
  const throttle = adultId => {
    try { limiter.check(`user-data:${adultId}`); } catch {
      fail('USER_DATA_RATE_LIMITED', 'Too many changes. Wait a moment and try again.', 429);
    }
  };
  const own = async (principal, householdId) => { await access.requireHousehold(principal, householdId); };
  const shared = async (principal, householdId) => {
    const { role } = await access.requireHousehold(principal, householdId);
    if (!WRITE_ROLES.includes(role.role)) fail('HOUSEHOLD_WRITE_FORBIDDEN', 'Your role in this household can read but not change it.', 403);
  };
  const memberIdOf = value => {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,100}$/.test(value)) invalid('memberId is not valid.');
    return value;
  };

  return {
    async listPermissions(principal, householdId) {
      await own(principal, householdId);
      return { householdId, permissions: await repository.listPermissions({ householdId, adultId: principal.adultId }) };
    },

    async setPermission(principal, householdId, permission, body, ifMatchHeader) {
      await own(principal, householdId);
      const name = parsePermissionName(permission);
      const parsed = parsePermissionBody(body);
      const ifMatch = parseIfMatch(ifMatchHeader);
      throttle(principal.adultId);
      return repository.setPermission({ householdId, adultId: principal.adultId, permission: name, ...parsed, ifMatch });
    },

    async listPlaces(principal, householdId) {
      await own(principal, householdId);
      await repository.purgeExpiredLocations();
      return { householdId, places: await repository.listPlaces({ householdId, adultId: principal.adultId }) };
    },

    async setPlace(principal, householdId, kind, query, body, ifMatchHeader) {
      parsePlaceKind(kind);
      if (kind === 'current_location') await own(principal, householdId); else await shared(principal, householdId);
      const memberId = memberIdOf(query.memberId);
      if (kind === 'current_location' && memberId) invalid('A current location belongs to you, not to a member.');
      const place = parsePlaceBody(kind, body);
      const ifMatch = parseIfMatch(ifMatchHeader);
      throttle(principal.adultId);
      await repository.purgeExpiredLocations();
      return repository.setPlace({ householdId, adultId: principal.adultId, memberId, place, ifMatch });
    },

    async deletePlace(principal, householdId, kind, query, ifMatchHeader) {
      parsePlaceKind(kind);
      if (kind === 'current_location') await own(principal, householdId); else await shared(principal, householdId);
      const memberId = memberIdOf(query.memberId);
      if (kind === 'current_location' && memberId) invalid('A current location belongs to you, not to a member.');
      let slot = null;
      if (kind === 'saved_place') {
        slot = query.slot;
        if (!PLACE_SLOTS.includes(slot)) invalid('slot is required for a saved place.');
      } else if (query.slot !== undefined) invalid('slot only applies to a saved place.');
      const ifMatch = parseIfMatch(ifMatchHeader);
      throttle(principal.adultId);
      await repository.deletePlace({ householdId, adultId: principal.adultId, memberId, kind, slot, ifMatch });
      return { status: 'removed', kind };
    },

    async getPreferences(principal, householdId) {
      await own(principal, householdId);
      return { householdId, ...await repository.getPreferences({ householdId, adultId: principal.adultId }) };
    },

    async setPreferences(principal, householdId, body, ifMatchHeader) {
      await own(principal, householdId);
      const { prefs } = parsePreferencesBody(body);
      const ifMatch = parseIfMatch(ifMatchHeader);
      throttle(principal.adultId);
      return { householdId, ...await repository.setPreferences({ householdId, adultId: principal.adultId, prefs, ifMatch }) };
    },

    async getOnboarding(principal, householdId) {
      await own(principal, householdId);
      return { householdId, ...await repository.getOnboarding({ householdId, adultId: principal.adultId }) };
    },

    async setOnboarding(principal, householdId, body, ifMatchHeader) {
      await own(principal, householdId);
      const { state, completed } = parseOnboardingBody(body);
      const ifMatch = parseIfMatch(ifMatchHeader);
      throttle(principal.adultId);
      return { householdId, ...await repository.setOnboarding({ householdId, adultId: principal.adultId, state, completed, ifMatch }) };
    },

    async listScenarios(principal, householdId) {
      await own(principal, householdId);
      return { householdId, scenarios: await repository.listScenarios({ householdId, adultId: principal.adultId }) };
    },

    async getScenario(principal, householdId, tool) {
      await own(principal, householdId);
      return { householdId, ...await repository.getScenario({ householdId, adultId: principal.adultId, tool: parseScenarioTool(tool) }) };
    },

    async setScenario(principal, householdId, tool, body, ifMatchHeader) {
      await own(principal, householdId);
      const { inputs } = parseScenarioBody(tool, body);
      const ifMatch = parseIfMatch(ifMatchHeader);
      throttle(principal.adultId);
      return { householdId, ...await repository.setScenario({ householdId, adultId: principal.adultId, tool, inputs, ifMatch }) };
    },

    // Caller has proved the bootstrap credential. Same e-mail, same household, a fresh session each time.
    async access(body) {
      const parsed = parseAccessBody(body);
      const result = await repository.access(parsed);
      return {
        returning: result.returning,
        household: { id: result.household.id, displayName: result.household.display_name, status: result.household.status },
        owner: { id: result.adultId },
        ownerMember: { id: result.ownerMemberId },
        session: result.session,
      };
    },
  };
}
