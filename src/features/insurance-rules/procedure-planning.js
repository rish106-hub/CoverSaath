// Procedure-planning arithmetic for chat (complete.md 3.3, intent procedure_planning). Pure integer arithmetic over resolved facts:
// the waiting period against the policy start, the sub-limit, the room-rent cap and the co-payment. Code owns every number; a model
// only words them. Every figure is an ESTIMATE from the terms on record, not an approval or a promise of payment (FOR LEGAL REVIEW).
//
// facts: { [factKey]: { id, status, value } } for facts that are user_confirmed or reviewed_reference (the caller filters).
// procedure: { name?, plannedDate? 'YYYY-MM-DD', estimatedCostMinor?, roomRentPerDayMinor?, stayDays? } (all validated by the caller).
// Money is integer paise. Resolves { checks, summary, missingInputs, factIds }. A check is { id, status, detail, factIds, values }
// with status ok | attention | info | unknown.

export const PLANNING_VERSION = 'procedure-planning.1';
const DAY_MS = 86_400_000;

const inr = minor => `INR ${(minor / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const isoOf = ms => new Date(ms).toISOString().slice(0, 10);
const parseDay = iso => {
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const ms = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(ms) && isoOf(ms) === iso ? ms : null;
};
const money = fact => (Number.isSafeInteger(fact?.value?.amountMinor) && fact.value.amountMinor >= 0 ? fact.value.amountMinor : null);
const days = fact => (Number.isInteger(fact?.value?.days) && fact.value.days >= 0 ? fact.value.days : null);
const bp = fact => (Number.isInteger(fact?.value?.bp) && fact.value.bp >= 0 && fact.value.bp <= 10_000 ? fact.value.bp : null);

function policyStartMs(facts) {
  if (facts.start_date?.value?.iso) return { ms: parseDay(facts.start_date.value.iso), fact: facts.start_date };
  if (facts.policy_period?.value?.startIso) return { ms: parseDay(facts.policy_period.value.startIso), fact: facts.policy_period };
  return { ms: null, fact: null };
}

export function planProcedure({ facts = {}, procedure = {} } = {}) {
  const checks = [];
  const missing = new Set();
  const used = new Set();
  const cite = (...list) => list.filter(Boolean).forEach(fact => used.add(fact.id));
  const plannedMs = parseDay(procedure.plannedDate);
  const estimate = Number.isSafeInteger(procedure.estimatedCostMinor) && procedure.estimatedCostMinor >= 0 ? procedure.estimatedCostMinor : null;

  // 1. Waiting periods against the policy start.
  const { ms: startMs, fact: startFact } = policyStartMs(facts);
  for (const [id, label] of [['waiting_initial', 'initial waiting period'], ['waiting_specific', 'waiting period for this procedure'], ['waiting_ped', 'waiting period for pre-existing conditions']]) {
    const waiting = days(facts[id]);
    if (waiting === null) continue;
    cite(facts[id], startFact);
    if (startMs === null) { checks.push({ id: `waiting:${id}`, status: 'unknown', detail: `The ${label} is ${waiting} days, but the policy start date is not on record.`, factIds: [facts[id].id], values: { waitingDays: waiting } }); missing.add('policy_start_date'); continue; }
    const eligible = startMs + waiting * DAY_MS;
    const values = { waitingDays: waiting, policyStart: isoOf(startMs), eligibleFrom: isoOf(eligible) };
    // The pre-existing waiting period only applies when the condition is pre-existing, so it is information, not a block.
    if (plannedMs === null) { checks.push({ id: `waiting:${id}`, status: 'unknown', detail: `The ${label} of ${waiting} days ends on ${values.eligibleFrom}. Tell me the planned date to compare.`, factIds: [facts[id].id, startFact.id], values }); missing.add('planned_date'); continue; }
    const over = plannedMs >= eligible;
    const applies = id === 'waiting_ped' ? ' (this applies only if the condition is pre-existing)' : '';
    checks.push({
      id: `waiting:${id}`, status: over ? 'ok' : (id === 'waiting_ped' ? 'info' : 'attention'),
      detail: over ? `The ${label} of ${waiting} days ended on ${values.eligibleFrom}, before the planned date ${procedure.plannedDate}${applies}.`
        : `The ${label} of ${waiting} days ends on ${values.eligibleFrom}, after the planned date ${procedure.plannedDate}${applies}.`,
      factIds: [facts[id].id, startFact.id], values: { ...values, plannedDate: procedure.plannedDate, daysShort: over ? 0 : Math.ceil((eligible - plannedMs) / DAY_MS) },
    });
  }

  // 2. Sub-limit.
  const subLimit = money(facts.sub_limit);
  let claimable = estimate;
  if (subLimit !== null) {
    cite(facts.sub_limit);
    if (estimate === null) { checks.push({ id: 'sub_limit', status: 'unknown', detail: `The sub-limit on record is ${inr(subLimit)}. Tell me the estimated cost to compare.`, factIds: [facts.sub_limit.id], values: { subLimitMinor: subLimit } }); missing.add('estimated_cost'); }
    else {
      const over = estimate > subLimit;
      claimable = Math.min(estimate, subLimit);
      checks.push({ id: 'sub_limit', status: over ? 'attention' : 'ok', detail: over ? `The estimate ${inr(estimate)} is above the sub-limit ${inr(subLimit)} by ${inr(estimate - subLimit)}.` : `The estimate ${inr(estimate)} is within the sub-limit ${inr(subLimit)}.`, factIds: [facts.sub_limit.id], values: { subLimitMinor: subLimit, estimateMinor: estimate, overMinor: Math.max(0, estimate - subLimit) } });
    }
  }

  // 3. Room-rent cap.
  const cap = money(facts.room_rent_limit);
  let roomExcess = 0;
  if (cap !== null) {
    cite(facts.room_rent_limit);
    const rent = Number.isSafeInteger(procedure.roomRentPerDayMinor) && procedure.roomRentPerDayMinor >= 0 ? procedure.roomRentPerDayMinor : null;
    const stay = Number.isInteger(procedure.stayDays) && procedure.stayDays >= 0 && procedure.stayDays <= 365 ? procedure.stayDays : null;
    if (rent === null) { checks.push({ id: 'room_rent', status: 'unknown', detail: `The room rent limit on record is ${inr(cap)} per day. Tell me the room rent per day to compare.`, factIds: [facts.room_rent_limit.id], values: { capMinor: cap } }); missing.add('room_rent_per_day'); }
    else {
      const over = rent > cap;
      const proportionBp = over && rent > 0 ? Math.floor((cap * 10_000) / rent) : 10_000;
      roomExcess = over && stay !== null ? (rent - cap) * stay : 0;
      checks.push({
        id: 'room_rent', status: over ? 'attention' : 'ok',
        detail: over ? `The room costs ${inr(rent)} per day, above the limit ${inr(cap)} by ${inr(rent - cap)} per day${stay !== null ? ` (${inr(roomExcess)} over ${stay} days)` : ''}. Some insurers also reduce other charges in the same proportion (${proportionBp / 100}%); check with the insurer.`
          : `The room costs ${inr(rent)} per day, within the limit ${inr(cap)}.`,
        factIds: [facts.room_rent_limit.id], values: { capMinor: cap, rentMinor: rent, proportionBp, excessPerDayMinor: Math.max(0, rent - cap), excessTotalMinor: roomExcess },
      });
      if (over && stay === null) missing.add('stay_days');
    }
  }

  // 4. Co-payment on the claimable amount.
  const copay = bp(facts.copay_percent);
  let copayMinor = null;
  if (copay !== null) {
    cite(facts.copay_percent);
    if (claimable === null) { checks.push({ id: 'copay', status: 'unknown', detail: `The co-payment on record is ${copay / 100}% of each claim. Tell me the estimated cost to work out your share.`, factIds: [facts.copay_percent.id], values: { copayBp: copay } }); missing.add('estimated_cost'); }
    else {
      copayMinor = Math.ceil((claimable * copay) / 10_000);
      checks.push({ id: 'copay', status: copay > 0 ? 'info' : 'ok', detail: `A co-payment of ${copay / 100}% on ${inr(claimable)} is ${inr(copayMinor)}, paid by you.`, factIds: [facts.copay_percent.id], values: { copayBp: copay, copayMinor, onMinor: claimable } });
    }
  }

  // 5. Approval and network terms (information only).
  for (const [id, text] of [['pre_authorisation_required', 'Approval before a planned admission'], ['cashless_non_network', 'Cashless outside the network']]) {
    const fact = facts[id];
    if (typeof fact?.value?.value !== 'boolean') continue;
    cite(fact);
    checks.push({ id, status: 'info', detail: `${text}: ${fact.value.value ? 'yes' : 'no'} (from the terms on record).`, factIds: [fact.id], values: { value: fact.value.value } });
  }

  let summary = null;
  if (estimate !== null && claimable !== null && (subLimit !== null || copay !== null || cap !== null)) {
    const insurerShare = Math.max(0, claimable - (copayMinor ?? 0) - roomExcess);
    summary = { estimateMinor: estimate, insurerShareMinor: insurerShare, youPayMinor: estimate - insurerShare, basis: 'estimate_from_terms_on_record' };
  }
  return Object.freeze({ version: PLANNING_VERSION, checks: Object.freeze(checks), summary, missingInputs: Object.freeze([...missing]), factIds: Object.freeze([...used]) });
}
