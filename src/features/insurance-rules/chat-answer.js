import { formatFactValue } from './fact-format.js';
import { NOT_IN_DOCUMENTS_TEXT } from './clause-answer.js';
import { factSourceLabel } from './fact-source-label.js';

// The deterministic chat answer (chat v0 behaviour carried into v1, complete.md 3.3). Used when CHAT_MODEL_ENABLED is not "true", when
// the budget is spent, when the provider is unavailable, and whenever the model output fails the code's checks. A template over typed
// facts: it never states eligibility, claim approval or payable money as a promise; every number comes from the facts or from
// procedure-planning.js. Wording is DRAFT and FOR LEGAL REVIEW.

const TOPIC_NAME = Object.freeze({ copay_percent: 'a co-payment', copay_zone_percent: 'a co-payment', room_rent_limit: 'a room rent limit', room_category: 'a room rent limit', waiting_ped: 'a waiting period', waiting_initial: 'a waiting period', waiting_specific: 'a waiting period', sub_limit: 'a sub-limit', deductible: 'a deductible' });


/**
 * facts: [{ factKey, entry, status, value, sourceIds, sourceTier, checkWithInsurer, holdingId }] (confirmed only).
 * conflictKeys: Set of fact keys with an open conflict. clauses: [{ id, page, text }] keyword hits (used only when no fact answers).
 * Resolves { text, usedFacts, status } with status evidence_found | unknown.
 */
export function buildDeterministicAnswer({ intent, factKeys, facts, conflictKeys = new Set(), plan = null, clauses = [], searchedClauses = false, awaitingPlan = false, missingTopics = [], holdingLines = [], generalWaiting = false }) {
  const byKey = new Map();
  for (const fact of facts) if (!byKey.has(fact.factKey)) byKey.set(fact.factKey, fact);
  const lines = [];
  const used = [];

  if (holdingLines.length > 0) return Object.freeze({ text: holdingLines.join('\n'), usedFacts: [], status: 'evidence_found' });

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
        lines.push(`- ${fact.entry.label} ${value} (${factSourceLabel(fact) ?? 'on record'}).${fact.checkWithInsurer ? ' Check with your insurer to be sure.' : ''}`);
      } else if (conflictKeys.has(key)) {
        lines.push(`- Your policy document and the insurer's wording disagree about this (${key.replace(/_/g, ' ')}). Review the difference and choose which is right.`);
      }
    }
    // The specific-disease waiting period is not read from any document: say so plainly next to the ones that are known.
    if (generalWaiting && used.length > 0 && !byKey.has('waiting_specific')) {
      lines.push('- I did not find a waiting period for specific diseases in your policy documents. It may simply not be printed there. Please check with your insurer.');
    }
    if (used.length === 0 && lines.length === 0) {
      if (awaitingPlan) {
        lines.push('I have not read the details of your policy yet because you have not confirmed which plan it is. Confirm the plan on the Add a cover page, then ask again.');
      } else if (clauses.length > 0) {
        for (const clause of clauses.slice(0, 3)) {
          const quote = String(clause.window ?? clause.text).replace(/\s+/g, ' ').slice(0, 300);
          const place = clause.page ? ` (page ${clause.page})` : '';
          lines.push(clause.excluded ? `- Your policy wording excludes this${place}: ${quote}` : `- From your policy wording${place}: ${quote}`);
        }
        for (const topic of missingTopics) lines.push(`- I did not find "${topic}" in your policy documents. It may simply not be printed there.`);
        lines.push('These are passages as printed; they are not a confirmed term.');
      } else if (searchedClauses) {
        const named = factKeys.slice(0, 2).map(key => TOPIC_NAME[key] ?? key.replace(/_/g, ' '));
        lines.push(named.length > 0
          ? `I did not find ${[...new Set(named)].join(' or ')} in your policy documents. It may simply not be printed there. Please check with your insurer.`
          : NOT_IN_DOCUMENTS_TEXT);
      } else if (factKeys.length > 0) {
        lines.push(`I do not have ${factKeys.slice(0, 2).map(key => key.replace(/_/g, ' ')).join(' or ')} confirmed for your policy yet.`);
      } else {
        lines.push('I can answer from the terms confirmed on your policy: for example room rent, waiting periods, co-payment, sub-limits and sum insured. What would you like to know?');
      }
    }
  }
  return Object.freeze({ text: lines.join('\n'), usedFacts: used, status: used.length > 0 || (intent === 'procedure_planning' && plan?.checks.length > 0) ? 'evidence_found' : 'unknown' });
}
