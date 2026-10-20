// Deterministic scorer. Compares extractor output to a human-verified golden file.
// Only golden fields with confirmed=true are scored.
import { normalizeValue } from './eval-extractor.js';

export const CRITICAL_FIELDS = Object.freeze([
  'policy_number', 'insured_members', 'base_sum_insured', 'total_premium',
  'policy_period_start', 'policy_period_end', 'room_rent_limit', 'co_payment',
]);

const UNKNOWN = 'unknown';
const isUnknown = value => value == null || normalizeValue(value) === UNKNOWN || normalizeValue(value) === '';

// `grounded(value)` checks the value is present in source text; a value with no source support is hallucinated.
export function classify(goldenValue, extractedValue, grounded = () => true) {
  const goldenAbsent = isUnknown(goldenValue);
  const extractedAbsent = isUnknown(extractedValue);
  if (extractedAbsent) return goldenAbsent ? 'match' : 'missing';
  if (!grounded(extractedValue)) return 'hallucinated';
  if (goldenAbsent) return 'hallucinated';
  return normalizeValue(goldenValue) === normalizeValue(extractedValue) ? 'match' : 'mismatch';
}

// adjudications: [{ field, accepted, value, state }] - an accepted verdict replaces the extractor value.
export function scoreFields(golden, extracted, adjudications = [], { grounded = () => true } = {}) {
  const overrides = new Map(adjudications.filter(item => item.accepted).map(item => [item.field, item]));
  const fields = {};
  for (const [field, truth] of Object.entries(golden.fields)) {
    if (truth.confirmed !== true) continue;
    const override = overrides.get(field);
    const value = override ? override.value : extracted[field]?.value;
    fields[field] = { classification: classify(truth.value, value, text => grounded(field, text)), critical: CRITICAL_FIELDS.includes(field), adjudicated: Boolean(override) };
  }
  const entries = Object.values(fields);
  const critical = entries.filter(entry => entry.critical);
  const ratio = (list, test) => (list.length ? list.filter(test).length / list.length : null);
  return {
    fields,
    summary: {
      scored: entries.length,
      fieldAccuracy: ratio(entries, entry => entry.classification === 'match'),
      criticalAccuracy: ratio(critical, entry => entry.classification === 'match'),
      hallucinationRate: ratio(entries, entry => entry.classification === 'hallucinated'),
      counts: Object.fromEntries(['match', 'mismatch', 'missing', 'hallucinated'].map(kind => [kind, entries.filter(entry => entry.classification === kind).length])),
    },
  };
}

export function adjudicationMetrics(before, after) {
  const changed = Object.keys(after.fields).filter(field => after.fields[field].adjudicated);
  const right = changed.filter(field => after.fields[field].classification === 'match' && before.fields[field].classification !== 'match');
  return {
    lift: (after.summary.fieldAccuracy ?? 0) - (before.summary.fieldAccuracy ?? 0),
    corrections: changed.length,
    precision: changed.length ? changed.filter(field => after.fields[field].classification === 'match').length / changed.length : null,
    fixed: right.length,
  };
}
