import { createHash } from 'node:crypto';
import { ANSWER_CARD_CONTRACT, ANSWER_CARD_LIMITS, ANSWER_CARD_SOURCE_STATUSES, ANSWER_CARD_SOURCE_TIERS } from '../../contracts/answer-card.js';
import { guardAnswerCard } from '../../features/chat-answer-guard/index.js';

// Chat v1 turn -> answer-card/v1 (architecture v1 section 4, PR 138). Deterministic: the card is assembled by code from what
// the turn already holds (answer text, the clause window or passage the answer rests on, the facts used with their quote) and is
// released ONLY through guardAnswerCard. Nothing is streamed or stored before the guard runs. A dropped card becomes the fixed
// "documents don't say" card, and its text replaces the turn text everywhere (fail closed). Copy is pending legal review.
//
// Evidence for the guard is the exact text each source points at: the clause window, the passage text, or a fact's verbatim quote
// plus its formatted value. Numbers in the headline and explanation must be found there (C3), quotes must be exact (C2), and the
// guard's phrase, identifier and contact checks run over every text in the card.

const sha = value => createHash('sha256').update(value, 'utf8').digest('hex');
const squash = text => String(text ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const tierOf = value => (ANSWER_CARD_SOURCE_TIERS.includes(value) ? value : 'own_pdf');
const statusOf = value => (ANSWER_CARD_SOURCE_STATUSES.includes(value) ? value : 'extracted_unverified');

/** A quote the guard can match exactly: the start of the evidence text, cut at a word boundary within the quote limit. */
export function quoteFrom(text, limit = ANSWER_CARD_LIMITS.quote) {
  const clean = squash(text);
  if (clean.length <= limit) return clean;
  const cut = clean.slice(0, limit);
  const space = cut.lastIndexOf(' ');
  return (space > limit / 2 ? cut.slice(0, space) : cut).trim();
}

/** Headline = the first sentence (or the start of it), explanation = what follows, both within the card limits. */
export function splitAnswerText(text) {
  const clean = squash(text);
  const end = clean.search(/[.!?](\s|$)/);
  let headline = end > 0 && end < ANSWER_CARD_LIMITS.headline ? clean.slice(0, end + 1) : clean.slice(0, ANSWER_CARD_LIMITS.headline);
  if (headline.length === ANSWER_CARD_LIMITS.headline && clean.length > headline.length) {
    const space = headline.lastIndexOf(' ', ANSWER_CARD_LIMITS.headline - 4);
    headline = `${headline.slice(0, space > 20 ? space : ANSWER_CARD_LIMITS.headline - 4).trim()}...`;
    return { headline, explanation: quoteFrom(clean, ANSWER_CARD_LIMITS.explanation) };
  }
  return { headline: headline || "Your documents don't say.", explanation: quoteFrom(clean.slice(headline.length), ANSWER_CARD_LIMITS.explanation) };
}

/**
 * Builds the card draft and the guard's evidence map from a finished turn.
 *   wording:   [{ documentId, page, ref, text, tier }]  the clause window or passage text the answer rests on
 *   facts:     [{ factId, factKey, status, tier, documentId, page, quote, valueText }]
 */
export function buildTurnCardDraft({ status, text, wording = [], facts = [] }) {
  const evidence = {};
  const sources = [];
  for (const item of wording) {
    if (sources.length >= ANSWER_CARD_LIMITS.sources || !squash(item.text)) continue;
    const id = `w-${sha(`${item.documentId}|${item.page}|${item.ref}`).slice(0, 16)}`;
    if (evidence[id]) continue;
    evidence[id] = { text: item.text, values: [], factIds: [] };
    sources.push({ id, factIds: [], tier: tierOf(item.tier), status: 'extracted_unverified', page: item.page ?? null, clause: null, quote: quoteFrom(item.text) });
  }
  for (const fact of facts) {
    if (sources.length >= ANSWER_CARD_LIMITS.sources) break;
    const evidenceText = [fact.quote, fact.valueText].filter(Boolean).join(' ');
    if (!squash(evidenceText)) continue;
    const id = `f-${sha(String(fact.factId)).slice(0, 16)}`;
    if (evidence[id]) continue;
    evidence[id] = { text: evidenceText, values: [], factIds: [String(fact.factId)] };
    sources.push({ id, factIds: [String(fact.factId)], tier: tierOf(fact.tier), status: statusOf(fact.status), page: fact.page ?? null, clause: null, quote: quoteFrom(fact.quote || fact.valueText) });
  }
  const found = status === 'evidence_found' && sources.length > 0;
  const { headline, explanation } = splitAnswerText(text);
  const card = {
    contract: ANSWER_CARD_CONTRACT,
    status: found ? 'evidence_found' : 'unknown',
    // Chat has no rule result per question, so the card never claims covered / not covered: the wording is shown with its sources.
    verdict: 'unknown',
    ruleResultId: null,
    headline,
    explanation,
    conditions: [],
    sources: found ? sources : [],
    gaps: [],
    actions: found ? [] : [{ kind: 'call_insurer', label: 'Call the number on your policy card' }],
    followups: [],
    speech: null,
    answer: String(text ?? ""),
    legalReview: 'pending',
  };
  return { card, evidence: found ? evidence : {} };
}

/** Builds, guards and returns { card, released, failedChecks }. `card` is always a guard-released card (never the raw draft). */
export function guardTurnAnswer(turn) {
  const { card, evidence } = buildTurnCardDraft(turn);
  const result = guardAnswerCard({ card, evidence, ruleResults: {}, mode: 'text' });
  return { card: result.card, released: result.released, failedChecks: result.released ? [] : result.failedChecks };
}
