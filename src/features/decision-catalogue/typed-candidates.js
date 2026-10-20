// Phase 2 typed twin of a cited finding. A finding stays open-ended evidence; when the ONE cited clause line that names
// the finding's subject states a value in a strict, unambiguous form, a typed candidate is added beside it. The twin keeps
// the finding's clause links and, because the batch origin is `model`, stays extracted_unverified: a typed value is a
// proposal for a reviewer, never a number a calculation may use. Anything ambiguous yields no twin and the finding
// survives as cited evidence. No guessing across lines, no unit conversion, no inference from silence.
import { text } from './contracts.js';

const STOP = new Set(['the', 'and', 'for', 'per', 'cover', 'benefit', 'limit', 'limits', 'under', 'with', 'this']);
const AMOUNT = /(?:rs\.?|inr|₹)\s*([0-9][0-9,]*)(?![0-9,]*\.[0-9])/gi;
const PERCENT = /(\d{1,3}(?:\.\d{1,2})?)\s*%/g;
const PERCENT_TEST = /\d\s*%/;
const UNIT = /\bper\s+(day|eye|year|claim|event|illness|admission|policy\s+year|hospitali[sz]ation)\b/i;

const lineOf = (body, subject) => {
  const words = [...new Set(subject.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !STOP.has(w)))].slice(0, 4);
  if (!words.length) return null;
  const hits = String(body ?? '').split(/\r?\n/).map(line => line.trim()).filter(line => line && words.every(w => line.toLowerCase().includes(w)));
  return hits.length === 1 ? hits[0] : null; // two lines naming the subject: ambiguous
};
const only = (line, pattern) => { const found = [...line.matchAll(pattern)]; return found.length === 1 ? found[0] : null; };
const rupees = raw => { const n = Number(raw.replace(/,/g, '')); return Number.isSafeInteger(n) && n > 0 && n < 1e11 ? n * 100 : null; };
const basisPoints = raw => { const bp = Math.round(Number(raw) * 100); return bp >= 0 && bp <= 10000 ? bp : null; };

function limit(line) {
  const amounts = [...line.matchAll(AMOUNT)];
  if (/\bat\s+actuals?\b/i.test(line) && !amounts.length && !PERCENT_TEST.test(line)) return { kind: 'actuals' };
  const pct = only(line, PERCENT);
  if (pct && /sum\s+insured/i.test(line) && !amounts.length) { const bp = basisPoints(pct[1]); return bp === null ? null : { kind: 'percent_of_sum_insured', basisPoints: bp }; }
  const amt = only(line, AMOUNT);
  if (!amt || pct) return null;
  const minor = rupees(amt[1]);
  if (minor === null) return null;
  const unit = line.match(UNIT);
  return { kind: 'amount', amountMinor: minor, currency: 'INR', basis: unit ? unit[1].toLowerCase().replace(/\s+/g, '_') : 'unspecified' };
}

/** @returns a typed candidate (plain proposal, no authority fields) or null */
export function typedTwin(candidate, clauseRows) {
  if (!candidate || candidate.clauseIds?.length !== 1) return null; // a value spread over clauses is not safely one value
  const clause = (clauseRows ?? []).find(row => row.clauseId === candidate.clauseIds[0]);
  const topic = text(candidate.topic, 120);
  const line = clause && topic ? lineOf(clause.text, topic) : null;
  if (!line) return null;
  const base = { ...candidate, value: undefined, unit: null, selection: 'unspecified', typedFromFinding: candidate.value?.findingId ?? null };
  const make = (factType, value, extra = {}) => ({ ...base, factType, value, ...extra });
  const t = topic;
  if (/\bnot\s+opted\b/i.test(line) && !/at\s+actuals/i.test(line)) return make('add_on', { name: t }, { selection: 'not_opted' });
  if (/\bco-?pay(?:ment)?\b/.test(t)) { const m = only(line, PERCENT); const bp = m && basisPoints(m[1]); return bp == null ? null : make('copay', { basisPoints: bp }); }
  if (/\bwaiting\s+period\b/.test(t)) {
    const m = only(line, /(\d{1,3})\s*(years?|months?)\b/gi);
    if (!m) return null;
    const months = Number(m[1]) * (/^y/i.test(m[2]) ? 12 : 1);
    return months <= 600 ? make('waiting_period', { months }) : null;
  }
  if (/\bicu\b/.test(t)) { const v = limit(line); return v ? make('icu_limit', v) : null; }
  if (/\broom\s+rent\b/.test(t)) { const v = limit(line); return v ? make('room_rent_limit', v) : null; }
  if (/\b(sub-?limit|per eye|cataract|per\s+\w+)\b/i.test(t) || UNIT.test(line)) { const v = limit(line); return v && v.kind !== 'actuals' ? make('sublimit', v) : null; }
  return null;
}

export function typedTwins(candidates, clauseRows) {
  return candidates.map(candidate => typedTwin(candidate, clauseRows)).filter(Boolean);
}
