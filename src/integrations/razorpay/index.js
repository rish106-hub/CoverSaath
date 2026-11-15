import { createHmac, timingSafeEqual } from 'node:crypto';

// Razorpay Standard Checkout (docs: razorpay.com/docs/payments/payment-gateway/web-integration/standard/integration-steps/, and the
// official razorpay-node SDK: orders.create, validatePaymentVerification). Two server-side operations only:
//   createOrder  POST https://api.razorpay.com/v1/orders with HTTP Basic auth (key id : key secret), body { amount, currency, receipt }.
//   verifySignature  HMAC-SHA256 of "<order_id>|<payment_id>" under the key secret, hex, compared in constant time.
// Fails closed: without RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET it is not configured and createOrder throws. The secret never leaves the
// server and is never logged; only the key id is returned to a client (Checkout needs it). Timeout 10 s, no retry: a retried order POST
// could create a second order, and an unpaid order costs nothing, so the caller simply asks again.
const API = 'https://api.razorpay.com/v1/orders';
const TIMEOUT_MS = 10_000;
const ID = /^[A-Za-z0-9_]{1,100}$/;
const coded = (code, message, statusCode) => Object.assign(new Error(message), { code, statusCode });

export function readRazorpayConfig(env = process.env) {
  const keyId = String(env.RAZORPAY_KEY_ID ?? '').trim();
  const keySecret = String(env.RAZORPAY_KEY_SECRET ?? '').trim();
  return keyId && keySecret ? Object.freeze({ keyId, keySecret }) : null;
}

export function createRazorpayClient({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const config = readRazorpayConfig(env);
  return Object.freeze({
    configured: config !== null,
    keyId: config?.keyId ?? null,
    async createOrder({ amountPaise, receipt }) {
      if (!config) throw coded('PAYMENTS_NOT_CONFIGURED', 'Payments are not configured.', 503);
      if (!Number.isInteger(amountPaise) || amountPaise < 100) throw coded('PAYMENT_AMOUNT_INVALID', 'The amount must be at least 100 paise.', 400);
      let res;
      try {
        res = await fetchImpl(API, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${config.keyId}:${config.keySecret}`).toString('base64')}` },
          body: JSON.stringify({ amount: amountPaise, currency: 'INR', receipt: String(receipt).slice(0, 40) }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch {
        throw coded('PAYMENT_PROVIDER_UNAVAILABLE', 'The payment service did not answer. Try again.', 502);
      }
      if (res.status === 401) throw coded('PAYMENT_PROVIDER_AUTH', 'The payment service refused our credentials.', 502);
      if (!res.ok) throw coded('PAYMENT_PROVIDER_ERROR', 'The payment service could not create the order.', 502);
      const body = await res.json().catch(() => null);
      if (!body || !ID.test(String(body.id ?? '')) || body.amount !== amountPaise || body.currency !== 'INR') {
        throw coded('PAYMENT_PROVIDER_ERROR', 'The payment service answered in an unexpected shape.', 502);
      }
      return { orderId: body.id, amountPaise: body.amount, currency: body.currency };
    },
    verifySignature({ orderId, paymentId, signature }) {
      if (!config) throw coded('PAYMENTS_NOT_CONFIGURED', 'Payments are not configured.', 503);
      if (![orderId, paymentId].every(v => typeof v === 'string' && ID.test(v)) || typeof signature !== 'string' || !/^[0-9a-f]{64}$/.test(signature)) return false;
      const expected = createHmac('sha256', config.keySecret).update(`${orderId}|${paymentId}`).digest();
      return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
    },
  });
}
