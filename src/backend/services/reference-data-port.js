import { createHash, randomUUID } from 'node:crypto';
import { ReferenceDataError, referenceDataEnabled } from '../../integrations/index.js';

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

  return {
    searchInsurers: ({ q }) => read('insurers.search', { q }),
    resolveInsurer: ({ q }) => read('insurers.resolve', { q }),
    searchProducts: params => read('products.search', params),
    getProduct: ({ productId }) => read('products.get', { productId }),
    listVersions: ({ productId }) => read('products.versions', { productId }),
    getFacts: ({ versionId, factType }) => read('versions.facts', factType === undefined ? { versionId } : { versionId, factType }),
  };
}
