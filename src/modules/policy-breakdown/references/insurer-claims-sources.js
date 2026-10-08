// Insurer-published claims data beyond HDFC ERGO. IRDAI requires every general insurer to publish Form NL-37
// ("Claims Data", counts of claims by segment, cumulative for the financial year up to the quarter end) on its own
// website. The Health column is parsed here. Every parser is deterministic and fails closed: a table whose rows
// do not reconcile (opening + booked + reopened - paid - repudiated - closed = outstanding at end) is rejected.
//
// Scope note: the NL-37 "Health" column is the insurer's WHOLE health line (retail + group + government), not
// retail only, and the period runs from 1 April of the financial year to the quarter end. Parsed results carry
// `segment: 'health_all_lines'` so callers can word the source accurately.
//
// Input: NL-37 is published as a PDF. `INSURER_CLAIMS_INPUT[id]` says 'pdf' (convert bytes with
// `parseNl37HealthPdf`, or join `extractPdfTextPages` output yourself and call the text parser) or 'html'.
// PDF links roll each quarter on most sites, so an operator re-checks the canonicalUrl every quarter; an old
// link keeps parsing to its (clearly dated) old period and never fabricates a newer one.
import { defineOfficialSource } from './official/contracts.js';
import { extractPdfTextPages } from './official/pdf-text.js';

const OWNER = 'knowvia-policy-breakdown';
const MIN_DISPOSED_CLAIMS = 100;
const MIN_ROW_NUMBERS = 15;
const HEALTH_INDEX = 7; // Fire, Marine Cargo, Marine Hull, Total Marine, Motor OD, Motor TP, Total Motor, Health
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const QUARTER_END = { 1: [6, 30], 2: [9, 30], 3: [12, 31], 4: [3, 31] };

const iso = (year, month, day) => `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
const lastDay = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();
const monthOf = name => MONTHS[String(name).slice(0, 3).toLowerCase()] ?? null;
const fullYear = value => (String(value).length === 2 ? 2000 + Number(value) : Number(value));

/** Quarter end as { year, month, day } from the wording NL-37 headers use, or null. */
function quarterEnd(text) {
  const t = String(text);
  let m = /q([1-4])\s*(?:of\s*)?fy\s*['’]?\s*(\d{4})\s*[-–/]\s*(\d{2,4})/i.exec(t);
  if (m) {
    const [month, day] = QUARTER_END[Number(m[1])];
    const startYear = Number(m[2]);
    return { year: Number(m[1]) === 4 ? startYear + 1 : startYear, month, day };
  }
  m = /quarter\s+ending\s+(?:on\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})/i.exec(t);
  if (m && monthOf(m[2])) return { year: Number(m[3]), month: monthOf(m[2]), day: Number(m[1]) };
  m = /as\s+(?:at|on)\s+([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/i.exec(t);
  if (m && monthOf(m[1])) return { year: Number(m[3]), month: monthOf(m[1]), day: Number(m[2]) };
  m = /quarter\s+ending\s+(?:on\s+)?([A-Za-z]{3,9})\.?[\s'’,]+(\d{2}|\d{4})\b/i.exec(t);
  if (m && monthOf(m[1])) { const year = fullYear(m[2]); const month = monthOf(m[1]); return { year, month, day: lastDay(year, month) }; }
  return null;
}

/** Cumulative financial-year period up to a quarter end: { label, start, end } or null. */
export function nl37Period(text) {
  const end = quarterEnd(text);
  if (!end || !Object.values(QUARTER_END).some(([month, day]) => month === end.month && day === end.day)) return null;
  const startYear = end.month >= 4 ? end.year : end.year - 1;
  const monthName = Object.keys(MONTHS).find(key => MONTHS[key] === end.month);
  const label = `FY ${startYear}-${String(startYear + 1).slice(2)} up to ${monthName[0].toUpperCase()}${monthName.slice(1)} ${end.year}`;
  return { label, start: iso(startYear, 4, 1), end: iso(end.year, end.month, end.day) };
}

const NUMBER_TOKEN = /^\(?-?\d[\d,]*\)?$|^-$/;
function toNumber(token) {
  if (token === '-') return 0;
  const negative = token.startsWith('(') || token.startsWith('-');
  const value = Number(token.replace(/[(),-]/g, ''));
  return negative ? -value : value;
}

/** Splits a line into its label prefix and trailing run of numeric tokens. */
function splitRow(line) {
  const tokens = line.trim().split(/\s+/);
  let start = tokens.length;
  while (start > 0 && NUMBER_TOKEN.test(tokens[start - 1])) start -= 1;
  return { prefix: tokens.slice(0, start).join(' '), numbers: tokens.slice(start) };
}

const BLANK_LABEL = /^[\s_()ivx.\-–]*$/i;
function roleOf(prefix, recent, taken) {
  const p = prefix.toLowerCase();
  if (/beginning of the period/.test(p)) return 'opening';
  if (/booked during/.test(p)) return 'booked';
  if (/reopened/.test(p)) return 'reopened';
  if (/paid during the period/.test(p)) return 'paid';
  if (/repudiated during the period/.test(p)) return 'repudiated';
  if (/closed/.test(p)) return 'closed';
  if (/less than 3\s*months/.test(p)) return 'bucket1';
  if (/3\s*months\s*to\s*6/.test(p)) return 'bucket2';
  if (/6\s*months\s*to\s*1\s*year/.test(p)) return 'bucket3';
  if (/1\s*year\s*and\s*above|above\s*1\s*year/.test(p)) return 'bucket4';
  if (BLANK_LABEL.test(p)) {
    const hint = recent.join(' ').toLowerCase();
    if (!taken.has('paid') && /paid during the period/.test(hint)) return 'paid';
    if (!taken.has('closed') && /other than repudiated|closed claims|closed without/.test(hint)) return 'closed';
  }
  return null;
}

/**
 * Parses IRDAI Form NL-37 text and returns the Health column.
 * { ok: true, period, counts, disposed, averageReimbursementDays: null, segment } or { ok: false, reason }.
 */
export function parseNl37HealthText(text) {
  const source = String(text ?? '');
  if (!/NL-?\s?37|claims data/i.test(source)) return { ok: false, reason: 'nl37_not_found' };
  if (!/Motor TP\s+Total Motor\s+Health\s+Personal\s+Accident\s+Travel\s+Total Health/i.test(source.replace(/\s+/g, ' '))) return { ok: false, reason: 'nl37_columns_unrecognised' };
  const period = nl37Period(source);
  if (!period) return { ok: false, reason: 'period_not_found' };

  const rows = new Map();
  let expected = 0;
  let recent = [];
  for (const line of source.split('\n')) {
    if (/in\s+lakhs/i.test(line) && rows.size > 0) break; // amounts table follows the counts table
    const { prefix, numbers } = splitRow(line);
    if (numbers.length < MIN_ROW_NUMBERS) {
      if (line.trim()) recent = [...recent, line].slice(-3);
      continue;
    }
    const role = roleOf(prefix, recent, rows);
    if (!role || rows.has(role)) continue;
    if (role === 'opening') expected = numbers.length;
    let cells = numbers;
    if (expected && cells.length > expected && cells.slice(0, cells.length - expected).every(token => token === '-')) cells = cells.slice(cells.length - expected);
    if (!expected || cells.length !== expected) return { ok: false, reason: 'row_shape_mismatch' };
    rows.set(role, cells.map(toNumber));
  }

  const roles = ['opening', 'booked', 'reopened', 'paid', 'repudiated', 'closed', 'bucket1', 'bucket2', 'bucket3', 'bucket4'];
  if (roles.some(role => !rows.has(role))) return { ok: false, reason: 'claims_rows_incomplete' };
  const opening = rows.get('opening');
  if (opening[HEALTH_INDEX] + opening[HEALTH_INDEX + 1] + opening[HEALTH_INDEX + 2] !== opening[HEALTH_INDEX + 3]) return { ok: false, reason: 'health_column_not_aligned' };
  const at = role => rows.get(role)[HEALTH_INDEX];
  const counts = {
    opening: at('opening'),
    intimated: at('booked') + at('reopened'),
    paid: at('paid'),
    repudiated: at('repudiated'),
    closedWithoutPayment: at('closed'),
    closing: at('bucket1') + at('bucket2') + at('bucket3') + at('bucket4'),
  };
  if (Object.values(counts).some(value => !Number.isInteger(value) || value < 0)) return { ok: false, reason: 'claims_rows_invalid' };
  if (counts.opening + counts.intimated - counts.paid - counts.repudiated - counts.closedWithoutPayment !== counts.closing) return { ok: false, reason: 'claims_table_does_not_reconcile' };
  const disposed = counts.paid + counts.repudiated + counts.closedWithoutPayment;
  if (disposed < MIN_DISPOSED_CLAIMS) return { ok: false, reason: 'too_few_disposed_claims' };
  return { ok: true, period, counts, disposed, averageReimbursementDays: null, segment: 'health_all_lines' };
}

/** PDF bytes -> parsed Health column. Uses the text layer only (no OCR). */
export async function parseNl37HealthPdf(bytes) {
  try {
    // Some insurers publish one combined disclosure PDF; keep only the NL-37 counts page and the page after it.
    const pages = await extractPdfTextPages(bytes, { maxPages: 200 });
    const first = pages.findIndex(page => /claims experience/i.test(page.text) && /beginning of the period/i.test(page.text));
    const chosen = first < 0 ? pages : pages.slice(first, first + 2);
    return parseNl37HealthText(chosen.map(page => page.text).join('\n'));
  } catch {
    return { ok: false, reason: 'pdf_text_unreadable' };
  }
}

const source = ({ id, publisher, url, hosts, maxBytes = 5 * 1024 * 1024 }) => ({
  id,
  sourceClass: 'insurer_disclosure',
  documentType: 'regulatory_disclosure',
  publisher,
  identity: { scope: 'insurer', legalInsurerName: publisher, uin: null, productName: null, version: null, effectiveFrom: null, effectiveTo: null },
  canonicalUrl: url,
  allowedHosts: hosts,
  expectedMimeTypes: ['application/pdf'],
  maxBytes,
  freshnessDays: 7,
  owner: OWNER,
});

/** Raw registry entries (shape accepted by defineOfficialSource). Each URL was opened and parsed on 2026-10-08. */
export const INSURER_CLAIMS_SOURCES = Object.freeze([
  source({ id: 'go-digit.claims-data', publisher: 'Go Digit General Insurance Limited', url: 'https://www.godigit.com/content/dam/godigit/general/financials/public-disclosure/fy-26-27/nl-37-claims-data.pdf', hosts: ['www.godigit.com'] }),
  source({ id: 'bajaj-general.claims-data', publisher: 'Bajaj General Insurance Limited', url: 'https://www.bajajgeneralinsurance.com/download-documents/financialinformation_general/2026-27q1/NL-37.pdf', hosts: ['www.bajajgeneralinsurance.com'] }),
  source({ id: 'iffco-tokio.claims-data', publisher: 'IFFCO-Tokio General Insurance Company Limited', url: 'https://www.iffcotokio.co.in/content/dam/iffcotokio/iffco-pdf/public-disclosure-june-2026.pdf', hosts: ['www.iffcotokio.co.in'], maxBytes: 12 * 1024 * 1024 }),
  source({ id: 'tata-aig.claims-data', publisher: 'Tata AIG General Insurance Company Limited', url: 'https://www.tataaig.com/s3/NL_37_cd0a8a2531.pdf', hosts: ['www.tataaig.com'] }),
].map(raw => Object.freeze(raw)));

export const INSURER_CLAIMS_PARSERS = Object.freeze(Object.fromEntries(INSURER_CLAIMS_SOURCES.map(entry => [entry.id, parseNl37HealthText])));
export const INSURER_CLAIMS_INPUT = Object.freeze(Object.fromEntries(INSURER_CLAIMS_SOURCES.map(entry => [entry.id, 'pdf'])));

/** Validated sources, ready to append to the official registry. */
export const defineInsurerClaimsSources = () => INSURER_CLAIMS_SOURCES.map(defineOfficialSource);
