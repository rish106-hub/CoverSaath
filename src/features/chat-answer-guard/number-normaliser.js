// Extract and normalise numbers from answer text so the guard can compare across formats.
// Canonical values { kind, value }:
//   money            value = paise (integer)   Rs 5,00,000 == 5 lakh == five lakh == 500k == पांच लाख
//   duration_months  value = months                   36 months == 3 years == 3 yrs; 1 year = 12 months
//   duration_days    value = days                     30 days
//   percent_bps      value = basis points             12.5% = 1250
//   date             value = 'YYYY-MM-DD'
// Month and day durations are different kinds. They compare equal (durationsEqual) only by the documented bridge: 1 month = 30 days,
// or a whole number of years = years * 365 days (so 24 months == 730 days and 36 months == 1080 or 1095 days). Nothing else bridges.
// Bare integers below 1000 carry no unit and are ignored; bare integers of 1000 or more are treated as rupees so an invented
// "500000" cannot slip through the grounding check.

const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const HINDI = 'एक दो तीन चार पांच छह सात आठ नौ दस ग्यारह बारह तेरह चौदह पंद्रह सोलह सत्रह अठारह उन्नीस बीस इक्कीस बाईस तेईस चौबीस पच्चीस छब्बीस सत्ताईस अट्ठाईस उनतीस तीस इकतीस बत्तीस तैंतीस चौंतीस पैंतीस छत्तीस सैंतीस अड़तीस उनतालीस चालीस इकतालीस बयालीस तैंतालीस चौवालीस पैंतालीस छियालीस सैंतालीस अड़तालीस उनचास पचास इक्यावन बावन तिरपन चौवन पचपन छप्पन सत्तावन अट्ठावन उनसठ साठ इकसठ बासठ तिरसठ चौंसठ पैंसठ छियासठ सड़सठ अड़सठ उनहत्तर सत्तर इकहत्तर बहत्तर तिहत्तर चौहत्तर पचहत्तर छिहत्तर सतहत्तर अठहत्तर उनासी अस्सी इक्यासी बयासी तिरासी चौरासी पचासी छियासी सत्तासी अट्ठासी नवासी नब्बे इक्यानवे बानवे तिरानवे चौरानवे पचानवे छियानवे सत्तानवे अट्ठानवे निन्यानवे'.split(' ');
const HINDI_EXTRA = { 'पाँच': 5, 'छः': 6, 'छे': 6, 'पन्द्रह': 15, 'अठाईस': 28 };

const WORD_VALUES = new Map();
for (let n = 1; n <= 99; n += 1) {
  const english = n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`;
  WORD_VALUES.set(english, n);
  if (n % 10 && n > 20) WORD_VALUES.set(english.replace(' ', '-'), n);
  WORD_VALUES.set(HINDI[n - 1], n);
}
for (const [word, n] of Object.entries(HINDI_EXTRA)) WORD_VALUES.set(word, n);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WORD_ALT = [...WORD_VALUES.keys()].sort((a, b) => b.length - a.length).map((w) => escapeRe(w).replace(/ /g, '\\s+').replace(/-/g, '[-\\s]')).join('|');
const DIGITS = '\\d{1,3}(?:,\\d{2,3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?';
const AMT = `(?:${DIGITS}|${WORD_ALT})`;
const NOT_PREV = '(?<![\\p{L}\\p{N}\\p{M}])';
const NOT_NEXT = '(?![\\p{L}\\p{N}\\p{M}])';

const UNIT_WORDS = { lakh: 1e5, lakhs: 1e5, lac: 1e5, lacs: 1e5, 'लाख': 1e5, crore: 1e7, crores: 1e7, cr: 1e7, 'करोड़': 1e7, 'करोड': 1e7, thousand: 1e3, hazaar: 1e3, hajar: 1e3, 'हज़ार': 1e3, 'हजार': 1e3 };
const UNIT_ALT = Object.keys(UNIT_WORDS).sort((a, b) => b.length - a.length).join('|');

function parseAmount(token) {
  const cleaned = token.toLowerCase().replace(/,/g, '').replace(/\s+/g, ' ');
  if (/^\d/.test(cleaned)) return Number(cleaned);
  return WORD_VALUES.get(cleaned) ?? WORD_VALUES.get(cleaned.replace(' ', '-')) ?? null;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, '0');
const validDate = (y, m, d) => { const t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d; };

const DATE_ISO = new RegExp(`${NOT_PREV}(\\d{4})-(\\d{2})-(\\d{2})${NOT_NEXT}`, 'gu');
const DATE_TEXT = new RegExp(`${NOT_PREV}(\\d{1,2})(?:st|nd|rd|th)?\\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?,?\\s+(\\d{4})${NOT_NEXT}`, 'giu');
const DURATION = new RegExp(`${NOT_PREV}(${AMT})\\s*-?\\s*(months?|mos?|years?|yrs?|days?|महीने|महीना|माह|साल|वर्ष|दिन)${NOT_NEXT}`, 'giu');
const PERCENT = new RegExp(`${NOT_PREV}(${AMT})\\s*(%|percent|per\\s+cent|प्रतिशत)`, 'giu');
const MONEY = new RegExp(`${NOT_PREV}(?:(rs\\.?|inr|₹|rupees?)\\s*)?(${AMT})(?:\\s*(${UNIT_ALT})|([kl]))?(?:\\s*(rupees?|rs\\.?|inr|रुपये|रुपए))?${NOT_NEXT}`, 'giu');
const BARE = /(?<![\p{L}\p{N}\p{M}.])(\d{1,3}(?:,\d{2,3})+|\d{4,})(?![\p{L}\p{N}\p{M}])/gu;

const mask = (text, start, end) => text.slice(0, start) + ' '.repeat(end - start) + text.slice(end);

export function extractNumbers(input) {
  let text = String(input ?? '').normalize('NFKC');
  const out = [];
  const scan = (regex, handler) => {
    regex.lastIndex = 0;
    const hits = [...text.matchAll(regex)];
    for (const m of hits) {
      const value = handler(m);
      if (value) { out.push(value); text = mask(text, m.index, m.index + m[0].length); }
    }
  };
  scan(DATE_ISO, (m) => (validDate(+m[1], +m[2], +m[3]) ? { kind: 'date', value: `${m[1]}-${m[2]}-${m[3]}` } : null));
  scan(DATE_TEXT, (m) => {
    const mon = MONTHS[m[2].toLowerCase().slice(0, m[2].toLowerCase().startsWith('sept') ? 4 : 3)] ?? MONTHS[m[2].toLowerCase().slice(0, 3)];
    return mon && validDate(+m[3], mon, +m[1]) ? { kind: 'date', value: `${m[3]}-${pad(mon)}-${pad(+m[1])}` } : null;
  });
  scan(DURATION, (m) => {
    const n = parseAmount(m[1]);
    if (n == null) return null;
    const unit = m[2].toLowerCase();
    if (/^(day|दिन)/.test(unit)) return { kind: 'duration_days', value: Math.round(n) };
    if (/^(year|yr|साल|वर्ष)/.test(unit)) return { kind: 'duration_months', value: Math.round(n * 12) };
    return { kind: 'duration_months', value: Math.round(n) };
  });
  scan(PERCENT, (m) => {
    const n = parseAmount(m[1]);
    return n == null ? null : { kind: 'percent_bps', value: Math.round(n * 100) };
  });
  scan(MONEY, (m) => {
    const [, prefix, amount, unitWord, unitLetter, suffix] = m;
    if (!prefix && !unitWord && !unitLetter && !suffix) return null;
    const n = parseAmount(amount);
    if (n == null) return null;
    const mult = unitWord ? UNIT_WORDS[unitWord.toLowerCase()] : unitLetter ? (unitLetter.toLowerCase() === 'k' ? 1e3 : 1e5) : 1;
    return { kind: 'money', value: Math.round(n * mult * 100) };
  });
  scan(BARE, (m) => ({ kind: 'money', value: Math.round(Number(m[1].replace(/,/g, '')) * 100) }));
  return out;
}

// Months and days are different kinds. The only bridge: 1 month = 30 days, or whole years * 365 days. Documented above and tested.
export function durationsEqual(a, b) {
  if (a.kind === b.kind) return a.value === b.value;
  const [months, days] = a.kind === 'duration_months' ? [a, b] : [b, a];
  if (months.kind !== 'duration_months' || days.kind !== 'duration_days') return false;
  return days.value === months.value * 30 || (months.value % 12 === 0 && days.value === (months.value / 12) * 365);
}

export function numbersEqual(a, b) {
  if (!a || !b) return false;
  if (a.kind.startsWith('duration_') && b.kind.startsWith('duration_')) return durationsEqual(a, b);
  return a.kind === b.kind && a.value === b.value;
}

// A value list may hold canonical objects, raw strings (extracted), or structured renderings of one fact (B12):
//   { kind:'duration', days:730 }  -> 730 days, and 24 months when days is a whole number of years (days/365*12) or of 30-day months
//   { kind:'money', amountMinor }  -> paise;  { kind:'date', iso|endsOn } -> date;  { kind:'duration', months }
// Any rendering of the same value therefore grounds "2 years", "24 months" and "730 days".
function expandEntry(entry) {
  if (entry.kind === 'duration') {
    const out = [];
    if (Number.isInteger(entry.days)) {
      out.push({ kind: 'duration_days', value: entry.days });
      if (entry.days % 365 === 0) out.push({ kind: 'duration_months', value: (entry.days / 365) * 12 });
      else if (entry.days % 30 === 0) out.push({ kind: 'duration_months', value: entry.days / 30 });
    }
    if (Number.isInteger(entry.months)) out.push({ kind: 'duration_months', value: entry.months });
    return out;
  }
  if (entry.kind === 'money' && Number.isInteger(entry.amountMinor)) return [{ kind: 'money', value: entry.amountMinor }];
  if (entry.kind === 'date' && typeof (entry.iso ?? entry.endsOn) === 'string') return [{ kind: 'date', value: entry.iso ?? entry.endsOn }];
  return typeof entry.value === 'number' || typeof entry.value === 'string' ? [{ kind: entry.kind, value: entry.value }] : [];
}

export function toCanonicalValues(list) {
  const out = [];
  for (const entry of list ?? []) {
    if (entry && typeof entry === 'object' && typeof entry.kind === 'string') out.push(...expandEntry(entry));
    else if (typeof entry === 'string') out.push(...extractNumbers(entry));
  }
  return out;
}

export function isGrounded(number, pool) {
  return pool.some((candidate) => numbersEqual(number, candidate));
}
