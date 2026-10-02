// Deterministic citation verification. A value can only become Proven when every quote is found in the
// stored page text AND the value itself appears in a quote. Matching tolerates whitespace, case,
// quote/dash style and rupee notation only — never digits, decimal points or digit separators.

const REPLACEMENTS = [
  [/[‘’‚‛′]/g, "'"],
  [/[“”„‟″]/g, '"'],
  [/[‐-―−]/g, '-'],
  [/ /g, ' '],
  [/₹|\brs\.?(?=\s*\d)|\binr\b/gi, 'rs '],
];

export const MIN_QUOTE_CHARACTERS = 6;
export const MIN_CROSS_PAGE_QUOTE_CHARACTERS = 15;

export function normaliseForMatch(text) {
  let value = String(text ?? '').normalize('NFKC');
  for (const [pattern, replacement] of REPLACEMENTS) value = value.replace(pattern, replacement);
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

// Loose fallback for OCR line-break and punctuation noise. Only used for quotes without digits, so it can
// never turn "1.5%" into "15%" or "5,00,0000" into "50,00,000".
const lettersOnly = text => normaliseForMatch(text).replace(/[^a-z]+/g, '');

/**
 * Checks one quote. Returns { matched, method, pageNumber, correctedPage }.
 * method: 'exact' | 'normalised' | 'letters' | 'other_page' | 'none'
 */
export function verifyQuote({ quote, pageNumber }, pagesByNumber) {
  if (typeof quote !== 'string' || quote.trim().length < MIN_QUOTE_CHARACTERS) return { matched: false, method: 'none', pageNumber, correctedPage: null };
  const page = pagesByNumber.get(pageNumber);
  if (page) {
    if (page.text.includes(quote)) return { matched: true, method: 'exact', pageNumber, correctedPage: null };
    if (normaliseForMatch(page.text).includes(normaliseForMatch(quote))) return { matched: true, method: 'normalised', pageNumber, correctedPage: null };
    if (!/\d/.test(quote)) {
      const needle = lettersOnly(quote);
      if (needle.length >= 12 && lettersOnly(page.text).includes(needle)) return { matched: true, method: 'letters', pageNumber, correctedPage: null };
    }
  }
  // The model may cite the wrong page; search elsewhere only for distinctive quotes, and record the move.
  if (quote.trim().length >= MIN_CROSS_PAGE_QUOTE_CHARACTERS) {
    const needle = normaliseForMatch(quote);
    const hits = [...pagesByNumber].filter(([number, candidate]) => number !== pageNumber && normaliseForMatch(candidate.text).includes(needle));
    if (hits.length === 1) return { matched: true, method: 'other_page', pageNumber: hits[0][0], correctedPage: hits[0][0] };
  }
  return { matched: false, method: 'none', pageNumber, correctedPage: null };
}

/** Verifies every citation of an item. All must match for the item to be citation-verified. */
export function verifyCitations(citations, pagesByNumber) {
  const results = (citations ?? []).map(citation => ({ ...citation, ...verifyQuote(citation, pagesByNumber) }));
  return {
    results,
    allMatched: results.length > 0 && results.every(result => result.matched),
    anyMatched: results.some(result => result.matched),
  };
}

// ---------------------------------------------------------------------------
// Value-in-quote check
// ---------------------------------------------------------------------------

const UNITS = { nil: 0, zero: 0, once: 1, twice: 2, thrice: 3, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SCALES = { hundred: 100, thousand: 1_000, lakh: 100_000, lakhs: 100_000, lac: 100_000, lacs: 100_000, crore: 10_000_000, crores: 10_000_000 };

function wordNumbers(text) {
  const found = [];
  const tokens = text.toLowerCase().replace(/-/g, ' ').split(/[^a-z]+/).filter(Boolean);
  let total = 0;
  let current = 0;
  let active = false;
  const flush = () => { if (active) found.push(total + current); total = 0; current = 0; active = false; };
  for (const token of tokens) {
    if (token in UNITS) { current += UNITS[token]; active = true; }
    else if (token in TENS) { current += TENS[token]; active = true; }
    else if (token in SCALES && active) {
      if (SCALES[token] === 100) current *= 100;
      else { total += current * SCALES[token]; current = 0; }
    } else if (token === 'and' && active) continue;
    else flush();
  }
  flush();
  return found;
}

/** Every number a quote states, including Indian grouping, decimals, "5 lakh" and number words. */
export function numbersInQuote(quote) {
  const text = String(quote ?? '');
  const numbers = new Set();
  for (const match of text.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(lakhs?|lacs?|crores?|thousand)?/gi)) {
    const base = Number(match[1].replace(/,/g, ''));
    if (!Number.isFinite(base)) continue;
    numbers.add(base);
    const scale = match[2] ? SCALES[match[2].toLowerCase()] : null;
    if (scale) numbers.add(base * scale);
  }
  for (const value of wordNumbers(text)) numbers.add(value);
  return numbers;
}

const alnum = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/**
 * Returns null when the value is supported by at least one quote, otherwise a reason code.
 * Booleans, enums, rules and lists are interpretations and are left to the verifier and human review.
 */
export function valueSupportedByQuotes(value, quotes) {
  if (!value || !quotes.length) return 'no_quote';
  const close = (left, right) => Math.abs(left - right) < 0.005;
  switch (value.kind) {
    case 'money': {
      const rupees = value.amountMinor / 100;
      return quotes.some(quote => [...numbersInQuote(quote)].some(number => close(number, rupees))) ? null : 'value_not_in_quote';
    }
    case 'percent':
      return quotes.some(quote => [...numbersInQuote(quote)].some(number => close(number, value.percent))) ? null : 'value_not_in_quote';
    case 'days': case 'months': case 'years': case 'count': {
      // A unit conversion the wording states ("2 years" → 24 months) is allowed.
      const accepted = new Set([value.count, value.kind === 'months' ? value.count / 12 : null, value.kind === 'days' ? value.count / 30 : null].filter(item => item != null));
      return quotes.some(quote => [...numbersInQuote(quote)].some(number => [...accepted].some(item => close(number, item)))) ? null : 'value_not_in_quote';
    }
    case 'date': {
      const [year, month, day] = value.date.split('-').map(Number);
      return quotes.some(quote => {
        const text = quote.toLowerCase();
        const numbers = numbersInQuote(quote);
        return text.includes(String(year)) && (numbers.has(day) || text.includes(String(day).padStart(2, '0'))) && (numbers.has(month) || text.includes(MONTHS[month - 1]) || text.includes(MONTHS[month - 1].slice(0, 3)));
      }) ? null : 'value_not_in_quote';
    }
    case 'text': {
      // Identifier-like text only (policy numbers, phone numbers, UINs). Descriptive text is reviewed by people.
      const needle = alnum(value.text);
      if (!/\d/.test(value.text) || needle.length === 0 || needle.length > 60) return null;
      return quotes.some(quote => alnum(quote).includes(needle)) ? null : 'value_not_in_quote';
    }
    default:
      return null;
  }
}
