import { formatFactValue } from './fact-format.js';

// The deterministic chat answer (chat v0 behaviour carried into v1, complete.md 3.3). Used when CHAT_MODEL_ENABLED is not "true", when
// the budget is spent, when the provider is unavailable, and whenever the model output fails the code's checks. A template over typed
// facts: it never states eligibility, claim approval or payable money as a promise; every number comes from the facts or from
// procedure-planning.js. Wording is DRAFT and FOR LEGAL REVIEW.

const SOURCE = Object.freeze({
  user_confirmed: 'confirmed by you',
  reviewed_reference: "from the insurer's published wording",
});

/**
 * facts: [{ factKey, entry, status, value, sourceIds, sourceTier, checkWithInsurer, holdingId }] (confirmed only).
 * conflictKeys: Set of fact keys with an open conflict. clauses: [{ id, page, text }] keyword hits (used only when no fact answers).
 * Resolves { text, usedFacts, status } with status evidence_found | unknown.
 */
export function buildDeterministicAnswer({ intent, factKeys, facts, conflictKeys = new Set(), plan = null, clauses = [] }) {
  const byKey = new Map();
  for (const fact of facts) if (!byKey.has(fact.factKey)) byKey.set(fact.factKey, fact);
  const lines = [];
  const used = [];

  if (intent === 'procedure_planning' && plan) {
    for (const check of plan.checks) lines.push(`- ${check.detail}`);
    for (const fact of facts) if (plan.factIds.includes(fact.sourceIds[0]) && !used.includes(fact)) used.push(fact);
    if (plan.summary) {
      const inr = minor => `INR ${(minor / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
      lines.push(`Estimate from the terms on record: the policy may cover about ${inr(plan.summary.insurerShareMinor)} and you may pay about ${inr(plan.summary.youPayMinor)}. This is an estimate, not an approval; the insurer decides.`);
    }
    if (plan.missingInputs.length > 0) lines.push(`To work this out fully I still need: ${plan.missingInputs.map(item => item.replace(/_/g, ' ')).join(', ')}.`);
    if (plan.checks.length === 0) lines.push('I do not have confirmed terms (waiting period, sub-limit, room rent limit or co-payment) for this policy yet, so I cannot compare your plan.');
  } else {
    for (const key of factKeys) {
      const fact = byKey.get(key);
      if (fact) {
        const value = formatFactValue(fact.entry.type, fact.value);
        if (value === null) continue;
        used.push(fact);
        lines.push(`- ${fact.entry.label} ${value} (${SOURCE[fact.status] ?? 'on record'}).${fact.checkWithInsurer ? ' Check with your insurer to be sure.' : ''}`);
      } else if (conflictKeys.has(key)) {
        lines.push(`- Your policy document and the insurer's wording disagree about this (${key.replace(/_/g, ' ')}). Review the difference and choose which is right.`);
      }
    }
    if (used.length === 0 && lines.length === 0) {
      if (clauses.length > 0) {
        for (const clause of clauses.slice(0, 3)) lines.push(`- From your policy document${clause.page ? ` (page ${clause.page})` : ''}: ${String(clause.text).replace(/\s+/g, ' ').slice(0, 300)}`);
        lines.push('These are passages as printed; they are not a confirmed term.');
      } else if (factKeys.length > 0) {
        lines.push(`I do not have ${factKeys.slice(0, 2).map(key => key.replace(/_/g, ' ')).join(' or ')} confirmed for your policy yet.`);
      } else {
        lines.push('I can answer from the terms confirmed on your policy: for example room rent, waiting periods, co-payment, sub-limits and sum insured. What would you like to know?');
      }
    }
  }
  return Object.freeze({ text: lines.join('\n'), usedFacts: used, status: used.length > 0 || (intent === 'procedure_planning' && plan?.checks.length > 0) ? 'evidence_found' : 'unknown' });
}
