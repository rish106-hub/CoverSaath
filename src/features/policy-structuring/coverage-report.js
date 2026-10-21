// Counts-only coverage report: every chunk ends stored, proposed or skipped, and nothing from the document
// (chunk text, values, quotes, labels) is copied in. Chunk ids and page numbers are positional, not content.
// Accounting is not accuracy: a stored chunk can still miss facts, which only a golden comparison measures.
import { isConflict } from './reconciler.js';
import { inferValueType, normalizeValue } from './validator.js';

const tally = (list, pick) => Object.fromEntries(list.reduce((counts, entry) => {
  const key = pick(entry);
  counts.set(key, (counts.get(key) ?? 0) + 1);
  return counts;
}, new Map()));
const count = value => (Number.isFinite(value) ? value : 0);

function chunkOutcome(chunk, outcome, storedIds, proposedIds) {
  if (!outcome) return null;
  if (outcome.status === 'skipped') return { outcome: 'skipped', reason: outcome.reason };
  if (storedIds.has(chunk.id)) return { outcome: 'stored' };
  if (proposedIds.has(chunk.id)) return { outcome: 'proposed' };
  return { outcome: 'skipped', reason: outcome.reason ?? 'none_returned' };
}

function commitCounts(commit) {
  if (!commit || typeof commit !== 'object') return null;
  const fields = ['observations', 'parameters', 'conflicting', 'skippedKeys', 'proposals'];
  return { replayed: commit.replayed === true, ...Object.fromEntries(fields.map(field => [field, Array.isArray(commit[field]) ? commit[field].length : count(commit[field])])) };
}

export function buildCoverageReport({ sectioned, extraction, reconciliation, commit = null } = {}) {
  const chunks = sectioned?.chunks ?? [];
  const accepted = extraction?.accepted ?? [];
  const proposals = extraction?.proposals ?? [];
  const rejected = extraction?.rejected ?? [];
  const outcomes = extraction?.chunkOutcomes ?? {};
  const storedIds = new Set(accepted.map(item => item.chunkId));
  const proposedIds = new Set(proposals.map(item => item.chunkId));
  const perChunk = [];
  let unaccounted = 0;
  for (const chunk of chunks) {
    const result = chunkOutcome(chunk, Object.hasOwn(outcomes, chunk.id) ? outcomes[chunk.id] : null, storedIds, proposedIds);
    if (!result) { unaccounted += 1; continue; }
    perChunk.push({ id: chunk.id, page: chunk.page, ...result });
  }
  const all = reconciliation?.conflicts ?? [];
  const conflicts = all.filter(isConflict);
  const variations = all.filter(entry => (entry.kind ?? (entry.reasonCode === 'per_subject_values' ? 'variation' : null)) === 'variation');
  const context = all.filter(entry => !isConflict(entry) && !variations.includes(entry));
  const skipped = perChunk.filter(entry => entry.outcome === 'skipped');
  return {
    chunks: {
      total: chunks.length,
      stored: perChunk.filter(entry => entry.outcome === 'stored').length,
      proposed: perChunk.filter(entry => entry.outcome === 'proposed').length,
      skipped: skipped.length,
      unaccounted,
    },
    skippedReasons: tally(skipped, entry => entry.reason),
    dropped: tally(sectioned?.dropped ?? [], entry => entry.reason),
    items: { accepted: accepted.length, proposals: proposals.length, rejected: rejected.length, rejectedReasons: tally(rejected, entry => entry.reason) },
    conflicts: {
      total: conflicts.length,
      deterministic: conflicts.filter(conflict => conflict.sources?.includes('deterministic')).length,
      reconciler: conflicts.filter(conflict => conflict.sources?.includes('reconciler')).length,
    },
    variations: { perSubject: variations.length, context: context.length },
    modelSelections: all.filter(entry => entry.selectedQuote).length,
    calls: count(extraction?.calls) + count(reconciliation?.calls),
    usage: {
      inputTokens: count(extraction?.usage?.inputTokens) + count(reconciliation?.usage?.inputTokens),
      outputTokens: count(extraction?.usage?.outputTokens) + count(reconciliation?.usage?.outputTokens),
    },
    perChunk,
    ...(commit ? { commit: commitCounts(commit) } : {}),
  };
}

// Eval metrics against a golden file. result: { extraction, reconciliation }.
export function scoreStructuring(golden, result) {
  const expectedKeys = golden?.structuring?.expectedKeys ?? [];
  const expectedConflicts = golden?.structuring?.expectedConflicts ?? [];
  const accepted = result?.extraction?.accepted ?? [];
  const rejected = result?.extraction?.rejected ?? [];
  const conflicts = (result?.reconciliation?.conflicts ?? []).filter(isConflict);
  const found = expected => accepted.some(item => item.parameterKey === expected.key && (expected.page == null || item.page === expected.page));
  const missingKeys = expectedKeys.filter(expected => !found(expected)).map(expected => expected.key);
  const foundConflicts = expectedConflicts.filter(expected => conflicts.some(conflict => conflict.target?.kind === 'registry' && conflict.target.key === expected.key)).map(expected => expected.id);
  const rawItems = result?.extraction?.rawItems ?? accepted.length + (result?.extraction?.proposals ?? []).length + rejected.length;
  return {
    keyRecall: expectedKeys.length ? (expectedKeys.length - missingKeys.length) / expectedKeys.length : null,
    hallucinationRate: rawItems ? rejected.filter(entry => entry.reason === 'quote_not_in_chunk').length / rawItems : 0,
    conflictRecall: expectedConflicts.length ? foundConflicts.length / expectedConflicts.length : null,
    missingKeys,
    foundConflicts,
  };
}

// Owner-verified critical fields (eval golden `fields`) mapped to registry keys. Keys whose registry entry
// forbids model extraction (identifiers, named members) are expected to stay unknown in structuring.
export const CRITICAL_FIELD_KEYS = Object.freeze({
  insurer: 'a.insurer_tpa_group_administrator',
  plan_name: 'a.product_uin_and_version',
  policy_number: 'a.contract_and_member_identifiers',
  policy_type: 'a.policy_type',
  policyholder_name: 'c.named_insured_members',
  insured_members: 'c.named_insured_members',
  policy_period_start: 'b.policy_period',
  policy_period_end: 'b.policy_period',
  base_sum_insured: 'd.sum_insured',
  total_premium: 'i.premium_now',
  room_rent_limit: 'd.room_rent_limit',
  icu_limit: 'd.icu_charge_limit',
  co_payment: 'd.co_pay_general',
  initial_waiting_period: 'f.initial_waiting_period',
  specified_disease_waiting_period: 'f.specified_disease_procedure_waits',
  ped_waiting_period: 'f.ped_waiting_period',
  add_ons_opted: 'a.add_ons_and_riders',
  exclusions_present: 'f.standard_exclusions_with_codes',
});

const PLAIN_NUMBER = /^\s*\d[\d,]*(?:\.\d+)?\s*$/;
const DATE_FRAGMENT = /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[/-]\d{1,2}[/-]\d{4}\b|\b\d{1,2}[\s-][a-z]{3}[a-z]*\.?[\s-]\d{4}\b/gi;
const DURATION_FRAGMENT = /\d+(?:\.\d+)?\s*\)?\s*(?:days?|months?|years?|yrs?)\b/gi;
const tokens = text => String(text ?? '').normalize('NFKC').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

// Golden type from printed markers (validator inferValueType); a bare number is `number`, anything else text.
function goldenType(value) {
  return inferValueType(value) ?? (PLAIN_NUMBER.test(value) ? 'number' : 'text');
}

// Typed readings: the stored normalised value when its kind matches, else the reading text normalised by
// the same validator rules. A period prints two dates, so each printed date is also a candidate.
function typedReadings(type, reading) {
  const out = [];
  if (reading?.normalized?.kind === type) out.push(reading.normalized);
  const text = String(reading?.value ?? '');
  const whole = normalizeValue(type, text);
  if (whole) out.push(whole);
  if (type === 'date') for (const [fragment] of text.matchAll(DATE_FRAGMENT)) out.push(normalizeValue('date', fragment));
  // A clause value ("... Code-Excl03: 30 days ...") holds the figure inside prose. A fragment counts only when
  // it is the single duration printed; several durations are ambiguous and never match.
  if (type === 'duration') {
    const fragments = [...text.matchAll(DURATION_FRAGMENT)];
    if (fragments.length === 1) out.push(normalizeValue('duration', fragments[0][0]));
  }
  return out.filter(Boolean);
}

// Exact equality per type. Durations need the same unit: 36 months is not 3 years (no 30/365-day conversion).
function sameTyped(golden, read) {
  switch (golden.kind) {
    case 'money': return read.amountMinor === golden.amountMinor && (golden.per == null || read.per === golden.per);
    case 'percentage': return read.percent === golden.percent;
    case 'date': return read.iso === golden.iso;
    case 'duration': return read.amount === golden.amount && read.unit === golden.unit;
    case 'boolean':
    case 'number': return read.value === golden.value;
    default: return false;
  }
}

// Text: the golden tokens appear as a contiguous run of whole reading tokens, never a raw substring.
function textMatches(golden, reading) {
  const want = tokens(golden);
  const have = tokens(reading?.value);
  if (!want.length) return false;
  for (let i = 0; i + want.length <= have.length; i += 1) if (want.every((token, j) => have[i + j] === token)) return true;
  return false;
}

// A reading matches a golden value by type: money, percentage, date, duration, boolean and number compare
// normalised values exactly; a typed golden with an unparseable reading never matches. Arrays need every element.
export function readingMatches(expected, reading) {
  const values = Array.isArray(expected) ? expected : [expected];
  return values.every(value => {
    if (typeof value !== 'string' && typeof value !== 'number') return false;
    const printed = String(value);
    const type = goldenType(printed);
    if (type === 'text') return textMatches(printed, reading);
    const golden = normalizeValue(type, printed);
    return golden != null && typedReadings(type, reading).some(read => sameTyped(golden, read));
  });
}

/**
 * Critical-field outcome per owner-verified golden field, for one review result (the structuring GET body):
 * correct | correct_unknown | conflicting_with_correct | conflicting_without_correct | wrong | missed | unknown_by_design.
 * `wrong` is a value presented as extracted that does not match; it is the outcome that blocks acceptance.
 */
export function scoreCriticalFields(goldenFields, review, { modelForbiddenKeys = [] } = {}) {
  const byKey = new Map((review?.parameters ?? []).map(parameter => [parameter.key, parameter]));
  const forbidden = new Set(modelForbiddenKeys);
  const fieldMap = new Map();
  for (const [field, expected] of Object.entries(goldenFields ?? {})) {
    const key = CRITICAL_FIELD_KEYS[field];
    if (!key) continue;
    const parameter = byKey.get(key);
    const readings = parameter?.readings ?? [];
    let outcome;
    const expectsUnknown = String(expected?.value ?? '').trim().toLowerCase() === 'unknown';
    if (!readings.length) outcome = expectsUnknown ? 'correct_unknown' : forbidden.has(key) ? 'unknown_by_design' : 'missed';
    else if (expectsUnknown) outcome = 'wrong';
    else if (parameter.state === 'conflicting') outcome = readings.some(reading => readingMatches(expected.value, reading)) ? 'conflicting_with_correct' : 'conflicting_without_correct';
    else {
      const asserted = readings.find(reading => reading.selected) ?? readings.at(-1);
      outcome = readingMatches(expected.value, asserted) ? 'correct' : 'wrong';
    }
    fieldMap.set(field, { key, outcome, state: parameter?.state ?? 'unknown', readings: readings.length });
  }
  const fields = Object.fromEntries(fieldMap);
  return { fields, totals: tally([...fieldMap.values()], entry => entry.outcome) };
}
