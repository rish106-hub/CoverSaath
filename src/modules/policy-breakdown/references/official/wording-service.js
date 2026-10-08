// Attaches the insurer's official policy wording to a breakdown when the uploaded pack does not include it.
//
// Identity is decided deterministically before any model call: the IRDAI UIN printed on the uploaded pages must
// exactly equal a registry entry's UIN (a UIN encodes product and version), and the fetched PDF must print the
// same UIN. Nothing a page says can choose a URL; only the operator-reviewed registry can. Wording pages are
// public documents, cached on disk by content hash, and are labelled as official wording in every prompt and
// citation so assembly can let the policy's own schedule outrank them.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { extractPdfTextPages, PDF_TEXT_EXTRACTOR_VERSION } from './pdf-text.js';
import { normaliseUin, OFFICIAL_SOURCE_REGISTRY, wordingSourcesByUin } from './registry.js';
import { insurerForUin } from './insurer-directory.js';
import { insurerSiteFetchers, insurerSiteSource } from './insurer-site-sources.js';
import { createDeterministicLinkChooser, createWordingNavigator } from './wording-navigator.js';

// IRDAI UINs: insurer code + line/product letters + 5-digit product number + V + version + filing year,
// e.g. HDFHLIP26058V082526.
const UIN_PATTERN = /\b[A-Z]{3,6}[A-Z]{1,4}\d{5}V\d{6}\b/g;
const MAX_ATTACHED_WORDINGS = 3; // base product plus add-ons printed on one schedule
export const OFFICIAL_DOCUMENT_PREFIX = 'official:';

/** Distinct UINs printed on the uploaded pages (official pages are ignored). */
export function findPolicyUins(pages) {
  const found = new Set();
  for (const page of pages) {
    if (page.official) continue;
    for (const match of String(page.text ?? '').toUpperCase().replace(/\s+(?=V\d{6}\b)/g, '').matchAll(UIN_PATTERN)) found.add(match[0]);
  }
  return [...found];
}

const safeName = value => String(value).replace(/[^a-z0-9._-]+/gi, '_').slice(0, 120);

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function writeJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value));
  renameSync(temporary, path);
}

export function officialPageLabel(link) {
  return `official_wording: ${link.publisher} ${link.productName} UIN ${link.uin}, fetched from the insurer website on ${link.retrievedAt.slice(0, 10)}`;
}

/**
 * A locator turns an exact UIN into zero or more candidate documents:
 *   { key, publisher, productName, uin, freshnessDays, via, fetch: () => adapter-style result }
 * Locators run in order; the first candidate whose PDF prints the exact UIN wins.
 */
export function registryWordingLocator({ adapter, registry = OFFICIAL_SOURCE_REGISTRY }) {
  const byUin = wordingSourcesByUin(registry);
  return Object.freeze({
    name: 'registry',
    async locate(uin) {
      return (byUin.get(normaliseUin(uin)) ?? []).map(source => ({
        key: source.id, publisher: source.publisher, productName: source.identity.productName, uin: source.identity.uin,
        freshnessDays: source.freshnessDays ?? 30, via: 'operator_registry',
        fetch: () => adapter.fetch({
          requestId: `wording-${Date.now()}`, registryEntryId: source.id, url: source.canonicalUrl, allowedHosts: source.allowedHosts,
          expectedMimeTypes: source.expectedMimeTypes, maxBytes: source.maxBytes, timeoutMs: 20_000, requestedAt: new Date().toISOString(),
        }),
      }));
    },
  });
}

/** IRDAI's central product repository. It lists every insurer but only products filed up to mid-2022. */
export function irdaiWordingLocator({ repository }) {
  return Object.freeze({
    name: 'irdai',
    async locate(uin) {
      let found;
      try { found = await repository.findByUin(uin); } catch { return []; }
      if (found.status !== 'found') return [];
      const { product } = found;
      return [{
        key: `irdai.${normaliseUin(product.uin).toLowerCase()}`, publisher: product.insurerName, productName: product.productName, uin: product.uin,
        freshnessDays: 180, via: 'irdai_product_repository', fetch: () => repository.fetchDocument(product),
      }];
    },
  });
}

/**
 * The insurer's own website, walked from its reviewed wording index pages. Link choice is deterministic by default
 * (an optional model chooser may only rank links already on the insurer's hosts). The navigator accepts a PDF only
 * when it prints the exact UIN as its own identity, not as a citation.
 */
export function insurerSiteWordingLocator({ adapter, chooseLinks = createDeterministicLinkChooser(), now = () => new Date(), log = () => {} }) {
  return Object.freeze({
    name: 'insurer_site',
    async locate(uin) {
      const insurer = insurerForUin(uin);
      const source = insurerSiteSource(insurer);
      if (!insurer || !source) return [];
      return [{
        key: `site.${insurer.id}.${normaliseUin(uin).toLowerCase()}`, publisher: insurer.legalName, productName: null, uin: normaliseUin(uin),
        freshnessDays: 30, via: 'insurer_site',
        async fetch() {
          const navigator = createWordingNavigator({ ...insurerSiteFetchers(adapter, source, { now }), chooseLinks, log });
          const found = await navigator.findWording({ insurer, uin: normaliseUin(uin), productName: null });
          if (found.status !== 'found') return { ok: false, error: { code: `NAVIGATOR_${found.reason ?? found.status}`.toUpperCase() } };
          return { ok: true, url: found.url, bytes: found.bytes, contentSha256: found.contentSha256, retrievedAt: now().toISOString() };
        },
      }];
    },
  });
}

/**
 * @param locators        ordered locators (default: the operator registry only)
 * @param cacheDirectory  where extracted wording pages are kept, keyed by candidate key and SHA-256
 */
export function createOfficialWordingService({ adapter, registry = OFFICIAL_SOURCE_REGISTRY, locators = null, cacheDirectory, extractText = extractPdfTextPages, now = () => new Date(), log = () => {} }) {
  const chain = locators ?? [registryWordingLocator({ adapter, registry })];
  const cachePath = (key, sha) => join(cacheDirectory, safeName(key), `${safeName(sha)}.json`);
  const latestPath = key => join(cacheDirectory, safeName(key), 'latest.json');

  async function fetchWording(candidate) {
    const at = now();
    const latest = readJson(latestPath(candidate.key));
    if (latest && at.getTime() - Date.parse(latest.retrievedAt) < candidate.freshnessDays * 86_400_000) {
      const cached = readJson(cachePath(candidate.key, latest.contentSha256));
      if (cached?.pages?.length) return { ok: true, cached };
    }
    const result = await candidate.fetch();
    if (!result?.ok) {
      // A previous good copy for the same key is still the right document for this UIN.
      const fallback = latest ? readJson(cachePath(candidate.key, latest.contentSha256)) : null;
      if (fallback?.pages?.length) return { ok: true, cached: fallback, staleReason: result?.error?.code ?? 'SOURCE_UNAVAILABLE' };
      return { ok: false, code: result?.error?.code ?? 'SOURCE_UNAVAILABLE' };
    }
    const pages = await extractText(result.bytes);
    const uin = normaliseUin(candidate.uin);
    if (!pages.some(page => normaliseUin(page.text).includes(uin))) return { ok: false, code: 'WORDING_UIN_NOT_PRINTED' };
    if (pages.filter(page => page.text.trim()).length < Math.ceil(pages.length / 2)) return { ok: false, code: 'WORDING_HAS_NO_TEXT_LAYER' };
    const contentSha256 = result.contentSha256 ?? createHash('sha256').update(result.bytes).digest('hex');
    const retrievedAt = result.retrievedAt ?? at.toISOString();
    const cached = {
      registryEntryId: candidate.key, uin: candidate.uin, publisher: candidate.publisher, productName: candidate.productName, via: candidate.via,
      url: result.url, contentSha256, retrievedAt, extractor: PDF_TEXT_EXTRACTOR_VERSION, pages,
    };
    mkdirSync(join(cacheDirectory, safeName(candidate.key)), { recursive: true });
    writeJson(cachePath(candidate.key, contentSha256), cached);
    writeJson(latestPath(candidate.key), { contentSha256, retrievedAt });
    return { ok: true, cached };
  }

  return Object.freeze({
    /** Decides and fetches the wording(s) for these uploaded pages. Never throws; returns links for the job. */
    async attach(pages) {
      const uins = findPolicyUins(pages).slice(0, MAX_ATTACHED_WORDINGS);
      if (uins.length === 0) return { status: 'no_uin_on_pages', links: [] };
      const links = [];
      const failures = [];
      for (const uin of uins) {
        let attached = false;
        for (const locator of chain) {
          let candidates = [];
          try { candidates = await locator.locate(uin); } catch (error) { failures.push({ uin, via: locator.name, code: error.code ?? 'LOCATOR_FAILED' }); }
          for (const candidate of candidates) {
            try {
              const fetched = await fetchWording(candidate);
              if (!fetched.ok) { failures.push({ uin, via: locator.name, code: fetched.code }); continue; }
              const { cached } = fetched;
              links.push({ registryEntryId: cached.registryEntryId, uin: cached.uin, publisher: cached.publisher, productName: cached.productName, via: cached.via ?? locator.name, url: cached.url, contentSha256: cached.contentSha256, retrievedAt: cached.retrievedAt, pageCount: cached.pages.length, staleReason: fetched.staleReason ?? null });
              attached = true;
              break;
            } catch (error) {
              failures.push({ uin, via: locator.name, code: error.code ?? 'WORDING_ATTACH_FAILED' });
            }
          }
          if (attached) break;
        }
        if (!attached && !failures.some(failure => failure.uin === uin)) failures.push({ uin, via: null, code: 'WORDING_NOT_LOCATED' });
      }
      for (const failure of failures) log({ event: 'official_wording_attach_failed', ...failure });
      const status = links.length ? 'attached' : failures.every(failure => failure.code === 'WORDING_NOT_LOCATED') ? 'wording_not_registered' : 'fetch_failed';
      return { status, uins, links, failures };
    },
    /** Wording pages for a stored link, from the content-hash cache. Null when the cache no longer has them. */
    pagesFor(link) {
      const cached = readJson(cachePath(link.registryEntryId, link.contentSha256));
      return cached?.pages?.length ? cached.pages : null;
    },
  });
}
