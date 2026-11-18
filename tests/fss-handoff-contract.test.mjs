// FSS handoff v1 contract: request allow-list, response shape, notice signature, and the client against a local stub. Synthetic data only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHandoffClient, normalizeHandoffRequest, parseHandoff, signNotice, verifyNotice, handoffEnabled, NOTICE_REPLAY_WINDOW_MS } from '../src/integrations/insurance-data/index.js';

const SECRET = 'test-secret-0123456789abcdef';
const body = state => JSON.stringify({ handoff_id: 'h-1', request_id: 'req-12345678', state, version_id: 'v-1' });

test('a request carries identifiers only; any other field is refused', () => {
  assert.deepEqual(normalizeHandoffRequest({ requestId: 'req-12345678', insurerName: ' Test  Insurer ', productName: 'Test Plan' }), { requestId: 'req-12345678', insurerName: 'Test Insurer', productName: 'Test Plan' });
  assert.equal(normalizeHandoffRequest({ requestId: 'req-12345678', insurerName: 'A', productName: 'B', uin: 'tst123v01' }).uin, 'TST123V01');
  for (const extra of [{ householdId: 'h' }, { policyNumber: 'P1' }, { text: 'document text' }]) {
    assert.throws(() => normalizeHandoffRequest({ requestId: 'req-12345678', insurerName: 'A', productName: 'B', ...extra }), { code: 'REFERENCE_DATA_REQUEST_INVALID' });
  }
  assert.throws(() => normalizeHandoffRequest({ requestId: 'x', insurerName: 'A', productName: 'B' }), { code: 'REFERENCE_DATA_REQUEST_INVALID' });
  assert.throws(() => normalizeHandoffRequest({ requestId: 'req-12345678', insurerName: 'A\u0000', productName: 'B' }), { code: 'REFERENCE_DATA_REQUEST_INVALID' });
});

test('a response must have the closed shape', () => {
  assert.deepEqual({ ...parseHandoff(JSON.parse(body('matched'))) }, { handoffId: 'h-1', requestId: 'req-12345678', state: 'matched', versionId: 'v-1' });
  assert.throws(() => parseHandoff({ handoff_id: 'h-1', request_id: 'req-12345678', state: 'surprise' }), { code: 'REFERENCE_DATA_RESPONSE_INVALID' });
  assert.throws(() => parseHandoff(null), { code: 'REFERENCE_DATA_RESPONSE_INVALID' });
});

test('a notice is verified by signature and time before it is read, and only a final state is accepted', () => {
  const raw = body('matched');
  const now = 1_800_000_000_000;
  const header = signNotice(raw, SECRET, now);
  assert.equal(verifyNotice({ rawBody: raw, header, secret: SECRET, now }).state, 'matched');
  assert.throws(() => verifyNotice({ rawBody: raw + ' ', header, secret: SECRET, now }), { code: 'FSS_NOTICE_SIGNATURE_INVALID' });
  assert.throws(() => verifyNotice({ rawBody: raw, header, secret: `${SECRET}x`, now }), { code: 'FSS_NOTICE_SIGNATURE_INVALID' });
  assert.throws(() => verifyNotice({ rawBody: raw, header: 'garbage', secret: SECRET, now }), { code: 'FSS_NOTICE_SIGNATURE_INVALID' });
  assert.throws(() => verifyNotice({ rawBody: raw, header, secret: SECRET, now: now + NOTICE_REPLAY_WINDOW_MS + 1 }), { code: 'FSS_NOTICE_STALE' });
  const working = body('working');
  assert.throws(() => verifyNotice({ rawBody: working, header: signNotice(working, SECRET, now), secret: SECRET, now }), { code: 'FSS_NOTICE_NOT_FINAL' });
  assert.throws(() => verifyNotice({ rawBody: raw, header, secret: 'short', now }), { code: 'REFERENCE_DATA_NOT_CONFIGURED' });
});

test('the client is off by default, sends only the allow-listed body with an idempotency key, and reads the state', async () => {
  assert.equal(handoffEnabled({}), false);
  await assert.rejects(createHandoffClient({ env: {} }).get('h-1'), { code: 'REFERENCE_DATA_DISABLED' });
  const env = { REFERENCE_DATA_ENABLED: 'true', FSS_HANDOFF_ENABLED: 'true', REFERENCE_DATA_BASE_URL: 'http://127.0.0.1:9', REFERENCE_DATA_API_KEY: 'k-test' };
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push({ url: String(url), init }); return new Response(body('accepted'), { status: 202 }); };
  const client = createHandoffClient({ env, fetchImpl });
  const made = await client.create({ requestId: 'req-12345678', insurerName: 'Test Insurer', productName: 'Test Plan' });
  assert.equal(made.state, 'accepted');
  assert.equal(seen[0].url, 'http://127.0.0.1:9/v1/handoffs');
  assert.equal(seen[0].init.method, 'POST');
  assert.equal(seen[0].init.headers['idempotency-key'], 'req-12345678');
  assert.deepEqual(JSON.parse(seen[0].init.body), { request_id: 'req-12345678', insurer_name: 'Test Insurer', product_name: 'Test Plan' });
  assert.equal((await client.get('h-1')).handoffId, 'h-1');
  assert.equal(seen[1].url, 'http://127.0.0.1:9/v1/handoffs/h-1');
  const down = createHandoffClient({ env, fetchImpl: async () => { throw new Error('boom'); } });
  await assert.rejects(down.get('h-1'), { code: 'REFERENCE_DATA_UNAVAILABLE', retryable: true });
  const auth = createHandoffClient({ env, fetchImpl: async () => new Response('{}', { status: 401 }) });
  await assert.rejects(auth.get('h-1'), { code: 'REFERENCE_DATA_AUTH_FAILED' });
  await assert.rejects(createHandoffClient({ env: { ...env, REFERENCE_DATA_BASE_URL: 'http://example.com' }, fetchImpl }).get('h-1'), { code: 'REFERENCE_DATA_NOT_CONFIGURED' });
});
