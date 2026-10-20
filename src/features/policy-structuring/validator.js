// Deterministic gate for model-extracted items. The output schema is built here field by field: nothing the
// model adds is copied, a quote must be a literal substring of the chunk text we sent, and the only state a
// kept registry item can carry is extracted_unverified (src/contracts/ai-authority.js).
import { modelMayProduceResolutionState } from '../../contracts/ai-authority.js';
import { getPolicyParameterRegistry } from '../coverage-analysis/policy-parameter-registry.js';

export const VALIDATOR_LIMITS = Object.freeze({ maxValueChars: 500, maxQuoteChars: 500, maxSubjectChars: 120, maxLabelChars: 120, maxRationaleChars: 300 });
export const PROPOSED_KEY_PATTERN = /^[a-z][a-z0-9_]{2,63}$/;
export const PROPOSED_CATEGORIES = Object.freeze(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'unassigned']);
const MODEL_STATES = new Set(['unknown', 'extracted_unverified', 'conflicting']);

function fail(code, message) { throw Object.assign(new Error(message), { code }); }

function registryOf(version) {
  try { return getPolicyParameterRegistry(version); } catch { return fail('STRUCTURING_INPUT_INVALID', 'Unknown registry version.'); }
}

// ---- value normalisation (never throws) ----

const NUMBER = /\d[\d,]*(?:\.\d+)?/g;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const numbersIn = text => text.match(NUMBER) ?? [];
const toNumber = raw => Number(raw.replace(/,/g, ''));
const clean = text => text.toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.;:]+$/, '');

function money(text) {
  let rest = clean(text).replace(/\/-/g, '').replace(/₹|\brs\b\.?|\binr\b/g, ' ');
  let per = null;
  rest = rest.replace(/\b(?:per|\/)\s*(day|month|year|annum|claim|event)\b/, (_, unit) => { per = unit === 'annum' ? 'year' : unit; return ' '; });
  rest = rest.replace(/\s+/g, ' ').trim();
  const match = /^(\d[\d,]*(?:\.\d+)?)\s*(lakhs?|lacs?|l|crores?|cr)?\.?$/.exec(rest);
  if (!match) return null;
  const unit = match[2] ?? '';
  const multiplier = unit.startsWith('l') ? 100_000 : unit.startsWith('c') ? 10_000_000 : 1;
  const amountMinor = Math.round(toNumber(match[1]) * multiplier * 100);
  if (!Number.isSafeInteger(amountMinor)) return null;
  return per ? { kind: 'money', amountMinor, currency: 'INR', per } : { kind: 'money', amountMinor, currency: 'INR' };
}

function duration(text) {
  const lower = clean(text);
  const hits = [...lower.matchAll(/(\d+(?:\.\d+)?)\s*\)?\s*(days?|months?|years?|yrs?)\b/g)];
  if (hits.length !== 1 || numbersIn(lower).length !== 1) return null;
  const unit = hits[0][2].startsWith('d') ? 'day' : hits[0][2].startsWith('m') ? 'month' : 'year';
  return { kind: 'duration', amount: Number(hits[0][1]), unit };
}

function isoDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return { kind: 'date', iso: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` };
}

function date(text) {
  const lower = clean(text);
  const found = [
    ...[...lower.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)].map(m => [m[0], Number(m[1]), Number(m[2]), Number(m[3])]),
    ...[...lower.matchAll(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/g)].map(m => [m[0], Number(m[3]), Number(m[2]), Number(m[1])]),
    ...[...lower.matchAll(/\b(\d{1,2})[\s-]([a-z]{3})[a-z]*\.?[\s-](\d{4})\b/g)].map(m => [m[0], Number(m[3]), MONTHS.indexOf(m[2]) + 1, Number(m[1])]),
  ];
  if (found.length !== 1 || /\d/.test(lower.replace(found[0][0], ''))) return null;
  const [, year, month, day] = found[0];
  return month ? isoDate(year, month, day) : null;
}

function percentage(text) {
  const lower = clean(text);
  const match = /(\d+(?:\.\d+)?)\s*(?:%|percent\b|per cent\b)/.exec(lower);
  if (!match || numbersIn(lower).length !== 1) return null;
  return { kind: 'percentage', percent: Number(match[1]) };
}

const BOOLEANS = new Map([
  ['yes', true], ['covered', true], ['opted', true], ['included', true], ['available', true],
  ['no', false], ['not covered', false], ['not opted', false], ['not included', false], ['not available', false],
]);
function boolean(text) {
  const value = BOOLEANS.get(clean(text).replace(/[^a-z ]/g, '').trim());
  return value === undefined ? null : { kind: 'boolean', value };
}

function number(text) {
  const lower = clean(text);
  const found = numbersIn(lower);
  if (found.length !== 1 || !/^[^\d]*\d[\d,]*(?:\.\d+)?[^\d]*$/.test(lower)) return null;
  const value = toNumber(found[0]);
  return Number.isFinite(value) ? { kind: 'number', value } : null;
}

const NORMALIZERS = Object.freeze({ money, duration, date, percentage, boolean, number });

export function normalizeValue(valueType, text) {
  if (typeof text !== 'string' || !Object.hasOwn(NORMALIZERS, valueType)) return null;
  try { return NORMALIZERS[valueType](text); } catch { return null; }
}

// Proposals carry no registry type, so the type is inferred from printed markers only.
export function inferValueType(text) {
  if (typeof text !== 'string') return null;
  const lower = text.toLowerCase();
  if (/₹|\brs\b\.?|\binr\b|\blakhs?\b|\blacs?\b|\bcrores?\b/.test(lower)) return 'money';
  if (/%|\bper ?cent\b/.test(lower)) return 'percentage';
  if (/\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[/-]\d{1,2}[/-]\d{4}\b|\b\d{1,2}[\s-][a-z]{3}[a-z]*\.?[\s-]\d{4}\b/.test(lower)) return 'date';
  if (/\d\s*\)?\s*(?:days?|months?|years?|yrs?)\b/.test(lower)) return 'duration';
  if (BOOLEANS.has(clean(lower).replace(/[^a-z ]/g, '').trim())) return 'boolean';
  return null;
}

const stable = value => (value && typeof value === 'object'
  ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
  : JSON.stringify(value));

export function comparisonKey(value) {
  if (value?.normalized != null) return stable(value.normalized);
  return String(value?.text ?? '').toLowerCase().replace(/[\s,]+/g, '');
}

// ---- item validation ----

const text = value => (typeof value === 'string' ? value.trim() : typeof value === 'number' && Number.isFinite(value) ? String(value) : '');
const present = value => value !== undefined && value !== null && value !== '';

function registryKeySet(registry) {
  const keys = new Set();
  for (const { key } of registry.parameters) { keys.add(key); keys.add(key.slice(key.indexOf('.') + 1)); }
  return keys;
}

// An empty proposed object ({proposed_key: "", ...}) is what a model sends for "no proposal"; it counts as absent.
const proposedFilled = proposed => !!proposed && typeof proposed === 'object' && !Array.isArray(proposed)
  ? Object.values(proposed).some(present)
  : present(proposed);

function checkRegistryKey(item, registry) {
  const definition = typeof item.registry_key === 'string' ? registry.parameters.find(entry => entry.key === item.registry_key) : null;
  if (!definition) return { reason: 'unknown_registry_key' };
  if (definition.modelExtraction?.allowed !== true) return { reason: 'model_extraction_not_permitted' };
  return { definition };
}

function checkProposed(proposed, reservedKeys) {
  if (!proposed || typeof proposed !== 'object' || Array.isArray(proposed)) return { reason: 'invalid_proposed_key' };
  const proposedKey = typeof proposed.proposed_key === 'string' ? proposed.proposed_key : '';
  if (!PROPOSED_KEY_PATTERN.test(proposedKey) || reservedKeys.has(proposedKey)) return { reason: 'invalid_proposed_key' };
  if (!PROPOSED_CATEGORIES.includes(proposed.category)) return { reason: 'invalid_category' };
  const label = text(proposed.label);
  if (!label || label.length > VALIDATOR_LIMITS.maxLabelChars) return { reason: 'label_invalid' };
  return { proposed: { proposedKey, category: proposed.category, label } };
}

// Exactly one target. When both are filled, a valid allowed registry key wins and the proposal is dropped (counted
// in the note); a forbidden or unknown registry key is never accepted, and a valid proposal then stands alone.
function checkTarget(item, registry, reservedKeys) {
  const hasKey = present(item.registry_key);
  const hasProposal = proposedFilled(item.proposed);
  if (!hasKey && !hasProposal) return { reason: 'ambiguous_target' };
  if (!hasProposal) return checkRegistryKey(item, registry);
  if (!hasKey) return checkProposed(item.proposed, reservedKeys);
  const registryTarget = checkRegistryKey(item, registry);
  if (registryTarget.definition) return { ...registryTarget, proposalDropped: true };
  const proposalTarget = checkProposed(item.proposed, reservedKeys);
  return proposalTarget.proposed ? proposalTarget : registryTarget;
}

// The value must be grounded in its own quote, not only the quote in the chunk: the value text appears in
// the quote (ignoring case, spaces and commas), or the quote normalises to the same value.
const squash = value => value.toLowerCase().replace(/[\s,]+/g, '');
function valueInQuote(valueText, normalized, valueType, quote) {
  if (squash(quote).includes(squash(valueText))) return true;
  return normalized != null && stable(normalizeValue(valueType, quote)) === stable(normalized);
}

const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function printedSubject(chunkText, subject) {
  if ((subject.match(/[\p{L}\p{N}]/gu) ?? []).length < 2) return false;
  const words = escapeRegExp(subject).replace(/\s+/g, '\\s+');
  return new RegExp(`(?<![\\p{L}\\p{N}])${words}(?![\\p{L}\\p{N}])`, 'iu').test(chunkText);
}

function checkItem(item, chunk, registry, reservedKeys) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return { reason: 'not_object' };
  if (present(item.state) && !(MODEL_STATES.has(item.state) && modelMayProduceResolutionState(item.state))) return { reason: 'authority_state' };
  const target = checkTarget(item, registry, reservedKeys);
  if (target.reason) return target;
  const valueText = text(item.value);
  if (!valueText) return { reason: 'value_missing' };
  if (valueText.length > VALIDATOR_LIMITS.maxValueChars) return { reason: 'value_too_long' };
  const subject = text(item.subject) || 'policy';
  if (subject.length > VALIDATOR_LIMITS.maxSubjectChars) return { reason: 'subject_too_long' };
  const quote = text(typeof item.evidence_quote === 'string' ? item.evidence_quote : '');
  if (!quote) return { reason: 'quote_missing' };
  if (quote.length > VALIDATOR_LIMITS.maxQuoteChars) return { reason: 'quote_too_long' };
  if (!chunk.text.includes(quote)) return { reason: 'quote_not_in_chunk' };
  if (item.page !== chunk.page) return { reason: 'page_mismatch' };
  if (!Number.isInteger(item.block_index) || !chunk.blockIndexes.includes(item.block_index)) return { reason: 'block_not_in_chunk' };
  // The model's confidence and rationale are review notes only; they never change state or storage.
  const note = {
    confidence: ['high', 'medium', 'low'].includes(item.confidence) ? item.confidence : null,
    rationale: text(item.rationale).slice(0, VALIDATOR_LIMITS.maxRationaleChars) || null,
    ...(target.proposalDropped ? { proposalDroppedRegistryMatch: true } : {}),
  };
  // A subject counts as named by the document only when it is printed in the chunk we sent, as whole words;
  // a model's own label ("Schedule", "Policy wording") or a fragment of a word ("a", "in") cannot turn a
  // contradiction into a per-subject variation.
  const subjectInSource = subject !== 'policy' && printedSubject(chunk.text, subject);
  const location = { evidenceQuote: quote, page: chunk.page, blockIndex: item.block_index, chunkId: chunk.id, subjectInSource, note };
  // A value not found in its own quote is a model paraphrase: the verbatim quote is stored instead, so
  // nothing printed is lost and no model wording is stored as a value.
  const typeOf = candidate => (target.definition ? target.definition.valueType : inferValueType(candidate));
  const grounded = valueInQuote(valueText, normalizeValue(typeOf(valueText), valueText), typeOf(valueText), quote);
  // Only a value printed verbatim inside its quote is stored as written; a value that merely normalises
  // equal (extra words around a duration, say) is stored as the quote, so no model wording is kept.
  const verbatim = grounded && quote.includes(valueText);
  const storedText = verbatim ? valueText : quote;
  note.valueSource = verbatim ? 'value' : 'quote';
  const valueType = typeOf(storedText);
  const normalized = normalizeValue(valueType, storedText);
  if (target.definition) {
    const parameterKey = target.definition.key;
    const state = 'extracted_unverified';
    if (!modelMayProduceResolutionState(state)) fail('STRUCTURING_AUTHORITY', 'Model may not produce this resolution state.');
    return { accepted: { kind: 'registry', parameterKey, valueType, value: { text: storedText, normalized, subject }, ...location, state } };
  }
  const { proposedKey, category, label } = target.proposed;
  return { proposal: { kind: 'proposed', proposedKey, category, label, value: { text: storedText, normalized, subject }, ...location } };
}

function checkChunk(chunk) {
  if (!chunk || typeof chunk !== 'object' || typeof chunk.id !== 'string' || typeof chunk.text !== 'string'
    || !Number.isInteger(chunk.page) || !Array.isArray(chunk.blockIndexes)) fail('STRUCTURING_INPUT_INVALID', 'A sectioned chunk is required.');
}

export function validateExtractedItems(rawItems, { chunk, registryVersion } = {}) {
  checkChunk(chunk);
  if (!Array.isArray(rawItems)) fail('STRUCTURING_INPUT_INVALID', 'Raw items must be an array.');
  const registry = registryOf(registryVersion);
  const reservedKeys = registryKeySet(registry);
  const out = { accepted: [], proposals: [], rejected: [] };
  for (const item of rawItems) {
    const result = checkItem(item, chunk, registry, reservedKeys);
    if (result.accepted) out.accepted.push(result.accepted);
    else if (result.proposal) out.proposals.push(result.proposal);
    else out.rejected.push({ reason: result.reason, chunkId: chunk.id });
  }
  return out;
}
