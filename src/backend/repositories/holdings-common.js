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

export const str = (value, name, max = 200) => {
  if (typeof value !== 'string' || !value || value.length > max) invalid(`${name} is invalid.`);
  return value;
};

export const isDay = value => typeof value === 'string' && /^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/.test(value);
