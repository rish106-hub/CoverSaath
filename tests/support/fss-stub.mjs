// Fixture fetch for the FSS (insurance-data-api) client. Serves recorded synthetic JSON from tests/fixtures/fss and can
// fail on demand. No network. Synthetic data only: UIN SYNTHHLT0001, fake insurer and product names.
import { readFileSync } from 'node:fs';

const fixture = name => JSON.parse(readFileSync(new URL(`../fixtures/fss/${name}.json`, import.meta.url), 'utf8'));
export const FSS_STUB_ENV = Object.freeze({
  REFERENCE_DATA_ENABLED: 'true',
  REFERENCE_DATA_BASE_URL: 'https://fss.example.invalid',
  REFERENCE_DATA_API_KEY: 'stub-key-not-real',
});
export const FSS_STUB_UIN = 'SYNTHHLT0001';
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** `fail` is a status number (401, 403, 404, 429, 500), 'timeout' (never answers until aborted) or null.
 * `facts` is a list of fixture names served in order for /facts, selected by the cursor (none = first). `endless` serves a next_cursor on every page. */
export function createFssStub({ fail = null, facts = ['facts-page-1', 'facts-page-2'], retryAfterSeconds = null, endless = false } = {}) {
  const calls = [];
  const state = { fail };
  const fetchImpl = (url, init = {}) => {
    const target = new URL(String(url));
    calls.push({ path: target.pathname, search: target.search, authorization: init.headers?.authorization });
    if (state.fail === 'timeout') {
      return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    }
    if (typeof state.fail === 'number') {
      return Promise.resolve(new Response('upstream detail', { status: state.fail, headers: retryAfterSeconds ? { 'retry-after': String(retryAfterSeconds) } : {} }));
    }
    const path = target.pathname;
    if (path === '/v1/products') return Promise.resolve(json(fixture('product')));
    if (/\/v1\/products\/[^/]+\/versions$/.test(path)) return Promise.resolve(json(fixture('versions')));
    if (/\/v1\/versions\/[^/]+\/facts$/.test(path)) {
      const cursor = target.searchParams.get('cursor');
      if (endless) {
        const n = cursor === null ? 1 : Number(cursor.replace('cur_', ''));
        return Promise.resolve(json({ ...fixture('facts-page-1'), next_cursor: `cur_${n + 1}` }));
      }
      const index = cursor === null ? 0 : Number(cursor.replace('cur_', '')) - 1;
      return Promise.resolve(facts[index] ? json(fixture(facts[index])) : json({ error: 'not_found' }, 404));
    }
    return Promise.resolve(json({ error: 'not_found' }, 404));
  };
  return { fetchImpl, calls, setFail: value => { state.fail = value; } };
}
