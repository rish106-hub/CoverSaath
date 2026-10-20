// B3-3 deterministic rules over applicable facts. A rule never calculates from a value that is not verified and
// applicable, never turns unknown into zero or false, and never predicts approval or payout.
import { deepFreeze, isIsoDate, isMinor, isRecord, text } from './contracts.js';
import { resolveApplicable } from './applicability.js';

const money = v => isRecord(v) && isMinor(v.amountMinor) && v.currency === 'INR' && Object.keys(v).every(k => ['amountMinor', 'currency', 'basis', 'type'].includes(k));
const bps = v => Number.isInteger(v) && v >= 0 && v <= 10000;
const limitShape = v => isRecord(v) && (
  (v.kind === 'amount' && money(v)) || (v.kind === 'percent_of_sum_insured' && bps(v.basisPoints)) ||
  v.kind === 'actuals' || (v.kind === 'category' && !!text(v.label, 80)));

export const RULES = deepFreeze([
  { id: 'sum_insured', group: 'D', factType: 'sum_insured', valid: v => money(v) },
  { id: 'room_rent_limit', group: 'D', factType: 'room_rent_limit', valid: limitShape },
  { id: 'icu_limit', group: 'D', factType: 'icu_limit', valid: limitShape },
  { id: 'copay', group: 'D', factType: 'copay', valid: v => isRecord(v) && bps(v.basisPoints) },
  { id: 'deductible', group: 'D', factType: 'deductible', valid: v => isRecord(v) && money(v) && ['per_claim', 'annual_aggregate'].includes(v.type) },
  { id: 'sublimit', group: 'E', factType: 'sublimit', valid: limitShape },
  { id: 'waiting_period', group: 'F', factType: 'waiting_period', valid: v => isRecord(v) && Number.isInteger(v.months) && v.months >= 0 && v.months <= 600 },
  { id: 'exclusion', group: 'F', factType: 'exclusion', valid: v => isRecord(v) && ['permanent', 'event', 'time_limited'].includes(v.kind) },
  { id: 'add_on', group: 'E', factType: 'add_on', valid: v => isRecord(v) && !!text(v.name, 120) },
  { id: 'restoration', group: 'D', factType: 'restoration', valid: v => isRecord(v) },
  { id: 'bonus', group: 'D', factType: 'bonus', valid: v => isRecord(v) },
  { id: 'policy_period', group: 'B', factType: 'policy_period', valid: v => isRecord(v) && isIsoDate(v.start) && isIsoDate(v.end) && v.start <= v.end },
]);

const BOUNDARIES = ['Contract observation only: not a payable amount, approval or claim prediction.', 'Sum insured is not spendable cash.'];

export function wholeMonthsBetween(start, end) {
  const [sy, sm, sd] = start.split('-').map(Number);
  const [ey, em, ed] = end.split('-').map(Number);
  return (ey - sy) * 12 + (em - sm) - (ed < sd ? 1 : 0);
}

export function evaluateRule(facts, rule, query) {
  const decision = resolveApplicable(facts, { ...query, factType: rule.factType, topic: query.topic ?? '' });
  let result = decision;
  if (decision.status === 'known' && !rule.valid(decision.value)) {
    result = { ...decision, status: 'unverified', value: null, candidateValue: null, reason: 'value_malformed' };
  }
  const out = { rule: rule.id, group: rule.group, result, boundaries: BOUNDARIES };

  if (rule.id === 'waiting_period') {
    // Completion needs a verified policy start date and an as-of date. Anything less stays unknown, never "0 months".
    const start = resolveApplicable(facts, { policyId: query.policyId, memberId: query.memberId ?? null, asOf: query.asOf ?? null, factType: 'policy_period', topic: 'continuous_cover' });
    const origin = start.status === 'known' && isIsoDate(start.value?.start) ? start.value.start : null;
    if (result.status !== 'known') out.completion = { state: 'unknown', reason: 'waiting_period_not_established' };
    else if (!origin || !query.asOf) out.completion = { state: 'unknown', reason: 'verified_start_or_date_missing' };
    else out.completion = { assumes: 'policy_period/continuous_cover.start is the verified start of uninterrupted cover, including credited prior cover; whole months are counted by calendar month and a month is complete only on the same day-of-month or later (the contract counting rule is not verified)', state: wholeMonthsBetween(origin, query.asOf) >= result.value.months ? 'completed' : 'not_completed', elapsedMonths: wholeMonthsBetween(origin, query.asOf), requiredMonths: result.value.months, since: origin };
  }
  return deepFreeze(out);
}

export function evaluateRules(facts, query, ruleIds = RULES.map(rule => rule.id)) {
  if (!query || !text(query.policyId, 128)) throw new TypeError('A policyId is required.');
  return RULES.filter(rule => ruleIds.includes(rule.id)).map(rule => evaluateRule(facts, rule, query));
}
