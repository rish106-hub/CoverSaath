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
