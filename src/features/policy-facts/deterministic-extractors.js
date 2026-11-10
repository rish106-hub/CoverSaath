// Deterministic fact extraction over sectioned document chunks (ADR 0025). No model, no provider call, no I/O.
// A fact is read only from a printed line of the form "Label: value" or a table row "Label | value | ...". The label decides the
// fact type, the normaliser (normalisers.js) decides the value, and the line itself is the quote. A header-above-values table, a
// label on one line and its value on the next, and anything a regular expression cannot read are NOT read here: they are left to
// the model path or stay unread. Nothing is guessed: an unreadable value gives no fact, and two different printed values for the
// same fact give a conflicting fact that holds no value.
//
// The output is a candidate list. Every candidate is verified against its chunk by evidence-verify.js before anything is stored.

import { FACT_TYPES } from './fact-types.js';
import { comparable, parse, parseNcbTiers, parsePaymentEvent, scan, valuesIn } from './normalisers.js';

export const EXTRACTION_LIMITS = Object.freeze({ maxLineChars: 500, maxLines: 4000, maxFacts: 200, maxEvidencePerFact: 4, maxChunks: 2000 });

const i = pattern => new RegExp(pattern, 'i');
const dash = '[\\s-]*';

// label: tested against the text before the first ':' or ' | ' (trimmed, parenthetical qualifiers allowed where listed)
// kind: the normaliser kind of FACT_TYPES[factType].parse; mode 'one' reads exactly one distinct value from the rest of the line
const SPECS = Object.freeze([
  { factType: 'sum_insured', label: i(`^(?:basic\\s+|total\\s+|base\\s+)?sum\\s+insured\\s*(?:\\([^)]*\\))?$`) },
  { factType: 'premium_total', label: i(`^(?:(?:total|gross|final)\\s+premium(?:\\s+(?:payable|amount))?|premium\\s+(?:payable|amount))\\s*(?:\\([^)]*\\))?$`) },
  { factType: 'premium_base', label: i(`^(?:basic|base|net)\\s+premium\\s*(?:\\([^)]*\\))?$`) },
  { factType: 'premium_gst', label: i(`^(?:gst|igst|total\\s+gst|gst\\s+amount)\\b[^:|]{0,30}$`) },
  { factType: 'deductible', label: i(`^(?:annual\\s+|aggregate\\s+)?deductible$`) },
  { factType: 'room_rent_limit', label: i(`^room\\s+rent(?:\\s+(?:limit|cap|eligibility))?$`) },
  { factType: 'policy_period', label: i(`^(?:policy\\s+period|period\\s+of\\s+(?:insurance|cover)|insurance\\s+period)$`) },
  { factType: 'issue_date', label: i(`^(?:(?:policy\\s+)?(?:issue|issuance)\\s+date|date\\s+of\\s+issue)$`) },
  { factType: 'start_date', label: i(`^(?:(?:policy\\s+|risk\\s+)?(?:start|commencement|inception)\\s+date|date\\s+of\\s+commencement)$`) },
  { factType: 'end_date', label: i(`^(?:(?:policy\\s+)?(?:end|expiry)\\s+date|date\\s+of\\s+expiry)$`) },
  { factType: 'renewal_date', label: i(`^(?:next\\s+)?(?:renewal|premium\\s+due)\\s+date$`) },
  { factType: 'continuous_coverage_since', label: i(`^(?:continuous\\s+coverage(?:\\s+(?:since|from|date))?|insured\\s+since)$`) },
  { factType: 'grace_period', label: i(`^grace\\s+period$`) },
  { factType: 'free_look_period', label: i(`^free${dash}look\\s+period$`) },
  { factType: 'waiting_initial', label: i(`^(?:initial\\s+waiting\\s+period|waiting\\s+period\\s*\\(?\\s*initial\\s*\\)?)$`) },
  { factType: 'waiting_ped', label: i(`^(?:(?:pre${dash}existing\\s+(?:diseases?|conditions?)|ped)\\s+waiting\\s+period|waiting\\s+period\\s*(?:for\\s+)?\\(?\\s*(?:ped|pre${dash}existing[^)]*)\\)?)$`) },
  { factType: 'waiting_maternity', label: i(`^maternity\\s+waiting\\s+period$`) },
  { factType: 'waiting_specific', label: i(`^(?:specific\\s+disease\\s+)?waiting\\s+period\\s+(?:for|-)\\s+(.+)$`), scoped: true },
  { factType: 'claim_submission_deadline', label: i(`^(?:claim\\s+(?:intimation|submission|filing)\\s+(?:deadline|period)|reimbursement\\s+(?:submission\\s+)?(?:deadline|period))$`) },
  { factType: 'copay_percent', label: i(`^co${dash}pay(?:ment)?(?:\\s+percent(?:age)?)?$`) },
  { factType: 'ncb_current', label: i(`^(?:current|accrued|earned)\\s+(?:no${dash}claim\\s+bonus|ncb|bonus)$`) },
  { factType: 'ncb_max', label: i(`^(?:maximum|max)\\s+(?:no${dash}claim\\s+bonus|ncb|bonus)$`) },
  { factType: 'ncb_table', label: i(`^(?:no${dash}claim\\s+bonus|ncb|cumulative\\s+bonus)$`) },
  { factType: 'loyalty_bonus', label: i(`^(?:guaranteed\\s+)?loyalty\\s+bonus$`) },
  { factType: 'last_payment', label: i(`^(?:last|previous)\\s+(?:premium\\s+)?payment$`) },
  { factType: 'payment_mode_last', label: i(`^(?:(?:last|previous)\\s+)?(?:premium\\s+)?(?:payment\\s+mode|mode\\s+of\\s+payment)$`) },
  { factType: 'payment_frequency', label: i(`^(?:(?:premium\\s+)?payment\\s+(?:mode|frequency)|premium\\s+frequency|frequency\\s+of\\s+payment|mode\\s+of\\s+premium\\s+payment)$`) },
  { factType: 'payment_count', label: i(`^(?:number\\s+of\\s+)?(?:premiums?\\s+paid|payments?\\s+made)$`) },
  { factType: 'payment_total', label: i(`^(?:total\\s+premiums?\\s+paid(?:\\s+(?:till|to)\\s+date)?|premiums?\\s+paid\\s+to\\s+date)$`) },
  { factType: 'seller_type', label: i(`^(?:sold\\s+by|(?:distribution\\s+|sales\\s+)?channel|intermediary(?:\\s+type)?|source\\s+of\\s+business|point\\s+of\\s+sale)$`) },
  { factType: 'seller_name', label: i(`^(?:(?:agent|broker|intermediary|posp|seller|distributor|corporate\\s+agent)\\s+name|name\\s+of\\s+(?:agent|broker|intermediary|seller))$`) },
  { factType: 'seller_code', label: i(`^(?:agent|broker|intermediary|posp|seller)\\s+(?:code|id)$`) },
  { factType: 'seller_irdai_registration', label: i(`^(?:agent|broker|intermediary|posp)\\s+(?:irdai\\s+)?(?:registration|licen[cs]e)\\s*(?:no\\.?|number)$`) },
  { factType: 'member_count', label: i(`^(?:number\\s+of\\s+(?:insured\\s+)?members|no\\.?\\s+of\\s+(?:lives|members|insured)|members\\s+(?:insured|covered))$`) },
]);

const slug = text => text.toLowerCase().normalize('NFC').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64);

function splitLine(line) {
  const pipe = line.indexOf(' | ');
  const colon = line.indexOf(':');
  // A table row (cells joined by " | ") or a "Label: value" line. The earlier separator wins.
  const useColon = colon >= 0 && (pipe < 0 || colon < pipe);
  if (useColon) return { label: line.slice(0, colon).trim(), rest: line.slice(colon + 1).trim() };
  if (pipe >= 0) return { label: line.slice(0, pipe).trim(), rest: line.slice(pipe + 3).trim() };
  return null;
}

const MEMBER_LINE = /\b(?:self|spouse|child|son|daughter|father|mother|member\s*\d*|age)\b/i;
const NOT_MEMBER_AGE = /waiting|period|term|renew|since|policy|premium|cover|tenure/i;

/** One candidate per (fact type, scope) occurrence: { factType, scopeKey, value, raw, quote, page, blockIndex, clauseId }. */
function readLine({ line, chunk, add }) {
  const split = splitLine(line);
  const where = { quote: line, page: chunk.page, blockIndex: chunk.blockIndexes?.[0] ?? null, clauseId: chunk.id ?? null };
  if (split && split.rest) {
    for (const spec of SPECS) {
      const labelMatch = spec.label.exec(split.label);
      if (!labelMatch) continue;
      const { rest } = split;
      if (spec.factType === 'ncb_table') {
        const table = parseNcbTiers(rest);
        if (table) {
          for (const tier of table.tiers) add({ factType: 'ncb_tier', scopeKey: `year_${tier.year}`, value: { bp: tier.bp }, raw: rest, ...where });
          add({ factType: 'ncb_max', scopeKey: '', value: { bp: table.maxBp }, raw: rest, ...where });
        }
        continue;
      }
      if (spec.factType === 'last_payment') {
        const event = parsePaymentEvent(rest);
        if (event?.mode) add({ factType: 'payment_mode_last', scopeKey: '', value: { value: event.mode }, raw: rest, ...where });
        if (event?.dateIso) add({ factType: 'payment_date_last', scopeKey: '', value: { iso: event.dateIso }, raw: rest, ...where });
        continue;
      }
      const definition = FACT_TYPES[spec.factType];
      const kind = definition.parse;
      const scopeKey = spec.scoped ? slug(labelMatch[1] ?? '') : '';
      if (spec.scoped && (!scopeKey || /^(?:initial|pre_existing|ped|maternity)/.test(scopeKey))) continue;
      if (kind === 'text') {
        const value = parse('text', rest);
        if (value) add({ factType: spec.factType, scopeKey, value, raw: rest, ...where });
        continue;
      }
      const distinct = new Map(valuesIn(kind, rest).map(value => [comparable(kind, value), value]));
      // Exactly one distinct value on the line, or the line is ambiguous and is not read.
      if (distinct.size === 1) add({ factType: spec.factType, scopeKey, value: [...distinct.values()][0], raw: rest, ...where });
    }
  }
  if (MEMBER_LINE.test(line) && !NOT_MEMBER_AGE.test(line)) {
    const ages = valuesIn('age', line);
    // Lines with several ages are several members; the member index is assigned after all lines are read (see extractFacts).
    for (const value of ages) add({ factType: 'member_age', scopeKey: '', value, raw: scan('age', line)[0] ?? line, ...where, memberAge: true });
  }
}

/**
 * Reads candidate facts from sectioned chunks ({ id, page, blockIndexes, text }) and groups them into facts:
 *   one distinct value  -> extracted_unverified, primary evidence plus corroborating quotes of the same value
 *   several values      -> conflicting, no value, one conflicting quote per distinct value
 * seller_type with no printed seller gives state 'unknown' and no evidence; a seller is never inferred.
 * Returns { facts, truncated }.
 */
export function extractFacts(chunks) {
  const found = [];
  let lines = 0;
  let truncated = false;
  for (const chunk of (Array.isArray(chunks) ? chunks : []).slice(0, EXTRACTION_LIMITS.maxChunks)) {
    if (!chunk || typeof chunk.text !== 'string') continue;
    for (const raw of chunk.text.split('\n')) {
      const line = raw.trim();
      if (!line || line.length > EXTRACTION_LIMITS.maxLineChars) continue;
      lines += 1;
      if (lines > EXTRACTION_LIMITS.maxLines) { truncated = true; break; }
      readLine({ line, chunk, add: candidate => found.push(candidate) });
    }
    if (truncated) break;
  }

  // Members are numbered in reading order, one scope per member.
  let member = 0;
  for (const candidate of found) {
    if (candidate.memberAge) { member += 1; candidate.scopeKey = `member_${member}`; }
  }

  const groups = new Map();
  for (const candidate of found) {
    const key = `${candidate.factType}\u0000${candidate.scopeKey}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(candidate);
  }

  const facts = [];
  for (const group of groups.values()) {
    const { factType, scopeKey } = group[0];
    const kind = FACT_TYPES[factType].parse;
    const byValue = new Map();
    for (const candidate of group) {
      const id = comparable(kind, candidate.value);
      if (id === null) continue;
      if (!byValue.has(id)) byValue.set(id, []);
      byValue.get(id).push(candidate);
    }
    if (byValue.size === 0) continue;
    const evidenceOf = (candidate, role) => ({ role, quote: candidate.quote, page: candidate.page, blockIndex: candidate.blockIndex, clauseId: candidate.clauseId });
    if (byValue.size === 1) {
      const [only] = byValue.values();
      const seen = new Set();
      const evidence = [];
      for (const candidate of only) {
        const id = `${candidate.page}:${candidate.quote}`;
        if (seen.has(id)) continue;
        seen.add(id);
        evidence.push(evidenceOf(candidate, evidence.length === 0 ? 'primary' : 'corroborating'));
        if (evidence.length >= EXTRACTION_LIMITS.maxEvidencePerFact) break;
      }
      facts.push({ factType, scopeKey, state: 'extracted_unverified', value: only[0].value, raw: only[0].raw, evidence });
    } else {
      const evidence = [...byValue.values()].slice(0, EXTRACTION_LIMITS.maxEvidencePerFact).map(list => evidenceOf(list[0], 'conflicting'));
      facts.push({ factType, scopeKey, state: 'conflicting', value: null, raw: null, evidence });
    }
  }

  // The seller type is always recorded: unknown when nothing is printed. Never inferred as 'direct'.
  if (!facts.some(fact => fact.factType === 'seller_type')) {
    facts.push({ factType: 'seller_type', scopeKey: '', state: 'unknown', value: null, raw: null, evidence: [] });
  }
  if (facts.length > EXTRACTION_LIMITS.maxFacts) truncated = true;
  return { facts: facts.slice(0, EXTRACTION_LIMITS.maxFacts), truncated };
}
