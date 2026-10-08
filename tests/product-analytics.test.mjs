import test from 'node:test';
import assert from 'node:assert/strict';
import { analyticsConsentCookie, readAnalyticsDecision } from '../src/ui/analytics/consent.js';
import { PRODUCT_EVENTS, sanitizeProductEvent } from '../src/ui/analytics/events.js';
import { createProductAnalytics } from '../src/ui/analytics/posthog-client.js';
import { hasAnalyticsConsent } from '../src/server/http/analytics-proxy.js';

function fakeSdk() {
  const calls = [];
  const record = name => (...args) => { calls.push([name, ...args]); };
  return { calls, init: record('init'), set_config: record('set_config'), opt_in_capturing: record('opt_in_capturing'), opt_out_capturing: record('opt_out_capturing'), capture: record('capture'), identify: record('identify'), reset: record('reset') };
}
// document.cookie semantics: assigning one "name=value; attrs" adds or replaces that cookie.
function fakeDocument(initial = '') {
  const jar = new Map(initial ? initial.split('; ').map(pair => pair.split('=')) : []);
  return { get cookie() { return [...jar].map(([name, value]) => `${name}=${value}`).join('; '); }, set cookie(line) { const [pair] = line.split(';'); const [name, value] = pair.split('='); jar.set(name, value); } };
}

test('consent cookie round-trips and the server proxy reads the same format', () => {
  for (const decision of ['granted', 'denied']) {
    const line = analyticsConsentCookie(decision, { secure: true });
    assert.match(line, /Path=\/; Max-Age=\d+; SameSite=Lax; Secure$/);
    const pair = line.split(';')[0];
    assert.equal(readAnalyticsDecision(pair), decision);
    assert.equal(hasAnalyticsConsent({ headers: { cookie: pair } }), decision === 'granted');
  }
  assert.equal(readAnalyticsDecision(''), null);
  assert.equal(readAnalyticsDecision('knowvia_consent=analytics%3Dgranted'), null, 'unversioned values are ignored');
  assert.equal(readAnalyticsDecision('knowvia_consent=v1%7Canalytics%3Dmaybe'), null);
  assert.throws(() => analyticsConsentCookie('yes'), /granted or denied/);
});

test('only allowlisted events and valid properties survive sanitising', () => {
  assert.equal(sanitizeProductEvent('patient_name_entered', { name: 'Ram' }), null);
  assert.deepEqual(sanitizeProductEvent('document_upload_completed', { document_kind: 'policy_wording', filename: 'ram-kumar.pdf' }),
    { event: 'document_upload_completed', properties: { document_kind: 'policy_wording' } });
  assert.deepEqual(sanitizeProductEvent('document_upload_completed', { document_kind: 'Ram Kumar policy' }).properties, {});
  assert.deepEqual(sanitizeProductEvent('member_added', { member_count: 3, dateOfBirth: '1962-07-21' }).properties, { member_count: 3 });
  assert.deepEqual(sanitizeProductEvent('breakdown_failed', { failed_step_count: 1.5 }).properties, {});
  for (const name of Object.keys(PRODUCT_EVENTS)) assert.match(name, /^[a-z]+(_[a-z]+)+$/, `${name} follows object_action`);
});

test('before consent the SDK is never loaded, so nothing can be captured or identified', async () => {
  const sdk = fakeSdk();
  let loads = 0;
  const analytics = createProductAnalytics({ key: 'phc_test', loadSdk: async () => { loads += 1; return sdk; }, doc: fakeDocument(), secure: false });
  analytics.track('household_created');
  analytics.identify('adult-1');
  await analytics.ready();
  assert.equal(loads, 0);
  assert.deepEqual(sdk.calls, []);
});

test('after grant the SDK loads with the constrained config and only clean events go out; deny stops it', async () => {
  const sdk = fakeSdk();
  const doc = fakeDocument();
  const analytics = createProductAnalytics({ key: 'phc_test', loadSdk: async () => sdk, doc, secure: false, origin: 'https://knowvia.example' });
  analytics.grant();
  analytics.track('document_upload_completed', { document_kind: 'policy_schedule', filename: 'x.pdf' });
  analytics.track('not_in_taxonomy');
  analytics.identify('adult-1');
  await analytics.ready();
  assert.equal(readAnalyticsDecision(doc.cookie), 'granted');
  const [[, key, config]] = sdk.calls;
  assert.equal(key, 'phc_test');
  assert.equal(config.api_host, 'https://knowvia.example/ingest');
  assert.equal(config.autocapture, false);
  assert.equal(config.capture_pageview, false);
  assert.equal(config.disable_session_recording, true);
  assert.equal(config.person_profiles, 'identified_only');
  const sent = sdk.calls.filter(([name]) => ['capture', 'identify'].includes(name));
  assert.deepEqual(sent, [
    ['capture', 'consent_granted', {}, { send_instantly: true }],
    ['capture', 'document_upload_completed', { document_kind: 'policy_schedule' }, { send_instantly: true }],
    ['identify', 'adult-1'],
  ]);

  analytics.deny();
  analytics.track('household_created');
  assert.equal(readAnalyticsDecision(doc.cookie), 'denied');
  assert.equal(sdk.calls.filter(([name]) => name === 'capture').length, 2);
  assert.ok(sdk.calls.some(([name]) => name === 'opt_out_capturing'));
});

test('a returning visitor who allowed analytics starts the SDK at once; without a key nothing loads', async () => {
  const sdk = fakeSdk();
  const analytics = createProductAnalytics({ key: 'phc_test', loadSdk: async () => sdk, doc: fakeDocument('knowvia_consent=v1%7Canalytics%3Dgranted'), secure: false });
  analytics.track('landing_viewed');
  await analytics.ready();
  assert.deepEqual(sdk.calls.map(([name]) => name), ['init', 'opt_in_capturing', 'capture']);

  let loads = 0;
  const off = createProductAnalytics({ key: '', loadSdk: async () => { loads += 1; return fakeSdk(); }, doc: fakeDocument(), secure: false });
  off.grant();
  off.track('household_created');
  await off.ready();
  assert.equal(off.enabled, false);
  assert.equal(loads, 0);
});
