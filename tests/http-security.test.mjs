import test from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from '../src/shared/http/index.js';

test('rate limiter isolates clients and resets after its bounded window', () => {
  let now = 1_000;
  const limiter = createRateLimiter({ limit: 2, windowMs: 1_000, clock: () => now });
  assert.equal(limiter.check('client-a').remaining, 1);
  assert.equal(limiter.check('client-a').remaining, 0);
  assert.throws(() => limiter.check('client-a'), /rate limit exceeded/i);
  assert.equal(limiter.check('client-b').remaining, 1);
  now = 2_001;
  assert.equal(limiter.check('client-a').remaining, 1);
});

test('rate limiter rejects unsafe configuration', () => {
  assert.throws(() => createRateLimiter({ limit: 0 }), /Rate limit/);
  assert.throws(() => createRateLimiter({ windowMs: 10 }), /window/);
});

test('public hosts are an exact opt-in and the local guard still applies', async () => {
  const { assertLocalRequest, clientRateKey } = await import('../src/shared/http/index.js');
  const request = (host, extra = {}) => ({ socket: { localPort: 8080, remoteAddress: '172.16.0.1' }, headers: { host, ...extra } });
  assert.throws(() => assertLocalRequest(request('knowvia-api.fly.dev')), /Local access only/);
  assert.doesNotThrow(() => assertLocalRequest(request('knowvia-api.fly.dev'), { publicHosts: ['knowvia-api.fly.dev'] }));
  assert.throws(() => assertLocalRequest(request('evil.example'), { publicHosts: ['knowvia-api.fly.dev'] }), /Local access only/);
  assert.throws(() => assertLocalRequest(request('knowvia-api.fly.dev', { 'sec-fetch-site': 'cross-site' }), { publicHosts: ['knowvia-api.fly.dev'] }), /Cross-site/);
  assert.throws(() => assertLocalRequest(request('knowvia-api.fly.dev', { origin: 'https://evil.example' }), { publicHosts: ['knowvia-api.fly.dev'] }), /Origin/);

  const keyed = headers => ({ socket: { remoteAddress: '172.16.0.1' }, headers });
  assert.equal(clientRateKey(keyed({ 'fly-client-ip': '203.0.113.9' })), '172.16.0.1', 'ignored unless trusted');
  assert.equal(clientRateKey(keyed({ 'fly-client-ip': '203.0.113.9' }), { trustFlyClientIp: true }), '203.0.113.9');
  assert.equal(clientRateKey(keyed({ 'fly-client-ip': 'not-an-ip' }), { trustFlyClientIp: true }), '172.16.0.1');
  assert.equal(clientRateKey(keyed({}), { trustFlyClientIp: true }), '172.16.0.1');
});
