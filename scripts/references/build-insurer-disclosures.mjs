#!/usr/bin/env node
// Builds insurer-disclosures.json (reference-store format) from the IRDAI "Handbook on Indian Insurance
// Statistics", a ZIP of XLSX workbooks (Part II = non-life, Part III = health).
//
//   node scripts/references/build-insurer-disclosures.mjs [handbook.zip] [--out dir] [--published-on yyyy-mm-dd] [--period FY2024-25]
//
// With no file argument the official ZIP is downloaded (the IRDAI site rejects clients without a browser user agent).
// Tables used (every entry names its table in `source`):
//   Table 53 (Part II)  Status of Claims of General and Health Insurers   -> claim_settlement_ratio_count, repudiation_ratio
//   Table 62 (Part III) Health insurance NEP, incurred claims and ICR      -> incurred_claim_ratio (health business only)
//   Table 49 (Part II)  Solvency Ratio of General, Health and Reinsurers   -> solvency_ratio
// Deliberately NOT produced: claim_settlement_ratio_amount (the handbook has no per-insurer claim amounts),
// average_settlement_days, complaints_per_10k_claims (Table 56 mixes complaint types and its 2024-25 layout is
// not claim-linked), and count ratios for general insurers (Table 53 pools motor/crop/fire/health for them, which
// says nothing about a health policy). Stand-alone health insurers are health-only, so their count ratios are valid.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readZip } from '../../src/modules/policy-breakdown/ocr/zip-reader.js';

export const HANDBOOK = Object.freeze({
  url: 'https://irdai.gov.in/documents/37343/825690/Handbook+on+Indian+Insurance+Statistics+2024-25.zip/c754826c-a24f-6adf-65d9-bba0e1bb8d2a?version=1.1&t=1770357151427&download=true',
  title: 'IRDAI Handbook on Indian Insurance Statistics 2024-25',
  page: 'https://irdai.gov.in/handbook-of-indian-insurance',
  period: 'FY2024-25',
  fiscalLabel: '2024-25',
  publishedOn: '2026-02-03',
});
export const MIN_CLAIMS_FOR_RATIO = 100;

// ---------------------------------------------------------------------------
// XLSX reading (zip of XML; no dependency)
// ---------------------------------------------------------------------------

const decodeXml = text => text
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&amp;/g, '&');

const textOf = xml => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(m => decodeXml(m[1])).join('');

function columnIndex(ref) {
  let n = 0;
  for (const ch of ref.replace(/[0-9]/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Returns Map<sheetName, Array<Array<string|number|null>>> (rows indexed 0.., columns indexed 0..). */
export function parseXlsx(input) {
  const files = readZip(input);
  const get = name => { const f = files.get(name); if (!f) throw new Error(`xlsx part missing: ${name}`); return f.toString('utf8'); };
  const shared = files.has('xl/sharedStrings.xml')
    ? [...get('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => textOf(m[1]))
    : [];
  const rels = new Map([...get('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b[^>]*>/g)].map(m => {
    const tag = m[0];
    return [tag.match(/\bId="([^"]+)"/)?.[1], tag.match(/\bTarget="([^"]+)"/)?.[1]];
  }));
  const sheets = new Map();
  for (const m of get('xl/workbook.xml').matchAll(/<sheet\b[^>]*>/g)) {
    const name = decodeXml(m[0].match(/\bname="([^"]*)"/)[1]);
    const target = rels.get(m[0].match(/\br:id="([^"]+)"/)?.[1]);
    if (!target) continue;
    const path = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
    const xml = get(path);
    const rows = [];
    for (const rowMatch of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const rowIndex = Number(rowMatch[1].match(/\br="(\d+)"/)?.[1]) - 1;
      const row = [];
      for (const cell of (rowMatch[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = cell[1].match(/\br="([A-Z]+\d+)"/)?.[1];
        if (!ref || cell[2] === undefined) continue;
        const type = cell[1].match(/\bt="([^"]+)"/)?.[1];
        const raw = cell[2].match(/<v>([\s\S]*?)<\/v>/)?.[1];
        let value = null;
        if (type === 'inlineStr') value = textOf(cell[2]);
        else if (raw !== undefined) value = type === 's' ? shared[Number(raw)] ?? null : type === 'str' || type === 'e' ? decodeXml(raw) : type === 'b' ? Number(raw) : Number(raw);
        row[columnIndex(ref)] = value;
      }
      rows[rowIndex] = row;
    }
    sheets.set(name, Array.from(rows, row => row ?? []));
  }
  return sheets;
}

// ---------------------------------------------------------------------------
// Table extraction
// ---------------------------------------------------------------------------

const cell = (row, index) => (row && index >= 0 ? row[index] ?? null : null);
const text = value => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');
const isNumber = value => typeof value === 'number' && Number.isFinite(value);
const round2 = value => Math.round(value * 100) / 100;

/** Removes the footnote markers the handbook appends to names (#, ^, $, *, %, &, @, ~) and a leading "$$". */
export function cleanInsurerName(name) {
  return text(name).replace(/^[$%&@~^*#']+/, '').replace(/[$%&@~^*#]+$/, '').trim();
}

const sheetByTable = (sheets, table) => {
  for (const [name, rows] of sheets) if (name.trim() === String(table)) return rows;
  throw new Error(`Table ${table} sheet not found`);
};

function requireTitle(rows, table) {
  const title = rows.slice(0, 3).flat().map(text).find(t => /^TABLE\s+\d+/i.test(t)) ?? '';
  if (!new RegExp(`^TABLE\\s+${table}\\b`, 'i').test(title)) throw new Error(`Sheet ${table}: title is "${title}", expected TABLE ${table}`);
  return title.replace(/\s+/g, ' ');
}

const findColumn = (row, label) => {
  const matches = row.map((v, i) => (text(v) === label ? i : -1)).filter(i => i >= 0);
  if (matches.length !== 1) throw new Error(`Expected exactly one "${label}" header, found ${matches.length}`);
  return matches[0];
};

function expectLabels(row, start, labels, table) {
  labels.forEach((label, offset) => {
    if (!text(row[start + offset]).toLowerCase().includes(label.toLowerCase())) {
      throw new Error(`Table ${table}: column ${start + offset} header "${text(row[start + offset])}" does not match "${label}"`);
    }
  });
}

const base = ({ source, period, publishedOn }) => ({ source, period, publishedOn });

/** Table 53: claims count status; stand-alone health insurers only. */
export function extractClaimStatus(sheets, meta) {
  const rows = sheetByTable(sheets, 53);
  const title = requireTitle(rows, 53);
  const start = findColumn(rows[1] ?? [], meta.fiscalLabel);
  expectLabels(rows[3] ?? [], start, ['start of the period', 'intimated', 'paid', 'repudiated', 'closed', 'end of period'], 53);
  const entries = [];
  let inHealth = false;
  for (const row of rows.slice(4)) {
    const label = text(row[1]);
    if (/^Stand-alone Health Insurers$/i.test(label)) { inHealth = true; continue; }
    if (/Stand-alone Health Insurers Total/i.test(label)) break;
    if (!inHealth || !label || !isNumber(row[0])) continue;
    const [paid, repudiated, closed] = [2, 3, 4].map(offset => cell(row, start + offset));
    if (![paid, repudiated, closed].every(isNumber)) continue;
    const disposed = paid + repudiated + closed;
    if (disposed < MIN_CLAIMS_FOR_RATIO) continue;
    const insurerName = cleanInsurerName(label);
    const where = `${meta.url} | ${meta.title}, ${title}, ${meta.fiscalLabel}, row "${label}"`;
    const common = base({ source: where, period: meta.period, publishedOn: meta.publishedOn });
    entries.push({
      insurerName, metric: 'claim_settlement_ratio_count', value: round2((paid / disposed) * 100), ...common,
      basis: { numerator: paid, denominator: disposed, formula: 'claims paid / (claims paid + repudiated + closed), by number of claims; health-only insurer' },
    });
    entries.push({
      insurerName, metric: 'repudiation_ratio', value: round2((repudiated / disposed) * 100), ...common,
      basis: { numerator: repudiated, denominator: disposed, formula: 'claims repudiated / (claims paid + repudiated + closed), by number of claims; health-only insurer' },
    });
  }
  return entries;
}

/** Table 62: health-only incurred claims ratio from the Total block (net claims incurred / net earned premium). */
export function extractHealthIncurredClaimRatio(sheets, meta) {
  const rows = sheetByTable(sheets, 62);
  const title = requireTitle(rows, 62);
  const yearStart = findColumn(rows[2] ?? [], meta.fiscalLabel);
  const totalStart = findColumn((rows[3] ?? []).slice(yearStart, yearStart + 15), 'Total') + yearStart;
  expectLabels(rows[4] ?? [], totalStart, ['Net Earned Premium', 'Claims Incurred', 'Incurred Claims Ratio'], 62);
  const entries = [];
  for (const row of rows.slice(5)) {
    const label = text(row[1]);
    if (/Total$/i.test(label) || /^Grand Total/i.test(label)) continue;
    const premium = cell(row, totalStart);
    const claims = cell(row, totalStart + 1);
    if (!label || !isNumber(premium) || !isNumber(claims) || premium <= 0 || claims < 0) continue;
    entries.push({
      insurerName: cleanInsurerName(label), metric: 'incurred_claim_ratio', value: round2((claims / premium) * 100),
      ...base({
        source: `${meta.url} | ${meta.title}, ${title}, ${meta.fiscalLabel}, "Total" block (govt schemes + group + family floater + individual health; excludes personal accident and travel), row "${label}"`,
        period: meta.period, publishedOn: meta.publishedOn,
      }),
      basis: { numerator: claims, denominator: premium, unit: 'INR lakh', formula: 'net claims incurred / net earned premium, health business only' },
    });
  }
  return entries;
}

/** Table 49: latest quarter solvency ratio (a multiple, stored as percent). */
export function extractSolvency(sheets, meta) {
  const rows = sheetByTable(sheets, 49);
  const title = requireTitle(rows, 49);
  const header = rows[1] ?? [];
  const column = findColumn(header, meta.solvencyQuarterLabel);
  const entries = [];
  for (const row of rows.slice(2)) {
    const label = text(row[1]);
    const value = cell(row, column);
    if (!label || !isNumber(value) || value <= 0 || /^General Insurance Corporation/i.test(label) || /^Reinsurer/i.test(label)) continue;
    entries.push({
      insurerName: cleanInsurerName(label), metric: 'solvency_ratio', value: round2(value * 100),
      ...base({
        source: `${meta.url} | ${meta.title}, ${title}, ${meta.solvencyQuarterLabel}, row "${label}" (insurer-level, all business; multiple x 100)`,
        period: meta.solvencyPeriod, publishedOn: meta.publishedOn,
      }),
      basis: { numerator: value, denominator: 1, formula: 'available / required solvency margin as published (times); stored as percent' },
    });
  }
  return entries;
}

/** Entries from workbooks already parsed. Throws if a table's layout is not what this parser was written for. */
export function buildEntries({ partII, partIII, meta }) {
  const merged = new Map([...partII, ...partIII]);
  return [
    ...extractClaimStatus(merged, meta),
    ...extractHealthIncurredClaimRatio(merged, meta),
    ...extractSolvency(merged, meta),
  ];
}

export function buildFromHandbookZip(zipBuffer, overrides = {}) {
  const outer = readZip(zipBuffer);
  const find = suffix => {
    const key = [...outer.keys()].find(name => basename(name).toLowerCase() === suffix);
    if (!key) throw new Error(`${suffix} not found in handbook archive`);
    return outer.get(key);
  };
  const meta = {
    ...HANDBOOK, ...overrides,
    solvencyQuarterLabel: overrides.solvencyQuarterLabel ?? 'March 2025',
    solvencyPeriod: overrides.solvencyPeriod ?? '2025-03-31',
  };
  const entries = buildEntries({ partII: parseXlsx(find('part ii.xlsx')), partIII: parseXlsx(find('part iii.xlsx')), meta });
  return { generatedFrom: meta.url, title: meta.title, publishedOn: meta.publishedOn, entries };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(argv) {
  const args = [...argv];
  const take = flag => { const i = args.indexOf(flag); if (i < 0) return null; const [, value] = args.splice(i, 2); return value; };
  const outDir = take('--out') ?? '.local/references';
  const publishedOn = take('--published-on');
  const period = take('--period');
  const file = args.find(a => !a.startsWith('--'));
  let buffer;
  if (file) buffer = readFileSync(file);
  else {
    const response = await fetch(HANDBOOK.url, { headers: { 'user-agent': 'Mozilla/5.0' } });
    if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}. Download the ZIP manually from ${HANDBOOK.page} and pass its path.`);
    buffer = Buffer.from(await response.arrayBuffer());
  }
  const output = buildFromHandbookZip(buffer, { ...(publishedOn ? { publishedOn } : {}), ...(period ? { period } : {}) });
  mkdirSync(outDir, { recursive: true });
  const target = join(outDir, 'insurer-disclosures.json');
  writeFileSync(target, `${JSON.stringify(output, null, 2)}\n`);
  const counts = output.entries.reduce((acc, e) => ({ ...acc, [e.metric]: (acc[e.metric] ?? 0) + 1 }), {});
  console.log(`Wrote ${output.entries.length} entries to ${target}`, counts);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exit(1); });
}
