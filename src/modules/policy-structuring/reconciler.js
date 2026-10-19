// Conflict detection and selection across validated items. Deterministic comparison always runs; one
// optional model call may flag extra conflicts and, by owner decision (2026-10-19, ADR 0006), select which
// reading applies. A selection is accepted only for a deterministic contradiction of comparable readings and
// only when it cites one of that group's own quotes; context differences and per-subject variations are never
// selected. The selected value stays extracted_unverified, every reading is kept, and the household confirms it.
import { modelMayProduceResolutionState } from '../../contracts/ai-authority.js';
import { errorReason } from './extractor.js';
import { comparisonKey } from './validator.js';
import {
  RECONCILE_SCHEMA, STRUCTURING_INSTRUCTIONS, STRUCTURING_RECONCILE_TASK,
} from '../ai-analysis/structuring-contract.js';

export { RECONCILE_SCHEMA };

export const RECONCILER_VERSION = 'policy-structuring-reconciler/v3';
export const RECONCILER_LIMITS = Object.freeze({ maxGroups: 80, maxQuotesPerGroup: 6 });

function fail(code, message) { throw Object.assign(new Error(message), { code }); }

// Readings split by subject only when the subject is an insured member: a privacy-gate name placeholder or a
// member or relation term ("Self", "Spouse", "Insured Person 2", "Member A"). Gemini fills subject with
// descriptive or benefit labels ("pre-existing diseases", "Pre-Hospitalization"); those would hide a
// contradiction as a per-subject variation, so they group under the key ('policy'). Over-reporting is
// acceptable; hiding a contradiction is not.
const MEMBER_WORDS = new Set(['self', 'spouse', 'husband', 'wife', 'son', 'daughter', 'child', 'children', 'mother', 'father',
  'proposer', 'insured', 'person', 'member', 'primary', 'dependent', 'dependant']);
const NAME_PLACEHOLDER = /^<name_[1-9][0-9]{0,5}>$/;
function memberSubject(words) {
  const fits = word => MEMBER_WORDS.has(word) || NAME_PLACEHOLDER.test(word) || /^\d{1,2}$/.test(word) || /^[a-z]$/.test(word);
  return words.every(fits) && words.some(word => MEMBER_WORDS.has(word) || NAME_PLACEHOLDER.test(word));
}
const subjectNorm = subject => {
  const norm = String(subject ?? 'policy').toLowerCase().replace(/[^\p{L}\p{N}<>_ ]+/gu, ' ').replace(/\s+/g, ' ').trim();
  return norm && memberSubject(norm.split(' ')) ? norm : 'policy';
};
const ref = item => ({ chunkId: item.chunkId, page: item.page, blockIndex: item.blockIndex });

export function groupItems(accepted = [], proposals = []) {
  const groups = new Map();
  for (const item of [...accepted, ...proposals]) {
    const kind = item.kind === 'registry' ? 'registry' : 'proposed';
    const key = kind === 'registry' ? item.parameterKey : item.proposedKey;
    const subject = subjectNorm(item.value?.subject);
    const groupId = `${kind}:${key}|${subject}`;
    if (!groups.has(groupId)) groups.set(groupId, { groupId, target: { kind, key }, subject, items: [] });
    groups.get(groupId).items.push(item);
  }
  return [...groups.values()].sort((a, b) => (a.groupId < b.groupId ? -1 : a.groupId > b.groupId ? 1 : 0));
}

const distinctValues = items => new Set(items.map(item => comparisonKey(item.value))).size;

// Two readings contradict only when they state comparable values: both normalised to the same kind, or
// both short value phrases. Differing readings that are not comparable (a clause beside a schedule value)
// are 'context': still unresolved, never a silent winner, but not reported as a contradiction.
export const SHORT_VALUE_CHARS = 60;
function comparable(left, right) {
  const [a, b] = [left.value?.normalized, right.value?.normalized];
  if (a?.kind && b?.kind && a.kind === b.kind) return true;
  return String(left.value?.text ?? '').length <= SHORT_VALUE_CHARS && String(right.value?.text ?? '').length <= SHORT_VALUE_CHARS;
}
const contradictPair = (left, right) => comparable(left, right) && comparisonKey(left.value) !== comparisonKey(right.value);
function contradicts(items) {
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      if (contradictPair(items[i], items[j])) return true;
    }
  }
  return false;
}
// A selected reading must itself take part in a contradiction: comparable with, and different from,
// another reading of the same group. A clause beside a schedule value is never picked as the winner.
const selectable = (items, quote) => items.some(item => item.evidenceQuote === quote
  && items.some(other => other !== item && contradictPair(item, other)));

const entry = (groupId, target, subject, kind, items) => ({
  groupId, target, subject, kind, sources: ['deterministic'],
  reasonCode: { conflict: 'model_observations_conflict', context: 'context_differs', variation: 'per_subject_values' }[kind],
  itemRefs: items.map(ref),
});

// Every key whose readings differ gets an entry, so no differing key is ever stored with one value unless a
// grounded selection is made: kind 'conflict' (comparable readings differ), 'context' (differing readings
// that cannot be compared) or 'variation' (different values for subjects printed in the document, such as
// members or benefits). Variations are never resolved to one value.
export function deterministicConflicts(groups) {
  const conflicts = groups.filter(group => distinctValues(group.items) > 1)
    .map(group => entry(group.groupId, group.target, group.subject, contradicts(group.items) ? 'conflict' : 'context', group.items));
  const byKey = new Map();
  for (const group of groups.filter(candidate => candidate.target.kind === 'registry')) {
    byKey.set(group.target.key, [...(byKey.get(group.target.key) ?? []), group]);
  }
  for (const [key, keyGroups] of byKey) {
    const items = keyGroups.flatMap(group => group.items);
    if (keyGroups.length < 2 || distinctValues(items) < 2) continue;
    const named = keyGroups.every(group => group.subject !== 'policy' && group.items.every(item => item.subjectInSource === true));
    const kind = named ? 'variation' : contradicts(items) ? 'conflict' : 'context';
    conflicts.push(entry(`registry:${key}|*`, { kind: 'registry', key }, null, kind, items));
  }
  return conflicts;
}

const kindOf = item => item?.kind ?? ({ per_subject_values: 'variation', context_differs: 'context' }[item?.reasonCode] ?? 'conflict');
// Only a contradiction is reported as a conflict; context and per-subject variation are reported apart.
export const isConflict = item => kindOf(item) === 'conflict';

function quotesOf(group, limit) {
  return [...new Set(group.items.map(item => item.evidenceQuote))].slice(0, limit);
}

function acceptModelConflict(candidate, sent) {
  const group = candidate && typeof candidate === 'object' && typeof candidate.group_id === 'string' ? sent.get(candidate.group_id) : undefined;
  if (!group) return { reason: 'unknown_group', groupId: null };
  const quotes = Array.isArray(candidate.quotes) ? candidate.quotes.map(quote => (typeof quote === 'string' ? quote.trim() : '')) : [];
  const allowed = new Set(group.quotes);
  if (!quotes.length || quotes.some(quote => !allowed.has(quote)) || new Set(quotes).size < 2) return { reason: 'ungrounded_conflict', groupId: group.groupId };
  const selected = typeof candidate.selected_quote === 'string' ? candidate.selected_quote.trim() : '';
  return { group, selectedQuote: selected && allowed.has(selected) ? selected : null, ungroundedSelection: Boolean(selected) && !allowed.has(selected) };
}

export async function reconcile({ accepted = [], proposals = [], call, consentCheck, limits = {} } = {}) {
  const caps = { ...RECONCILER_LIMITS, ...limits };
  const groups = groupItems(accepted, proposals);
  const conflicts = deterministicConflicts(groups);
  const out = { conflicts, calls: 0, usage: { inputTokens: 0, outputTokens: 0 }, skipped: [] };
  const candidates = groups.filter(group => group.items.length >= 2);
  for (const group of candidates.slice(caps.maxGroups)) out.skipped.push({ groupId: group.groupId, reason: 'group_cap' });
  const sendable = candidates.slice(0, caps.maxGroups);
  if (!sendable.length) return out;
  if (typeof call !== 'function' || typeof consentCheck !== 'function') fail('STRUCTURING_INPUT_INVALID', 'A provider call and consent check are required.');
  const sent = new Map(sendable.map(group => [group.groupId, { ...group, quotes: quotesOf(group, caps.maxQuotesPerGroup) }]));
  const payload = { groups: [...sent.values()].map(group => ({
    group_id: group.groupId, target: group.target.key, subject: group.subject,
    readings: group.items.filter(item => group.quotes.includes(item.evidenceQuote)).map(item => ({ value: item.value.text, quote: item.evidenceQuote, page: item.page })),
  })) };
  // The reconcile call counts against the document's remaining input-token budget.
  if (Number.isFinite(caps.maxInputTokens) && Math.ceil(JSON.stringify(payload).length / 4) > caps.maxInputTokens) {
    out.skipped.push({ groupId: null, reason: 'token_cap' });
    return out;
  }
  await consentCheck();
  let response;
  out.calls = 1;
  try { response = await call({ task: STRUCTURING_RECONCILE_TASK, system: STRUCTURING_INSTRUCTIONS[STRUCTURING_RECONCILE_TASK], payload, schema: RECONCILE_SCHEMA }); } catch (error) {
    out.skipped.push({ groupId: null, reason: errorReason(error) });
    return out;
  }
  out.usage.inputTokens += Number.isFinite(response?.usage?.inputTokens) ? response.usage.inputTokens : 0;
  out.usage.outputTokens += Number.isFinite(response?.usage?.outputTokens) ? response.usage.outputTokens : 0;
  if (!response?.json || !Array.isArray(response.json.conflicts)) {
    out.skipped.push({ groupId: null, reason: 'malformed_response' });
    return out;
  }
  for (const candidate of response.json.conflicts) {
    const result = acceptModelConflict(candidate, sent);
    if (!result.group) { out.skipped.push({ groupId: result.groupId, reason: result.reason }); continue; }
    if (result.ungroundedSelection) out.skipped.push({ groupId: result.group.groupId, reason: 'ungrounded_selection' });
    let existing = conflicts.find(conflict => conflict.groupId === result.group.groupId);
    if (existing) { if (!existing.sources.includes('reconciler')) existing.sources.push('reconciler'); } else {
      existing = { groupId: result.group.groupId, target: result.group.target, subject: result.group.subject, kind: 'conflict', sources: ['reconciler'], reasonCode: 'reconciler_conflict', itemRefs: result.group.items.map(ref) };
      conflicts.push(existing);
    }
    // Auto-selection only for a deterministic contradiction of comparable readings in this group. A
    // model-only flag, context difference or a reading outside the contradiction stays unresolved.
    if (result.selectedQuote) {
      if (existing.kind === 'conflict' && existing.sources.includes('deterministic') && selectable(result.group.items, result.selectedQuote)) {
        existing.selectedQuote = result.selectedQuote;
      } else {
        out.skipped.push({ groupId: result.group.groupId, reason: 'selection_not_contradiction' });
      }
    }
  }
  return out;
}

const REASON_ORDER = ['model_observations_conflict', 'reconciler_conflict', 'context_differs', 'per_subject_values'];

// A key with differing readings is conflicting unless its only entry is a contradiction that carries a
// grounded model selection and nothing else differs (no context difference, no per-subject variation, no
// second entry). Then the selected reading is the value, still extracted_unverified, with reasonCode
// model_selected_from_conflict. The selected reading must be one the entry itself cites.
export function decideStates({ accepted = [], conflicts = [] } = {}) {
  const byKey = new Map();
  for (const item of accepted.filter(candidate => candidate.kind === 'registry')) {
    byKey.set(item.parameterKey, [...(byKey.get(item.parameterKey) ?? []), item]);
  }
  return [...byKey.keys()].sort().map(parameterKey => {
    const observations = byKey.get(parameterKey).map(item => ({ value: item.value, page: item.page, blockIndex: item.blockIndex, evidenceQuote: item.evidenceQuote }));
    const entries = conflicts.filter(conflict => conflict.target?.kind === 'registry' && conflict.target.key === parameterKey);
    const reasons = entries.map(conflict => conflict.reasonCode ?? (conflict.sources?.includes('deterministic') ? 'model_observations_conflict' : 'reconciler_conflict'));
    const conflictReason = observations.length >= 2 ? REASON_ORDER.find(reason => reasons.includes(reason)) : undefined;
    const [only] = entries;
    const cited = observation => Array.isArray(only?.itemRefs)
      && only.itemRefs.some(item => item.page === observation.page && item.blockIndex === observation.blockIndex);
    const selection = entries.length === 1 && kindOf(only) === 'conflict' && only.reasonCode === 'model_observations_conflict' && only.selectedQuote
      && observations.some(observation => observation.evidenceQuote === only.selectedQuote && cited(observation)) ? only.selectedQuote : null;
    const state = conflictReason && !selection ? 'conflicting' : 'extracted_unverified';
    if (!modelMayProduceResolutionState(state)) fail('STRUCTURING_AUTHORITY', 'Model may not produce this resolution state.');
    if (selection && observations.length >= 2) return { parameterKey, state, reasonCode: 'model_selected_from_conflict', selectedQuote: selection, observations };
    return { parameterKey, state, reasonCode: conflictReason ?? 'model_extracted_unverified', observations };
  });
}
