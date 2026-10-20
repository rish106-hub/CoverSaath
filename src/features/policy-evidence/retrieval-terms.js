// Query shaping for clause retrieval (ADR 0008). Pure and deterministic: no model, no provider call. Every option is
// off unless a caller asks for it; `npm run eval:retrieval` measures each one against the same golden data.

// Question words that name nothing in a policy. Dropping them stops common words from competing with subject words.
const STOPWORDS = new Set(`a an and are as at be by can could do does for from has have how i if in is it its me my of on or our policy
that the their there this to was what when where which who will with would you your am any get give`.split(/\s+/));

// Insurance vocabulary: the word a member uses -> words a policy prints. Generic domain terms, not tied to one policy.
const SYNONYMS = Object.freeze({
  icu: ['intensive care'],
  consumables: ['non-medical', 'expenses'],
  consumable: ['non-medical', 'expenses'],
  lasik: ['refractive error', 'eyesight'],
  spectacles: ['refractive error', 'contact lenses', 'eyesight'],
  deductible: ['aggregate deductible', 'co-payment'],
  copay: ['co-payment'],
  'co-pay': ['co-payment'],
  cancel: ['cancellation', 'free look'],
  refund: ['cancellation', 'free look'],
  cashless: ['network hospital', 'authorization'],
  checkup: ['health check-up'],
  'check-up': ['health check-up'],
  ped: ['pre-existing'],
  preexisting: ['pre-existing'],
  maternity: ['delivery', 'childbirth'],
  ambulance: ['emergency transport'],
  daycare: ['day care'],
  ayush: ['ayurveda', 'homeopathy', 'unani'],
  restore: ['reinstatement', 'recharge'],
  portability: ['migration', 'port'],
  bonus: ['cumulative bonus', 'no claim bonus'],
  copayment: ['co-payment'],
});

export function shapeQuery(query, { dropStopwords = false, synonyms = false } = {}) {
  if (!dropStopwords && !synonyms) return query;
  const words = String(query ?? '').normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}-]*/gu) ?? [];
  const kept = dropStopwords ? words.filter(word => !STOPWORDS.has(word)) : words;
  const extra = synonyms ? kept.flatMap(word => SYNONYMS[word] ?? []) : [];
  const shaped = [...kept, ...extra].join(' ');
  return shaped || query;
}

// Measured on the 34-question golden set (62 expected clauses) at gateway budgets of 32k, 24k and 16k bytes. Reading
// only the best search hit of each list before the endorsement and schedule clauses lifted first-pass recall (0.89, 0.39,
// 0.21 to 0.92, 0.85, 0.80) and sweep recall (0.95, 0.84, 0.52 to 0.99, 0.97, 0.88) while keeping 19.0, 16.5 and 9.1 of
// the 19 endorsement and schedule clauses (all search ranks first kept only 13.2, 7.4 and 4.4). Neighbour clauses added
// nothing, so there is no option for them. `{}` is the earlier behaviour. Clauses that do not fit are counted in the
// answer's "not read" unknown, never dropped silently.
export const RETRIEVAL_TUNING = Object.freeze({ dropStopwords: true, synonyms: true, searchFirst: 1 });
