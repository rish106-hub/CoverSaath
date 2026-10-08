// Discovery sources for insurers' own websites, derived from the reviewed insurer directory. A navigator may fetch
// any page or PDF on an insurer's listed hosts (and nothing else), reached from its reviewed wording index pages.
// Query strings are limited to the cache-busting keys insurers actually use on document links.
import { buildDiscoveredFetchRequest, defineDiscoverySource } from './discovery.js';
import { INSURER_DIRECTORY } from './insurer-directory.js';

const OWNER = 'knowvia-policy-breakdown';
export const INSURER_SITE_QUERY_KEYS = Object.freeze(['v', 't', 'updated_at', 'version']);

function siteSource(insurer) {
  try {
    return defineDiscoverySource({
      id: `${insurer.id}.site`,
      publisher: insurer.legalName,
      sourceClass: 'insurer_policy_wording',
      documentType: 'policy_wording',
      indexUrl: insurer.wordingIndexUrls[0],
      allowedHosts: [...insurer.officialHosts],
      documentPathPrefixes: ['/'],
      allowedQueryKeys: [...INSURER_SITE_QUERY_KEYS],
      expectedMimeTypes: ['text/html', 'application/pdf'],
      maxBytes: 20 * 1024 * 1024,
      freshnessDays: 30,
      owner: OWNER,
    });
  } catch {
    return null; // an index URL the strict URL rule cannot accept is simply not navigable
  }
}

export const INSURER_SITE_SOURCES = Object.freeze(INSURER_DIRECTORY
  .filter(insurer => insurer.access === 'server_rendered' && insurer.wordingIndexUrls.length)
  .map(siteSource)
  .filter(Boolean));

const sourceByInsurer = new Map(INSURER_SITE_SOURCES.map(source => [source.id.replace(/\.site$/, ''), source]));
export const insurerSiteSource = insurer => sourceByInsurer.get(insurer?.id) ?? null;

/** fetchPage / fetchDocument for the navigator, bound to one insurer's discovery source and the guarded adapter. */
export function insurerSiteFetchers(adapter, source, { now = () => new Date() } = {}) {
  const get = async url => {
    const request = buildDiscoveredFetchRequest({ requestId: `site-${now().getTime()}`, discoverySource: source, url, requestedAt: now().toISOString(), timeoutMs: 20_000 });
    return adapter.fetchDiscovered(request, source);
  };
  return Object.freeze({
    async fetchPage(url) {
      let result;
      try { result = await get(url); } catch (error) { return { ok: false, code: error.code ?? 'URL_NOT_ALLOWED' }; }
      if (!result.ok) return { ok: false, code: result.error.code };
      if (result.mimeType !== 'text/html') return { ok: false, code: 'NOT_HTML', url: result.url };
      return { ok: true, url: result.url, html: Buffer.from(result.bytes).toString('utf8') };
    },
    async fetchDocument(url) {
      let result;
      try { result = await get(url); } catch (error) { return { ok: false, code: error.code ?? 'URL_NOT_ALLOWED' }; }
      if (!result.ok) return { ok: false, code: result.error.code };
      if (result.mimeType !== 'application/pdf') return { ok: false, code: 'NOT_PDF' };
      return { ok: true, url: result.url, bytes: result.bytes, contentSha256: result.contentSha256 };
    },
  });
}
