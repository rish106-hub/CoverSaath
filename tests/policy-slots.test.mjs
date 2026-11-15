import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createRazorpayClient } from '../src/integrations/index.js';
import { createPolicySlotService } from '../src/backend/services/policy-slot-service.js';

// Synthetic test credentials only: never a real key.
const env = { PAYMENTS_ENABLED: 'true', RAZORPAY_KEY_ID: 'rzp_test_synthetic', RAZORPAY_KEY_SECRET: 'synthetic-secret-for-tests' };
const sign = (orderId, paymentId, secret = env.RAZORPAY_KEY_SECRET) => createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
const principal = { adultId: 'a1' };
const access = { requireHousehold: async () => undefined };

function memoryRepo({ used = 0, paid = 0 } = {}) {
  const rows = new Map();
  const state = { used, paid, schedules: new Set() };
  return {
    state,
    counts: async () => ({ used: state.used, paid: state.paid }),
    hasSchedule: async (_h, sha) => state.schedules.has(sha),
    createOrder: async ({ orderId, amountPaise }) => { rows.set(orderId, { id: `row-${orderId}`, status: 'created', paymentId: null, amountPaise }); },
    findOrder: async (_h, orderId) => rows.get(orderId) ?? null,
    markPaid: async ({ id, paymentId }) => {
      for (const row of rows.values()) if (row.id === id && row.status === 'created') { row.status = 'paid'; row.paymentId = paymentId; state.paid++; return true; }
      return false;
    },
  };
}

test('razorpay: order POST uses basic auth and the paise amount; never sends the secret in the body', async () => {
  const calls = [];
  const client = createRazorpayClient({ env, fetchImpl: async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ id: 'order_ABC123', amount: 19900, currency: 'INR' }), { status: 200 }); } });
  const order = await client.createOrder({ amountPaise: 19900, receipt: 'slot-1' });
  assert.deepEqual(order, { orderId: 'order_ABC123', amountPaise: 19900, currency: 'INR' });
  assert.equal(calls[0].url, 'https://api.razorpay.com/v1/orders');
  assert.equal(calls[0].init.headers.authorization, `Basic ${Buffer.from('rzp_test_synthetic:synthetic-secret-for-tests').toString('base64')}`);
  assert.deepEqual(JSON.parse(calls[0].init.body), { amount: 19900, currency: 'INR', receipt: 'slot-1' });
  await assert.rejects(client.createOrder({ amountPaise: 99, receipt: 'x' }), { code: 'PAYMENT_AMOUNT_INVALID' });
});

test('razorpay: a refused key and a provider error are coded, not thrown raw', async () => {
  const at = status => createRazorpayClient({ env, fetchImpl: async () => new Response('{}', { status }) });
  await assert.rejects(at(401).createOrder({ amountPaise: 19900, receipt: 'r' }), { code: 'PAYMENT_PROVIDER_AUTH' });
  await assert.rejects(at(500).createOrder({ amountPaise: 19900, receipt: 'r' }), { code: 'PAYMENT_PROVIDER_ERROR' });
  await assert.rejects(createRazorpayClient({ env: {} }).createOrder({ amountPaise: 19900, receipt: 'r' }), { code: 'PAYMENTS_NOT_CONFIGURED' });
});

test('razorpay: signature is HMAC-SHA256 of order|payment; a wrong or malformed one fails', () => {
  const client = createRazorpayClient({ env });
  assert.equal(client.verifySignature({ orderId: 'order_A', paymentId: 'pay_B', signature: sign('order_A', 'pay_B') }), true);
  assert.equal(client.verifySignature({ orderId: 'order_A', paymentId: 'pay_C', signature: sign('order_A', 'pay_B') }), false);
  assert.equal(client.verifySignature({ orderId: 'order_A', paymentId: 'pay_B', signature: sign('order_A', 'pay_B', 'other') }), false);
  assert.equal(client.verifySignature({ orderId: 'order_A', paymentId: 'pay_B', signature: 'not-hex' }), false);
});

test('slots: first policy is free; a second needs a verified payment; a repeat of a held schedule is not a new policy', async () => {
  const repo = memoryRepo();
  const razorpay = createRazorpayClient({ env, fetchImpl: async () => new Response(JSON.stringify({ id: 'order_X1', amount: 19900, currency: 'INR' }), { status: 200 }) });
  const slots = createPolicySlotService({ repository: repo, access, env, client: razorpay });
  await slots.assertCanAddSchedule({ householdId: 'h1', contentSha256: 'a'.repeat(64) });
  await assert.rejects(slots.createOrder({ principal, householdId: 'h1' }), { code: 'POLICY_SLOT_AVAILABLE', statusCode: 409 });
  repo.state.used = 1; repo.state.schedules.add('a'.repeat(64));
  await slots.assertCanAddSchedule({ householdId: 'h1', contentSha256: 'a'.repeat(64) });
  await assert.rejects(slots.assertCanAddSchedule({ householdId: 'h1', contentSha256: 'b'.repeat(64) }), { code: 'PAYMENT_REQUIRED', statusCode: 402 });

  const order = await slots.createOrder({ principal, householdId: 'h1' });
  assert.deepEqual(order, { orderId: 'order_X1', amountPaise: 19900, currency: 'INR', keyId: 'rzp_test_synthetic' });
  await assert.rejects(slots.verify({ principal, householdId: 'h1', orderId: 'order_X1', paymentId: 'pay_1', signature: sign('order_X1', 'pay_2') }), { code: 'PAYMENT_SIGNATURE_INVALID', statusCode: 400 });
  await assert.rejects(slots.verify({ principal, householdId: 'h1', orderId: 'order_X1', paymentId: '', signature: 'x' }), { code: 'PAYMENT_FIELDS_REQUIRED' });
  await assert.rejects(slots.verify({ principal, householdId: 'h1', orderId: 'order_NOPE', paymentId: 'pay_1', signature: sign('order_NOPE', 'pay_1') }), { code: 'PAYMENT_ORDER_NOT_FOUND' });
  const ok = await slots.verify({ principal, householdId: 'h1', orderId: 'order_X1', paymentId: 'pay_1', signature: sign('order_X1', 'pay_1') });
  assert.equal(ok.paid, true);
  assert.equal(ok.allowed, 2);
  await slots.assertCanAddSchedule({ householdId: 'h1', contentSha256: 'b'.repeat(64) });
  // A replay of the same verified payment is accepted once more and does not add a slot.
  assert.equal((await slots.verify({ principal, householdId: 'h1', orderId: 'order_X1', paymentId: 'pay_1', signature: sign('order_X1', 'pay_1') })).allowed, 2);
});

test('slots: off unless PAYMENTS_ENABLED is exactly true (no gate, order routes 503)', async () => {
  const slots = createPolicySlotService({ repository: memoryRepo({ used: 5 }), access, env: { ...env, PAYMENTS_ENABLED: 'yes' } });
  await slots.assertCanAddSchedule({ householdId: 'h1', contentSha256: 'c'.repeat(64) });
  await assert.rejects(slots.createOrder({ principal, householdId: 'h1' }), { code: 'PAYMENTS_DISABLED', statusCode: 503 });
});
