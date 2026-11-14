// Deterministic output guard for answer-card/v1 (arch A section 4.1, arch B G1-G6). Pure: no model, DB or network.
// Fails closed: any failed check releases the fixed "documents don't say" card and no model text.
import { ANSWER_CARD_CONTRACT, ANSWER_CARD_LIMITS, validateAnswerCardShape } from '../../contracts/answer-card.js';
import { ADVICE_PHRASES, OUTCOME_PROMISE_PHRASES, firstMatch } from './banned-phrases.js';
import { extractNumbers, isGrounded, toCanonicalValues } from './number-normaliser.js';
import { containsContactValue, isValidContact } from './insurer-contact.js';
export { CONTACT_PURPOSES, containsContactValue, isValidContact, pickInsurerContact } from './insurer-contact.js';

export const GUARD_CHECK_IDS = Object.freeze({
  shape: 'card_shape',
  citation: 'citation_present',
  quote: 'quote_exact',
  number: 'number_grounded',
  verdict: 'verdict_rule_backed',
  outcome: 'no_outcome_promise',
  advice: 'no_advice',
  identifier: 'no_identifier_echo',
  speech: 'speech_template',
  contact: 'contact_trusted',
  inputs: 'verdict_inputs_verified', // downgrade, not drop
});
const RETRYABLE = new Set([GUARD_CHECK_IDS.citation, GUARD_CHECK_IDS.quote, GUARD_CHECK_IDS.number]);
const NO_RULE_VERDICTS = new Set(['unknown', 'depends']);

const squash = (text) => String(text ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();

const VERDICT_PHRASES = Object.freeze({
  covered: 'Your policy says: covered',
  not_covered: 'Your policy says: not covered',
  partly_covered: 'Your policy says: partly covered',
  depends: 'Your policy says: it depends',
  unknown: "Your documents don't say",
});
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatRupees(minor) {
  const s = String(Math.floor(minor / 100));
  const grouped = s.length > 3 ? `${s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${s.slice(-3)}` : s;
  return `Rs ${grouped}`;
}

function formatIsoDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? '');
  return m && MONTH_NAMES[+m[2] - 1] ? `${+m[3]} ${MONTH_NAMES[+m[2] - 1]} ${m[1]}` : null;
}

// C8 template. Verdict phrase plus at most one amount or date taken from the first condition that carries one. Never model text.
export function speechFromHeadline(card) {
  const phrase = VERDICT_PHRASES[card?.verdict] ?? VERDICT_PHRASES.unknown;
  const conditions = Array.isArray(card?.conditions) ? card.conditions : [];
  const withAmount = conditions.find((c) => Number.isInteger(c?.amountMinor) && c.amountMinor > 0);
  if (withAmount) return `${phrase}, up to ${formatRupees(withAmount.amountMinor)}.`;
  const dated = conditions.map((c) => formatIsoDate(c?.endsOn)).find(Boolean);
  if (dated) return `${phrase}, from ${dated}.`;
  return `${phrase}.`;
}

// All copy here is pending legal review. `contact` is a trusted contact (pickInsurerContact); without one the card points to
// the number printed on the user's own policy documents instead of naming one.
export function unknownCard({ contact = null } = {}) {
  const headline = "Your documents don't say.";
  const explanation = 'Please check with your insurer.';
  return {
    contract: ANSWER_CARD_CONTRACT,
    status: 'unknown',
    verdict: 'unknown',
    ruleResultId: null,
    headline,
    explanation,
    conditions: [],
    sources: [],
    gaps: [],
    actions: [isValidContact(contact)
      ? { kind: 'call_insurer', label: 'Call your insurer', contactId: contact.id, contact: { kind: contact.kind, value: contact.value } }
      : { kind: 'call_insurer', label: 'Call the number on your policy card' }],
    followups: [],
    speech: { lang: 'en', text: headline },
    answer: `${headline} ${explanation}`,
    legalReview: 'pending',
  };
}

function luhn(digits) {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

// C7 / G6: identifiers must never be echoed.
export function containsIdentifier(text) {
  const t = String(text ?? '').normalize('NFKC');
  if (/(?<!\d[\s-]?)\d{4}[\s-]?\d{4}[\s-]?\d{4}(?![\s-]?\d)/.test(t)) return true; // Aadhaar-like, 12 digits
  if (/(?<![A-Za-z0-9])[A-Z]{5}[0-9]{4}[A-Z](?![A-Za-z0-9])/.test(t)) return true; // PAN
  for (const m of t.matchAll(/(?<![\d])\d(?:[\s-]?\d){12,18}(?![\d])/g)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return true; // card number
  }
  if (/\b(?:otp|code)\b\D{0,20}(?<![\d])\d{6}(?![\d])|(?<![\d])\d{6}(?![\d])\D{0,20}\b(?:otp|code)\b/i.test(t)) return true;
  return false;
}

function cardTexts(card) {
  const texts = [card.headline, card.explanation, card.answer, card.speech?.text];
  for (const c of card.conditions ?? []) texts.push(c.text);
  for (const s of card.sources ?? []) texts.push(s.quote);
  for (const a of card.actions ?? []) texts.push(a.label);
  for (const f of card.followups ?? []) texts.push(f);
  return texts.filter((t) => typeof t === 'string');
}

function ruleValues(ruleResults, id) {
  const entry = id != null && Object.hasOwn(ruleResults ?? {}, id) ? ruleResults[id] : null;
  return entry ? toCanonicalValues(entry.values) : [];
}

function sourceValues(evidence, id) {
  const entry = evidence[id];
  return [...toCanonicalValues(entry.values), ...extractNumbers(entry.text)];
}

function structuredNumbers(condition) {
  const out = [];
  if (Number.isInteger(condition.amountMinor)) out.push({ kind: 'money', value: condition.amountMinor });
  if (Number.isInteger(condition.days)) out.push({ kind: 'duration_days', value: condition.days });
  if (typeof condition.endsOn === 'string') out.push({ kind: 'date', value: condition.endsOn });
  return out;
}

function runChecks(card, evidence, ruleResults, mode, contacts) {
  const failed = new Set();
  const conditions = card.conditions ?? [];
  const sources = card.sources ?? [];
  const exists = (id) => Boolean(evidence && Object.hasOwn(evidence, id));

  // C1 citation_present: headline (via card sources), every condition, any non-unknown verdict.
  const cardCited = sources.length > 0 && sources.every((s) => exists(s.id));
  if ((card.status === 'evidence_found' || card.verdict !== 'unknown') && !cardCited) failed.add(GUARD_CHECK_IDS.citation);
  for (const c of conditions) if (c.sourceIds.length === 0 || !c.sourceIds.every(exists)) failed.add(GUARD_CHECK_IDS.citation);

  // C2 quote_exact
  for (const s of sources) {
    const quote = squash(s.quote);
    const text = exists(s.id) ? squash(evidence[s.id].text) : null;
    if (quote.length === 0 || quote.length > ANSWER_CARD_LIMITS.quote || text === null || !text.includes(quote)) failed.add(GUARD_CHECK_IDS.quote);
  }

  // C3 number_grounded
  const cardRuleValues = ruleValues(ruleResults, card.ruleResultId);
  const cardPool = [...cardRuleValues, ...sources.flatMap((s) => (exists(s.id) ? sourceValues(evidence, s.id) : []))];
  for (const n of [...extractNumbers(card.headline), ...extractNumbers(card.explanation)]) if (!isGrounded(n, cardPool)) failed.add(GUARD_CHECK_IDS.number);
  for (const c of conditions) {
    const pool = [...cardRuleValues, ...ruleValues(ruleResults, c.ruleResultId), ...c.sourceIds.flatMap((id) => (exists(id) ? sourceValues(evidence, id) : []))];
    for (const n of [...extractNumbers(c.text), ...structuredNumbers(c)]) if (!isGrounded(n, pool)) failed.add(GUARD_CHECK_IDS.number);
  }

  // C4 verdict_rule_backed
  const rule = card.ruleResultId != null && Object.hasOwn(ruleResults ?? {}, card.ruleResultId) ? ruleResults[card.ruleResultId] : null;
  if (!NO_RULE_VERDICTS.has(card.verdict) && !rule) failed.add(GUARD_CHECK_IDS.verdict);
  if (rule && rule.verdict != null && rule.verdict !== card.verdict) failed.add(GUARD_CHECK_IDS.verdict);

  // C5 / C6 / C7
  const texts = cardTexts(card);
  if (texts.some((t) => firstMatch(OUTCOME_PROMISE_PHRASES, t))) failed.add(GUARD_CHECK_IDS.outcome);
  if (texts.some((t) => firstMatch(ADVICE_PHRASES, t))) failed.add(GUARD_CHECK_IDS.advice);
  if (texts.some(containsIdentifier)) failed.add(GUARD_CHECK_IDS.identifier);

  // C10 contact_trusted: no contact value in any text; every contactId must be a trusted contact passed by the caller.
  if (texts.some(containsContactValue)) failed.add(GUARD_CHECK_IDS.contact);
  if ((card.actions ?? []).some((a) => a.contact != null)) failed.add(GUARD_CHECK_IDS.contact); // drafts reference, never carry
  for (const a of card.actions ?? []) if (a.contactId != null && !isValidContact(contacts?.[a.contactId])) failed.add(GUARD_CHECK_IDS.contact);

  // C8 speech_template: present speech must equal the template; voice mode requires it.
  if (card.speech != null ? card.speech.text !== speechFromHeadline(card) : mode === 'voice') failed.add(GUARD_CHECK_IDS.speech);
  return [...failed];
}

const VERIFIED_STATUSES = new Set(['user_confirmed', 'reviewed_reference']);
const COVERAGE_VERDICTS = new Set(['covered', 'not_covered', 'partly_covered']);

// C9 verdict_inputs_verified (B5). Not a drop: a coverage verdict built on an unverified fact is downgraded to `depends` and the
// card asks the user to confirm that fact. Fails closed: a rule result with a missing or empty `inputs` array is downgraded too (no factId, so no action).
function downgradeIfUnverified(card, ruleResults) {
  if (!COVERAGE_VERDICTS.has(card.verdict)) return { card, downgradedFactIds: [] };
  const inputs = ruleResults?.[card.ruleResultId]?.inputs;
  const list = Array.isArray(inputs) ? inputs : [];
  const unverified = list.filter((i) => !VERIFIED_STATUSES.has(i?.status));
  if (list.length > 0 && unverified.length === 0) return { card, downgradedFactIds: [] };
  const downgradedFactIds = [...new Set(unverified.map((i) => i?.factId).filter((id) => typeof id === 'string' && id.length > 0))];
  const next = { ...card, verdict: 'depends' };
  if (downgradedFactIds.length > 0) {
    next.actions = [
      { kind: 'answer_question', label: 'Is this right?', factId: downgradedFactIds[0] },
      ...(card.actions ?? []).filter((a) => a.kind !== 'answer_question' || a.factId !== downgradedFactIds[0]),
    ].slice(0, ANSWER_CARD_LIMITS.actions);
  }
  if (card.speech != null) next.speech = { ...card.speech, text: speechFromHeadline(next) };
  return { card: next, downgradedFactIds };
}

const RELEASED = new WeakSet();
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); Object.values(value).forEach(deepFreeze); }
  return value;
}
// guardAnswerCard is the ONLY producer of a releasable card (B2). Callers must emit only `result.card`, never a draft headline
// or model text before this runs; transports check isReleasedCard(card) before writing an `answer` event.
export function isReleasedCard(card) {
  return RELEASED.has(card);
}

// Attach the trusted value to each referenced contact. Runs only after C10 passed, so every id resolves.
function resolveContacts(card, contacts) {
  if (!(card.actions ?? []).some((a) => a.contactId != null)) return card;
  return {
    ...card,
    actions: card.actions.map((a) => {
      if (a.contactId == null) return a;
      const c = contacts[a.contactId];
      return { ...a, contact: { kind: c.kind, value: c.value } };
    }),
  };
}

// contacts: { [contactId]: { id, kind, value, purpose } } from FSS for the insurer of this policy. fallbackContactId names the
// contact the dropped card should offer (pickInsurerContact); an unknown or invalid id gives the policy-card wording instead.
export function guardAnswerCard({ card, evidence = {}, ruleResults = {}, mode = 'text', contacts = {}, fallbackContactId = null } = {}) {
  const shape = validateAnswerCardShape(card);
  const failedChecks = (shape.valid ? runChecks(card, evidence, ruleResults, mode, contacts) : [GUARD_CHECK_IDS.shape]).sort();
  if (failedChecks.length === 0) {
    const { card: downgraded, downgradedFactIds } = downgradeIfUnverified(structuredClone(card), ruleResults);
    const next = resolveContacts(downgraded, contacts);
    const verdictChanged = next.verdict !== card.verdict;
    deepFreeze(next);
    RELEASED.add(next);
    return { released: true, card: next, downgraded: verdictChanged, downgradedFactIds };
  }
  const retryable = mode === 'text' && failedChecks.every((id) => RETRYABLE.has(id));
  const fallback = fallbackContactId != null && Object.hasOwn(contacts ?? {}, fallbackContactId) ? contacts[fallbackContactId] : null;
  const dropped = deepFreeze(unknownCard({ contact: fallback }));
  RELEASED.add(dropped);
  return { released: false, card: dropped, failedChecks, retryable };
}
