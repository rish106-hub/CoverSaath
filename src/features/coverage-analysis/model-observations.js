import { MODEL_EXTRACTED_UNVERIFIED } from './agent-contracts.js';

// The three model-assisted extraction tasks whose payloads carry parameter values. Question
// drafting and synthesis never produce parameter evidence.
export const MODEL_OBSERVATION_TASK_KEYS = Object.freeze(['profile', 'group', 'personal']);

const PROFILE_UNKNOWN_PLACEHOLDER = 'UNKNOWN';
const isScalar = value => ['string', 'number', 'boolean'].includes(typeof value);

function candidate(parameterKey, value, sourceIds) {
  if (typeof parameterKey !== 'string' || !isScalar(value)) return null;
  const ids = [...new Set(sourceIds.filter(id => typeof id === 'string' && id !== ''))];
  return ids.length === 0 ? null : { parameterKey, value, sourceIds: ids };
}

/**
 * The model-extracted values in a completed extraction payload, as candidates for unverified
 * parameter observations: { parameterKey, value, sourceIds } where sourceIds are the opaque
 * citation ids the model saw. Only values the runtime carried as model_extracted_unverified
 * with a scalar value and at least one citation are returned; unknown and conflicting facts
 * produce no observation. Pure: no I/O, never throws on unexpected shapes.
 */
export function modelObservationCandidates(taskKey, payload) {
  const found = [];
  const add = item => { if (item) found.push(item); };
  if (taskKey === 'profile') {
    for (const [field, entry] of Object.entries(payload?.profile ?? {})) {
      // The profile adapter writes the placeholder 'UNKNOWN' for a fact the model marked known
      // without a value; that is an absent value, not evidence.
      if (entry?.status !== MODEL_EXTRACTED_UNVERIFIED || entry.value === PROFILE_UNKNOWN_PLACEHOLDER) continue;
      add(candidate(field, entry.value, (entry.sources ?? []).map(source => source?.id)));
    }
  } else if (taskKey === 'group') {
    for (const policy of Array.isArray(payload) ? payload : []) {
      for (const node of policy?.coverageGraph?.nodes ?? []) {
        if (node?.status !== MODEL_EXTRACTED_UNVERIFIED) continue;
        add(candidate(node.fact, node.value, (node.citations ?? []).map(citation => citation?.sourceId)));
      }
    }
  } else if (taskKey === 'personal') {
    for (const dimension of Object.values(payload?.dimensions ?? {})) {
      for (const assertion of dimension?.assertions ?? []) {
        if (assertion?.status !== MODEL_EXTRACTED_UNVERIFIED) continue;
        add(candidate(assertion.field, assertion.value, (assertion.sources ?? []).map(source => source?.id)));
      }
    }
  }
  return found;
}
