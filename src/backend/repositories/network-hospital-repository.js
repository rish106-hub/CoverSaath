// Network hospitals (migration 055): PUBLIC reference rows, no household column. Writes come from the sync job only; reads are bounded
// and parameterised. Cashless-first ordering so the useful rows are on top.
const PINCODE = /^[0-9]{6}$/;
const MAX_LIST = 50;
const invalid = () => Object.assign(new Error('Hospital request was invalid.'), { code: 'HOSPITAL_REQUEST_INVALID', statusCode: 400 });

export class NetworkHospitalRepository {
  constructor(database) {
    if (!database || typeof database.run !== 'function') throw new TypeError('A database is required.');
    this.database = database;
  }

  /** Upserts one page by id. Idempotent. Returns the number of rows written. */
  async upsertMany(rows) {
    if (!Array.isArray(rows) || rows.length > 500) throw invalid();
    return this.database.transaction(async () => {
      for (const r of rows) {
        await this.database.run(
          `INSERT INTO network_hospitals (id, insurer_id, tpa_id, name, address, city, pincode, lat, lng, cashless, source_ref, valid_from, valid_to, synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS date), CAST(? AS date), now())
           ON CONFLICT (id) DO UPDATE SET insurer_id = EXCLUDED.insurer_id, tpa_id = EXCLUDED.tpa_id, name = EXCLUDED.name, address = EXCLUDED.address,
             city = EXCLUDED.city, pincode = EXCLUDED.pincode, lat = EXCLUDED.lat, lng = EXCLUDED.lng, cashless = EXCLUDED.cashless,
             source_ref = EXCLUDED.source_ref, valid_from = EXCLUDED.valid_from, valid_to = EXCLUDED.valid_to, synced_at = now()`,
          [r.id, r.insurerId ?? null, r.tpaId ?? null, r.name, r.address ?? '', r.city, r.pincode, r.lat ?? null, r.lng ?? null, r.cashless === true,
            r.sourceRef, r.validFrom ?? null, r.validTo ?? null]);
      }
      return rows.length;
    });
  }

  /** Hospitals in one pincode that are listed today (valid window), cashless first. `insurerId` (optional) keeps insurer-specific and all-insurer rows. */
  async byPincode({ pincode, insurerId = null }) {
    if (typeof pincode !== 'string' || !PINCODE.test(pincode)) throw invalid();
    if (insurerId !== null && (typeof insurerId !== 'string' || insurerId.length < 1 || insurerId.length > 100)) throw invalid();
    const rows = await this.database.many(
      `SELECT id, name, address, city, pincode, cashless FROM network_hospitals
       WHERE pincode = ? AND (?::text IS NULL OR insurer_id IS NULL OR insurer_id = ?)
         AND (valid_from IS NULL OR valid_from <= current_date) AND (valid_to IS NULL OR valid_to >= current_date)
       ORDER BY cashless DESC, name, id LIMIT ?`, [pincode, insurerId, insurerId, MAX_LIST]);
    return rows.map(row => ({ id: row.id, name: row.name, address: row.address, city: row.city, pincode: row.pincode, cashless: row.cashless === true }));
  }
}
