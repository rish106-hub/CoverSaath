// Deterministic clause answer for chat (no model, no provider). Given a question and candidate wording clauses it picks the best
// sentence window, or says nothing when no clause carries the question's content terms. Retrieval aid only: it never states
// eligibility or money; the text it returns is verbatim wording from a clause. Wording of the fixed sentences is DRAFT, FOR LEGAL REVIEW.

export const NOT_IN_DOCUMENTS_TEXT = 'The policy documents you uploaded do not say anything about this, so I cannot answer it from them. Please check with your insurer.';
export const MAX_WINDOW_CHARS = 280;
const RELEVANCE_FLOOR = 0.5;

// Words that name nothing in a policy (question frame, generic insurance talk). Not content terms.
const STOPWORDS = new Set(`a an and are as at be been being by can could do does did for from has have had how i if in is it its me my of on or our
policy policies plan that the their there this to was were what when where which who whom will with would you your am any get give gets
cover covered covers coverage covering limit limits amount much many applicable apply applies applied charge charges above below
about under over per each every other tell say says said mean means please also than then these those them they some such so not no yes
include included includes insurer insurance claim claims eligible eligibility allowed allow
pay pays paid whole long fast take must before after rupee rupees rs percentage percent spend define defined defines definition number total full
earn earns want know need needs like happen happens
`.split(/\s+/).filter(Boolean));

// Frame words that appear in most policies: they never decide relevance alone. A question needs its specific (other) terms to match.
const WEAK = new Set(['wait', 'period', 'treatment', 'year', 'day', 'month', 'week', 'hour', 'last', 'time', 'benefit', 'expense', 'cost', 'procedure', 'condition', 'paid', 'much']);

// Insurance vocabulary folded to one canonical token on both the question and the clause text. Generic domain terms, not tied to one policy.
const CANON = Object.freeze([
  [/\bpre[-\s]?hospitali[sz]ation\b/g, 'prehospitalisation'],
  [/\bpost[-\s]?hospitali[sz]ation\b/g, 'posthospitalisation'],
  [/\bco[-\s]?pay(?:ment)?s?\b/g, 'copayment'],
  [/\bpre[-\s]?existing(?:\s+(?:diseases?|conditions?|illness(?:es)?))?\b|\bpeds?\b/g, 'preexisting'],
  [/\broom\s+(?:rent|charges?|tariff|cap|limit)s?\b/g, 'roomrent'],
  [/\bcosmetic\b|\baesthetic\b|\bplastic\b/g, 'cosmetic'],
  [/\bhospitali[sz]ations?\b|\bhospitali[sz]ed\b/g, 'hospitalisation'],
  [/\bcheck[-\s]?ups?\b|\bhealth\s+check\b/g, 'checkup'],
  [/\broom\b/g, 'roomrent'],
  [/\bdoctors?\s+visits?\b|\bconsult\w*/g, 'consultation'],
  [/\bsubmi(?:t|ts|tted|ssion|ssions)\b/g, 'submit'],
  [/\bcancel\w*/g, 'cancellation'],
  [/\bday[-\s]?care\b/g, 'daycare'],
  [/\bnon[-\s]?medical\b|\bconsumables?\b/g, 'nonmedical'],
  [/\bintensive\s+care\b|\bicu\b/g, 'icu'],
  [/\bsum\s+insured\b|\bcover(?:age)?\s+amount\b/g, 'suminsured'],
  [/\bayush\b|\bayurved\w*|\bhomeopath\w*|\bunani\b/g, 'ayush'],
  [/\bweight[-\s]?loss\b|\bbariatric\b|\bobesity\b/g, 'weightloss'],
  [/\beyesight\b|\brefractive\b|\blasik\b|\bspectacles?\b/g, 'eyesight'],
  [/\bmaternity\b|\bchildbirth\b|\bdelivery\b|\bpregnan\w*/g, 'maternity'],
  [/\binfertil\w*|\bivf\b|\bassisted\s+reproduction\b/g, 'infertility'],
  [/\bdental\b|\bteeth\b|\btooth\b/g, 'dental'],
  [/\boutpatient\b|\bopd\b/g, 'outpatient'],
  [/\bself[-\s]?(?:inflicted|harm)\b|\bsuicid\w*/g, 'selfharm'],
  [/\bnuclear\b|\bwar\b/g, 'war'],
  [/\bexpire[sd]?\b|\bexpiry\b|\bend\s+date\b|\bvalid\s+until\b/g, 'policyend'],
  [/\bintimat\w*|\binform\b/g, 'notify'],
  [/\bnotif\w*/g, 'notify'],
  [/\bcumulative\s+bonus\b|\bno[-\s]?claim\s+bonus\b|\bncb\b|\bclaim[-\s]?free\b/g, 'bonus'],
  [/\bre-?store\w*|\brecharge\b|\breinstat\w*|\breload\b/g, 'restoration'],
  [/\bsub[-\s]?limits?\b/g, 'sublimit'],
]);

// Surface words added to the retrieval query so a clause that prints the other word is still a candidate.
const EXPANSIONS = Object.freeze({
  cosmetic: 'aesthetic plastic cosmetic', preexisting: 'pre-existing', copayment: 'co-payment', roomrent: 'room rent room charges',
  weightloss: 'weight-loss bariatric obesity', eyesight: 'refractive eyesight', maternity: 'maternity delivery childbirth',
});

const EXCLUSION = /\b(?:excluded|exclusions?|not\s+(?:covered|payable|admissible|eligible)|shall\s+not\s+be\s+(?:liable|payable)|we\s+will\s+not\s+(?:pay|cover)|no\s+cover)\b/i;

function canonical(text) {
  let out = String(text ?? '').normalize('NFKC').toLowerCase();
  for (const [pattern, token] of CANON) out = out.replace(pattern, ` ${token} `);
  return out;
}

function stem(word) {
  let w = word;
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 4 && w.endsWith('es')) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  return w.length > 4 && w.endsWith('e') ? w.slice(0, -1) : w;
}

const wordsOf = text => canonical(text).match(/[\p{L}\p{N}]+/gu) ?? [];

/** The question's content terms: stems after stopwords and canonical insurance synonyms. Deduplicated. */
export function contentTerms(question) {
  const out = [];
  for (const raw of wordsOf(question)) {
    if (STOPWORDS.has(raw) || raw.length < 2) continue;
    const term = stem(raw);
    if (STOPWORDS.has(term) || out.includes(term)) continue;
    out.push(term);
  }
  return out;
}

/** Capitalised words inside the question (a place or a name, e.g. "Pune"): the clause must carry each of them or it does not answer. */
function requiredTerms(question) {
  const words = String(question ?? '').normalize('NFKC').match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.slice(1).filter(word => /^[A-Z][a-z]{2,}$/.test(word)).map(word => stem(word.toLowerCase())).filter(term => !STOPWORDS.has(term));
}

/** The message plus surface synonyms, for the clause keyword search (so "aesthetic" finds a clause that says "cosmetic"). */
export function expandQuery(question) {
  const folded = ` ${wordsOf(question).join(' ')} `;
  const extra = Object.entries(EXPANSIONS).filter(([token]) => folded.includes(` ${token} `)).map(([, words]) => words);
  return extra.length ? `${question} ${extra.join(' ')}` : question;
}

function segmentsOf(text) {
  const segments = [];
  String(text ?? '').split('\n').forEach((line, lineIndex) => {
    for (const part of line.split(/(?<=[.;])\s+(?=[A-Z(])/)) {
      const trimmed = part.replace(/\s+/g, ' ').trim();
      if (trimmed) segments.push({ text: trimmed, lineIndex });
    }
  });
  return segments;
}

// True when the segment carries the question: at least half of all content terms and at least 60% of the specific (non-frame) ones.
function clears(terms, text) {
  const have = new Set(wordsOf(text).map(stem));
  const strong = terms.filter(term => !WEAK.has(term));
  if (strong.length === 0) return false;
  const matched = terms.filter(term => have.has(term)).length;
  const strongMatched = strong.filter(term => have.has(term)).length;
  return matched / terms.length >= RELEVANCE_FLOOR && strongMatched / strong.length >= 0.6;
}

function scoreText(terms, text) {
  const have = new Set(wordsOf(text).map(stem));
  let matched = 0;
  for (const term of terms) if (have.has(term)) matched += 1;
  return matched;
}

const clip = (text, max) => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`);

/** True when a passage text carries enough of the question's content terms. The floor for vector passages. */
export function clearsRelevanceFloor(question, text) {
  const terms = contentTerms(question);
  if (terms.length === 0) return false;
  return clears(terms, text);
}

/**
 * clauses: [{ id, documentId, page, text, kind?, sectionPath?, blockIndexes? }].
 * Returns null when no clause clears the relevance floor (the caller answers "unknown", no sources), else
 * { clause, text, excluded, page, blockIndex, matched, total } where `text` is the best sentence window (<= 280 chars).
 */
export function selectClauseAnswer({ question, clauses }) {
  const terms = contentTerms(question);
  if (terms.length === 0) return null;
  const required = requiredTerms(question);
  let best = null;
  for (const clause of clauses) {
    const segments = segmentsOf(clause.text);
    segments.forEach((segment, index) => {
      const matched = scoreText(terms, segment.text);
      if (matched < 1 || !clears(terms, segment.text)) return;
      if (required.length && scoreText(required, segment.text) < required.length) return;
      if (!best || matched > best.matched || (matched === best.matched && segment.text.length < best.segment.text.length)) best = { clause, segments, index, segment, matched };
    });
  }
  if (!best) return null;
  let text = best.segment.text;
  const next = best.segments[best.index + 1];
  // A short matching sentence takes the next one as context when that one matches too; a long page is never pasted.
  if (next && text.length < 120 && scoreText(terms, next.text) > 0 && text.length + next.text.length + 1 <= MAX_WINDOW_CHARS) text = `${text} ${next.text}`;
  text = clip(text, MAX_WINDOW_CHARS);
  const section = (best.clause.sectionPath ?? []).join(' ');
  const excluded = EXCLUSION.test(best.segment.text) || (/exclusion/i.test(section) && best.clause.kind === 'exclusion');
  const lines = String(best.clause.text ?? '').split('\n');
  const blocks = best.clause.blockIndexes ?? [];
  const blockIndex = blocks.length === lines.length ? blocks[best.segment.lineIndex] : (blocks[0] ?? null);
  return { clause: best.clause, text, excluded, page: best.clause.page ?? null, blockIndex: blockIndex ?? null, matched: best.matched, total: terms.length };
}
