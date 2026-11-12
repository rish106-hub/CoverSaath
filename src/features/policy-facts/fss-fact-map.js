// FSS fact -> CoverSaath product-term fact (ADR 0034, design note section 3). Pure: no I/O, never throws. Takes facts already parsed and
// screened by src/integrations/insurance-data/schemas.js (`outcome: 'verified'` means non-synthetic, independently verified, evidenced and
// its family verified or partial). Only four types map in P0:
//   room_rent_limit (fixed_amount_per_day)         -> room_rent_limit   { amountMinor, currency }   rupees x 100
//   copay (percentage)                             -> copay_percent     { bp }                      percent x 100
//   initial_waiting_period (duration)              -> waiting_initial   { days, original }
//   pre_existing_disease_waiting_period (duration) -> waiting_ped       { days, original }
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

export const FSS_FACT_MAP = Object.freeze({
  room_rent_limit: Object.freeze({ factKey: 'room_rent_limit', transform: money }),
  copay: Object.freeze({ factKey: 'copay_percent', transform: percent }),
  initial_waiting_period: Object.freeze({ factKey: 'waiting_initial', transform: duration }),
  pre_existing_disease_waiting_period: Object.freeze({ factKey: 'waiting_ped', transform: duration }),
});

export const FSS_MAPPED_FACT_TYPES = Object.freeze(Object.keys(FSS_FACT_MAP));

/** Maps parsed FSS facts to [{ factKey, value, fact }]. `fact` is the source fact (for its evidence). */
export function mapFssFacts(facts) {
  const out = [];
  for (const fact of Array.isArray(facts) ? facts : []) {
    if (!fact || fact.outcome !== 'verified' || !Object.hasOwn(FSS_FACT_MAP, fact.factType)) continue;
    if ((fact.conditions?.length ?? 0) > 0 || (fact.exceptions?.length ?? 0) > 0) continue;
    const entry = FSS_FACT_MAP[fact.factType];
    const value = entry.transform(fact.value);
    if (value === null) continue;
    out.push(Object.freeze({ factKey: entry.factKey, value, fact }));
  }
  return out;
}

const SAFE_ID = /[^A-Za-z0-9_.:-]/g;

/**
 * The evidence sealed in reference_ref_enc for one mapped fact. Opaque FSS ids, page numbers and hashes only: never the UIN, never a key.
 * Reads return only { source, pageNumber, verificationStatus } of it (holdings-service sourceView).
 */
export function fssEvidence({ fact, versionId, cacheKey }) {
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
    quote: null,
  });
}
