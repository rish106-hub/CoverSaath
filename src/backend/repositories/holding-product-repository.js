// Thin reads and writes the holding product confirmation needs on policy_holdings (migration 048) and policy_profiles (043).
// Every statement is scoped by household_id. The holding stores no insurer, plan or UIN; the confirmation itself is written to
// policy_profiles by PolicyProfileRepository.confirm (state 'reported'), and this class only links the two and moves the status.
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const invalid = () => Object.assign(new Error('Holding request was invalid.'), { code: 'HOLDING_INVALID', statusCode: 400 });
const id = value => { if (typeof value !== 'string' || !ID.test(value)) throw invalid(); return value; };

const present = row => row && Object.freeze({
  id: row.id, householdId: row.household_id, documentId: row.document_id, policyProfileId: row.policy_profile_id, status: row.status,
});

export class HoldingProductRepository {
  constructor(database, { clock = () => new Date() } = {}) {
    if (!database || typeof database.one !== 'function') throw new TypeError('A database is required.');
    this.database = database;
    this.clock = clock;
  }

  /** The holding by id, or null. Ownership is proven by the caller through the holding's document. */
  async get(holdingId) {
    return present(await this.database.one('SELECT id, household_id, document_id, policy_profile_id, status FROM policy_holdings WHERE id = ?', [id(holdingId)]));
  }

  /** The UIN stored for a profile of the household (server side only). Null when the profile is missing or holds no UIN. */
  async profileUin({ householdId, policyProfileId }) {
    const row = await this.database.one('SELECT uin FROM policy_profiles WHERE id = ? AND household_id = ?', [id(policyProfileId), id(householdId)]);
    return row?.uin ?? null;
  }

  /** Links the confirmed profile and moves uploaded or insurer_pending to product_reported. Later statuses are left alone. */
  async linkReportedProduct({ householdId, holdingId, policyProfileId }) {
    const at = this.clock().toISOString();
    const { changes } = await this.database.run(
      `UPDATE policy_holdings SET policy_profile_id = ?, updated_at = ?,
         status = CASE WHEN status IN ('uploaded', 'insurer_pending') THEN 'product_reported' ELSE status END
       WHERE id = ? AND household_id = ?`, [id(policyProfileId), at, id(holdingId), id(householdId)]);
    return changes === 1;
  }

  /** uploaded -> insurer_pending once candidates exist. No other status moves. */
  async markInsurerPending({ householdId, holdingId }) {
    const { changes } = await this.database.run(
      "UPDATE policy_holdings SET status = 'insurer_pending', updated_at = ? WHERE id = ? AND household_id = ? AND status = 'uploaded'",
      [this.clock().toISOString(), id(holdingId), id(householdId)]);
    return changes === 1;
  }
}
