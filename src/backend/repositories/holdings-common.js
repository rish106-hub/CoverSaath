// Shared helpers of the holdings and memory repositories (migrations 048-052, ADR 0032). Coded, client-safe errors only: a foreign
// household, holding, member or document answers the same 404 as a missing one.

export const WRITE_ROLES = Object.freeze(['owner', 'member']);
export const LIST_LIMIT = 200;

export const fail = (code, message, statusCode) => { throw Object.assign(new Error(message), { code, statusCode }); };
export const invalid = message => fail('INVALID_REQUEST', message, 400);

/**
 * Household access for a person. Resolves the role. A person who cannot see the household gets HOUSEHOLD_NOT_FOUND (404, from the
 * household repository); one who can read but not write gets HOUSEHOLD_WRITE_FORBIDDEN (403).
 */
export async function requirePerson(households, householdId, adultId, { write = false } = {}) {
  const { role } = await households.requireAccess(householdId, adultId, { write });
  if (write && !WRITE_ROLES.includes(role.role)) fail('HOUSEHOLD_WRITE_FORBIDDEN', 'Your role in this household can read but not change it.', 403);
  return role;
}

/** A consent grant of the household for the purpose, not revoked and not expired. Throws CONSENT_REQUIRED (403) otherwise. */
export async function requireGrant(db, { householdId, grantId, purpose, subjectAdultId = null, now }) {
  const grant = typeof grantId === 'string' && grantId ? await db.one(`SELECT id FROM consent_grants
    WHERE id = ? AND household_id = ? AND purpose = ? AND revoked_at IS NULL AND (expires_at IS NULL OR julianday(expires_at) > julianday(?))
      AND (?::text IS NULL OR subject_adult_id = ?)`, [grantId, householdId, purpose, now, subjectAdultId, subjectAdultId]) : null;
  if (!grant) fail('CONSENT_REQUIRED', 'Active consent is required before this information can be stored.', 403);
}

const SCOPE_MATCH = `EXISTS (SELECT 1 FROM consent_scopes AS scope WHERE scope.consent_grant_id = grant_record.id
  AND scope.resource_type = ? AND scope.action = ? AND scope.data_category = ? AND scope.recipient = ?)`;
const scopeArgs = scope => [scope.resourceType, scope.action, scope.dataCategory, scope.recipient];

/**
 * Provider-call consent (audit F1, invariant 2): a grant of the household for the purpose, not revoked, not expired, whose scope names
 * exactly this resource type, action, data category and RECIPIENT (a NULL recipient never matches). With `subjectAdultId` the grant must
 * be that adult's. `lock: true` takes FOR SHARE so a concurrent revoke waits for the commit. Throws CONSENT_REQUIRED (403) otherwise.
 */
export async function requireScopedGrant(db, { householdId, grantId, purpose, subjectAdultId = null, scope, now, lock = false }) {
  const grant = typeof grantId === 'string' && grantId ? await db.one(`SELECT grant_record.id FROM consent_grants AS grant_record
    WHERE grant_record.id = ? AND grant_record.household_id = ? AND grant_record.purpose = ? AND grant_record.revoked_at IS NULL
      AND (grant_record.expires_at IS NULL OR julianday(grant_record.expires_at) > julianday(?))
      AND (?::text IS NULL OR grant_record.subject_adult_id = ?) AND ${SCOPE_MATCH}${lock ? ' FOR SHARE OF grant_record' : ''}`,
  [grantId, householdId, purpose, now, subjectAdultId, subjectAdultId, ...scopeArgs(scope)]) : null;
  if (!grant) fail('CONSENT_REQUIRED', 'Active consent is required before this information can leave for the provider.', 403);
}

/** The id of the newest matching grant (same rules as requireScopedGrant), or null. Never throws for "none". */
export async function findScopedGrant(db, { householdId, purpose, subjectAdultId = null, scope, now }) {
  const row = await db.one(`SELECT grant_record.id FROM consent_grants AS grant_record
    WHERE grant_record.household_id = ? AND grant_record.purpose = ? AND grant_record.revoked_at IS NULL
      AND (grant_record.expires_at IS NULL OR julianday(grant_record.expires_at) > julianday(?))
      AND (?::text IS NULL OR grant_record.subject_adult_id = ?) AND ${SCOPE_MATCH}
    ORDER BY grant_record.granted_at DESC, grant_record.id DESC LIMIT 1`, [householdId, purpose, now, subjectAdultId, subjectAdultId, ...scopeArgs(scope)]);
  return row?.id ?? null;
}

export const str = (value, name, max = 200) => {
  if (typeof value !== 'string' || !value || value.length > max) invalid(`${name} is invalid.`);
  return value;
};

export const isDay = value => typeof value === 'string' && /^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/.test(value);
