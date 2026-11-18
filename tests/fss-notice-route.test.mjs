import test from 'node:test';
import assert from 'node:assert/strict';
import { postgresTestOptions } from './support/pg.mjs';
import { startApp } from './support/read-back-harness.mjs';
import { signNotice } from '../src/integrations/insurance-data/index.js';

// POST /api/v1/fss/notices (ADR 0037): off by default, HMAC is the only credential, refusals are coded 401s, unknown request ids drop with a 200.
const opts = postgresTestOptions();
const SECRET = 'synthetic-notice-secret-0123456789';
const ON = { HOLDINGS_ENABLED: 'true', REFERENCE_DATA_ENABLED: 'true', FSS_HANDOFF_ENABLED: 'true', FSS_NOTICE_SECRET: SECRET, REFERENCE_DATA_BASE_URL: 'https://fss.example.invalid', REFERENCE_DATA_API_KEY: 'stub-key-not-real' };
const body = JSON.stringify({ handoff_id: 'h-1', request_id: 'req-unknown-0001', state: 'no_match' });
const post = (app, raw, signature) => fetch(`${app.base}/api/v1/fss/notices`, { method: 'POST', headers: { 'content-type': 'application/json', ...(signature ? { 'x-fss-signature': signature } : {}) }, body: raw });

test('notice route is a 404 while the flag is off', opts, async t => {
  const app = await startApp(t);
  assert.equal((await post(app, body, signNotice(body, SECRET))).status, 404);
});

test('notice route: no header, bad MAC and stale are 401; valid unknown request is dropped with 200; oversized is 413', opts, async t => {
  const app = await startApp(t, { env: ON });
  assert.equal((await post(app, body)).status, 401);
  assert.equal((await post(app, body, signNotice(body, 'wrong-secret-0123456789abcd'))).status, 401);
  assert.equal((await post(app, body, signNotice(body, SECRET, Date.now() - 3_600_000))).status, 401);
  const ok = await post(app, body, signNotice(body, SECRET));
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { result: 'unknown' });
  assert.equal((await post(app, 'x'.repeat(5000), signNotice('x', SECRET))).status, 413);
});
