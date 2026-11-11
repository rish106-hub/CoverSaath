// Erasure of the holdings and memory stores (migrations 048-052, ADR 0032). Needs only the database (no encryption key), so every
// erasure path always has one. Rows are DELETED, never redacted (no key residue). Each function joins the caller's transaction,
// deletes in foreign-key order and resolves counts only. Conflicts go first: they hold ids of facts and must never outlive them.

const count = result => result.changes;

async function deleteConflictsOfFacts(db, householdId, factIds) {
  if (factIds.length === 0) return 0;
  return count(await db.run(`DELETE FROM memory_conflicts WHERE household_id = ?
    AND (candidate_fact_ids && CAST(? AS text[]) OR resolving_fact_id = ANY(CAST(? AS text[])))`, [householdId, factIds, factIds]));
}

const empty = () => ({ conflicts: 0, facts: 0, declarations: 0, payments: 0, dues: 0, holdings: 0 });

/** Everything of one household (household erasure). */
export async function eraseMemoryForHousehold(db, { householdId }) {
  const counts = empty();
  counts.dues = count(await db.run('DELETE FROM premium_dues WHERE household_id = ?', [householdId]));
  counts.payments = count(await db.run('DELETE FROM premium_payments WHERE household_id = ?', [householdId]));
  counts.conflicts = count(await db.run('DELETE FROM memory_conflicts WHERE household_id = ?', [householdId]));
  counts.facts = count(await db.run('DELETE FROM household_memory_facts WHERE household_id = ?', [householdId]));
  counts.declarations = count(await db.run('DELETE FROM member_declarations WHERE household_id = ?', [householdId]));
  counts.holdings = count(await db.run('DELETE FROM policy_holdings WHERE household_id = ?', [householdId]));
  return counts;
}

/**
 * What was read from, or linked to, withdrawn or erased documents: their holdings (with the payments, dues, conflicts and facts that
 * hang on them), and every fact that cites the document. `householdId` null only for a system path that knows the documents.
 */
export async function eraseMemoryForDocuments(db, { householdId = null, documentIds }) {
  const counts = empty();
  if (documentIds.length === 0) return counts;
  const scope = householdId ? ' AND household_id = ?' : '';
  const extra = householdId ? [householdId] : [];
  const facts = (await db.many(`SELECT id, household_id FROM household_memory_facts WHERE source_document_id = ANY(CAST(? AS text[]))${scope}`, [documentIds, ...extra]));
  const holdings = (await db.many(`SELECT id, household_id FROM policy_holdings WHERE document_id = ANY(CAST(? AS text[]))${scope}`, [documentIds, ...extra]));
  const heldFacts = holdings.length === 0 ? [] : await db.many('SELECT id, household_id FROM household_memory_facts WHERE holding_id = ANY(CAST(? AS text[]))', [holdings.map(row => row.id)]);
  const byHousehold = new Map();
  for (const row of [...facts, ...heldFacts]) {
    if (!byHousehold.has(row.household_id)) byHousehold.set(row.household_id, new Set());
    byHousehold.get(row.household_id).add(row.id);
  }
  for (const [owner, ids] of byHousehold) counts.conflicts += await deleteConflictsOfFacts(db, owner, [...ids]);
  if (holdings.length > 0) {
    const holdingIds = holdings.map(row => row.id);
    counts.conflicts += count(await db.run('DELETE FROM memory_conflicts WHERE holding_id = ANY(CAST(? AS text[]))', [holdingIds]));
    counts.dues = count(await db.run('DELETE FROM premium_dues WHERE holding_id = ANY(CAST(? AS text[]))', [holdingIds]));
    counts.payments = count(await db.run('DELETE FROM premium_payments WHERE holding_id = ANY(CAST(? AS text[]))', [holdingIds]));
  }
  counts.facts = count(await db.run(`DELETE FROM household_memory_facts WHERE source_document_id = ANY(CAST(? AS text[]))${scope}`, [documentIds, ...extra]));
  if (holdings.length > 0) {
    counts.facts += count(await db.run('DELETE FROM household_memory_facts WHERE holding_id = ANY(CAST(? AS text[]))', [holdings.map(row => row.id)]));
    counts.holdings = count(await db.run(`DELETE FROM policy_holdings WHERE document_id = ANY(CAST(? AS text[]))${scope}`, [documentIds, ...extra]));
  }
  return counts;
}

/** Everything written under one consent grant (revocation). */
export async function eraseMemoryForConsentGrant(db, { householdId, consentGrantId }) {
  const counts = empty();
  const facts = (await db.many('SELECT id FROM household_memory_facts WHERE household_id = ? AND consent_grant_id = ?', [householdId, consentGrantId])).map(row => row.id);
  counts.conflicts = await deleteConflictsOfFacts(db, householdId, facts);
  counts.dues = count(await db.run('DELETE FROM premium_dues WHERE household_id = ? AND consent_grant_id = ?', [householdId, consentGrantId]));
  counts.payments = count(await db.run('DELETE FROM premium_payments WHERE household_id = ? AND consent_grant_id = ?', [householdId, consentGrantId]));
  counts.facts = count(await db.run('DELETE FROM household_memory_facts WHERE household_id = ? AND consent_grant_id = ?', [householdId, consentGrantId]));
  counts.declarations = count(await db.run('DELETE FROM member_declarations WHERE household_id = ? AND consent_grant_id = ?', [householdId, consentGrantId]));
  return counts;
}

/** What is about one member (member removal). Facts and declarations cascade from the member row; conflicts are removed first. */
export async function eraseMemoryForMember(db, { householdId, memberId }) {
  const counts = empty();
  const facts = (await db.many('SELECT id FROM household_memory_facts WHERE household_id = ? AND subject_member_id = ?', [householdId, memberId])).map(row => row.id);
  counts.conflicts = await deleteConflictsOfFacts(db, householdId, facts);
  counts.facts = count(await db.run('DELETE FROM household_memory_facts WHERE household_id = ? AND subject_member_id = ?', [householdId, memberId]));
  counts.declarations = count(await db.run('DELETE FROM member_declarations WHERE household_id = ? AND member_id = ?', [householdId, memberId]));
  await db.run('UPDATE premium_payments SET payer_member_id = NULL WHERE household_id = ? AND payer_member_id = ?', [householdId, memberId]);
  return counts;
}
