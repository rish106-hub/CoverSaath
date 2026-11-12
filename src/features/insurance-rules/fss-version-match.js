// FSS version match (ADR 0034, design note section 2). Pure decision logic: it never fetches. The caller passes `lookup(endpoint, params)`,
// which resolves the parsed body of an allow-listed reference read (a live read in the refresh job, a cache-only read on reads) or throws.
//
// Inputs: the owner-confirmed UIN (server side only), the owner-confirmed insurer and product names, and the own-PDF start date
// (extracted_unverified, ISO date) when there is one.
//   1. UIN present: products.search {uin} must give exactly one non-synthetic health product whose UIN is that UIN. The UIN wins over names.
//   2. No UIN: insurers.resolve must give `resolved`, then products.search {insurerId, q} must give exactly one exact name match
//      (case-folded, spaces collapsed).
//   3. Version: drop synthetic, test_fixture, withdrawn and access_blocked. Take the one whose effective window contains the start date;
//      with no start date, the only remaining version.
// Anything else is no match. The result carries opaque FSS ids only; the UIN is never part of it.

export const MATCH_OUTCOMES = Object.freeze({ matched: 'matched', noMatch: 'no_match', versionUnresolved: 'version_unresolved', syntheticOnly: 'synthetic_only' });

const DROPPED_FRESHNESS = new Set(['test_fixture', 'withdrawn', 'access_blocked']);
const SYNTHETIC_FRESHNESS = new Set(['test_fixture']);
const isSyntheticProduct = product => product.verificationStatus === 'synthetic_test';
const fold = value => (typeof value === 'string' ? value.normalize('NFC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-IN') : '');
const uinKey = value => (typeof value === 'string' ? value.toUpperCase().replace(/[^A-Z0-9]/g, '') : '');
const isoDay = value => (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null);

const result = (outcome, extra = {}) => Object.freeze({ outcome, ...extra });

async function matchProduct({ lookup, uin, insurerName, productName }) {
  if (uin) {
    const { products } = await lookup('products.search', { uin });
    const health = products.filter(product => /health/i.test(product.lineOfBusiness) && uinKey(product.uinRaw) === uinKey(uin));
    const live = health.filter(product => !isSyntheticProduct(product));
    if (live.length === 1) return live[0];
    return health.length > 0 && live.length === 0 ? result(MATCH_OUTCOMES.syntheticOnly) : result(MATCH_OUTCOMES.noMatch);
  }
  if (!insurerName || !productName) return result(MATCH_OUTCOMES.noMatch);
  const resolved = await lookup('insurers.resolve', { q: insurerName });
  if (resolved.status !== 'resolved' || !resolved.insurer) return result(MATCH_OUTCOMES.noMatch);
  const { products } = await lookup('products.search', { insurerId: resolved.insurer.id, q: productName });
  const named = products.filter(product => /health/i.test(product.lineOfBusiness) && fold(product.productName) === fold(productName));
  const live = named.filter(product => !isSyntheticProduct(product));
  if (live.length === 1) return live[0];
  return named.length > 0 && live.length === 0 ? result(MATCH_OUTCOMES.syntheticOnly) : result(MATCH_OUTCOMES.noMatch);
}

/** Picks the one version of a product that applies on `startDate` (ISO day) from parsed versions. Pure. */
export function pickVersion({ versions, startDate = null }) {
  const kept = versions.filter(version => !DROPPED_FRESHNESS.has(version.freshness));
  if (kept.length === 0) {
    return versions.some(version => SYNTHETIC_FRESHNESS.has(version.freshness)) ? result(MATCH_OUTCOMES.syntheticOnly) : result(MATCH_OUTCOMES.versionUnresolved);
  }
  const start = isoDay(startDate);
  if (start === null) return kept.length === 1 ? result(MATCH_OUTCOMES.matched, { versionId: kept[0].versionId }) : result(MATCH_OUTCOMES.versionUnresolved);
  const inWindow = kept.filter(version => {
    const from = isoDay(version.effectiveFrom);
    const to = isoDay(version.effectiveTo);
    return (from === null || from <= start) && (to === null || start <= to);
  });
  return inWindow.length === 1 ? result(MATCH_OUTCOMES.matched, { versionId: inWindow[0].versionId }) : result(MATCH_OUTCOMES.versionUnresolved);
}

/**
 * Resolves the confirmed product to exactly one FSS version.
 * Returns { outcome: 'matched', productId, versionId } or { outcome: 'no_match' | 'version_unresolved' | 'synthetic_only' }.
 * Lookup errors (ReferenceDataError) propagate to the caller.
 */
export async function matchFssVersion({ lookup, uin = null, insurerName = null, productName = null, startDate = null }) {
  const product = await matchProduct({ lookup, uin, insurerName, productName });
  if (product.outcome) return product;
  const { data } = await lookup('products.versions', { productId: product.productId });
  const picked = pickVersion({ versions: data, startDate });
  return picked.outcome === MATCH_OUTCOMES.matched ? result(MATCH_OUTCOMES.matched, { productId: product.productId, versionId: picked.versionId }) : picked;
}
