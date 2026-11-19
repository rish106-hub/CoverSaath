// Line guard for the policy.md prose pass (ADR 0039 D6). Pure: no model, DB or network. It reuses the answer-card guard's primitives
// (number_grounded, no_outcome_promise, no_advice, no_identifier_echo, contact_trusted) and adds "no new facts": a reworded sentence may use
// only the words of its own source sentence plus a short list of connecting words, keep every negation, and add no number.
// Code owns the label, quote and citation of a line (never sent to the model), so quote_exact holds by construction.
// Fails closed: any failed check fails the line, and the caller then serves the deterministic render.
import { ADVICE_PHRASES, OUTCOME_PROMISE_PHRASES, firstMatch } from './banned-phrases.js';
import { extractNumbers, isGrounded } from './number-normaliser.js';
import { containsContactValue } from './insurer-contact.js';
import { containsIdentifier } from './index.js';

export const PROSE_CHECK_IDS = Object.freeze({
  number: 'number_grounded',
  outcome: 'no_outcome_promise',
  advice: 'no_advice',
  identifier: 'no_identifier_echo',
  contact: 'contact_trusted',
  newFacts: 'no_new_facts',
  markup: 'no_markup',
  length: 'length',
});

export const PROSE_LINE_MAX = 400;

// Connecting words that carry no fact. Anything else must come from the source sentence. Negations are deliberately absent.
const FUNCTION_WORDS = new Set(`a an the this that these those it its is are was were be been being has have had do does did of for to in on at by with from as
  and or but if then than so per each any all your you yours our we they their them he she his her which who what when where how also about
  can may might will would shall should could up out over under into only just here there more most less least within after before during`.split(/\s+/).filter(Boolean));
// Dropping one of these from a sentence flips or hides its meaning; each one in the source must appear in the reworded sentence.
const NEGATIONS = ['not', 'no', 'never', 'nil', 'none', 'unknown', 'excluded', 'without', 'cannot', 'neither', 'nor'];

const squash = text => String(text ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const wordsOf = text => (squash(text).replace(/\{\{[A-Z_]+\d*\}\}/g, ' ').toLowerCase().match(/[\p{L}][\p{L}'-]*/gu) ?? []);
const stem = word => (word.length > 3 ? word.replace(/(ies)$/, 'y').replace(/(es|s|ed|ing|ly)$/, '') : word);

/** Failed check ids for one reworded sentence against its source sentence. [] means the line may be used. */
export function checkProseLine({ source, text }) {
  const failed = new Set();
  const out = squash(text);
  const original = squash(source);
  if (out.length === 0 || out.length > PROSE_LINE_MAX || /[\r\n]/.test(String(text))) failed.add(PROSE_CHECK_IDS.length);
  if (/[[\]"“”<>`]/.test(out)) failed.add(PROSE_CHECK_IDS.markup);

  const pool = extractNumbers(original);
  for (const number of extractNumbers(out)) if (!isGrounded(number, pool)) failed.add(PROSE_CHECK_IDS.number);

  if (firstMatch(OUTCOME_PROMISE_PHRASES, out)) failed.add(PROSE_CHECK_IDS.outcome);
  if (firstMatch(ADVICE_PHRASES, out)) failed.add(PROSE_CHECK_IDS.advice);
  if (containsIdentifier(out)) failed.add(PROSE_CHECK_IDS.identifier);
  if (containsContactValue(out)) failed.add(PROSE_CHECK_IDS.contact);

  // no new facts
  const sourceWords = new Set(wordsOf(original).map(stem));
  const outWords = wordsOf(out);
  for (const word of outWords) {
    if (FUNCTION_WORDS.has(word) || sourceWords.has(stem(word))) continue;
    failed.add(PROSE_CHECK_IDS.newFacts);
  }
  const outSet = new Set(outWords);
  for (const negation of NEGATIONS) {
    if (wordsOf(original).includes(negation) && !outSet.has(negation)) failed.add(PROSE_CHECK_IDS.newFacts);
    if (outSet.has(negation) && !wordsOf(original).includes(negation)) failed.add(PROSE_CHECK_IDS.newFacts);
  }
  return [...failed].sort();
}
