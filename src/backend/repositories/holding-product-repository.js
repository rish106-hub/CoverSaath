// Thin reads the holding product confirmation needs on policy_holdings (migration 048) and policy_profiles (043). Writes go through
// PolicyHoldingRepository (link, setStatus: transition rules and audit) and PolicyProfileRepository.confirm (state 'reported').
// The holding stores no insurer, plan or UIN. Reads by id only prove nothing: the route proves ownership through the document.
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const invalid = () => Object.assign(new Error('Holding request was invalid.'), { code: 'HOLDING_INVALID', statusCode: 400 });
const id = value => { if (typeof value !== 'string' || !ID.test(value)) throw invalid(); return value; };

const present = row => row && Object.freeze({
  id: row.id, householdId: row.household_id, documentId: row.document_id, policyProfileId: row.policy_profile_id, status: row.status,
});

export class HoldingProductRepository {
  constructor(database) {
    if (!database || typeof database.one !== 'function') throw new TypeError('A database is required.');
    this.database = database;
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

  /** Like profileUin, but only a UIN the owner confirmed (uin_state 'reported'). Null otherwise. */
  async confirmedProfileUin({ householdId, policyProfileId }) {
    const row = await this.database.one("SELECT uin FROM policy_profiles WHERE id = ? AND household_id = ? AND uin_state = 'reported'", [id(policyProfileId), id(householdId)]);
    return row?.uin ?? null;
  }
}
