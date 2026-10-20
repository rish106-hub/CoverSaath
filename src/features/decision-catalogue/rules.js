// B3-3 deterministic rules over applicable facts. A rule never calculates from a value that is not verified and
// applicable, never turns unknown into zero or false, and never predicts approval or payout.
import { deepFreeze, isIsoDate, isMinor, isRecord, text } from './contracts.js';
import { resolveApplicable } from './applicability.js';

const money = v => isRecord(v) && isMinor(v.amountMinor) && v.currency === 'INR' && Object.keys(v).every(k => ['amountMinor', 'currency', 'basis', 'type', 'kind'].includes(k));
const bps = v => Number.isInteger(v) && v >= 0 && v <= 10000;
// A zero or negative cap is not a limit: "nothing is payable" is an exclusion fact, not a zero limit.
const positiveMoney = v => money(v) && v.amountMinor > 0;
const limitShape = v => isRecord(v) && (
  (v.kind === 'amount' && positiveMoney(v)) || (v.kind === 'percent_of_sum_insured' && bps(v.basisPoints) && v.basisPoints > 0) ||
  v.kind === 'actuals' || (v.kind === 'category' && !!text(v.label, 80)));
const times = v => v === undefined || (Number.isInteger(v) && v >= 1 && v <= 99);

export const RULES = deepFreeze([
  { id: 'sum_insured', group: 'D', factType: 'sum_insured', valid: v => positiveMoney(v) },
  { id: 'room_rent_limit', group: 'D', factType: 'room_rent_limit', valid: limitShape },
  { id: 'icu_limit', group: 'D', factType: 'icu_limit', valid: limitShape },
  { id: 'copay', group: 'D', factType: 'copay', valid: v => isRecord(v) && bps(v.basisPoints) },
  { id: 'deductible', group: 'D', factType: 'deductible', valid: v => isRecord(v) && positiveMoney(v) && ['per_claim', 'annual_aggregate'].includes(v.type) },
  { id: 'sublimit', group: 'E', factType: 'sublimit', valid: limitShape },
  { id: 'waiting_period', group: 'F', factType: 'waiting_period', valid: v => isRecord(v) && Number.isInteger(v.months) && v.months >= 0 && v.months <= 600 },
  { id: 'exclusion', group: 'F', factType: 'exclusion', valid: v => isRecord(v) && ['permanent', 'event', 'time_limited'].includes(v.kind) },
  { id: 'add_on', group: 'E', factType: 'add_on', valid: v => isRecord(v) && !!text(v.name, 120) },
  { id: 'restoration', group: 'D', factType: 'restoration', valid: v => isRecord(v) && times(v.times) && Object.keys(v).every(k => ['kind', 'basisPoints', 'amountMinor', 'currency', 'basis', 'type', 'times'].includes(k))
    && ((v.kind === 'percent_of_sum_insured' && bps(v.basisPoints) && v.basisPoints > 0) || (v.kind === 'amount' && positiveMoney(v)) || v.kind === 'full_sum_insured') },
  { id: 'bonus', group: 'D', factType: 'bonus', valid: v => isRecord(v) && Object.keys(v).every(k => ['basisPointsPerYear', 'maxBasisPoints', 'reducesOnClaim'].includes(k))
    && bps(v.basisPointsPerYear) && v.basisPointsPerYear > 0 && (v.maxBasisPoints === undefined || (Number.isInteger(v.maxBasisPoints) && v.maxBasisPoints >= v.basisPointsPerYear && v.maxBasisPoints <= 100000))
    && (v.reducesOnClaim === undefined || typeof v.reducesOnClaim === 'boolean') },
  { id: 'policy_identity', group: 'A', factType: 'policy_identity', valid: v => isRecord(v) && !!text(v.insurer, 200) && !!text(v.productName, 200) },
  { id: 'member_enrolment', group: 'C', factType: 'member_enrolment', valid: v => isRecord(v) && ['enrolled', 'not_enrolled'].includes(v.status) },
  { id: 'network_status', group: 'G', factType: 'network_status', dynamic: true, valid: v => isRecord(v) && !!text(v.provider, 200) && ['network', 'non_network'].includes(v.status) },
  { id: 'claim_documents', group: 'H', factType: 'claim_documents', valid: v => isRecord(v) && Array.isArray(v.documents) && v.documents.length > 0 && v.documents.length <= 40 && v.documents.every(item => !!text(item, 200)) },
  { id: 'renewal_portability', group: 'I', factType: 'renewal_portability', valid: v => isRecord(v) && (v.portable === undefined || typeof v.portable === 'boolean') && (v.renewalTerms === undefined || !!text(v.renewalTerms, 400)) },
  // Evidence that cover ran without a break since `since`, including credited prior cover. The policy start date is NOT this evidence.
  { id: 'continuous_cover', group: 'B', factType: 'continuous_cover', valid: v => isRecord(v) && isIsoDate(v.since) && typeof v.uninterrupted === 'boolean' && (v.creditedPriorCover === undefined || typeof v.creditedPriorCover === 'boolean') },
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
  // Network and cashless information changes without notice, so it is never a permanent known value.
  if (rule.dynamic && result.status === 'known') result = { ...result, status: 'dynamic', candidateValue: result.value, value: null, reason: 'needs_current_confirmation' };
  const out = { rule: rule.id, group: rule.group, topic: query.topic ?? '', result, boundaries: BOUNDARIES };

  // A value that depends on conditions, exceptions or overrides is not an unconditional rule, whatever its status.
  out.conditional = ['conditions', 'exceptions', 'overrides'].some(key => Array.isArray(result[key]) && result[key].length > 0);

  if (rule.id === 'waiting_period') {
    // Completion needs the waiting period itself, evidence that cover was uninterrupted (with any prior-cover credit)
    // and an as-of date, each verified. A policy start date alone is never continuity: renewal gaps, lapses and
    // portability credit are not visible in it. Anything less stays unknown, never "0 months".
    const continuity = resolveApplicable(facts, { policyId: query.policyId, memberId: query.memberId ?? null, asOf: query.asOf ?? null, factType: 'continuous_cover', topic: '' });
    const valid = continuity.status === 'known' && isIsoDate(continuity.value?.since) && typeof continuity.value?.uninterrupted === 'boolean';
    if (result.status !== 'known') out.completion = { state: 'unknown', reason: 'waiting_period_not_established' };
    else if (!query.asOf) out.completion = { state: 'unknown', reason: 'as_of_date_missing' };
    else if (!valid) out.completion = { state: 'unknown', reason: 'continuity_not_evidenced' };
    else if (continuity.value.uninterrupted !== true) out.completion = { state: 'unknown', reason: 'cover_interrupted' };
    else {
      const elapsed = wholeMonthsBetween(continuity.value.since, query.asOf);
      out.completion = {
        assumes: 'Whole months are counted by calendar month and a month is complete only on the same day-of-month or later; the contract counting rule is not verified.',
        state: elapsed >= result.value.months ? 'completed' : 'not_completed', elapsedMonths: elapsed, requiredMonths: result.value.months, since: continuity.value.since,
        creditedPriorCover: continuity.value.creditedPriorCover === true, continuityCitations: continuity.citations,
      };
    }
  }
  return deepFreeze(out);
}

export function evaluateRules(facts, query, ruleIds = RULES.map(rule => rule.id)) {
  if (!query || !text(query.policyId, 128)) throw new TypeError('A policyId is required.');
  // The general (topic '') result always comes first and never borrows a topic-specific value. Each topic that has a
  // fact of the rule's type in this policy is evaluated on its own, so a disease-specific sublimit or waiting period
  // is reported beside, not hidden behind, the general rule.
  // A caller that names a topic gets exactly that topic.
  return RULES.filter(rule => ruleIds.includes(rule.id)).flatMap(rule => {
    if (query.topic != null) return [evaluateRule(facts, rule, query)];
    const topics = [...new Set(facts.filter(fact => fact.factType === rule.factType && fact.policyId === query.policyId && fact.topic !== '').map(fact => fact.topic))].sort();
    return ['', ...topics].map(topic => evaluateRule(facts, rule, { ...query, topic }));
  });
}
