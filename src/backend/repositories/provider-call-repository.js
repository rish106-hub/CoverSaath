import { randomUUID } from 'node:crypto';

// Provider call audit (migration 056, ADR 0030). One append-only row per model call that reached the gateway.
// Counts, a digest of the redacted payload, usage and cost only: never a prompt, a response or any text.

const WORD = /^[a-z][a-z0-9_-]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;
// The only keys a redaction report may carry; each is a number (or the gate version string). Anything else is dropped.
const REPORT_NUMBER_KEYS = ['gatedSlots', 'placeholders', 'reasonCodes', 'gatedBytes'];
const nonNegativeInt = value => (Number.isInteger(value) && value >= 0 ? Math.min(value, 2_147_483_647) : 0);

/** Counts-only redaction report from a gateway event. Never copies a string other than the gate version label. */
export function redactionReport(event = {}) {
  const report = {};
  if (typeof event.gateVersion === 'string' && /^[a-z0-9.-]{1,60}$/.test(event.gateVersion)) report.gateVersion = event.gateVersion;
  for (const key of REPORT_NUMBER_KEYS) if (Number.isInteger(event[key])) report[key] = nonNegativeInt(event[key]);
  return report;
}

export class ProviderCallRepository {
  constructor(database, { clock = () => new Date(), paisePerUsd = Number(process.env.COST_PAISE_PER_USD) > 0 ? Number(process.env.COST_PAISE_PER_USD) : 9000 } = {}) {
    this.database = database;
    this.clock = clock;
    // An accounting estimate, not a quote: set COST_PAISE_PER_USD when the rate matters.
    this.paisePerUsd = paisePerUsd;
  }

  /** Records one call from a gateway event ({ task, outcome, provider, model, inputTokens, outputTokens, costUsd, payloadSha256, householdId, ...gate counts }). */
  async record(event) {
    const purpose = typeof event?.task === 'string' && WORD.test(event.task) ? event.task : null;
    if (!purpose) throw Object.assign(new Error('A provider call needs a purpose.'), { code: 'PROVIDER_CALL_INVALID' });
    const provider = typeof event.provider === 'string' && WORD.test(event.provider) ? event.provider : 'none';
    const model = typeof event.model === 'string' && event.model.length > 0 ? event.model.slice(0, 120) : 'none';
    const status = typeof event.outcome === 'string' && WORD.test(event.outcome.toLowerCase()) ? event.outcome.toLowerCase() : 'error';
    const payloadSha256 = typeof event.payloadSha256 === 'string' && SHA256.test(event.payloadSha256) ? event.payloadSha256 : null;
    const householdId = typeof event.householdId === 'string' && event.householdId.length > 0 && event.householdId.length <= 256 ? event.householdId : null;
    const costPaise = Number.isFinite(event.costUsd) && event.costUsd > 0 ? Math.min(Math.ceil(event.costUsd * this.paisePerUsd), 2_147_483_647) : 0;
    const id = randomUUID();
    await this.database.run(
      `INSERT INTO provider_calls (id, household_id, purpose, provider, model, redaction_report_json, payload_sha256, input_tokens, output_tokens, cost_paise, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, householdId, purpose, provider, model, JSON.stringify(redactionReport(event)), payloadSha256, nonNegativeInt(event.inputTokens), nonNegativeInt(event.outputTokens), costPaise, status, this.clock().toISOString()],
    );
    return id;
  }

  /** Counts for one household, oldest first (an operator or test read; never the payload, which is not stored). */
  async listForHousehold(householdId, { limit = 100 } = {}) {
    return this.database.many('SELECT * FROM provider_calls WHERE household_id = ? ORDER BY created_at, id LIMIT ?', [householdId, Math.min(Math.max(limit, 1), 1000)]);
  }

  async eraseForHousehold(householdId) {
    const result = await this.database.run('DELETE FROM provider_calls WHERE household_id = ?', [householdId]);
    return result.changes;
  }
}
