import { createInsuranceDataClient, referenceDataEnabled } from '../../integrations/index.js';
import { holdingsEnabled } from './holdings-flag.js';
import { signatureFor } from './reference-data-port.js';

const REGISTRY_CACHE_KEY = 'registry/snapshot-v1';
const normalUin = value => (typeof value === 'string' ? value.toUpperCase().replace(/[\s/._-]/g, '') : '');

// Network hospitals (S-C2). Off unless HOLDINGS_ENABLED is exactly "true".
//   importHospitals()  job (reference.import, scope 'hospitals'): pages the reference service export into network_hospitals through the
//                      existing insurance-data client. Idempotent upserts; at most MAX_PAGES pages per run. Needs REFERENCE_DATA_ENABLED=true.
//   list()             owner read: hospitals in a pincode for one holding. Ownership is checked through the holding's household (404 otherwise).
//                      The insurer is resolved server side (never from the request): the holding's confirmed policy profile UIN -> the cached
//                      registry product -> its insurerId. Rows of that insurer and all-insurer rows (insurer_id NULL) are returned. With no
//                      confirmed insurer the list is empty with reason 'insurer_unknown', never every insurer's rows (audit F3).
// The UIN is never read here. SCALE: PostGIS and radius search later (migration 055 note).
const MAX_PAGES = 100;
const PINCODE = /^[0-9]{6}$/;
const coded = (code, message, statusCode, extra = {}) => Object.assign(new Error(message), { code, statusCode, ...extra });
const notFound = () => coded('HOLDING_NOT_FOUND', 'Holding was not found.', 404);

export function createNetworkHospitalService({ repository, holdingRepository, policyHoldings, referenceCache, env = process.env, client = null }) {
  for (const [name, dep] of Object.entries({ repository, holdingRepository, policyHoldings, referenceCache })) if (!dep) throw new TypeError(`createNetworkHospitalService needs ${name}.`);
  let built = client;
  const reference = () => { built ??= createInsuranceDataClient({ env }); return built; };
  const requireEnabled = () => { if (!holdingsEnabled(env)) throw coded('HOLDINGS_DISABLED', 'Holdings are disabled.', 503); };

  // Confirmed UIN of the holding's profile -> registry product -> insurer id. Null when any link is missing.
  async function insurerOf(holding) {
    if (!holding.policyProfileId) return null;
    const uin = await holdingRepository.confirmedProfileUin({ householdId: holding.householdId, policyProfileId: holding.policyProfileId });
    if (!uin) return null;
    const row = await referenceCache.get(REGISTRY_CACHE_KEY);
    if (!row || row.signature !== signatureFor(row.body) || !Array.isArray(row.body?.products)) return null;
    const ids = new Set(row.body.products.filter(item => normalUin(item.uinRaw) === uin).map(item => item.insurerId).filter(value => typeof value === 'string' && value.length > 0));
    return ids.size === 1 ? [...ids][0] : null;
  }

  return Object.freeze({
    enabled: () => holdingsEnabled(env),

    async importHospitals() {
      requireEnabled();
      if (!referenceDataEnabled(env)) throw coded('REFERENCE_DATA_DISABLED', 'Reference data is disabled.', 503, { retryable: false });
      let cursor;
      let written = 0;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const { data } = await reference().read('hospitals.export', cursor === undefined ? {} : { cursor });
        written += await repository.upsertMany(data.hospitals);
        cursor = data.nextCursor ?? undefined;
        if (cursor === undefined) break;
      }
      return { written };
    },

    /** Owner read. A missing holding and another household's holding answer the same 404; a bad pincode is a coded 400. */
    async list({ holdingId, adultId, pincode }) {
      requireEnabled();
      if (typeof pincode !== 'string' || !PINCODE.test(pincode)) throw coded('HOSPITAL_PINCODE_INVALID', 'pincode must be 6 digits.', 400);
      let holding;
      try {
        holding = await holdingRepository.get(holdingId);
        if (!holding) throw notFound();
        await policyHoldings.get({ householdId: holding.householdId, adultId, holdingId: holding.id });
      } catch (error) {
        if (['HOLDING_NOT_FOUND', 'HOLDING_INVALID', 'HOUSEHOLD_NOT_FOUND', 'HOUSEHOLD_WRITE_FORBIDDEN', 'HOUSEHOLD_ACCESS_DENIED'].includes(error?.code) || error?.statusCode === 404 || error?.statusCode === 403) throw notFound();
        throw error;
      }
      const insurerId = await insurerOf(holding);
      if (insurerId === null) return { hospitals: [], reason: 'insurer_unknown' };
      const { hospitals, truncated } = await repository.byPincodePage({ pincode, insurerId });
      return truncated ? { hospitals, truncated: true } : { hospitals };
    },
  });
}
