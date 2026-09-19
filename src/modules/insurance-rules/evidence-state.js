import { freeze, requireEnum, requireRecord, requireString, EVIDENCE_STATES } from './contracts.js';
import { selectControllingObservations, validateCitation } from './source-hierarchy.js';

const stable = value => JSON.stringify(value, Object.keys(value && typeof value === 'object' && !Array.isArray(value) ? value : {}).sort());

export function normaliseObservation(value, path) {
  const input = requireRecord(value, path);
  const field = requireString(input.field, `${path}.field`);
  const state = requireEnum(input.state, EVIDENCE_STATES, `${path}.state`);
  const source = validateCitation(input.source, `${path}.source`);
  if (state === 'known' && input.value === undefined) throw new TypeError(`${path}.value is required for known evidence.`);
  return freeze({
    field,
    state: source ? state : 'unknown',
    value: source && state === 'known' ? structuredClone(input.value) : null,
    source,
    reason: source ? (input.reason ?? null) : 'A source id, type, version and page are required.',
    memberId: input.memberId ? requireString(input.memberId, `${path}.memberId`) : null,
    treatmentTags: Array.isArray(input.treatmentTags)
      ? [...new Set(input.treatmentTags.map((tag, index) => requireString(tag, `${path}.treatmentTags[${index}]`)))]
      : [],
  });
}

export function resolveEvidence(field, observations) {
  const relevant = observations.filter(item => item.field === field);
  const explicitConflict = relevant.filter(item => item.state === 'conflict');
  const known = selectControllingObservations(relevant.filter(item => item.state === 'known' && item.source));
  const values = new Set(known.map(item => stable(item.value)));
  if (explicitConflict.length || values.size > 1) {
    return freeze({ field, state: 'conflict', value: null, observations: [...known, ...explicitConflict], reason: 'Controlling source-backed observations disagree.' });
  }
  if (known.length > 0 && values.size === 1) {
    return freeze({ field, state: 'known', value: structuredClone(known[0].value), observations: known, reason: null });
  }
  return freeze({ field, state: 'unknown', value: null, observations: relevant, reason: relevant[0]?.reason ?? 'No controlling source-backed observation was supplied.' });
}

export function propagateEvidenceState(states) {
  if (states.includes('conflict')) return 'conflict';
  if (states.includes('unknown') || states.length === 0) return 'unknown';
  return 'known';
}
