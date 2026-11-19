// FSS fact -> product-term fact (ADR 0034, design note section 3). Pure: no I/O, never throws. Takes facts already parsed and
// screened by src/integrations/insurance-data/schemas.js (`outcome: 'verified'` means non-synthetic, independently verified, evidenced and
// its family verified or partial). Eleven FSS names map to eleven product-term fact keys (the pack's seven shown fact types plus P0's room rent and copay):
//   room_rent_limit (fixed_amount_per_day)         -> room_rent_limit   { amountMinor, currency }   rupees x 100
//   copay (percentage)                             -> copay_percent     { bp }                      percent x 100
//   initial_waiting_period (duration)              -> waiting_initial   { days, original }
//   pre_existing_disease_waiting_period (duration) -> waiting_ped       { days, original }
//   pre_hospitalisation_days (duration)            -> pre_hospitalisation_days  { days, original }   (also FSS name pre_hospitalization_days)
//   post_hospitalisation_days (duration)           -> post_hospitalisation_days { days, original }   (also post_hospitalization_days)
//   free_look_period (duration)                    -> free_look_period          { days, original }
//   day_care_covered (bool yes/no)                 -> day_care_covered          { value }            (also FSS name day_care)
//   clause_ayush (bool yes/no)                     -> clause_ayush              { text }             (also FSS name ayush; text slot, see ayush())
// Everything else stays absent: other fact types, facts with conditions or exceptions (a conditional term is not the headline term),
// unusable or withheld families, values that do not fit. Nothing is guessed.

const FIXED_PER_DAY = 'fixed_amount_per_day';
const DURATION_UNITS = Object.freeze({ day: 'day', days: 'day', month: 'month', months: 'month', year: 'year', years: 'year' });

const money = value => {
  if (value?.limitType !== FIXED_PER_DAY || !Number.isFinite(value.amount) || value.amount < 0) return null;
  if (value.currency && value.currency.toUpperCase() !== 'INR') return null;
  const amountMinor = Math.round(value.amount * 100);
  return Number.isSafeInteger(amountMinor) ? { amountMinor, currency: 'INR' } : null;
};

const percent = value => {
  if (!Number.isFinite(value?.percentage) || value.percentage < 0 || value.percentage > 100) return null;
  return { bp: Math.round(value.percentage * 100) };
};

// Same arithmetic as the own-PDF duration normaliser (a year is 365 days, a month 30, twelve months carry into a year), so 36 months equals 3 years.
const duration = value => {
  const part = value?.duration;
  const unit = part && Object.hasOwn(DURATION_UNITS, part.unit) ? DURATION_UNITS[part.unit] : null;
  if (!unit || !Number.isInteger(part.value) || part.value < 0 || part.value > 1200) return null;
  const months = unit === 'year' ? part.value * 12 : unit === 'month' ? part.value : 0;
  const days = unit === 'day' ? part.value : Math.floor(months / 12) * 365 + (months % 12) * 30;
  return days <= 36_600 ? { days, original: [{ amount: part.value, unit }] } : null;
};

// FSS sends a yes/no key as { kind: 'bool', text: 'yes' | 'no' } (insurance-data-api profile-facts.ts factValue). Anything else is not a decided boolean.
const yesNo = value => {
  if (value?.kind !== 'bool' || typeof value.text !== 'string') return null;
  const answer = value.text.trim().toLowerCase();
  return answer === 'yes' ? true : answer === 'no' ? false : null;
};
const boolean = value => { const answer = yesNo(value); return answer === null ? null : { value: answer }; };
// clause_ayush is a TEXT slot ("Is AYUSH treatment covered, and how?"), FSS reads only whether it is covered. The value is the fixed words
// below, never FSS text, so nothing free-form enters the slot; it says nothing about "how". Wording is FOR LEGAL REVIEW.
const ayush = value => { const answer = yesNo(value); return answer === null ? null : { text: answer ? 'AYUSH treatment is covered' : 'AYUSH treatment is not covered' }; };

export const FSS_FACT_MAP = Object.freeze({
  room_rent_limit: Object.freeze({ factKey: 'room_rent_limit', transform: money }),
  copay: Object.freeze({ factKey: 'copay_percent', transform: percent }),
  initial_waiting_period: Object.freeze({ factKey: 'waiting_initial', transform: duration }),
  pre_existing_disease_waiting_period: Object.freeze({ factKey: 'waiting_ped', transform: duration }),
  pre_hospitalisation_days: Object.freeze({ factKey: 'pre_hospitalisation_days', transform: duration }),
  pre_hospitalization_days: Object.freeze({ factKey: 'pre_hospitalisation_days', transform: duration }),
  post_hospitalisation_days: Object.freeze({ factKey: 'post_hospitalisation_days', transform: duration }),
  post_hospitalization_days: Object.freeze({ factKey: 'post_hospitalisation_days', transform: duration }),
  free_look_period: Object.freeze({ factKey: 'free_look_period', transform: duration }),
  day_care_covered: Object.freeze({ factKey: 'day_care_covered', transform: boolean }),
  day_care: Object.freeze({ factKey: 'day_care_covered', transform: boolean }),
  clause_ayush: Object.freeze({ factKey: 'clause_ayush', transform: ayush }),
  ayush: Object.freeze({ factKey: 'clause_ayush', transform: ayush }),
});

export const FSS_MAPPED_FACT_TYPES = Object.freeze(Object.keys(FSS_FACT_MAP));

/**
 * Maps parsed FSS facts to [{ factKey, value, fact, unchecked }]. `fact` is the source fact (for its evidence). `outcome: 'verified'`
 * is a reviewed insurer reading (`unchecked: false`); `outcome: 'unchecked'` is a model-extracted one that FSS has not reviewed
 * (`unchecked: true`, ADR 0036): it becomes an ida_wording row with status extracted_unverified, never reviewed_reference.
 */
export function mapFssFacts(facts) {
  const out = [];
  for (const fact of Array.isArray(facts) ? facts : []) {
    if (!fact || (fact.outcome !== 'verified' && fact.outcome !== 'unchecked') || !Object.hasOwn(FSS_FACT_MAP, fact.factType)) continue;
    if ((fact.conditions?.length ?? 0) > 0 || (fact.exceptions?.length ?? 0) > 0) continue;
    const entry = FSS_FACT_MAP[fact.factType];
    const value = entry.transform(fact.value);
    if (value === null) continue;
    out.push(Object.freeze({ factKey: entry.factKey, value, fact, unchecked: fact.outcome === 'unchecked' }));
  }
  return out;
}

const SAFE_ID = /[^A-Za-z0-9_.:-]/g;

/**
 * The evidence sealed in reference_ref_enc for one mapped fact. Opaque FSS ids, page numbers and hashes only: never the UIN, never a key.
 * Reads return only { source, pageNumber, verificationStatus } of it (holdings-service sourceView).
 */
export function fssEvidence({ fact, versionId, cacheKey }) {
  // ADR 0036: the verbatim insurer quote (12..200 characters, already checked by the parser) and the page it is on. It is sealed with the
  // reference and read back from it only; the first evidence item that has one wins.
  const quoted = (fact.evidence ?? []).find(item => typeof item.quote === 'string' && item.quote.length > 0);
  return Object.freeze({
    source: 'fss',
    refId: `fss:${String(fact.factId).replace(SAFE_ID, '_').slice(0, 120)}`,
    versionId,
    factId: fact.factId,
    factType: fact.factType,
    taxonomyVersion: fact.taxonomyVersion ?? null,
    reviewId: fact.reviewId ?? null,
    reviewerId: fact.reviewerId ?? null,
    verificationStatus: fact.verificationStatus,
    evidence: Object.freeze((fact.evidence ?? []).map(item => Object.freeze({ documentId: item.documentId, pageNumber: item.pageNumber, sha256: item.sha256 }))),
    cacheKey,
    quote: quoted?.quote ?? null,
    quotePage: quoted ? quoted.pageNumber : null,
  });
}
