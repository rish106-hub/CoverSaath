import { randomUUID } from 'node:crypto';

// Paid policy slots (migration 067). Rows are Razorpay orders of one household; only a server-verified checkout marks one paid.
export class PolicySlotRepository {
  constructor(database, { clock = () => new Date() } = {}) {
    this.database = database;
    this.clock = clock;
  }

  async counts(householdId) {
    const paid = await this.database.one("SELECT count(*) AS n FROM policy_slot_payments WHERE household_id = ? AND status = 'paid'", [householdId]);
    const used = await this.database.one(
      "SELECT count(*) AS n FROM document_uploads WHERE household_id = ? AND document_kind = 'policy_schedule' AND lifecycle_state = 'active'", [householdId]);
    return { paid: Number(paid?.n ?? 0), used: Number(used?.n ?? 0) };
  }

  /** True when this household already holds an active schedule with these bytes (a repeat upload is not a new policy). */
  async hasSchedule(householdId, contentSha256) {
    const row = await this.database.one(
      "SELECT 1 AS ok FROM document_uploads WHERE household_id = ? AND document_kind = 'policy_schedule' AND lifecycle_state = 'active' AND content_sha256 = ? LIMIT 1",
      [householdId, contentSha256]);
    return Boolean(row);
  }

  async createOrder({ householdId, adultId, orderId, amountPaise, currency }) {
    const id = `slotpay_${randomUUID()}`;
    await this.database.run(
      "INSERT INTO policy_slot_payments (id, household_id, adult_id, provider, order_id, amount_paise, currency, status, created_at) VALUES (?, ?, ?, 'razorpay', ?, ?, ?, 'created', ?)",
      [id, householdId, adultId, orderId, amountPaise, currency, this.clock().toISOString()]);
    return id;
  }

  async findOrder(householdId, orderId) {
    const row = await this.database.one('SELECT id, status, payment_id, amount_paise FROM policy_slot_payments WHERE household_id = ? AND order_id = ?', [householdId, orderId]);
    return row ? { id: row.id, status: row.status, paymentId: row.payment_id, amountPaise: Number(row.amount_paise) } : null;
  }

  /** created -> paid, once. Returns false when another request marked it first. */
  async markPaid({ id, paymentId }) {
    const result = await this.database.run(
      "UPDATE policy_slot_payments SET status = 'paid', payment_id = ?, paid_at = ? WHERE id = ? AND status = 'created'",
      [paymentId, this.clock().toISOString(), id]);
    return Number(result?.changes ?? result?.rowCount ?? 0) === 1;
  }
}
