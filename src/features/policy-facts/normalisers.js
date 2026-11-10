// Table-driven normalisers for policy facts (ADR 0025). Pure: no I/O, no model, never throws on odd text (returns null).
//
// Each kind has two functions:
//   scan(text)     the segments of a text that could hold a value of that kind (bounded work, no backtracking-heavy patterns)
//   parse(segment) one segment -> a value object, or null when it is not a value of that kind
// `valuesIn(kind, text)` is scan + parse: the evidence verifier runs it on a quote to prove the stored value is really printed there.
//
// Conventions (FOR REVIEW):
//   * Money is INR in minor units (paise). Lakh = 100,000 and crore = 10,000,000 rupees. A "per day" style rate is not a plain amount and is refused.
//   * Dates are the printed calendar date (Indian day-first order for dd/mm/yyyy), with no time zone and no time. IST is the assumed calendar.
//   * Durations become days: a year is 365 days, a month is 30 days, and twelve months carry into a year first (36 months = 3 years = 1095 days).
//     The printed amount and unit are kept in the sealed value so nothing printed is lost.
//   * Percentages become basis points (1% = 100 bp).
//   * A seller is never inferred: only a printed word gives a type, and "direct" needs that exact word.

import { createHash } from 'node:crypto';
import { normalizeValue } from '../policy-structuring/validator.js';

export const NORMALISER_VERSION = 'pf-norm.1';

const MAX_TEXT = 4000;
const MAX_SEGMENTS = 50;
const MAX_MINOR = 10_000_000_000_000; // 100 billion rupees: far above any cover, rejects runaway numbers

export const AMOUNT_BANDS = Object.freeze(['lt_10k', '10k_50k', '50k_1l', '1l_5l', '5l_10l', '10l_25l', '25l_50l', '50l_1cr', 'gte_1cr']);

/** The coarse plaintext band of an amount in paise. */
export function amountBand(amountMinor) {
  const rupees = amountMinor / 100;
  if (rupees < 10_000) return 'lt_10k';
  if (rupees < 50_000) return '10k_50k';
  if (rupees < 100_000) return '50k_1l';
  if (rupees < 500_000) return '1l_5l';
  if (rupees < 1_000_000) return '5l_10l';
  if (rupees < 2_500_000) return '10l_25l';
  if (rupees < 5_000_000) return '25l_50l';
  if (rupees < 10_000_000) return '50l_1cr';
  return 'gte_1cr';
}

const nfc = text => (typeof text === 'string' ? text.normalize('NFC') : '');
const bounded = text => nfc(text).slice(0, MAX_TEXT);
const matches = (pattern, text) => [...bounded(text).matchAll(pattern)].slice(0, MAX_SEGMENTS).map(match => match[0]);

// ---- money ----

const MONEY_SCAN = /(?:₹|\brs\b\.?|\binr\b|\brupees\b)\s*\d[\d,]{0,20}(?:\.\d{1,2})?(?:\s*(?:lakhs?|lacs?|crores?|cr|l)\b)?(?:\s*\/-)?|\d[\d,]{0,20}(?:\.\d{1,2})?\s*(?:lakhs?|lacs?|crores?)\b|\d[\d,]{0,20}\s*\/-|\d[\d,]{0,20}(?:\.\d{1,2})?\s*\(\s*rupees\b[^)]{0,100}\)/gi;

function parseMoney(segment) {
  const stripped = nfc(segment).replace(/\([^)]*\)/g, ' ').replace(/\b(?:only|rupees)\b/gi, ' ');
  const value = normalizeValue('money', stripped);
  if (!value || value.per || !Number.isSafeInteger(value.amountMinor) || value.amountMinor < 0 || value.amountMinor > MAX_MINOR) return null;
  return { amountMinor: value.amountMinor, currency: 'INR' };
}

// ---- dates ----

const MONTH_NAMES = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const DATE_TOKEN = new RegExp(`\\b\\d{4}-\\d{2}-\\d{2}\\b|\\b\\d{1,2}[/-]\\d{1,2}[/-]\\d{4}\\b|\\b\\d{1,2}(?:st|nd|rd|th)?[\\s-](?:${MONTH_NAMES})\\.?,?[\\s-]\\d{4}\\b`, 'gi');

function parseDate(segment) {
  const value = normalizeValue('date', nfc(segment).replace(/(\d)(?:st|nd|rd|th)\b/gi, '$1').replace(/,/g, ' '));
  if (!value?.iso) return null;
  const year = Number(value.iso.slice(0, 4));
  return year >= 1990 && year <= 2100 ? { iso: value.iso } : null;
}

const dayNumber = iso => Math.round(Date.parse(`${iso}T00:00:00Z`) / 86_400_000);

function dateTokens(text) {
  return matches(DATE_TOKEN, text);
}

function scanDateRange(text) {
  const tokens = dateTokens(text);
  return tokens.length === 2 ? [bounded(text)] : [];
}

function parseDateRange(segment) {
  const tokens = dateTokens(segment);
  if (tokens.length !== 2) return null;
  const [start, end] = tokens.map(parseDate);
  if (!start || !end || start.iso > end.iso) return null;
  const days = dayNumber(end.iso) - dayNumber(start.iso) + 1;
  return days >= 1 && days <= 36_600 ? { startIso: start.iso, endIso: end.iso, days } : null;
}

// ---- durations (days, with the printed units kept) ----

const WORD_NUMBERS = Object.freeze({ one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, twenty: 20, thirty: 30, sixty: 60, ninety: 90 });
const NUMBER_WORD = `\\d{1,4}|${Object.keys(WORD_NUMBERS).join('|')}`;
const DURATION_UNIT = '(?:years?|yrs?|months?|days?)';
const DURATION_SCAN = new RegExp(`\\b(?:${NUMBER_WORD})\\s*\\)?\\s*${DURATION_UNIT}\\b(?:\\s*(?:,|and|&)?\\s*(?:${NUMBER_WORD})\\s*\\)?\\s*${DURATION_UNIT}\\b){0,2}|\\b(?:nil|none)\\b`, 'gi');
const DURATION_PART = new RegExp(`(${NUMBER_WORD})\\s*\\)?\\s*(years?|yrs?|months?|days?)\\b`, 'gi');
const unitOf = raw => (raw.toLowerCase().startsWith('y') ? 'year' : raw.toLowerCase().startsWith('m') ? 'month' : 'day');
const UNIT_RANK = Object.freeze({ year: 0, month: 1, day: 2 });

function parseDuration(segment) {
  const text = bounded(segment).trim().toLowerCase();
  if (/^(?:nil|none)$/.test(text)) return { days: 0, original: [{ amount: 0, unit: 'day' }] };
  const parts = [...text.matchAll(DURATION_PART)].map(match => ({
    amount: /^\d+$/.test(match[1]) ? Number(match[1]) : WORD_NUMBERS[match[1]],
    unit: unitOf(match[2]),
  }));
  if (parts.length === 0 || parts.length > 3) return null;
  // Units appear once each, largest first ("2 years 6 months"); anything else is ambiguous.
  for (let index = 1; index < parts.length; index += 1) if (UNIT_RANK[parts[index].unit] <= UNIT_RANK[parts[index - 1].unit]) return null;
  if (parts.some(part => !Number.isInteger(part.amount) || part.amount < 0 || part.amount > 1200)) return null;
  const years = parts.find(part => part.unit === 'year')?.amount ?? 0;
  const months = (parts.find(part => part.unit === 'month')?.amount ?? 0) + years * 12;
  const extraDays = parts.find(part => part.unit === 'day')?.amount ?? 0;
  const days = Math.floor(months / 12) * 365 + (months % 12) * 30 + extraDays;
  return days <= 36_600 ? { days, original: parts } : null;
}

// ---- percentages (basis points) ----

const PERCENT_SCAN = /\d{1,3}(?:\.\d{1,2})?\s*(?:%|percent\b|per cent\b)/gi;

function parsePercent(segment) {
  const match = /^(\d{1,3}(?:\.\d{1,2})?)\s*(?:%|percent|per cent)$/i.exec(bounded(segment).trim());
  if (!match) return null;
  const bp = Math.round(Number(match[1]) * 100);
  return bp >= 0 && bp <= 10_000 ? { bp } : null;
}

// ---- plain numbers and ages ----

function parseNumber(segment) {
  const match = /^\d{1,9}$/.exec(bounded(segment).trim());
  return match ? { n: Number(match[0]) } : null;
}

const AGE_SCAN = /\bage\s*[:\-]?\s*\d{1,3}\b|\b\d{1,3}\s*(?:years?|yrs?)(?:\s*old)?\b/gi;

function parseAge(segment) {
  const match = /(\d{1,3})/.exec(bounded(segment));
  const n = match ? Number(match[1]) : NaN;
  return Number.isInteger(n) && n >= 0 && n <= 120 ? { n } : null;
}

// ---- closed vocabularies ----

const keywordKind = (table) => {
  const names = Object.keys(table);
  return {
    scan: text => (names.some(name => table[name].test(bounded(text))) ? [bounded(text)] : []),
    parse: segment => {
      const found = names.filter(name => table[name].test(bounded(segment)));
      return found.length === 1 ? { value: found[0] } : null;
    },
  };
};

export const PAYMENT_MODES = Object.freeze(['upi', 'credit_card', 'debit_card', 'net_banking', 'cheque', 'cash', 'auto_debit', 'wallet']);
export const PAYMENT_FREQUENCIES = Object.freeze(['single', 'annual', 'half_yearly', 'quarterly', 'monthly']);
export const SELLER_TYPES = Object.freeze(['agent', 'broker', 'posp', 'bancassurance', 'aggregator', 'direct', 'insurer_branch', 'unknown']);

const PAYMENT_MODE = keywordKind({
  upi: /\bupi\b|\bbhim\b/i,
  credit_card: /\bcredit[\s-]*card\b|\bcc\b/i,
  debit_card: /\bdebit[\s-]*card\b/i,
  net_banking: /\bnet[\s-]*banking\b|\binternet[\s-]*banking\b|\bonline[\s-]*banking\b/i,
  cheque: /\bche(?:que|ck)\b|\bdemand[\s-]*draft\b/i,
  cash: /\bcash\b/i,
  auto_debit: /\bnach\b|\becs\b|\bauto[\s-]*debit\b|\bstanding[\s-]*instruction\b|\be[\s-]?mandate\b/i,
  wallet: /\bwallet\b/i,
});

const PAYMENT_FREQUENCY = keywordKind({
  single: /\bsingle[\s-]*(?:premium|pay)\b|\bone[\s-]*time\b|\blump[\s-]*sum\b/i,
  annual: /\bannual(?:ly)?\b|(?<!half[\s-]*)\byearly\b/i,
  half_yearly: /\bhalf[\s-]*yearly\b|\bsemi[\s-]*annual(?:ly)?\b/i,
  quarterly: /\bquarterly\b/i,
  monthly: /\bmonthly\b/i,
});

// 'unknown' is never produced from text: it is the value of an absent seller. Order matters only through exclusivity (exactly one hit).
const SELLER_TYPE = keywordKind({
  posp: /\bposp\b|\bpoint[\s-]*of[\s-]*sales?\b/i,
  bancassurance: /\bbancassurance\b|\bbanca\b/i,
  aggregator: /\baggregators?\b/i,
  broker: /\bbrokers?\b|\bbrokerage\b/i,
  agent: /\b(?:individual\s+|corporate\s+)?agents?\b/i,
  direct: /\bdirect\b/i,
  insurer_branch: /\binsurer\s+branch\b|\bbranch\s+office\b/i,
});

// A seller type that names both a POSP and an agent (a POSP is a kind of agent) is the POSP.
function parseSellerType(segment) {
  const text = bounded(segment);
  if (/\bposp\b|\bpoint[\s-]*of[\s-]*sales?\b/i.test(text)) return { value: 'posp' };
  return SELLER_TYPE.parse(text);
}

// ---- free text ----

const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/u;
function parseText(segment) {
  const text = bounded(segment).replace(/\s+/g, ' ').trim();
  return text.length >= 1 && text.length <= 300 && !CONTROL.test(text) ? { text } : null;
}

const KINDS = Object.freeze({
  money: { scan: text => matches(MONEY_SCAN, text), parse: parseMoney },
  date: { scan: dateTokens, parse: parseDate },
  date_range: { scan: scanDateRange, parse: parseDateRange },
  duration: { scan: text => matches(DURATION_SCAN, text), parse: parseDuration },
  percent: { scan: text => matches(PERCENT_SCAN, text), parse: parsePercent },
  number: { scan: text => matches(/\b\d{1,9}\b/g, text), parse: parseNumber },
  age: { scan: text => matches(AGE_SCAN, text), parse: parseAge },
  payment_mode: PAYMENT_MODE,
  payment_frequency: PAYMENT_FREQUENCY,
  seller_type: { scan: SELLER_TYPE.scan, parse: parseSellerType },
  text: { scan: text => (bounded(text).trim() ? [bounded(text)] : []), parse: parseText },
});

export const NORMALISER_KINDS = Object.freeze(Object.keys(KINDS));

export function scan(kind, text) {
  if (!Object.hasOwn(KINDS, kind) || typeof text !== 'string') return [];
  try { return KINDS[kind].scan(text); } catch { return []; }
}

export function parse(kind, segment) {
  if (!Object.hasOwn(KINDS, kind) || typeof segment !== 'string') return null;
  try { return KINDS[kind].parse(segment); } catch { return null; }
}

/** Every value of `kind` that parses from a text, in order of appearance. */
export function valuesIn(kind, text) {
  return scan(kind, text).map(segment => parse(kind, segment)).filter(value => value !== null);
}

/** The part of a value that decides equality (a duration is its days; the printed unit does not matter). */
export function comparable(kind, value) {
  if (!value || typeof value !== 'object') return null;
  switch (kind) {
    case 'money': return String(value.amountMinor);
    case 'date': return value.iso;
    case 'date_range': return `${value.startIso}/${value.endIso}`;
    case 'duration': return String(value.days);
    case 'percent': return String(value.bp);
    case 'number': case 'age': return String(value.n);
    case 'payment_mode': case 'payment_frequency': case 'seller_type': return value.value;
    case 'text': return nfc(value.text);
    default: return null;
  }
}

/** Canonical JSON (sorted keys) of a value, the plaintext that gets sealed. */
export function canonicalJson(value) {
  const sort = item => (Array.isArray(item) ? item.map(sort)
    : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(key => [key, sort(item[key])]))
      : item);
  return JSON.stringify(sort(value));
}

/**
 * Splits a value into the plaintext coarse columns and the sealed canonical value of policy_facts (migration 044 shape CHECK).
 * `valueType` is the storage type of the fact type. Returns null when the value does not fit the type.
 */
export function toStorage(valueType, value) {
  if (!value || typeof value !== 'object') return null;
  const empty = { currency: null, amountBand: null, durationDays: null, percentBp: null, bool: null, enumValue: null, ym: null, sealed: null };
  switch (valueType) {
    case 'money':
      return Number.isSafeInteger(value.amountMinor) ? { ...empty, currency: 'INR', amountBand: amountBand(value.amountMinor), sealed: canonicalJson({ amountMinor: value.amountMinor, currency: 'INR' }) } : null;
    case 'date':
      return typeof value.iso === 'string' ? { ...empty, ym: value.iso.slice(0, 7), sealed: canonicalJson({ iso: value.iso }) } : null;
    case 'date_range':
      return typeof value.startIso === 'string' ? { ...empty, ym: value.startIso.slice(0, 7), durationDays: value.days, sealed: canonicalJson({ days: value.days, endIso: value.endIso, startIso: value.startIso }) } : null;
    case 'duration':
      return Number.isInteger(value.days) ? { ...empty, durationDays: value.days, sealed: canonicalJson({ days: value.days, original: value.original ?? [] }) } : null;
    case 'percent':
      return Number.isInteger(value.bp) ? { ...empty, percentBp: value.bp } : null;
    case 'number':
      return Number.isInteger(value.n) ? { ...empty, sealed: canonicalJson({ n: value.n }) } : null;
    case 'enum':
      return typeof value.value === 'string' ? { ...empty, enumValue: value.value } : null;
    case 'bool':
      return typeof value.value === 'boolean' ? { ...empty, bool: value.value } : null;
    case 'text':
      return typeof value.text === 'string' ? { ...empty, sealed: canonicalJson({ text: nfc(value.text) }) } : null;
    default:
      return null;
  }
}

// ---- compound normalisers used by the extractors ----

/**
 * A no-claim bonus table: "10%, 20%, 30%" (years 1..n) or "Year 1: 10%, Year 2: 20%". Returns { tiers: [{ year, bp }], maxBp } or null.
 * Refuses a table with a repeated year, more than 20 tiers, or fewer than one tier.
 */
export function parseNcbTiers(text) {
  const source = bounded(text);
  const labelled = [...source.matchAll(/\b(?:year|yr)\s*(\d{1,2})\s*[:\-]?\s*(\d{1,3}(?:\.\d{1,2})?)\s*(?:%|percent\b|per cent\b)/gi)]
    .map(match => ({ year: Number(match[1]), bp: Math.round(Number(match[2]) * 100) }));
  const percents = valuesIn('percent', source).map(value => value.bp);
  const tiers = labelled.length > 0 ? labelled : percents.map((bp, index) => ({ year: index + 1, bp }));
  if (tiers.length < 1 || tiers.length > 20) return null;
  if (new Set(tiers.map(tier => tier.year)).size !== tiers.length) return null;
  if (tiers.some(tier => tier.year < 1 || tier.year > 20 || tier.bp < 0 || tier.bp > 10_000)) return null;
  return { tiers, maxBp: Math.max(...tiers.map(tier => tier.bp)) };
}

/**
 * One premium payment as printed: { mode, dateIso, amountMinor }, each null when absent. Needs a mode or a date; refuses a line with
 * two different modes or two dates (that is two payments; read them separately).
 */
export function parsePaymentEvent(text) {
  const source = bounded(text);
  const dates = valuesIn('date', source);
  const modes = valuesIn('payment_mode', source);
  const amounts = valuesIn('money', source);
  if (dates.length > 1 || modes.length > 1 || amounts.length > 1) return null;
  if (dates.length === 0 && modes.length === 0) return null;
  return { mode: modes[0]?.value ?? null, dateIso: dates[0]?.iso ?? null, amountMinor: amounts[0]?.amountMinor ?? null };
}

/** The ages printed in a text ("34 yrs, 36 yrs, 5 yrs" or "Age: 34"), in order. Never a date of birth. */
export function parseMemberAges(text) {
  return valuesIn('age', text).map(value => value.n);
}

/** sha256 hex of the NFC form of a text (used for page-level digests, never for a short value). */
export const sha256Nfc = text => createHash('sha256').update(nfc(text)).digest('hex');
