// Deterministic citation verification. A value can only become Proven when every quote is found in the
// stored page text AND the value itself appears in a quote. Matching tolerates whitespace, case,
// quote/dash style, rupee notation and HTML table markup only — never digits, decimal points or digit separators.

const REPLACEMENTS = [
  [/[‘’‚‛′]/g, "'"],
  [/[“”„‟″]/g, '"'],
  [/[‐-―−]/g, '-'],
  [/ /g, ' '],
  [/₹|\brs\.?(?=\s*\d)|\binr\b/gi, 'rs '],
  // Sarvam returns tables as HTML; models quote them as "cell | cell". Table markup and pipes become spaces.
  // Only named tags are stripped (never a bare <…>), so text such as "<18 years" is kept.
  [/<\/?(?:table|thead|tbody|tfoot|tr|td|th|br|p|div|span)\b[^>]*>/gi, ' '],
  [/\|/g, ' '],
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
 * method: 'exact' | 'normalised' | 'letters' | 'compact' | 'other_page' | 'adjacent_page' | 'table_aligned'
 *         | 'ellipsis_segments' | 'none'
 */
export function verifyQuote({ quote, pageNumber }, pagesByNumber) {
  if (typeof quote !== 'string' || quote.trim().length < MIN_QUOTE_CHARACTERS) return { matched: false, method: 'none', pageNumber, correctedPage: null };
  const page = pagesByNumber.get(pageNumber);
  if (page) {
    const method = matchOnPage(quote, page.text);
    if (method) return { matched: true, method, pageNumber, correctedPage: null };
  }
  // The model may cite the wrong page; search elsewhere only for distinctive quotes, and record the move.
  if (quote.trim().length >= MIN_CROSS_PAGE_QUOTE_CHARACTERS) {
    const needle = normaliseForMatch(quote);
    const hits = [...pagesByNumber].filter(([number, candidate]) => number !== pageNumber && normaliseForMatch(candidate.text).includes(needle));
    if (hits.length === 1) return { matched: true, method: 'other_page', pageNumber: hits[0][0], correctedPage: hits[0][0] };
    // Repeated text (e.g. a CIS and the wording both state it): accept only the single neighbour of the cited page.
    const adjacent = hits.filter(([number]) => Math.abs(number - pageNumber) === 1);
    if (adjacent.length === 1) return { matched: true, method: 'adjacent_page', pageNumber: adjacent[0][0], correctedPage: adjacent[0][0] };
  }
  if (page && tableAlignedMatch(quote, page.text)) return { matched: true, method: 'table_aligned', pageNumber, correctedPage: null };
  if (page && ellipsisSegmentsMatch(quote, page.text)) return { matched: true, method: 'ellipsis_segments', pageNumber, correctedPage: null };
  return { matched: false, method: 'none', pageNumber, correctedPage: null };
}

function matchOnPage(quote, pageText) {
  if (pageText.includes(quote)) return 'exact';
  if (normaliseForMatch(pageText).includes(normaliseForMatch(quote))) return 'normalised';
  if (!/\d/.test(quote)) {
    const needle = lettersOnly(quote);
    if (needle.length >= 12 && lettersOnly(pageText).includes(needle)) return 'letters';
  }
  if (compactMatch(quote, pageText)) return 'compact';
  return null;
}

// Punctuation/spacing-insensitive match that keeps digits, for OCR and PDF line-break noise around numbers. Every
// number in the quote must also be a number token on the page (commas ignored, decimal points kept), so "1.5%"
// can never match "15%" and no digit can be added, dropped or moved across a decimal point.
const compact = text => normaliseForMatch(text).replace(/[^a-z0-9]+/g, '');
const numberTokens = text => (normaliseForMatch(text).match(/\d+(?:[.,]\d+)*/g) ?? []).map(token => token.replace(/,/g, ''));
function compactMatch(quote, pageText) {
  const needle = compact(quote);
  if (needle.length < 20 || !compact(pageText).includes(needle)) return false;
  const onPage = new Set(numberTokens(pageText));
  return numberTokens(quote).every(token => onPage.has(token));
}

// Models sometimes join two spans of one page with "..." (or "…"). Each span must match the same page on its own,
// in order, and be long enough to be distinctive. Nothing between the spans is claimed.
function ellipsisSegmentsMatch(quote, pageText) {
  const segments = quote.split(/\s*(?:\.{3,}|…)\s*/).map(segment => segment.trim()).filter(Boolean);
  if (segments.length < 2 || segments.length > 6 || segments.some(segment => normaliseForMatch(segment).length < MIN_CROSS_PAGE_QUOTE_CHARACTERS)) return false;
  const haystack = normaliseForMatch(pageText);
  let from = 0;
  for (const segment of segments) {
    const at = haystack.indexOf(normaliseForMatch(segment), from);
    if (at < 0) return false;
    from = at + normaliseForMatch(segment).length;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Table-aligned quotes
// ---------------------------------------------------------------------------
// Models quote an OCR table as "header\nvalue" or "name\trelation\nname\trelation": cells that are not adjacent
// in the page text. Such a quote is accepted only when every fragment equals a real cell of ONE table and the
// cells line up: fragments on one quote line sit in one row, left to right; quote lines sit in later rows; and
// single-cell lines (a header over its value) share a column. Nothing looser — no cross-table or diagonal joins.

const MAX_TABLE_CELLS = 2_000;
const decodeEntities = text => text.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

/** Parses HTML tables into cells with { row, start, end, text } column spans (rowspan/colspan aware). */
export function parseHtmlTables(pageText) {
  const tables = [];
  for (const tableMatch of String(pageText ?? '').matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    const cells = [];
    const occupied = new Map(); // `${row}:${col}` -> true (from rowspans above)
    let row = 0;
    for (const rowMatch of tableMatch[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      let col = 0;
      for (const cellMatch of rowMatch[1].matchAll(/<t([dh])\b([^>]*)>([\s\S]*?)<\/t\1>/gi)) {
        while (occupied.has(`${row}:${col}`)) col += 1;
        const colspan = Math.min(Math.max(Number(/colspan="?(\d+)/i.exec(cellMatch[2])?.[1] ?? 1), 1), 50);
        const rowspan = Math.min(Math.max(Number(/rowspan="?(\d+)/i.exec(cellMatch[2])?.[1] ?? 1), 1), 50);
        for (let r = 1; r < rowspan; r += 1) for (let c = col; c < col + colspan; c += 1) occupied.set(`${row + r}:${c}`, true);
        const text = normaliseForMatch(decodeEntities(cellMatch[3]));
        if (text) cells.push({ row, start: col, end: col + colspan - 1, text });
        col += colspan;
        if (cells.length > MAX_TABLE_CELLS) break;
      }
      row += 1;
    }
    if (cells.length) tables.push(cells);
  }
  return tables;
}

const cellMatches = (fragment, cell) => fragment === cell.text
  || (fragment.length >= MIN_QUOTE_CHARACTERS && !/^[\d.,\s-]+$/.test(fragment) && ` ${cell.text} `.includes(` ${fragment} `));

/** True when a multi-fragment quote maps onto aligned cells of a single table on the page. */
export function tableAlignedMatch(quote, pageText) {
  if (!/<t[dh]\b/i.test(String(pageText ?? ''))) return false;
  const lines = String(quote).split(/\r?\n/)
    .map(line => line.split(/\t|\|/).map(fragment => normaliseForMatch(fragment)).filter(Boolean))
    .filter(line => line.length);
  if (lines.reduce((sum, line) => sum + line.length, 0) < 2 || lines.length > 40) return false;
  const placeLine = (cells, line, minRow) => {
    // Every way this line fits in one row (left to right), at or after minRow.
    const options = [];
    const rows = [...new Set(cells.filter(cell => cell.row >= minRow).map(cell => cell.row))];
    for (const row of rows) {
      const rowCells = cells.filter(cell => cell.row === row).sort((a, b) => a.start - b.start);
      const placed = [];
      let from = 0;
      for (const fragment of line) {
        const index = rowCells.findIndex((cell, i) => i >= from && cellMatches(fragment, cell));
        if (index < 0) { placed.length = 0; break; }
        placed.push(rowCells[index]);
        from = index + 1;
      }
      if (placed.length === line.length) options.push({ row, cells: placed });
    }
    return options;
  };
  const overlaps = (a, b) => a.start <= b.end && b.start <= a.end;
  return parseHtmlTables(pageText).some(cells => {
    const search = (index, minRow, previous) => {
      if (index === lines.length) return true;
      for (const option of placeLine(cells, lines[index], minRow)) {
        if (previous && option.row <= previous.row) continue;
        // A header line over a value line: both single cells, so they must share a column.
        if (previous && previous.cells.length === 1 && option.cells.length === 1 && !overlaps(previous.cells[0], option.cells[0])) continue;
        if (search(index + 1, option.row + 1, option)) return true;
      }
      return false;
    };
    return search(0, 0, null);
  });
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
