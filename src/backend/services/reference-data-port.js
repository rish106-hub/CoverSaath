import { createHash, randomUUID } from 'node:crypto';
import { ReferenceDataError, referenceDataEnabled, collectFactPages } from '../../integrations/index.js';

// ReferenceDataPort (B3): reads PUBLIC insurance reference data (insurers, products, versions, facts) through the D3
// cache (migration 033). Off unless REFERENCE_DATA_ENABLED is exactly "true". Reference data is context only: it never
// decides eligibility, money, consent or release (X1 rule 8). Nothing household-related is ever an input here; the
// client rejects any parameter outside its allow-list, and cache keys are hashes of those normalised parameters.
// Failure policy: fresh cache wins; one process refreshes at a time (lease); on failure serve the cached body labelled
// stale; with no cache, throw a coded error. Never fabricates data.

const digest = value => createHash('sha256').update(value, 'utf8').digest('hex');
const canonical = value => JSON.stringify(value, (key, v) => (v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v));

export const cacheKeyFor = (endpoint, params) => `${endpoint.toLowerCase().replace(/[^a-z0-9.]/g, '-')}/${digest(canonical(params)).slice(0, 40)}`;
export const signatureFor = body => digest(canonical(body));

export function createReferenceDataPort({ repository, client, env = process.env, owner = `ref-${randomUUID()}`, leaseMs } = {}) {
  if (!repository || !client) throw new TypeError('createReferenceDataPort needs a repository and a client.');
  const unavailable = () => new ReferenceDataError('REFERENCE_DATA_UNAVAILABLE', 'Reference data is unavailable.', { retryable: true, statusCode: 503 });

  const factsParams = ({ versionId, factType, cursor }) => ({ versionId, ...(factType === undefined ? {} : { factType }), ...(cursor == null ? {} : { cursor }) });

  async function read(endpoint, rawParams) {
    if (!referenceDataEnabled(env)) {
      throw new ReferenceDataError('REFERENCE_DATA_DISABLED', 'Reference data is disabled.', { statusCode: 503 });
    }
    const params = client.normalizeParams(endpoint, rawParams);
    const key = cacheKeyFor(endpoint, params);
    let row = await repository.get(key);
    // A row whose body no longer matches its signature is corrupt or tampered: drop it and treat as a miss.
    if (row && row.signature !== signatureFor(row.body)) {
      await repository.remove(key);
      row = null;
    }
    const served = (source, stale) => ({ data: row.body, source, stale, fetchedAt: row.fetchedAt, referenceContextOnly: true });
    if (row?.fresh) return served('cache', false);

    const hasLease = await repository.acquireLease({ key, owner, ...(leaseMs ? { leaseMs } : {}) });
    if (!hasLease) {
      // Another process is refreshing this key: do not stampede the service.
      if (row) return served('cache', true);
      throw unavailable();
    }
    try {
      const { data, etag } = await client.read(endpoint, params);
      const stored = await repository.put({ key, etag, body: data, signature: signatureFor(data) });
      return { data: stored.body, source: 'service', stale: false, fetchedAt: stored.fetchedAt, referenceContextOnly: true };
    } catch (error) {
      if (error instanceof ReferenceDataError && error.code === 'REFERENCE_DATA_NOT_FOUND') {
        if (row) await repository.remove(key);
        throw error;
      }
      if (row) {
        await repository.markStale(key);
        return served('cache', true);
      }
      throw error instanceof ReferenceDataError ? error : unavailable();
    } finally {
      await repository.releaseLease({ key, owner }).catch(() => {});
    }
  }

  /** Cache-only read: never fetches, never takes a lease, never writes. Null on disabled, miss or a corrupt row. */
  async function peek(endpoint, rawParams) {
    if (!referenceDataEnabled(env)) return null;
    const key = cacheKeyFor(endpoint, client.normalizeParams(endpoint, rawParams));
    const row = await repository.get(key);
    if (!row || row.signature !== signatureFor(row.body)) return null;
    return { data: row.body, source: 'cache', stale: !row.fresh, fetchedAt: row.fetchedAt, referenceContextOnly: true };
  }

  return {
    peek,
    peekFacts: ({ versionId, factType, cursor }) => peek('versions.facts', factsParams({ versionId, factType, cursor })),
    /** All facts pages (max 5) through the cache. Coverage comes from the first page. */
    async getAllFacts({ versionId, factType }) {
      const pages = [];
      const merged = await collectFactPages(async cursor => {
        const result = await read('versions.facts', factsParams({ versionId, factType, cursor }));
        pages.push(result);
        return result.data;
      });
      return { data: merged, source: pages.every(p => p.source === 'cache') ? 'cache' : 'service', stale: pages.some(p => p.stale), referenceContextOnly: true };
    },
    searchInsurers: ({ q }) => read('insurers.search', { q }),
    resolveInsurer: ({ q }) => read('insurers.resolve', { q }),
    searchProducts: params => read('products.search', params),
    getProduct: ({ productId }) => read('products.get', { productId }),
    listVersions: ({ productId }) => read('products.versions', { productId }),
    getFacts: ({ versionId, factType, cursor }) => read('versions.facts', factsParams({ versionId, factType, cursor })),
  };
}
