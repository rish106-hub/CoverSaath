// Cashless hospital network lookups from insurers' own public locators.
//
// Only locators an operator has verified by hand are registered. The HTTP call is INJECTED (`httpGetJson`): the
// integrator backs it with the guarded, allowlisted adapter, so this module never opens a socket. URLs are built
// only from a registry template plus validated public parameters, each encoded. Results are Dynamic evidence:
// they always carry the retrieval time, and a network list is a point-in-time snapshot, so callers must tell the
// household to confirm with the hospital / TPA before admission.

export const NETWORK_CONFIRM_NOTE = 'Network lists change without notice. Confirm with the hospital and the insurer or TPA before admission.';

const PAGE_SIZE = 100;
const MAX_PAGES = 5;
const MAX_MATCHES = 25;
const MAX_CITY_LENGTH = 60;
const MAX_NAME_LENGTH = 80;

const HDFC_ERGO_NAME = 'HDFC ERGO General Insurance Company Limited';
const text = value => (typeof value === 'string' ? value.trim() : '');

// Parsers turn one upstream JSON page into { total, items } or null when the shape is not recognised.
const hdfcHospitalPage = body => {
  if (!body || typeof body !== 'object' || !Number.isInteger(body.count) || body.count < 0 || !Array.isArray(body.data)) return null;
  const items = body.data
    .filter(row => row && typeof row === 'object' && text(row.name) && row.enabled !== 0 && row.hospitalType !== 'EXCLUDED')
    .map(row => ({ name: text(row.name), address: text(row.address), city: text(row.city), pincode: /^\d{6}$/.test(text(row.pincode)) ? text(row.pincode) : '' }));
  return { total: body.count, items, rawCount: body.data.length };
};

/**
 * Verified 2026-10-08 with plain GET: `count` is the total rows matching the filters (not the page size),
 * `city` matches the city label case-insensitively and exactly, `search` is a name substring search.
 * Required headers: x-app-request-id (any UUID, supplied per request by the caller) and x-api-client.
 */
export const NETWORK_LOCATOR_REGISTRY = Object.freeze([
  Object.freeze({
    insurerId: 'hdfc-ergo',
    legalName: HDFC_ERGO_NAME,
    aliases: Object.freeze(['hdfc ergo', 'hdfc ergo general insurance', 'hdfc ergo general insurance company']),
    kind: 'json_api',
    baseUrl: 'https://customer-portal.hdfcergo.com/content/v1/locator/hospitals',
    allowedHosts: Object.freeze(['customer-portal.hdfcergo.com']),
    requestTemplate: Object.freeze({ offset: 'offset', limit: 'limit', city: 'city', search: 'search' }),
    headers: Object.freeze({ 'x-api-client': 'CP_WEBSITE', accept: 'application/json' }),
    requestIdHeader: 'x-app-request-id',
    // What the count means, shown to reviewers: the locator's own city label, not a metro area.
    cityScopeNote: 'Counts hospitals whose listed city label equals the city name; suburbs and districts can be listed under their own labels.',
    parser: hdfcHospitalPage,
  }),
]);

const normaliseKey = value => text(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\b(limited|ltd|company|co|the)\b/g, ' ').replace(/\s+/g, ' ').trim();

export function findLocatorEntry(insurer, registry = NETWORK_LOCATOR_REGISTRY) {
  const key = normaliseKey(insurer);
  if (!key) return null;
  return registry.find(entry => entry.insurerId === key.replace(/ /g, '-') || normaliseKey(entry.legalName) === key
    || entry.aliases.some(alias => normaliseKey(alias) === key)) ?? null;
}

// ---- input validation ----------------------------------------------------------------------------------------

export function validateCity(city) {
  const value = text(city).replace(/\s+/g, ' ');
  if (!value || value.length > MAX_CITY_LENGTH || !/^[\p{L}][\p{L} ]*$/u.test(value)) return null;
  return value;
}

export function validatePincode(pincode) {
  const value = text(String(pincode ?? ''));
  return /^[1-9]\d{5}$/.test(value) ? value : null;
}

// A hospital name is public data; anything that looks like a person's identifier or contact detail is refused.
const PRIVATE_SIGNALS = [/@/, /\d{6,}/, /\b\d{3,5}[\s-]\d{3,5}[\s-]?\d{0,5}\b/, /https?:|www\./i, /\b[A-Z]{5}\d{4}[A-Z]\b/, /\b(aadhaar|aadhar|pan|policy\s*(no|number)|claim\s*(no|number)|member\s*id|dob|passport)\b/i];

export function validateHospitalName(name) {
  const value = text(name).replace(/\s+/g, ' ');
  if (value.length < 2 || value.length > MAX_NAME_LENGTH) return null;
  if (!/^[\p{L}\p{N}][\p{L}\p{N} .,&'()\/-]*$/u.test(value)) return null;
  if (PRIVATE_SIGNALS.some(pattern => pattern.test(value))) return null;
  return value;
}

// ---- name matching -------------------------------------------------------------------------------------------

const STOP_TOKENS = new Set(['hospital', 'hospitals', 'the', 'and', 'pvt', 'ltd', 'private', 'limited', 'clinic', 'centre', 'center', 'nursing', 'home', 'multispeciality', 'multispecialty', 'multi', 'speciality', 'specialty', 'super', 'general', 'medical', 'research', 'institute', 'of']);
const tokens = name => text(name).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').split(' ').filter(Boolean);
const identity = name => tokens(name).join(' ');
const distinctive = name => tokens(name).filter(token => !STOP_TOKENS.has(token));

/** 'exact' (same normalised name), 'subset' (every distinctive query token is in the candidate), or null. */
export function matchKind(query, candidate) {
  if (identity(query) && identity(query) === identity(candidate)) return 'exact';
  const queryTokens = distinctive(query);
  if (!queryTokens.length) return null;
  const candidateTokens = new Set(tokens(candidate));
  return queryTokens.every(token => candidateTokens.has(token)) ? 'subset' : null;
}

// ---- locator ------------------------------------------------------------------------------------------------

function buildUrl(entry, params) {
  const url = new URL(entry.baseUrl);
  if (!entry.allowedHosts.includes(url.hostname) || url.protocol !== 'https:') throw new Error('locator_host_not_allowed');
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    const name = entry.requestTemplate[key];
    if (!name) throw new Error(`locator_template_missing_${key}`);
    url.searchParams.set(name, String(value));
  }
  return url.toString();
}

/**
 * @param {{ httpGetJson: (url: string, headers: Record<string,string>) => Promise<unknown>, now?: () => Date,
 *           newRequestId?: () => string, registry?: readonly object[] }} deps
 *   httpGetJson must return the parsed JSON body and throw on any non-2xx, timeout or non-JSON response.
 */
export function createNetworkLocator({ httpGetJson, now = () => new Date(), newRequestId = () => globalThis.crypto.randomUUID(), registry = NETWORK_LOCATOR_REGISTRY } = {}) {
  if (typeof httpGetJson !== 'function') throw new TypeError('httpGetJson is required');

  const headersFor = entry => ({ ...entry.headers, ...(entry.requestIdHeader ? { [entry.requestIdHeader]: newRequestId() } : {}) });
  const sourceFor = (entry, retrievedAt) => ({ insurerId: entry.insurerId, insurerName: entry.legalName, label: `${entry.legalName} hospital locator, retrieved ${retrievedAt.slice(0, 10)}`, url: entry.baseUrl, note: NETWORK_CONFIRM_NOTE });

  async function fetchPage(entry, params) {
    const body = await httpGetJson(buildUrl(entry, params), headersFor(entry));
    const page = entry.parser(body);
    if (!page) throw new Error('locator_unrecognised_response');
    return page;
  }

  const base = (status, entry, retrievedAt, extra = {}) => ({ status, retrievedAt, source: entry ? sourceFor(entry, retrievedAt) : null, ...extra });

  return {
    registry,

    /** Number of the insurer's cashless network hospitals in a city. status: ok | unavailable | unsupported | invalid_input. */
    async countInCity({ insurer, city } = {}) {
      const retrievedAt = now().toISOString();
      const entry = findLocatorEntry(insurer, registry);
      if (!entry) return base('unsupported', null, retrievedAt, { count: null });
      const cleanCity = validateCity(city);
      if (!cleanCity) return base('invalid_input', entry, retrievedAt, { count: null });
      try {
        const page = await fetchPage(entry, { offset: 0, limit: 1, city: cleanCity });
        if (!Number.isSafeInteger(page.total) || page.total > 100_000) return base('unavailable', entry, retrievedAt, { count: null });
        return base('ok', entry, retrievedAt, { count: page.total, city: cleanCity, scopeNote: entry.cityScopeNote });
      } catch {
        return base('unavailable', entry, retrievedAt, { count: null });
      }
    },

    /**
     * Is a named hospital in the insurer's network? status: in_network | not_found | unavailable (plus unsupported /
     * invalid_input). matches[] lists every candidate with its matchKind ('exact' | 'subset'); in_network is only
     * returned when at least one match is listed. not_found means the locator returned no matching row, not that
     * the hospital is certainly outside the network.
     */
    async findHospital({ insurer, city, name, pincode } = {}) {
      const retrievedAt = now().toISOString();
      const entry = findLocatorEntry(insurer, registry);
      if (!entry) return base('unsupported', null, retrievedAt, { matches: [] });
      const cleanCity = validateCity(city);
      const cleanName = validateHospitalName(name);
      const cleanPincode = pincode === undefined || pincode === null || pincode === '' ? null : validatePincode(pincode);
      if (!cleanCity || !cleanName || (pincode && !cleanPincode)) return base('invalid_input', entry, retrievedAt, { matches: [] });
      const searchTerm = distinctive(cleanName).join(' ') || cleanName;
      const matches = [];
      try {
        for (let page = 0; page < MAX_PAGES && matches.length < MAX_MATCHES; page += 1) {
          const result = await fetchPage(entry, { offset: page * PAGE_SIZE, limit: PAGE_SIZE, city: cleanCity, search: searchTerm });
          for (const item of result.items) {
            const kind = matchKind(cleanName, item.name);
            if (!kind) continue;
            if (cleanPincode && item.pincode && item.pincode !== cleanPincode) continue;
            matches.push({ name: item.name, address: item.address, city: item.city, pincode: item.pincode, matchKind: kind });
          }
          if (result.rawCount < PAGE_SIZE || (page + 1) * PAGE_SIZE >= result.total) break;
        }
      } catch {
        return base('unavailable', entry, retrievedAt, { matches: [] });
      }
      matches.sort((a, b) => (a.matchKind === b.matchKind ? 0 : a.matchKind === 'exact' ? -1 : 1));
      return base(matches.length ? 'in_network' : 'not_found', entry, retrievedAt, { matches: matches.slice(0, MAX_MATCHES), city: cleanCity });
    },
  };
}

/**
 * Section 10 disclosure entries for a successful countInCity result. Returns [] for any other status, so a failed
 * lookup leaves network_hospitals_in_city Unknown rather than inventing a zero.
 */
export function networkDisclosureEntries(result, { insurerName, city } = {}) {
  if (!result || result.status !== 'ok' || !Number.isSafeInteger(result.count) || result.count < 0) return [];
  const name = text(insurerName) || result.source?.insurerName;
  const cleanCity = validateCity(city ?? result.city);
  const retrieved = typeof result.retrievedAt === 'string' ? result.retrievedAt.slice(0, 10) : '';
  if (!name || !cleanCity || !/^\d{4}-\d{2}-\d{2}$/.test(retrieved)) return [];
  return [{
    insurerName: name,
    metric: 'network_hospitals_in_city',
    value: result.count,
    period: retrieved,
    publishedOn: retrieved,
    source: `${result.source?.insurerName ?? name} insurer locator, retrieved ${retrieved}`,
    sourceKind: 'insurer_reported',
    city: cleanCity,
  }];
}
