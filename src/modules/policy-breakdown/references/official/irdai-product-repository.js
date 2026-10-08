// IRDAI "Health Insurance Products" repository (https://irdai.gov.in/health-insurance-products): look up the
// regulator-filed product document for an exact UIN, then fetch that PDF.
//
// Observed behaviour (2026-10-08, see report): the Liferay portlet filters server-side with a plain GET render URL
// (p_p_id, p_p_lifecycle=0, p_p_state=normal, p_p_mode=view, namespaced filterUIN). The UIN filter is exact
// (case-insensitive, trimmed; prefixes return nothing). No browser user agent is required. The listing holds
// ~1,820 rows, all "Non-Archived", with approval dates up to June 2022 (FY 2022-23) only, so products filed later
// (for example any ...V0x2324/2425/2526 UIN) are absent. `not_found` here means "not in IRDAI's listing", never
// "the product or UIN does not exist".
//
// All network access goes through the official-source adapter (`fetchDiscovered`); page text can only select a
// document URL that IRDAI_HEALTH_PRODUCTS already allows (irdai.gov.in, /documents/37343/931203/, no query).
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { OfficialSourceContractError } from './contracts.js';
import { buildDiscoveredFetchRequest, defineDiscoverySource, validateDiscoveredUrl } from './discovery.js';
import { normaliseUin } from './registry.js';

const PORTLET_ID = 'com_irdai_document_media_IRDAIDocumentMediaPortlet';
const NS = `_${PORTLET_ID}_`;
const IRDAI = 'Insurance Regulatory and Development Authority of India';
const OWNER = 'knowvia-policy-breakdown';
const INDEX_URL = 'https://irdai.gov.in/health-insurance-products';
// Current UINs (e.g. HDFHLIP26058V082526) and legacy ones (e.g. IRDA/NL-HLT/L&TGI/P-H/V.I/242/13-14).
const UIN_PATTERN = /^[A-Z0-9][A-Z0-9/&.()-]{5,79}$/;
const SEARCH_TIMEOUT_MS = 15_000;
const DOCUMENT_TIMEOUT_MS = 30_000;
const DAY_MS = 86_400_000;

/** The search/listing page itself: exact path, only the portlet render parameters this module sends. */
export const IRDAI_HEALTH_PRODUCTS_SEARCH = defineDiscoverySource({
  id: 'irdai.health-insurance-products.search',
  publisher: IRDAI,
  sourceClass: 'regulator_product_repository',
  documentType: 'product_index',
  indexUrl: INDEX_URL,
  allowedHosts: ['irdai.gov.in'],
  documentPathPrefixes: ['/health-insurance-products'],
  allowedQueryKeys: ['p_p_id', 'p_p_lifecycle', 'p_p_state', 'p_p_mode', `${NS}filterUIN`, `${NS}archiveOn`],
  expectedMimeTypes: ['text/html'],
  maxBytes: 3 * 1024 * 1024,
  freshnessDays: 30,
  owner: OWNER,
});

/**
 * Product documents linked from the listing rows. Every health-product row observed links under
 * /documents/37343/931203/; the PDF is served identically without the listing's ?version&t&download query, so
 * discovered links are canonicalised to path-only and no query is allowed.
 */
export const IRDAI_HEALTH_PRODUCTS = defineDiscoverySource({
  id: 'irdai.health-insurance-products.document',
  publisher: IRDAI,
  sourceClass: 'regulator_product_repository',
  documentType: 'policy_wording',
  indexUrl: INDEX_URL,
  allowedHosts: ['irdai.gov.in'],
  documentPathPrefixes: ['/documents/37343/931203/'],
  allowedQueryKeys: [],
  expectedMimeTypes: ['application/pdf'],
  maxBytes: 20 * 1024 * 1024,
  freshnessDays: 365,
  owner: OWNER,
});

export const IRDAI_DISCOVERY_SOURCES = Object.freeze([IRDAI_HEALTH_PRODUCTS_SEARCH, IRDAI_HEALTH_PRODUCTS]);
export const IRDAI_LOOKUP_STATUSES = Object.freeze(['found', 'not_found', 'unavailable']);

/** Normalise and validate a UIN for lookup. Throws OfficialSourceContractError(IRDAI_UIN_INVALID). */
export function normaliseIrdaiUin(value) {
  const uin = normaliseUin(value);
  if (!UIN_PATTERN.test(uin) || !/\d/.test(uin)) throw new OfficialSourceContractError('IRDAI_UIN_INVALID', 'UIN must be a public IRDAI product identifier.');
  return uin;
}

/** The exact search URL for one UIN (archived rows included so the caller can see and flag them). */
export function irdaiSearchUrl(uin) {
  const params = new URLSearchParams({
    p_p_id: PORTLET_ID,
    p_p_lifecycle: '0',
    p_p_state: 'normal',
    p_p_mode: 'view',
    [`${NS}filterUIN`]: normaliseIrdaiUin(uin),
    [`${NS}archiveOn`]: 'true',
  });
  return validateDiscoveredUrl(`${INDEX_URL}?${params}`, IRDAI_HEALTH_PRODUCTS_SEARCH);
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
function decodeEntities(value) {
  return value.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8}|#39);/gi, (match, name) => {
    const lower = name.toLowerCase();
    if (lower.startsWith('#x')) return safeCodePoint(Number.parseInt(lower.slice(2), 16), match);
    if (lower.startsWith('#')) return safeCodePoint(Number.parseInt(lower.slice(1), 10), match);
    return ENTITIES[lower] ?? match;
  });
}
const safeCodePoint = (code, fallback) => (Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : fallback);
const cellText = html => decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

function cell(rowHtml, column) {
  const match = rowHtml.match(new RegExp(`<td[^>]*class="[^"]*\\btable-col-${column}\\b[^"]*"[^>]*>([\\s\\S]*?)</td>`, 'i'));
  return match ? match[1] : null;
}

function isoFromIrdaiDate(value) {
  const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(value ?? '');
  if (!match) return null;
  const iso = `${match[3]}-${match[2]}-${match[1]}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === iso ? iso : null;
}

function documentUrlFrom(documentsHtml) {
  const hrefs = [...new Set([...(documentsHtml ?? '').matchAll(/href="([^"]*)"/gi)].map(match => decodeEntities(match[1]).trim()))];
  if (hrefs.length !== 1) return { url: null, problem: hrefs.length ? 'multiple_document_links' : 'missing_document_link' };
  try {
    const url = new URL(hrefs[0], INDEX_URL);
    url.search = '';
    url.hash = '';
    return { url: validateDiscoveredUrl(url.toString(), IRDAI_HEALTH_PRODUCTS), problem: null };
  } catch {
    return { url: null, problem: 'document_link_rejected' };
  }
}

/**
 * Deterministically parse the listing table. Returns { recognised, empty, rows }. Fails closed: a page without the
 * search container's empty-results marker, or whose marker contradicts the rows, is `recognised: false`.
 * Each row: { insurerName, uin, productName, approvalDate, financialYear, productType, archived, documentUrl, problems }.
 */
export function parseIrdaiProductRows(html) {
  const page = String(html ?? '');
  const marker = page.match(/<div[^>]*class="([^"]*)"[^>]*id="_com_irdai_document_media_IRDAIDocumentMediaPortlet_fileEntriesSearchContainerEmptyResultsMessage"/i)
    ?? page.match(/<div[^>]*id="_com_irdai_document_media_IRDAIDocumentMediaPortlet_fileEntriesSearchContainerEmptyResultsMessage"[^>]*class="([^"]*)"/i);
  const tbody = page.match(/<tbody[^>]*class="[^"]*\btable-data\b[^"]*"[^>]*>([\s\S]*?)<\/tbody>/i);
  if (!marker || !tbody) return Object.freeze({ recognised: false, empty: false, rows: Object.freeze([]) });
  const empty = !/\bhide\b/.test(marker[1]);
  const rows = [];
  for (const [, rowHtml] of tbody[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const uinCell = cell(rowHtml, 'uin');
    if (uinCell == null) continue;
    const problems = [];
    const archiveText = cellText(cell(rowHtml, 'archive-nonarchive') ?? '').toLowerCase();
    const archived = archiveText === 'archived' ? true : archiveText === 'non-archived' ? false : null;
    if (archived == null) problems.push('archive_flag_unrecognised');
    const approvalRaw = cellText(cell(rowHtml, 'approvalDate') ?? '');
    const approvalDate = isoFromIrdaiDate(approvalRaw);
    if (!approvalDate) problems.push('approval_date_unrecognised');
    const document = documentUrlFrom(cell(rowHtml, 'documents'));
    if (document.problem) problems.push(document.problem);
    rows.push(Object.freeze({
      insurerName: cellText(cell(rowHtml, 'insurer') ?? '') || null,
      uin: cellText(uinCell) || null,
      productName: cellText(cell(rowHtml, 'productName') ?? '') || null,
      approvalDate,
      financialYear: cellText(cell(rowHtml, 'fy') ?? '') || null,
      productType: cellText(cell(rowHtml, 'top') ?? '') || null,
      archived,
      documentUrl: document.url,
      problems: Object.freeze(problems),
    }));
  }
  if (empty === (rows.length > 0)) return Object.freeze({ recognised: false, empty, rows: Object.freeze([]) });
  return Object.freeze({ recognised: true, empty, rows: Object.freeze(rows) });
}

const productOf = row => Object.freeze({
  insurerName: row.insurerName,
  uin: row.uin,
  productName: row.productName,
  approvalDate: row.approvalDate,
  financialYear: row.financialYear,
  productType: row.productType,
  archived: row.archived,
  documentUrl: row.documentUrl,
});

/**
 * Select the product for an exact UIN from parsed rows. Exact equality after normaliseUin only; never fuzzy.
 * Non-archived rows win; an archived-only match is returned with archived:true. `not_found` only when IRDAI shows
 * its empty-results marker: rows without an exact match mean the server filter was not applied (IRDAI returns the
 * unfiltered listing then), which is `unavailable`, never a negative. Distinct documents for one UIN, or a matching
 * row with unusable fields, are also `unavailable` (fail closed).
 */
export function selectIrdaiProduct(parsed, uin) {
  const target = normaliseIrdaiUin(uin);
  if (!parsed?.recognised) return { status: 'unavailable', code: 'IRDAI_PAGE_UNRECOGNISED', product: null };
  const matches = parsed.rows.filter(row => row.uin && normaliseUin(row.uin) === target);
  if (matches.length === 0) {
    return parsed.empty
      ? { status: 'not_found', code: 'IRDAI_UIN_NOT_LISTED', product: null }
      : { status: 'unavailable', code: 'IRDAI_FILTER_NOT_APPLIED', product: null };
  }
  if (matches.some(row => row.problems.length > 0)) return { status: 'unavailable', code: 'IRDAI_ROW_INVALID', product: null };
  const current = matches.filter(row => row.archived === false);
  const preferred = current.length ? current : matches;
  const byDocument = new Map(preferred.map(row => [row.documentUrl, row]));
  if (byDocument.size > 1) return { status: 'unavailable', code: 'IRDAI_UIN_MULTIPLE_DOCUMENTS', product: null };
  return { status: 'found', code: null, product: productOf(preferred[0]) };
}

function validCachedProduct(product, uin) {
  if (!product || typeof product !== 'object' || normaliseUin(product.uin) !== uin) return null;
  try {
    return productOf({ ...product, documentUrl: validateDiscoveredUrl(product.documentUrl, IRDAI_HEALTH_PRODUCTS) });
  } catch {
    return null;
  }
}

/**
 * createIrdaiProductRepository({ adapter, now, cacheDirectory? })
 *   findByUin(uin) -> { status: 'found'|'not_found'|'unavailable', code, product|null, checkedAt, evidence|null, cached }
 *   fetchDocument(product) -> adapter.fetchDiscovered result for the product PDF
 * `adapter` must expose fetchDiscovered and be configured with IRDAI_DISCOVERY_SOURCES. With `cacheDirectory`,
 * found/not_found results are cached as JSON for IRDAI_HEALTH_PRODUCTS_SEARCH.freshnessDays.
 */
export function createIrdaiProductRepository({ adapter, now = () => new Date(), cacheDirectory = null } = {}) {
  if (!adapter || typeof adapter.fetchDiscovered !== 'function') throw new TypeError('adapter must provide fetchDiscovered(request, discoverySource).');
  const timestamp = () => new Date(now()).toISOString();
  const cacheFile = uin => join(cacheDirectory, `irdai-uin-${createHash('sha256').update(uin).digest('hex').slice(0, 32)}.json`);

  async function readCache(uin) {
    if (!cacheDirectory) return null;
    try {
      const entry = JSON.parse(await readFile(cacheFile(uin), 'utf8'));
      const ageMs = Date.parse(timestamp()) - Date.parse(entry.checkedAt);
      if (entry.uin !== uin || !(ageMs >= 0 && ageMs < IRDAI_HEALTH_PRODUCTS_SEARCH.freshnessDays * DAY_MS)) return null;
      if (entry.status === 'not_found') return { status: 'not_found', code: 'IRDAI_UIN_NOT_LISTED', product: null, checkedAt: entry.checkedAt, evidence: entry.evidence ?? null, cached: true };
      const product = entry.status === 'found' ? validCachedProduct(entry.product, uin) : null;
      return product ? { status: 'found', code: null, product, checkedAt: entry.checkedAt, evidence: entry.evidence ?? null, cached: true } : null;
    } catch {
      return null;
    }
  }

  async function writeCache(uin, result) {
    if (!cacheDirectory || (result.status !== 'found' && result.status !== 'not_found')) return;
    try {
      await mkdir(cacheDirectory, { recursive: true });
      const file = cacheFile(uin);
      const temporary = `${file}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify({ uin, status: result.status, product: result.product, checkedAt: result.checkedAt, evidence: result.evidence }));
      await rename(temporary, file);
    } catch { /* cache is an optimisation; lookups stay correct without it */ }
  }

  return Object.freeze({
    async findByUin(rawUin) {
      const uin = normaliseIrdaiUin(rawUin);
      const cached = await readCache(uin);
      if (cached) return Object.freeze(cached);
      const checkedAt = timestamp();
      const request = buildDiscoveredFetchRequest({
        requestId: `irdai-search-${randomUUID()}`,
        discoverySource: IRDAI_HEALTH_PRODUCTS_SEARCH,
        url: irdaiSearchUrl(uin),
        requestedAt: checkedAt,
        timeoutMs: SEARCH_TIMEOUT_MS,
      });
      const response = await adapter.fetchDiscovered(request, IRDAI_HEALTH_PRODUCTS_SEARCH);
      if (!response?.ok) {
        return Object.freeze({ status: 'unavailable', code: response?.error?.code ?? 'SOURCE_UNAVAILABLE', product: null, checkedAt, evidence: null, cached: false });
      }
      const html = new TextDecoder('utf-8', { fatal: false }).decode(response.bytes);
      const selection = selectIrdaiProduct(parseIrdaiProductRows(html), uin);
      const evidence = Object.freeze({
        discoverySourceId: IRDAI_HEALTH_PRODUCTS_SEARCH.id,
        indexUrl: IRDAI_HEALTH_PRODUCTS_SEARCH.indexUrl,
        retrievedAt: response.retrievedAt,
        contentSha256: response.contentSha256 ?? createHash('sha256').update(response.bytes).digest('hex'),
      });
      const result = { ...selection, checkedAt, evidence, cached: false };
      await writeCache(uin, result);
      return Object.freeze(result);
    },

    async fetchDocument(product) {
      const url = validateDiscoveredUrl(product?.documentUrl, IRDAI_HEALTH_PRODUCTS, 'product.documentUrl');
      const request = buildDiscoveredFetchRequest({
        requestId: `irdai-document-${randomUUID()}`,
        discoverySource: IRDAI_HEALTH_PRODUCTS,
        url,
        requestedAt: timestamp(),
        timeoutMs: DOCUMENT_TIMEOUT_MS,
      });
      return adapter.fetchDiscovered(request, IRDAI_HEALTH_PRODUCTS);
    },
  });
}
