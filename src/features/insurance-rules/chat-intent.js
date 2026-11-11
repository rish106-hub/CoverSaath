// Deterministic intent and topic classification for chat v1 (complete.md 3.3 step 1). Fixed keyword rules over the message; the result
// is a label from CHAT_INTENTS and a list of registry fact keys the question is about. It never states a fact. A model may add a label
// later, labelled unverified; the code path here is the default and the fallback.

const rules = (...pairs) => pairs.map(([pattern, keys]) => ({ pattern, keys }));

// Topic words -> fact keys of src/contracts/policy-facts.js (an unknown key is dropped by the caller).
export const TOPIC_RULES = Object.freeze(rules(
  [/room\s*rent|room\s*cap|room\s*categor|private\s*room|single\s*room/, ['room_rent_limit', 'room_category']],
  [/\bicu\b|intensive\s*care/, ['icu_limit']],
  [/co-?\s?pay/, ['copay_percent', 'copay_zone_percent']],
  [/sub-?\s?limit/, ['sub_limit']],
  [/pre-?\s?existing|\bped\b/, ['waiting_ped']],
  [/maternity|delivery|pregnan/, ['waiting_maternity', 'maternity_covered']],
  [/initial\s*waiting|30[-\s]?day|first\s*30/, ['waiting_initial']],
  [/waiting/, ['waiting_initial', 'waiting_ped', 'waiting_specific']],
  [/sum\s*insured|cover\s*amount|coverage\s*amount/, ['sum_insured']],
  [/deductible/, ['deductible']],
  [/restor|recharge|reload/, ['restoration_available', 'clause_restoration']],
  [/day-?\s?care/, ['day_care_covered']],
  [/pre-?\s?hospital|post-?\s?hospital|before\s*admission|after\s*discharge/, ['pre_hospitalisation_days', 'post_hospitalisation_days']],
  [/ambulance/, ['ambulance_limit']],
  [/renew|expiry|expire|policy\s*(period|term)|end\s*date/, ['renewal_date', 'end_date', 'policy_period']],
  [/grace/, ['grace_period']],
  [/no-?\s?claim|\bncb\b|bonus/, ['ncb_current', 'ncb_max']],
  [/cashless|network\s*hospital/, ['network_type', 'cashless_non_network', 'pre_authorisation_required']],
  [/pre-?\s?auth/, ['pre_authorisation_required']],
  [/intimat|inform\s*the\s*insurer/, ['claim_intimation_window']],
  [/submit|file\s*a\s*claim|claim\s*deadline|reimburse/, ['claim_submission_deadline']],
  [/premium|how\s*much\s*do\s*i\s*pay/, ['premium_total']],
  [/\bayush\b/, ['clause_ayush']],
  [/mental/, ['mental_health_covered']],
  [/portab/, ['portability_allowed']],
  [/exclu|not\s*cover/, ['clause_exclusion']],
));

const PLANNING = /\b(plan(ning|ned)?|schedul(e|ed|ing)|upcoming|book(ed|ing)?|going\s*to\s*(have|get|be\s*admitted|undergo)|need\s*to\s*(have|get|undergo)|will\s*(be\s*admitted|undergo))\b/;
const PROCEDURE = /\b(surgery|operation|procedure|admit(ted)?|admission|hospitali[sz]ation|cataract|knee|hernia|angioplasty|bypass|appendix|appendectomy|delivery|c-?section|transplant)\b/;

/** { intent, factKeys } for one message. `hasProcedure` is true when the caller sent a structured procedure block. */
export function classifyChatMessage(message, { hasProcedure = false } = {}) {
  const text = String(message ?? '').normalize('NFKC').toLowerCase();
  if (text.trim() === '') return { intent: 'unknown', factKeys: [] };
  const factKeys = [];
  for (const { pattern, keys } of TOPIC_RULES) if (pattern.test(text)) for (const key of keys) if (!factKeys.includes(key)) factKeys.push(key);
  let intent;
  if (hasProcedure || (PLANNING.test(text) && PROCEDURE.test(text))) intent = 'procedure_planning';
  else if (/waiting/.test(text)) intent = 'waiting_period';
  else if (/sub-?\s?limit/.test(text)) intent = 'sub_limit';
  else if (/\b(claim|cashless|reimburse|intimat)/.test(text) && factKeys.length === 0) intent = 'claim_process';
  else if (/\b(premium|due\s*date|renewal)\b/.test(text) && factKeys.length === 0) intent = 'premium_due';
  else if (/\b(upload|document|pdf|scan|photo)\b/.test(text) && factKeys.length === 0) intent = 'document_help';
  else if (factKeys.length > 0 || /\b(cover(ed|age)?|include[sd]?|exclu)/.test(text)) intent = 'coverage_question';
  else intent = 'general';
  return { intent, factKeys };
}
