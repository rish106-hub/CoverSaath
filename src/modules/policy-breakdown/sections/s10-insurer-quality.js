// Section 10 — Insurer quality: will they actually pay, and how fast?
// Analysis section. No model reads the policy for this section. analyze(context) derives every value
// deterministically from supplied, dated public disclosures (references.insurerDisclosures) that match the
// policy's own insurer_name, plus Section 1 tpa_name for the claims-handling model. No insurer statistics are
// embedded here; with no matching disclosure every metric is Unknown.

import { defineSection } from '../contracts.js';

const SECTION_NUMBER = 10;
const ACCEPTED_INPUT_STATES = new Set(['Proven', 'Calculated']);

// Metric key -> how a disclosure value is read and bounded.
// Percent bounds deliberately exceed 100 for incurred claim ratio and solvency ratio: an insurer can pay more in
// claims than it earns in premium, and solvency is disclosed as a multiple (1.85 times = 185 percent).
const METRICS = Object.freeze({
  claim_settlement_ratio_count: { kind: 'percent', min: 0, max: 100 },
  claim_settlement_ratio_amount: { kind: 'percent', min: 0, max: 100 },
  incurred_claim_ratio: { kind: 'percent', min: 0, max: 1_000 },
  repudiation_ratio: { kind: 'percent', min: 0, max: 100 },
  complaints_per_10k_claims: { kind: 'count', min: 0, max: 10_000 },
  solvency_ratio: { kind: 'percent', min: 0, max: 10_000 },
  average_settlement_days: { kind: 'days', min: 0, max: 3_650 },
  network_hospitals_in_city: { kind: 'count', min: 0, max: 100_000, byCity: true },
  public_complaint_patterns: { kind: 'text_list' },
});

const insurerMetric = (key, label, description, valueType, extra = {}) => ({
  key,
  label,
  description,
  valueType,
  effects: ['inform'],
  bases: ['not_applicable'],
  critical: false,
  visibility: 'cover',
  memberScoped: false,
  emergencyCard: false,
  estimateInput: false,
  derivedFrom: ['insurer_name'],
  ...extra,
});

const percentRange = max => value => (value?.kind === 'percent' && (value.percent < 0 || value.percent > max) ? `percent must be 0–${max}` : null);
const countRange = max => value => (value && typeof value.count === 'number' && (value.count < 0 || value.count > max) ? `value must be 0–${max}` : null);

const parameters = [
  insurerMetric('claim_settlement_ratio_count', 'Claim settlement ratio (by count)',
    'Claims settled as a percentage of claims disposed of in the disclosed period, counted by number of claims. Percent 0–100. Dynamic: always carries the disclosure period and publication date.',
    'percent', { validate: percentRange(100) }),
  insurerMetric('claim_settlement_ratio_amount', 'Claim settlement ratio (by amount)',
    'Rupee amount paid as a percentage of rupee amount claimed for claims disposed of in the disclosed period. Percent 0–100. Usually lower than the count ratio because large claims are more often partly paid.',
    'percent', { validate: percentRange(100) }),
  insurerMetric('incurred_claim_ratio', 'Incurred claim ratio',
    'Net claims incurred as a percentage of net premium earned in the disclosed period. Percent; may exceed 100 when claims outstrip premium. Not a measure of individual claim fairness.',
    'percent', { validate: percentRange(1_000) }),
  insurerMetric('repudiation_ratio', 'Repudiation ratio',
    'Claims rejected (repudiated) as a percentage of claims disposed of in the disclosed period, by count unless the disclosure says otherwise. Percent 0–100.',
    'percent', { validate: percentRange(100) }),
  insurerMetric('complaints_per_10k_claims', 'Complaints per 10,000 claims',
    'Number of complaints registered against the insurer per 10,000 claims in the disclosed period, rounded to a whole number as disclosed.',
    'count', { validate: countRange(10_000) }),
  insurerMetric('solvency_ratio', 'Solvency ratio',
    'Available solvency margin divided by required solvency margin, expressed as a percent (a disclosed 1.85 times is stored as 185). May exceed 100.',
    'percent', { validate: percentRange(10_000) }),
  insurerMetric('average_settlement_days', 'Average claim settlement turnaround',
    'Average number of days from receipt of the last required claim document to payment, as disclosed for the period. Integer days.',
    'days', { validate: countRange(3_650) }),
  {
    key: 'claims_handling_model',
    label: 'Claims handled in-house or by a TPA',
    description: 'Whether this policy\'s claims are serviced by a named Third Party Administrator (tpa) or the insurer\'s own claims team (in_house). Derived from the Section 1 tpa_name only: a Proven TPA name gives tpa. Absence of a TPA is not provable from a missing field, so a missing TPA name stays Unknown.',
    valueType: 'enum',
    enumValues: ['in_house', 'tpa', 'unknown'],
    effects: ['inform'],
    bases: ['not_applicable'],
    critical: false,
    visibility: 'operational',
    memberScoped: false,
    emergencyCard: false,
    estimateInput: false,
    derivedFrom: ['tpa_name'],
  },
  insurerMetric('network_hospitals_in_city', 'Network hospitals in the household\'s city',
    'Number of cashless network hospitals of this insurer in the household\'s city, from a dated network disclosure for that city. Integer count. Dynamic: network lists change often.',
    'count', { visibility: 'operational', validate: countRange(100_000) }),
  insurerMetric('public_complaint_patterns', 'Public complaint patterns',
    'Recurring complaint themes against this insurer from a dated public disclosure (for example ombudsman or regulator complaint categories). Short strings, as disclosed.',
    'text_list'),
];

const expertise = `Section 10 is an analysis section. No model reads the policy for it and nothing here may be inferred from general knowledge, memory, news or reputation. Every value comes from a supplied, dated public disclosure that names the same insurer as the policy's own Section 1 insurer_name. This text is guidance for reviewers and operators who read or explain these figures.

How matching works. The insurer name from the policy is compared to each disclosure's insurerName after normalisation: case, punctuation and spacing are ignored, "Limited" and "Ltd" are dropped, and "Company" and "Co." are treated as the same token. Nothing fuzzier is accepted: a disclosure for a sister company, a life insurer in the same group or a brand name is not a match. If insurer_name is not Proven or Calculated, no disclosure is used and every metric is Unknown (or Conflicting / NotPermitted when that is the input's state). For each metric the most recent disclosure period is used; a disclosure published after the analysis date is ignored. If two disclosures for the same metric and period carry different values, the result is Conflicting and both values are preserved in notes for a reviewer to resolve against the original source. Every value is Dynamic and its stateReason carries the period and publication date.

Definitions.
- Claim settlement ratio by count: claims settled divided by claims disposed of (settled plus repudiated plus closed) in the period, by number of claims.
- Claim settlement ratio by amount: rupees paid divided by rupees claimed for disposed claims. It is usually lower than the count ratio. Small claims are numerous and usually paid in full, which lifts the count ratio; large claims are fewer but are more often partly paid (room-rent proportionate deduction, sub-limits, non-payable items, co-pay) or rejected, and each one weighs heavily in rupees. A household facing a large hospital bill is closer to the amount ratio. Neither ratio says what a particular claim will receive.
- Incurred claim ratio: net claims incurred divided by net premium earned. It describes the insurer's book, not claim fairness. Very low can mean tight claim payment; above 100 means claims exceeded premium for that period.
- Repudiation ratio: claims rejected divided by claims disposed of, by count unless the disclosure states amount.
- Complaints per 10,000 claims: registered complaints scaled per 10,000 claims in the period.
- Solvency ratio: available solvency margin divided by required solvency margin, stored as a percent (1.85 times = 185).
- Average settlement turnaround: average days from the last required document to payment.
- Claims handling model: tpa when the policy names a Third Party Administrator (Section 1 tpa_name Proven); otherwise Unknown. in_house is recorded only when it can be established, never assumed from a missing TPA name.
- Network hospitals in city: count of the insurer's network hospitals in the household's city from a dated, city-specific disclosure. Without a household city or a city-specific disclosure it is Unknown.

Reviewer cautions. Compare periods before comparing insurers: a figure from an older year is not comparable with a newer one. Group, retail and government-scheme business can be pooled in one ratio; read the disclosure scope. Do not present any of these figures as a prediction or guarantee for a household's claim, and do not use them to give advice.`;

const reviewGuidance = `No Section 10 parameter is critical; none drives a cash estimate or the emergency card. Before any figure is shown, check: (1) the disclosure's insurerName is the same legal entity as the policy's insurer_name; (2) the period and publication date in stateReason are the latest available and the source label points to the original disclosure; (3) percent figures were entered as percent (solvency 1.85 times as 185, not 1.85); (4) any Conflicting metric is resolved against the original document, not by picking the more favourable value; (5) network_hospitals_in_city refers to the household's own city and the network list date is recent.`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const readParameter = (store, key) => {
  if (!store) return null;
  if (typeof store.get === 'function') return store.get(key) ?? null;
  return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
};

/** Normalised legal-entity name used for exact matching. */
export function normaliseInsurerName(name) {
  if (typeof name !== 'string') return '';
  return name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .filter(token => token !== 'limited' && token !== 'ltd')
    .map(token => (token === 'company' ? 'co' : token === 'pvt' ? 'private' : token))
    .join(' ');
}

const normaliseCity = city => (typeof city === 'string' ? city.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() : '');

const isIsoDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));

/**
 * Turns a disclosure period label into a sortable end date (yyyy-mm-dd), or null when unparseable.
 * Accepted: "FY2025-26" / "2025-26" / "FY 2025-2026" (Indian financial year ending 31 March), "2025" (calendar
 * year), "2025-06" (month), "2025-06-30" (date). A label that reads as consecutive years ("2011-12") is taken as a
 * financial year.
 */
export function periodEndDate(period) {
  if (typeof period !== 'string') return null;
  const label = period.trim();
  const fy = label.match(/^(?:FY\s*)?(\d{4})\s*[-–/]\s*(\d{2}|\d{4})$/i);
  if (fy) {
    const start = Number(fy[1]);
    const endRaw = fy[2].length === 2 ? Number(`${String(start + 1).slice(0, 2)}${fy[2]}`) : Number(fy[2]);
    // A label like "2026-02" fails the consecutive-year test and falls through to the month form below.
    if (endRaw === start + 1) return `${endRaw}-03-31`;
  }
  if (/^\d{4}$/.test(label)) return `${label}-12-31`;
  const month = label.match(/^(\d{4})-(\d{2})$/);
  if (month) {
    const m = Number(month[2]);
    if (m < 1 || m > 12) return null;
    const last = new Date(Date.UTC(Number(month[1]), m, 0)).getUTCDate();
    return `${month[1]}-${month[2]}-${String(last).padStart(2, '0')}`;
  }
  return isIsoDate(label) ? label : null;
}

function toValue(metric, raw) {
  const spec = METRICS[metric];
  if (spec.kind === 'text_list') {
    if (!Array.isArray(raw)) return null;
    const items = raw.map(entry => String(entry).trim()).filter(Boolean).slice(0, 60);
    return items.length ? { kind: 'text_list', items } : null;
  }
  let number = raw;
  if (raw && typeof raw === 'object') number = spec.kind === 'percent' ? raw.percent : raw.count;
  if (typeof number !== 'number' || !Number.isFinite(number) || number < spec.min || number > spec.max) return null;
  if (spec.kind === 'percent') return { kind: 'percent', percent: Math.round(number * 100) / 100 };
  if (!Number.isInteger(number)) return null;
  return { kind: spec.kind, count: number };
}

const valueSignature = value => JSON.stringify(value.kind === 'text_list' ? [...value.items].sort() : value);
const describeValue = value => {
  if (value.kind === 'percent') return `${value.percent}%`;
  if (value.kind === 'text_list') return value.items.join('; ');
  return String(value.count);
};

const result = (key, evidenceState, stateReason, { value = null, derivedFrom = ['insurer_name'], notes = null } = {}) => ({
  key, value, evidenceState, stateReason, derivedFrom, notes,
});

function propagated(state, inputKey) {
  if (state === 'NotPermitted') return { evidenceState: 'NotPermitted', reason: `${inputKey}_not_permitted` };
  if (state === 'Conflicting') return { evidenceState: 'Conflicting', reason: `${inputKey}_conflicting` };
  if (state === 'Unknown' || !state) return { evidenceState: 'Unknown', reason: `${inputKey}_unknown` };
  return { evidenceState: 'Unknown', reason: `${inputKey}_not_proven_${String(state).toLowerCase()}` };
}

// ---------------------------------------------------------------------------
// analyze
// ---------------------------------------------------------------------------

function analyzeClaimsHandling(parameterStore) {
  const tpa = readParameter(parameterStore, 'tpa_name');
  const derivedFrom = ['tpa_name'];
  if (!tpa || !ACCEPTED_INPUT_STATES.has(tpa.evidenceState)) {
    const { evidenceState, reason } = propagated(tpa?.evidenceState, 'tpa_name');
    return result('claims_handling_model', evidenceState, reason, { derivedFrom });
  }
  const name = tpa.value?.text?.trim();
  if (!name) return result('claims_handling_model', 'Unknown', 'tpa_name_has_no_value', { derivedFrom });
  return result('claims_handling_model', 'Calculated', 'policy_names_a_tpa', {
    value: { kind: 'enum', enumValue: 'tpa' },
    derivedFrom,
    notes: `Claims serviced by the TPA named in the policy: ${name}.`,
  });
}

function analyzeMetric(metric, matched, asOf, householdCity) {
  const spec = METRICS[metric];
  if (spec.byCity && !householdCity) return result(metric, 'Unknown', 'household_city_unknown');
  const rejected = [];
  const usable = [];
  for (const disclosure of matched) {
    if (disclosure.metric !== metric) continue;
    if (spec.byCity && normaliseCity(disclosure.city) !== householdCity) continue;
    const end = periodEndDate(disclosure.period);
    if (!end || !isIsoDate(disclosure.publishedOn)) { rejected.push('undated_or_unparseable_period'); continue; }
    if (asOf && disclosure.publishedOn > asOf) { rejected.push('published_after_analysis_date'); continue; }
    const value = toValue(metric, disclosure.value);
    if (!value) { rejected.push('value_out_of_range_or_wrong_type'); continue; }
    usable.push({ end, value, disclosure });
  }
  if (usable.length === 0) {
    const reason = spec.byCity ? 'no_city_disclosure_for_insurer' : 'no_disclosure_for_insurer';
    return result(metric, 'Unknown', reason, { notes: rejected.length ? `Ignored disclosures: ${[...new Set(rejected)].join(', ')}.` : null });
  }
  const latestEnd = usable.reduce((max, entry) => (entry.end > max ? entry.end : max), usable[0].end);
  const latest = usable.filter(entry => entry.end === latestEnd);
  const distinct = new Map();
  for (const entry of latest) {
    const signature = valueSignature(entry.value);
    if (!distinct.has(signature)) distinct.set(signature, []);
    distinct.get(signature).push(entry);
  }
  const periodLabel = latest[0].disclosure.period;
  if (distinct.size > 1) {
    const detail = [...distinct.values()].map(entries => `${describeValue(entries[0].value)} (${entries.map(e => `${e.disclosure.source ?? 'unlabelled source'}, published ${e.disclosure.publishedOn}`).join('; ')})`).join(' vs ');
    return result(metric, 'Conflicting', `disclosures_disagree_for_period ${periodLabel}`, { notes: `Conflicting values for ${periodLabel}: ${detail}.` });
  }
  const entries = [...distinct.values()][0];
  const publishedOn = entries.map(e => e.disclosure.publishedOn).sort().at(-1);
  const sources = [...new Set(entries.map(e => e.disclosure.source).filter(Boolean))];
  return result(metric, 'Dynamic', `public_disclosure period ${periodLabel}, published ${publishedOn}`, {
    value: entries[0].value,
    notes: `Source: ${sources.length ? sources.join('; ') : 'unlabelled'}.${spec.byCity ? ` City: ${entries[0].disclosure.city}.` : ''}`,
  });
}

function analyze(context = {}) {
  const { asOf = null, parameters: parameterStore = null, household = null, references = {} } = context;
  const outputs = [];
  const insurer = readParameter(parameterStore, 'insurer_name');
  const insurerUsable = insurer && ACCEPTED_INPUT_STATES.has(insurer.evidenceState) && typeof insurer.value?.text === 'string' && insurer.value.text.trim();
  const disclosureMetrics = Object.keys(METRICS);

  if (!insurerUsable) {
    const { evidenceState, reason } = insurer && ACCEPTED_INPUT_STATES.has(insurer.evidenceState)
      ? { evidenceState: 'Unknown', reason: 'insurer_name_has_no_value' }
      : propagated(insurer?.evidenceState, 'insurer_name');
    for (const metric of disclosureMetrics) outputs.push(result(metric, evidenceState, reason));
  } else {
    const target = normaliseInsurerName(insurer.value.text);
    const disclosures = Array.isArray(references?.insurerDisclosures) ? references.insurerDisclosures : [];
    const matched = disclosures.filter(d => d && typeof d === 'object' && METRICS[d.metric] && normaliseInsurerName(d.insurerName) === target);
    const householdCity = normaliseCity(household?.city);
    for (const metric of disclosureMetrics) outputs.push(analyzeMetric(metric, matched, asOf, householdCity));
  }
  outputs.push(analyzeClaimsHandling(parameterStore));
  // Return in declared parameter order.
  const order = parameters.map(p => p.key);
  return outputs.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
}

export default defineSection({
  number: SECTION_NUMBER,
  id: 'section-10-insurer-quality',
  title: 'Insurer quality',
  question: 'Will they actually pay, and how fast?',
  kind: 'analysis',
  expertise,
  parameters,
  analyze,
  reviewGuidance,
});
