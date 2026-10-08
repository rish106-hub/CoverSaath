// Cashless network counts per (insurer, city), read from the insurer's own hospital locator and stored as dated,
// insurer-reported Section 10 disclosures (metric network_hospitals_in_city). A count is context only: it never
// says whether a particular hospital will grant cashless, and every value carries the "confirm before admission"
// note from network-locators.js.
//
// Requests go only through the guarded adapter's fetchDiscovered with a discovery source per locator, so the URL
// can only be the registered locator path with the registered query keys (offset, limit, city, search).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { NETWORK_COUNTS_FILE } from './reference-store.js';
import { buildDiscoveredFetchRequest, defineDiscoverySource } from './official/discovery.js';
import { createNetworkLocator, NETWORK_LOCATOR_REGISTRY, networkDisclosureEntries } from './official/network-locators.js';

const FORMAT = 'knowvia.network-counts/v1';
// Locators list cities under their current official names. The household's own label is kept on the stored entry.
const CITY_ALIASES = new Map([['bangalore', 'Bengaluru'], ['bombay', 'Mumbai'], ['madras', 'Chennai'], ['calcutta', 'Kolkata'], ['gurgaon', 'Gurugram'], ['poona', 'Pune'], ['trivandrum', 'Thiruvananthapuram'], ['mysore', 'Mysuru']]);
const locatorCity = city => CITY_ALIASES.get(String(city).trim().toLowerCase()) ?? city;
const MAX_ENTRIES = 2_000;
const DAY_MS = 86_400_000;

/** One discovery source per registered locator: its exact path and query keys, JSON only. */
export const NETWORK_LOCATOR_DISCOVERY_SOURCES = Object.freeze(NETWORK_LOCATOR_REGISTRY.map(entry => {
  const url = new URL(entry.baseUrl);
  return defineDiscoverySource({
    id: `${entry.insurerId}.hospital-locator`,
    publisher: entry.legalName,
    sourceClass: 'insurer_network_list',
    documentType: 'network_hospital_list',
    indexUrl: entry.baseUrl,
    allowedHosts: [...entry.allowedHosts],
    documentPathPrefixes: [url.pathname],
    allowedQueryKeys: Object.values(entry.requestTemplate),
    expectedMimeTypes: ['application/json'],
    maxBytes: 2 * 1024 * 1024,
    freshnessDays: 1,
    owner: 'knowvia-policy-breakdown',
  });
}));

/** httpGetJson for the locator, backed by the guarded adapter. Static headers are not needed (verified 2026-10-08). */
export function adapterJsonGetter(adapter, { now = () => new Date() } = {}) {
  return async url => {
    const host = new URL(url).hostname;
    const source = NETWORK_LOCATOR_DISCOVERY_SOURCES.find(item => item.allowedHosts.includes(host));
    if (!source) throw Object.assign(new Error('locator host not registered'), { code: 'LOCATOR_NOT_REGISTERED' });
    const result = await adapter.fetchDiscovered(buildDiscoveredFetchRequest({ requestId: `locator-${now().getTime()}`, discoverySource: source, url, requestedAt: now().toISOString(), timeoutMs: 10_000 }), source);
    if (!result.ok) throw Object.assign(new Error(result.error.code), { code: result.error.code });
    return JSON.parse(Buffer.from(result.bytes).toString('utf8'));
  };
}

function readStore(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed?.format === FORMAT ? parsed : null;
  } catch { return null; }
}

/**
 * ensureCount({ insurerName, city }) fetches a count when none is stored for that pair within freshness. It never
 * throws; on failure the previous count (if any) stays and the metric is simply not refreshed.
 */
export function createNetworkCountRefresher({ adapter, directory, now = () => new Date(), locator = null, log = () => {}, onUpdated = () => {} }) {
  const network = locator ?? createNetworkLocator({ httpGetJson: adapterJsonGetter(adapter, { now }), now });
  const path = join(directory, NETWORK_COUNTS_FILE);
  const inFlight = new Map();
  const pairKey = (insurer, city) => `${String(insurer).toLowerCase()}|${String(city).toLowerCase()}`;

  async function run(insurerName, city) {
    const store = readStore(path) ?? { format: FORMAT, entries: [], attempts: {} };
    const key = pairKey(insurerName, city);
    const lastAttempt = store.attempts[key] ? Date.parse(store.attempts[key]) : 0;
    if (now().getTime() - lastAttempt < DAY_MS) return { status: 'fresh' };
    const result = await network.countInCity({ insurer: insurerName, city: locatorCity(city) });
    store.attempts[key] = now().toISOString();
    if (result.status === 'unsupported' || result.status === 'invalid_input') {
      // Remember the miss for a day too, so unsupported insurers cost nothing on every view.
    } else if (result.status !== 'ok') {
      log({ event: 'network_count_refresh_failed', status: result.status });
    }
    const fresh = networkDisclosureEntries(result, { insurerName, city }).map(entry => ({ ...entry, cityScopeNote: result.scopeNote ?? null, confirmNote: result.source?.note ?? null }));
    if (fresh.length) {
      const replaced = new Set(fresh.map(entry => pairKey(entry.insurerName, entry.city)));
      store.entries = [...store.entries.filter(entry => !replaced.has(pairKey(entry.insurerName, entry.city)) || entry.period !== fresh[0].period), ...fresh].slice(-MAX_ENTRIES);
    }
    mkdirSync(directory, { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(store, null, 1)}\n`);
    renameSync(temporary, path);
    if (fresh.length) onUpdated();
    return { status: result.status, count: result.count ?? null };
  }

  return Object.freeze({
    path,
    ensureCount({ insurerName, city }) {
      if (!insurerName || !city) return Promise.resolve({ status: 'invalid_input' });
      const key = pairKey(insurerName, city);
      if (!inFlight.has(key)) {
        inFlight.set(key, run(insurerName, city).catch(error => { log({ event: 'network_count_refresh_error', code: error.code ?? error.name }); return { status: 'unavailable' }; })
          .finally(() => inFlight.delete(key)));
      }
      return inFlight.get(key);
    },
  });
}
