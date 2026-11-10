// Policy type the user tags when a case is created (plan R2). It later chooses the fact schema.
// Keep in sync with the beta/BFF copy (src/adapters/documents-contract.ts) and migration 041.
export const POLICY_TYPES = Object.freeze(['personal_health', 'group_health', 'term_life', 'other']);
export const DEFAULT_POLICY_TYPE = 'other';

export const isPolicyType = value => typeof value === 'string' && POLICY_TYPES.includes(value);

/** Returns a valid policy type. undefined/null means the default; any other bad value throws POLICY_TYPE_INVALID (400). */
export function parsePolicyType(value) {
  if (value === undefined || value === null) return DEFAULT_POLICY_TYPE;
  if (!isPolicyType(value)) {
    throw Object.assign(new Error(`policyType must be one of: ${POLICY_TYPES.join(', ')}.`), { code: 'POLICY_TYPE_INVALID', statusCode: 400 });
  }
  return value;
}
