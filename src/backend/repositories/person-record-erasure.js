import { RECORD_TYPES } from '../../contracts/capture-registry.js';

// Erasure of person records by consent category (ADR 0018). Used inside the consent revocation transaction and by the repository.
// It needs only the database (no encryption key), so a revocation always has an erasure path. Counts-only audit.
const CATEGORY_TYPES = Object.freeze(Object.entries(RECORD_TYPES).reduce((map, [type, meta]) => {
  if (meta.consentCategory) (map[meta.consentCategory] ??= []).push(type);
  return map;
}, {}));

export const PERSON_RECORD_CATEGORIES = Object.freeze(Object.keys(CATEGORY_TYPES));

/**
 * Deletes every person record of one household whose type needs one of `categories`. Revoking the consent that gated them erases
 * them all, whichever adult entered them. Joins the caller's transaction. Resolves the number of rows removed.
 */
export async function erasePersonRecordsForCategories(database, { householdId, categories, reasonCode = 'consent_revoked', actorType = 'system', actorId = 'person-record-repository', audit = null }) {
  const types = [...new Set(categories.flatMap(category => CATEGORY_TYPES[category] ?? []))];
  if (types.length === 0) return 0;
  const removed = await database.run('DELETE FROM person_records WHERE household_id = ? AND record_type = ANY(CAST(? AS text[]))', [householdId, types]);
  if (removed.changes > 0) {
    await audit?.append({ householdId, actorType, actorId, action: 'person_records.erased', resourceType: 'household', resourceId: householdId, payload: { reasonCode, categories, recordTypes: types, count: removed.changes } });
  }
  return removed.changes;
}
