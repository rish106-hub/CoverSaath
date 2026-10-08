// Insurer-reported claims disclosures, refreshed from registry sources (e.g. an insurer's own "Claims Data"
// page). Government data (the IRDAI handbook, insurer-disclosures.json) stays the primary source; this file adds
// newer, insurer-reported figures for metrics IRDAI does not split by health business. Section 10 already picks
// the most recent period per metric, so a fresh quarter replaces an older annual figure automatically.
//
// Parsing is deterministic and fails closed: a table that does not reconcile (opening + intimated − paid −
// repudiated − closed = closing) is rejected, never half-used. The last good file is kept on any failure.
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { INSURER_REPORTED_FILE } from './reference-store.js';
import { INSURER_CLAIMS_SOURCES, parseNl37HealthPdf } from './insurer-claims-sources.js';

export const INSURER_REPORTED_FORMAT = 'knowvia.insurer-reported-disclosures/v1';
const MIN_DISPOSED_CLAIMS = 100;
const RETRY_AFTER_FAILURE_MS = 6 * 60 * 60 * 1000;
const MAX_ENTRIES = 5_000;
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

const decode = text => text.replace(/&nbsp;/g, ' ').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const cellText = html => decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const count = text => (/^\d{1,3}(?:,\d{2,3})*$|^\d+$/.test(text) ? Number(text.replace(/,/g, '')) : null);
const round2 = value => Math.round(value * 100) / 100;

function tables(html) {
  // Visible markup only: embedded framework payloads repeat the table as escaped strings.
  const visible = String(html).replace(/<script\b[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[\s\S]*?<\/style>/gi, ' ');
  return [...visible.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)].map(match =>
    [...match[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(row =>
      [...row[1].matchAll(/<t([dh])\b([^>]*)>([\s\S]*?)<\/t\1>/gi)].flatMap(cell => {
        const span = Math.min(Math.max(Number(/colspan="?(\d+)/i.exec(cell[2])?.[1] ?? 1), 1), 10);
        return Array.from({ length: span }, () => cellText(cell[3]));
      })));
}

/** "Apr'26 - Jun'26" -> { label, start: '2026-04-01', end: '2026-06-30' } or null. */
export function parseQuarterLabel(text) {
  const match = /([A-Za-z]{3})[a-z]*\s*['’]\s*(\d{2})\s*[-–]\s*([A-Za-z]{3})[a-z]*\s*['’]\s*(\d{2})/.exec(String(text));
  if (!match) return null;
  const [startMonth, endMonth] = [MONTHS[match[1].toLowerCase()], MONTHS[match[3].toLowerCase()]];
  if (!startMonth || !endMonth) return null;
  const [startYear, endYear] = [2000 + Number(match[2]), 2000 + Number(match[4])];
  const lastDay = new Date(Date.UTC(endYear, endMonth, 0)).getUTCDate();
  const start = `${startYear}-${String(startMonth).padStart(2, '0')}-01`;
  const end = `${endYear}-${String(endMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  if (end < start) return null;
  return { label: match[0].replace(/\s+/g, ' '), start, end };
}

/**
 * Parses a published claims-status table with a "Retail Health" column (rows: outstanding at start, intimated,
 * paid, repudiated, closed without payment, outstanding at end) and an optional retail-health TAT table.
 * Returns { ok: true, period, counts, averageReimbursementDays } or { ok: false, reason }.
 */
export function parseRetailHealthClaimsTables(html) {
  for (const rows of tables(html)) {
    const header = rows.find(row => row.some(cell => /^retail health$/i.test(cell)));
    if (!header) continue;
    const column = header.findIndex(cell => /^retail health$/i.test(cell));
    const period = rows.map(row => parseQuarterLabel(row[column] ?? '')).find(Boolean);
    const valueOf = pattern => {
      const row = rows.find(item => item.some(cell => pattern.test(cell)));
      return row ? count(row[column] ?? '') : null;
    };
    const counts = {
      opening: valueOf(/^outstanding as on/i),
      intimated: valueOf(/^claims intimated/i),
      paid: valueOf(/^claims paid/i),
      repudiated: valueOf(/^claims repudiated/i),
      closedWithoutPayment: valueOf(/^claims closed without payment/i),
      closing: valueOf(/^outstanding at the end/i),
    };
    if (!period) return { ok: false, reason: 'period_not_found' };
    if (Object.values(counts).some(value => value === null)) return { ok: false, reason: 'claims_rows_incomplete' };
    if (counts.opening + counts.intimated - counts.paid - counts.repudiated - counts.closedWithoutPayment !== counts.closing) return { ok: false, reason: 'claims_table_does_not_reconcile' };
    const disposed = counts.paid + counts.repudiated + counts.closedWithoutPayment;
    if (disposed < MIN_DISPOSED_CLAIMS) return { ok: false, reason: 'too_few_disposed_claims' };
    let averageReimbursementDays = null;
    for (const tat of tables(html)) {
      if (!tat.some(row => row.some(cell => /retail health claims tat/i.test(cell)))) continue;
      const row = tat.find(item => item.some(cell => /^average reimbursement tat/i.test(cell)));
      const days = row ? /^(\d{1,3})\s*days?$/i.exec(row.at(-1) ?? '') : null;
      if (days) averageReimbursementDays = Number(days[1]);
    }
    return { ok: true, period, counts, disposed, averageReimbursementDays };
  }
  return { ok: false, reason: 'retail_health_table_not_found' };
}

/** Turns a parsed table into reference-store entries (percent values, period = quarter end date). */
export function claimsTableEntries(parsed, { insurerName, url, retrievedOn }) {
  const allLines = parsed.segment === 'health_all_lines';
  const document = allLines ? 'public disclosure Form NL-37 "Claims Data", Health (all health lines, cumulative for the financial year)' : '"Claims Data", Retail Health';
  const label = `${insurerName} website ${document}, ${parsed.period.label} (${url}); insurer-reported and not audited by IRDAI; retrieved ${retrievedOn}`;
  const formula = `claims paid / (paid + repudiated + closed without payment), by number of claims, ${allLines ? 'all health lines' : 'retail health only'}`;
  const base = { insurerName, period: parsed.period.end, publishedOn: retrievedOn, sourceKind: 'insurer_reported' };
  const entries = [
    { ...base, metric: 'claim_settlement_ratio_count', value: round2(parsed.counts.paid / parsed.disposed * 100), source: `${label}; ${formula}`, basis: { numerator: parsed.counts.paid, denominator: parsed.disposed, formula } },
    { ...base, metric: 'repudiation_ratio', value: round2(parsed.counts.repudiated / parsed.disposed * 100), source: `${label}; claims repudiated / (paid + repudiated + closed without payment), by number of claims`, basis: { numerator: parsed.counts.repudiated, denominator: parsed.disposed } },
  ];
  if (parsed.averageReimbursementDays != null) entries.push({ ...base, metric: 'average_settlement_days', value: parsed.averageReimbursementDays, source: `${label}; "Average Reimbursement TAT" as published (retail health reimbursement claims)` });
  return entries;
}

// Each parser takes the page text (HTML sources) or the raw bytes (PDF sources) and may be async.
export const DISCLOSURE_PARSERS = Object.freeze({
  'hdfc-ergo.claims-data': parseRetailHealthClaimsTables,
  ...Object.fromEntries(INSURER_CLAIMS_SOURCES.map(source => [source.id, parseNl37HealthPdf])),
});

function readStore(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed?.format === INSURER_REPORTED_FORMAT ? parsed : null;
  } catch { return null; }
}

/**
 * Keeps insurer-reported disclosures current. `refreshIfStale()` is cheap when nothing is due and never throws;
 * concurrent calls share one run. Network access happens only through the registry-bound adapter, so a page
 * cannot redirect the fetch anywhere the registry does not allow.
 */
export function createInsurerDisclosureRefresher({ adapter, registry, directory, now = () => new Date(), parsers = DISCLOSURE_PARSERS, log = () => {}, onUpdated = () => {} }) {
  const sources = registry.filter(source => source.sourceClass === 'insurer_disclosure' && parsers[source.id]);
  const path = join(directory, INSURER_REPORTED_FILE);
  let inFlight = null;

  const due = (store, source, at) => {
    const state = store?.sources?.[source.id];
    if (!state) return true;
    const success = state.lastSuccessAt ? Date.parse(state.lastSuccessAt) : 0;
    const attempt = state.lastAttemptAt ? Date.parse(state.lastAttemptAt) : 0;
    if (attempt > success && at - attempt < RETRY_AFTER_FAILURE_MS) return false;
    return at - success >= (source.freshnessDays ?? 7) * 86_400_000;
  };

  async function run({ force = false } = {}) {
    const at = now();
    const store = readStore(path) ?? { format: INSURER_REPORTED_FORMAT, sources: {}, entries: [] };
    const summary = [];
    let changed = false;
    for (const source of sources) {
      if (!force && !due(store, source, at.getTime())) continue;
      const attemptedAt = at.toISOString();
      const state = { ...(store.sources[source.id] ?? {}), lastAttemptAt: attemptedAt };
      try {
        const result = await adapter.fetch({
          requestId: `disclosure-${source.id}-${at.getTime()}`, registryEntryId: source.id, url: source.canonicalUrl,
          allowedHosts: source.allowedHosts, expectedMimeTypes: source.expectedMimeTypes, maxBytes: source.maxBytes,
          timeoutMs: 15_000, requestedAt: attemptedAt,
        });
        if (!result.ok) throw Object.assign(new Error(result.error.code), { code: result.error.code });
        const input = result.mimeType === 'application/pdf' ? result.bytes : Buffer.from(result.bytes).toString('utf8');
        const parsed = await parsers[source.id](input);
        if (!parsed.ok) throw Object.assign(new Error(parsed.reason), { code: `PARSE_${parsed.reason.toUpperCase()}` });
        const fresh = claimsTableEntries(parsed, { insurerName: source.publisher, url: result.url, retrievedOn: result.retrievedAt.slice(0, 10) })
          .map(entry => ({ ...entry, registryEntryId: source.id, contentSha256: result.contentSha256, retrievedAt: result.retrievedAt }));
        const replaced = new Set(fresh.map(entry => `${entry.metric}|${entry.period}`));
        store.entries = [...store.entries.filter(entry => entry.registryEntryId !== source.id || !replaced.has(`${entry.metric}|${entry.period}`)), ...fresh].slice(-MAX_ENTRIES);
        Object.assign(state, { lastSuccessAt: result.retrievedAt, lastError: null, contentSha256: result.contentSha256, latestPeriod: parsed.period.end });
        summary.push({ source: source.id, status: 'refreshed', period: parsed.period.end, entries: fresh.length });
      } catch (error) {
        state.lastError = error.code ?? 'REFRESH_FAILED';
        summary.push({ source: source.id, status: 'failed', code: state.lastError });
        log({ event: 'insurer_disclosure_refresh_failed', source: source.id, code: state.lastError });
      }
      store.sources[source.id] = state;
      changed = true;
    }
    if (changed) {
      mkdirSync(directory, { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify({ ...store, updatedAt: at.toISOString() }, null, 1)}\n`);
      renameSync(temporary, path);
      onUpdated();
    }
    return summary;
  }

  return Object.freeze({
    path,
    sourceIds: sources.map(source => source.id),
    refresh(options) { return run(options); },
    refreshIfStale() {
      if (inFlight) return inFlight;
      inFlight = run().catch(error => { log({ event: 'insurer_disclosure_refresh_error', code: error.code ?? error.name }); return []; })
        .finally(() => { inFlight = null; });
      return inFlight;
    },
    status() { return existsSync(path) ? readStore(path)?.sources ?? {} : {}; },
  });
}
