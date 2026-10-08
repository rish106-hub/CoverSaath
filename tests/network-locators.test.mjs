import test from 'node:test';
import assert from 'node:assert/strict';

import { createNetworkLocator, networkDisclosureEntries, matchKind, validateCity, validateHospitalName, validatePincode, NETWORK_CONFIRM_NOTE } from '../src/modules/policy-breakdown/references/official/network-locators.js';

const NOW = new Date('2026-10-08T06:00:00Z');
// Synthetic hospitals only.
const hospital = (name, city = 'PUNE', pincode = '411001') => ({ enabled: 1, name, address: `1 Test Road, ${city}`, city, pincode, hospitalType: 'NETWORK' });
const PUNE = [
  hospital('SUNRISE MULTISPECIALITY HOSPITAL'), hospital('SUNRISE CHILDREN HOSPITAL', 'PUNE', '411028'),
  hospital('LAKEVIEW HEART INSTITUTE'), hospital('GREEN VALLEY HOSPITAL & RESEARCH CENTRE'),
];

function fakeApi(rows = PUNE, calls = []) {
  return async (url, headers) => {
    calls.push({ url, headers });
    const u = new URL(url);
    const offset = Number(u.searchParams.get('offset')); const limit = Number(u.searchParams.get('limit'));
    const search = (u.searchParams.get('search') ?? '').toLowerCase();
    const city = (u.searchParams.get('city') ?? '').toLowerCase();
    const filtered = rows.filter(r => (!city || r.city.toLowerCase() === city) && (!search || search.split(' ').every(t => r.name.toLowerCase().includes(t))));
    return { count: filtered.length, data: filtered.slice(offset, offset + limit) };
  };
}
const locator = (get, extra = {}) => createNetworkLocator({ httpGetJson: get, now: () => NOW, newRequestId: () => 'req-1', ...extra });

test('countInCity reads the total-count field, not the page length', async () => {
  const rows = Array.from({ length: 250 }, (_, i) => hospital(`TEST HOSPITAL ${i}`));
  const calls = [];
  const result = await locator(fakeApi(rows, calls)).countInCity({ insurer: 'HDFC ERGO General Insurance Company Limited', city: 'pune' });
  assert.equal(result.status, 'ok');
  assert.equal(result.count, 250);
  assert.equal(result.retrievedAt, '2026-10-08T06:00:00.000Z');
  assert.match(result.source.label, /retrieved 2026-10-08/);
  assert.equal(result.source.note, NETWORK_CONFIRM_NOTE);
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.hostname, 'customer-portal.hdfcergo.com');
  assert.equal(url.searchParams.get('limit'), '1');
  assert.equal(calls[0].headers['x-api-client'], 'CP_WEBSITE');
  assert.equal(calls[0].headers['x-app-request-id'], 'req-1');
});

test('countInCity maps a zero count to ok/0 and insurer aliases resolve', async () => {
  const result = await locator(fakeApi()).countInCity({ insurer: 'hdfc ergo', city: 'Atlantis' });
  assert.deepEqual([result.status, result.count], ['ok', 0]);
});

test('input validation rejects before any request is made', async () => {
  let calls = 0;
  const l = locator(async () => { calls += 1; return { count: 0, data: [] }; });
  for (const city of ['', 'Pune; DROP', 'Pune&city=x', 'a'.repeat(61), 'Pune123', 42]) {
    assert.equal((await l.countInCity({ insurer: 'hdfc ergo', city })).status, 'invalid_input', String(city));
  }
  assert.equal((await l.findHospital({ insurer: 'hdfc ergo', city: 'Pune', name: 'Call 9876543210' })).status, 'invalid_input');
  assert.equal((await l.findHospital({ insurer: 'hdfc ergo', city: 'Pune', name: 'x@y.com' })).status, 'invalid_input');
  assert.equal((await l.findHospital({ insurer: 'hdfc ergo', city: 'Pune', name: 'Sunrise', pincode: '12' })).status, 'invalid_input');
  assert.equal((await l.countInCity({ insurer: 'Unknown Insurer Ltd', city: 'Pune' })).status, 'unsupported');
  assert.equal(calls, 0);
  assert.equal(validateCity('New Delhi'), 'New Delhi');
  assert.equal(validatePincode('411001'), '411001');
  assert.equal(validatePincode('011001'), null);
  assert.equal(validateHospitalName("St. Mary's Hospital & Research (Pune)"), "St. Mary's Hospital & Research (Pune)");
});

test('encoded params cannot inject extra query keys', async () => {
  const calls = [];
  await locator(fakeApi(PUNE, calls)).findHospital({ insurer: 'hdfc ergo', city: 'Pune', name: "Sunrise & Co (x)" });
  const url = new URL(calls[0].url);
  assert.deepEqual([...url.searchParams.keys()].sort(), ['city', 'limit', 'offset', 'search']);
});

test('findHospital lists exact before subset matches and never hides candidates', async () => {
  const result = await locator(fakeApi()).findHospital({ insurer: 'hdfc ergo', city: 'Pune', name: 'Sunrise Multispeciality Hospital' });
  assert.equal(result.status, 'in_network');
  assert.equal(result.matches[0].matchKind, 'exact');
  assert.equal(result.matches[0].name, 'SUNRISE MULTISPECIALITY HOSPITAL');
  const broad = await locator(fakeApi()).findHospital({ insurer: 'hdfc ergo', city: 'Pune', name: 'Sunrise' });
  assert.equal(broad.status, 'in_network');
  assert.equal(broad.matches.length, 2);
  assert.ok(broad.matches.every(m => m.matchKind === 'subset'));
});

test('pincode narrows candidates; non-matching name is not_found', async () => {
  const byPin = await locator(fakeApi()).findHospital({ insurer: 'hdfc ergo', city: 'Pune', name: 'Sunrise', pincode: '411028' });
  assert.deepEqual(byPin.matches.map(m => m.name), ['SUNRISE CHILDREN HOSPITAL']);
  const none = await locator(fakeApi()).findHospital({ insurer: 'hdfc ergo', city: 'Pune', name: 'Moonlight Hospital' });
  assert.equal(none.status, 'not_found');
  assert.deepEqual(none.matches, []);
});

test('name matching is token based, not substring fuzzy', () => {
  assert.equal(matchKind('Lakeview Heart Institute', 'LAKEVIEW HEART INSTITUTE'), 'exact');
  assert.equal(matchKind('Green Valley', 'GREEN VALLEY HOSPITAL & RESEARCH CENTRE'), 'subset');
  assert.equal(matchKind('Green Valley Hospital', 'GREEN VALE HOSPITAL'), null);
  assert.equal(matchKind('Hospital', 'ANY HOSPITAL'), null);
});

test('findHospital paginates until the reported total is read', async () => {
  const rows = Array.from({ length: 230 }, (_, i) => hospital(i === 215 ? 'ZETA CARE HOSPITAL' : `FILLER ${i} HOSPITAL`));
  const calls = [];
  const result = await locator(fakeApi(rows, calls)).findHospital({ insurer: 'hdfc ergo', city: 'Pune', name: 'Zeta Care Hospital' });
  assert.equal(result.status, 'in_network');
  assert.ok(calls.length >= 1);
});

test('unavailable upstream and unrecognised shapes fail closed', async () => {
  const boom = locator(async () => { throw new Error('503'); });
  assert.equal((await boom.countInCity({ insurer: 'hdfc ergo', city: 'Pune' })).status, 'unavailable');
  assert.equal((await boom.findHospital({ insurer: 'hdfc ergo', city: 'Pune', name: 'Sunrise' })).status, 'unavailable');
  for (const body of [null, {}, { count: 'many', data: [] }, { count: -1, data: [] }, { count: 3 }, '<html>']) {
    const r = await locator(async () => body).countInCity({ insurer: 'hdfc ergo', city: 'Pune' });
    assert.equal(r.status, 'unavailable');
    assert.equal(r.count, null);
  }
});

test('networkDisclosureEntries builds the s10 shape and drops failed lookups', async () => {
  const result = await locator(fakeApi()).countInCity({ insurer: 'hdfc ergo', city: 'Pune' });
  const [entry] = networkDisclosureEntries(result, { insurerName: 'HDFC ERGO General Insurance Company Limited', city: 'Pune' });
  assert.deepEqual(entry, {
    insurerName: 'HDFC ERGO General Insurance Company Limited', metric: 'network_hospitals_in_city', value: 4,
    period: '2026-10-08', publishedOn: '2026-10-08',
    source: 'HDFC ERGO General Insurance Company Limited insurer locator, retrieved 2026-10-08', sourceKind: 'insurer_reported', city: 'Pune',
  });
  assert.deepEqual(networkDisclosureEntries({ status: 'unavailable', count: null }, { insurerName: 'X', city: 'Pune' }), []);
  assert.deepEqual(networkDisclosureEntries(result, { insurerName: 'X', city: 'Pune;' }), []);
});
