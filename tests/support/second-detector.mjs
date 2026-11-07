// Independent second detector for the privacy gate (ADR 0017 D6). CI and tests only: it is never imported by src/ and
// never runs at request time. It imports nothing from src/ and shares no patterns with the gate. SYNTHETIC DATA ONLY.
//
// Technique (different from the gate's labelled-regex rules): normalise to a skeleton, split into alphanumeric tokens
// with offsets, then test windows of consecutive tokens against identifier shapes, and fuzzy-match known names.
// Placeholders (<KIND_n>) are hard breaks: a window never spans one.
//
// Returns hits as { kind, at } only; it never returns the matched text, so a failing test cannot print a value.

const PLACEHOLDER = /<[A-Z]+(?:_[A-Z]+)*_[1-9]\d{0,5}>/g;
const BREAK = '\u0001';

function digitValue(character) {
  // Decimal digits come in runs of ten code points; the value is the offset inside the run.
  let steps = 0;
  let cp = character.codePointAt(0) - 1;
  while (steps < 9 && /^\p{Nd}$/u.test(String.fromCodePoint(cp))) { steps += 1; cp -= 1; }
  return steps;
}

export function skeletonText(raw) {
  const mapped = String(raw).normalize('NFKC').replace(/\p{Cf}/gu, '').replace(PLACEHOLDER, BREAK)
    .replace(/\p{Nd}/gu, character => (/[0-9]/.test(character) ? character : String(digitValue(character))));
  return mapped;
}

// Alphanumeric tokens with offsets. A window may only join tokens that are separated by plain separators (spaces,
// dashes, dots, slashes, line breaks), never a break marker or a long gap.
export function tokensOf(text) {
  const tokens = [];
  for (const match of text.matchAll(/[\p{L}\p{M}0-9]+/gu)) tokens.push({ value: match[0], at: match.index, end: match.index + match[0].length });
  return tokens;
}

function joinable(text, left, right) {
  const gap = text.slice(left.end, right.at);
  return gap.length <= 4 && !gap.includes(BREAK) && !/[\p{L}0-9]/u.test(gap);
}

function windows(text, tokens, maxTokens) {
  const out = [];
  for (let start = 0; start < tokens.length; start += 1) {
    let joined = tokens[start].value;
    out.push({ at: tokens[start].at, joined, count: 1 });
    for (let next = start + 1; next < tokens.length && next - start < maxTokens; next += 1) {
      if (!joinable(text, tokens[next - 1], tokens[next])) break;
      joined += tokens[next].value;
      out.push({ at: tokens[start].at, joined, count: next - start + 1 });
    }
  }
  return out;
}

// Confusable letters that OCR swaps for digits, applied only to a window that is at least 60% digits.
const CONFUSABLE = { O: '0', o: '0', I: '1', l: '1', S: '5', B: '8', Z: '2' };
function digitsOf(joined) {
  const digits = (joined.match(/[0-9]/g) ?? []).length;
  if (joined.length === 0 || digits / joined.length < 0.6) return /^[0-9]+$/.test(joined) ? joined : null;
  const mapped = [...joined].map(character => CONFUSABLE[character] ?? character).join('');
  return /^[0-9]+$/.test(mapped) ? mapped : null;
}

// Allow-list: values that look like identifiers but are policy wording. Each entry says why.
const ALLOWED = [
  /^1800\d{6,7}$/, // toll-free customer-care numbers printed by insurers
  /^(?:19|20)\d{2}$/, // calendar years
];

function digitShape(digits) {
  if (ALLOWED.some(pattern => pattern.test(digits))) return null;
  if (/^[6-9]\d{9}$/.test(digits)) return 'mobile';
  if (/^91[6-9]\d{9}$/.test(digits)) return 'mobile';
  if (/^0[6-9]\d{9}$/.test(digits)) return 'mobile';
  // STD landline: trunk 0, 2 to 4 digit area code, 6 to 8 digit number (10 or 11 digits in all).
  if (/^0[1-5]\d{8,9}$/.test(digits)) return 'landline';
  if (/^[2-9]\d{11}$/.test(digits)) return 'aadhaar';
  if (/^\d{14}$/.test(digits)) return 'abha';
  if (/^\d{16}$/.test(digits)) return 'vid';
  return null;
}

// Damerau-Levenshtein (optimal string alignment) distance, bounded to 2.
function distance(a, b) {
  if (Math.abs(a.length - b.length) > 1) return 2;
  const rows = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1);
    }
  }
  return rows[a.length][b.length];
}

// Transliteration table for the corpus names only (Latin lower case <-> Devanagari).
export const TRANSLITERATION = Object.freeze([
  ['rahul', 'राहुल'], ['meera', 'मीरा'], ['ravi', 'रवि'], ['kavya', 'काव्या'], ['ananya', 'अनन्या'], ['asha', 'आशा'],
  ['arjun', 'अर्जुन'], ['testcase', 'टेस्टकेस'], ['synthetic', 'सिंथेटिक'], ['fakename', 'फेकनेम'], ['placeholder', 'प्लेसहोल्डर'],
  ['example', 'एग्जाम्पल'], ['fictional', 'फिक्शनल'],
]);

function nameTokens(name) {
  return name.normalize('NFKC').toLowerCase().split(/[\s.,]+/u).filter(Boolean);
}

function nameHits(lowerTokens, names) {
  const hits = [];
  const scripts = new Map(TRANSLITERATION.flatMap(([latin, devanagari]) => [[latin, devanagari], [devanagari, latin]]));
  for (const name of names) {
    const parts = nameTokens(name);
    for (const token of lowerTokens) {
      for (const part of parts) {
        const alternates = [part, scripts.get(part)].filter(Boolean);
        const hit = alternates.some(candidate => (candidate.length >= 5 ? distance(token.value, candidate) <= 1 : token.value === candidate));
        if (hit && part.length >= 3) hits.push({ kind: 'name', at: token.at });
      }
    }
    // Initial plus surname ("R. Fakename", "R Fakename").
    const surname = parts.at(-1);
    if (parts.length >= 2 && surname.length >= 4) {
      for (let index = 1; index < lowerTokens.length; index += 1) {
        const previous = lowerTokens[index - 1];
        if (lowerTokens[index].value === surname && previous.value.length === 1) hits.push({ kind: 'name_initial', at: previous.at });
      }
    }
  }
  return hits;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function dobHits(tokens, dobs) {
  const hits = [];
  for (const dob of dobs) {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(dob);
    if (!match) continue;
    const [year, month, day] = [match[1], Number(match[2]), Number(match[3])];
    for (let index = 0; index + 2 < tokens.length; index += 1) {
      const trio = tokens.slice(index, index + 3).map(token => token.value.toLowerCase());
      const asMonth = value => (/^\d+$/.test(value) ? Number(value) : MONTHS.indexOf(value.slice(0, 3)) + 1);
      const dayOk = trio.some(value => /^\d{1,2}(?:st|nd|rd|th)?$/.test(value) && parseInt(value, 10) === day);
      const monthOk = trio.some(value => asMonth(value) === month);
      const yearOk = trio.some(value => value === year || (value.length === 2 && value === year.slice(2)));
      if (dayOk && monthOk && yearOk) hits.push({ kind: 'dob', at: tokens[index].at });
    }
  }
  return hits;
}

/**
 * Scans a gate output. `known` is the corpus row's knownIdentifiers ([{ kind, value }]). Returns [{ kind, at }].
 */
export function detect(output, known = []) {
  const text = skeletonText(output);
  const tokens = tokensOf(text);
  const hits = [];
  for (const window of windows(text, tokens, 8)) {
    const digits = digitsOf(window.joined);
    if (digits && digits.length >= 10) {
      const shape = digitShape(digits);
      if (shape) hits.push({ kind: shape, at: window.at });
    }
    if (window.count <= 3 && /^[A-Za-z]{5}[0-9]{4}[A-Za-z]$/.test(window.joined)) hits.push({ kind: 'pan', at: window.at });
    if (window.count <= 2 && /^[A-Za-z]{4}0[A-Za-z0-9]{6}$/.test(window.joined)) hits.push({ kind: 'ifsc', at: window.at });
  }
  // Bank account numbers: 9 to 18 digits shortly after an account cue.
  for (const cue of text.matchAll(/a\/c|account/giu)) {
    const tail = text.slice(cue.index + cue[0].length, cue.index + cue[0].length + 40);
    for (const run of tail.matchAll(/\d(?:[ -]?\d){8,17}/g)) {
      const digits = run[0].replace(/\D/g, '');
      if (digits.length >= 9 && digits.length <= 18) hits.push({ kind: 'account', at: cue.index });
    }
  }
  for (const match of text.matchAll(/[A-Za-z0-9._%+-]+(?:@|\s*[([{]\s*at\s*[)\]}]\s*)[A-Za-z0-9-]+(?:\s*[([{]\s*dot\s*[)\]}]\s*|\.)?[A-Za-z0-9.-]*/giu)) hits.push({ kind: 'email', at: match.index });
  // Dates near a birth cue.
  for (const cue of text.matchAll(/d\.?o\.?b\.?|date of birth|birth date|born|जन्म/giu)) {
    const tail = text.slice(cue.index, cue.index + 40);
    if (/\d{1,2}[/. -]\d{1,2}[/. -]\d{2,4}/.test(tail) || /\d{1,2}(?:st|nd|rd|th)?[ -]*[A-Za-z]{3,9}[ ,-]*\d{2,4}/.test(tail)
      || /[A-Za-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}/.test(tail)) hits.push({ kind: 'dob_label', at: cue.index });
  }
  // Six-digit PIN codes after an address cue (a plain six-digit amount elsewhere is not a PIN).
  for (const cue of text.matchAll(/(?<![\p{L}\p{M}])(?:flat|house|plot|door|road|street|nagar|colony|sector|block|village|city|district|pin|पता|नगर|मकान)(?![\p{L}\p{M}])/giu)) {
    const tail = text.slice(cue.index, cue.index + 80);
    if (/(?<![0-9₹])[1-9][0-9]{2}\s?[0-9]{3}(?![0-9])/.test(tail.replace(/rs\.?\s*\d[\d,]*/gi, ''))) hits.push({ kind: 'pin', at: cue.index });
  }
  const names = known.filter(entry => entry.kind === 'NAME').map(entry => entry.value);
  const lowerTokens = tokens.map(token => ({ ...token, value: token.value.toLowerCase() }));
  if (names.length) hits.push(...nameHits(lowerTokens, names));
  hits.push(...dobHits(tokens, known.filter(entry => entry.kind === 'DOB').map(entry => entry.value)));
  const lowered = text.toLowerCase();
  for (const entry of known.filter(candidate => candidate.kind === 'EMAIL')) if (lowered.includes(String(entry.value).toLowerCase())) hits.push({ kind: 'known_email', at: 0 });
  for (const entry of known.filter(candidate => candidate.kind === 'PHONE')) {
    const tail = String(entry.value).replace(/\D/g, '').slice(-10);
    if (tail.length === 10 && text.replace(/\D/g, '').includes(tail)) hits.push({ kind: 'known_phone', at: 0 });
  }
  return hits;
}
