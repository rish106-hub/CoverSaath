import { randomUUID } from 'node:crypto';
import { householdLock } from '../database/postgres/locks.js';
import { resolveColumnCrypto } from '../security/column-crypto.js';
import { amountBand } from '../../features/policy-facts/normalisers.js';
import { LIST_LIMIT, fail, invalid, isDay, requireGrant, requirePerson, str } from './holdings-common.js';

// Premium payments and dues (migration 052, ADR 0032). Exact amounts (paise), the agent name and the agent code are sealed (AAD
// <table>.<column>.<row id>); only a coarse amount band, calendar days and closed enums are plain. Every read and write is scoped to
// a household the acting adult can see and to a holding of that household. Writes need a current profile_intake grant of the adult,
// run under the household lock and append a counts-only audit event (no amount, no agent).

export const PAYMENT_CHANNELS = Object.freeze(['upi', 'card', 'netbanking', 'cheque', 'cash', 'salary_deduction', 'unknown']);
export const PAID_VIA = Object.freeze(['self', 'agent', 'employer', 'bank']);
export const DUE_STATES = Object.freeze(['expected', 'paid', 'overdue']);
const MAX_PAISE = 100_000_000_000;
const notFound = () => fail('PREMIUM_NOT_FOUND', 'Not found.', 404);

const paise = value => {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_PAISE) invalid('amountPaise is invalid.');
  return value;
};

export class PremiumRepository {
  constructor(database, { clock = () => new Date(), audit = null, households, ...options } = {}) {
    if (!database || !households) throw new TypeError('A database and households are required.');
    this.database = database;
    this.clock = clock;
    this.audit = audit;
    this.households = households;
    this.crypto = resolveColumnCrypto(options);
  }

  #payment(row) {
    return {
      id: row.id, holdingId: row.holding_id, amountPaise: this.crypto.openJson('premium_payments', 'amount_enc', row.id, row.amount_enc), amountBand: row.amount_band,
      currency: row.currency, paidOn: row.paid_on, channel: row.channel, paidVia: row.paid_via, payerMemberId: row.payer_member_id,
      agentName: row.agent_name_enc === null ? null : this.crypto.openJson('premium_payments', 'agent_name_enc', row.id, row.agent_name_enc),
      agentCode: row.agent_code_enc === null ? null : this.crypto.openJson('premium_payments', 'agent_code_enc', row.id, row.agent_code_enc),
      receiptDocumentId: row.receipt_document_id, createdAt: row.created_at,
    };
  }

  #due(row) {
    return {
      id: row.id, holdingId: row.holding_id, dueOn: row.due_on, amountPaise: this.crypto.openJson('premium_dues', 'amount_enc', row.id, row.amount_enc),
      amountBand: row.amount_band, currency: row.currency, state: row.state, paidPaymentId: row.paid_payment_id, createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  async #holding(db, householdId, holdingId) {
    if (!(await db.one('SELECT id FROM policy_holdings WHERE id = ? AND household_id = ?', [str(holdingId, 'holdingId'), householdId]))) fail('HOLDING_NOT_FOUND', 'Holding not found.', 404);
  }

  async recordPayment({ householdId, adultId, holdingId, amountPaise, paidOn, channel = 'unknown', paidVia = 'self', payerMemberId = null, agentName = null, agentCode = null, receiptDocumentId = null, consentGrantId }) {
    paise(amountPaise);
    if (!isDay(paidOn)) invalid('paidOn is invalid.');
    if (!PAYMENT_CHANNELS.includes(channel)) invalid('channel is invalid.');
    if (!PAID_VIA.includes(paidVia)) invalid('paidVia is invalid.');
    if ((agentName !== null || agentCode !== null) && paidVia !== 'agent') invalid('An agent is only recorded when paidVia is agent.');
    for (const [name, value] of [['agentName', agentName], ['agentCode', agentCode]]) if (value !== null) str(value, name, 120);
    const db = this.database;
    const at = this.clock().toISOString();
    return db.transaction(async () => {
      await requirePerson(this.households, householdId, adultId, { write: true });
      await this.#holding(db, householdId, holdingId);
      await requireGrant(db, { householdId, grantId: consentGrantId, purpose: 'profile_intake', subjectAdultId: adultId, now: at });
      const rowId = `ppay-${randomUUID()}`;
      const sealed = column => (column.value === null ? null : this.crypto.sealJson('premium_payments', column.name, rowId, column.value));
      try {
        await db.run(`INSERT INTO premium_payments (id, household_id, holding_id, amount_enc, amount_band, currency, paid_on, channel, paid_via, payer_member_id,
            agent_name_enc, agent_code_enc, receipt_document_id, consent_grant_id, created_at) VALUES (?, ?, ?, ?, ?, 'INR', ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
          rowId, householdId, holdingId, sealed({ name: 'amount_enc', value: amountPaise }), amountBand(amountPaise), paidOn, channel, paidVia, payerMemberId,
          sealed({ name: 'agent_name_enc', value: agentName }), sealed({ name: 'agent_code_enc', value: agentCode }), receiptDocumentId, consentGrantId, at]);
      } catch (error) {
        if (/premium payment/.test(String(error?.message))) notFound();
        throw error;
      }
      await this.audit?.append({ householdId, actorType: 'adult_user', actorId: adultId, action: 'premium.payment_recorded', resourceType: 'premium_payment', resourceId: rowId, payload: { channel, paidVia, band: amountBand(amountPaise) } });
      return this.#payment(await db.one('SELECT * FROM premium_payments WHERE id = ?', [rowId]));
    }, { locks: [householdLock(householdId)] });
  }

  async listPayments({ householdId, adultId, holdingId = null }) {
    await requirePerson(this.households, householdId, adultId);
    const rows = await this.database.many(`SELECT * FROM premium_payments WHERE household_id = ? AND (?::text IS NULL OR holding_id = ?) ORDER BY paid_on DESC, id LIMIT ?`, [householdId, holdingId, holdingId, LIST_LIMIT]);
    return rows.map(row => this.#payment(row));
  }

  async deletePayment({ householdId, adultId, paymentId }) {
    const db = this.database;
    return db.transaction(async () => {
      await requirePerson(this.households, householdId, adultId, { write: true });
      const removed = await db.run('DELETE FROM premium_payments WHERE id = ? AND household_id = ?', [str(paymentId, 'paymentId'), householdId]);
      if (removed.changes === 0) notFound();
      await this.audit?.append({ householdId, actorType: 'adult_user', actorId: adultId, action: 'premium.payment_deleted', resourceType: 'premium_payment', resourceId: paymentId, payload: {} });
    }, { locks: [householdLock(householdId)] });
  }

  /** Records a premium expected on a date. One due per (holding, day): a repeat returns the existing one. */
  async addDue({ householdId, adultId, holdingId, dueOn, amountPaise, consentGrantId }) {
    paise(amountPaise);
    if (!isDay(dueOn)) invalid('dueOn is invalid.');
    const db = this.database;
    const at = this.clock().toISOString();
    return db.transaction(async () => {
      await requirePerson(this.households, householdId, adultId, { write: true });
      await this.#holding(db, householdId, holdingId);
      await requireGrant(db, { householdId, grantId: consentGrantId, purpose: 'profile_intake', subjectAdultId: adultId, now: at });
      const existing = await db.one('SELECT * FROM premium_dues WHERE holding_id = ? AND due_on = ?', [holdingId, dueOn]);
      if (existing) return this.#due(existing);
      const rowId = `pdue-${randomUUID()}`;
      await db.run(`INSERT INTO premium_dues (id, household_id, holding_id, due_on, amount_enc, amount_band, currency, state, consent_grant_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'INR', 'expected', ?, ?, ?)`, [rowId, householdId, holdingId, dueOn, this.crypto.sealJson('premium_dues', 'amount_enc', rowId, amountPaise), amountBand(amountPaise), consentGrantId, at, at]);
      await this.audit?.append({ householdId, actorType: 'adult_user', actorId: adultId, action: 'premium.due_added', resourceType: 'premium_due', resourceId: rowId, payload: { band: amountBand(amountPaise) } });
      return this.#due(await db.one('SELECT * FROM premium_dues WHERE id = ?', [rowId]));
    }, { locks: [householdLock(householdId)] });
  }

  /** Settles a due with a payment of the same household and holding. */
  async markDuePaid({ householdId, adultId, dueId, paymentId }) {
    const db = this.database;
    return db.transaction(async () => {
      await requirePerson(this.households, householdId, adultId, { write: true });
      const due = await db.one('SELECT * FROM premium_dues WHERE id = ? AND household_id = ? FOR UPDATE', [str(dueId, 'dueId'), householdId]);
      if (!due) notFound();
      try {
        await db.run(`UPDATE premium_dues SET state = 'paid', paid_payment_id = ?, updated_at = ? WHERE id = ?`, [str(paymentId, 'paymentId'), this.clock().toISOString(), dueId]);
      } catch (error) {
        if (/premium due/.test(String(error?.message))) notFound();
        throw error;
      }
      return this.#due(await db.one('SELECT * FROM premium_dues WHERE id = ?', [dueId]));
    }, { locks: [householdLock(householdId)] });
  }

  async listDues({ householdId, adultId, holdingId = null, state = null }) {
    await requirePerson(this.households, householdId, adultId);
    if (state !== null && !DUE_STATES.includes(state)) invalid('state is invalid.');
    const rows = await this.database.many(`SELECT * FROM premium_dues WHERE household_id = ? AND (?::text IS NULL OR holding_id = ?) AND (?::text IS NULL OR state = ?)
      ORDER BY due_on, id LIMIT ?`, [householdId, holdingId, holdingId, state, state, LIST_LIMIT]);
    return rows.map(row => this.#due(row));
  }
}
