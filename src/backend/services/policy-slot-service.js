import { createRazorpayClient } from '../../integrations/index.js';

// Paid policy slots (owner decision 2026-11-15). Off unless PAYMENTS_ENABLED is exactly "true": then no gate and the routes answer 503.
// Deterministic rule: a household may hold 1 + (paid slots) active policy schedules. Adding one more needs a Razorpay payment of
// POLICY_SLOT_PRICE_PAISE (default 19900 = Rs 199). A slot is paid only after verifySignature passes on the server; the client's word never
// counts. Money is decided here, never by a model.
const FREE_SLOTS = 1;
const coded = (code, message, statusCode) => Object.assign(new Error(message), { code, statusCode });

export function paymentsEnabled(env = process.env) {
  return env.PAYMENTS_ENABLED === 'true';
}

export function createPolicySlotService({ repository, access, env = process.env, client = null }) {
  if (!repository || !access) throw new TypeError('createPolicySlotService needs repository and access.');
  let built = client;
  const razorpay = () => { built ??= createRazorpayClient({ env }); return built; };
  const price = () => {
    const n = Number(env.POLICY_SLOT_PRICE_PAISE ?? 19900);
    return Number.isInteger(n) && n >= 100 ? n : 19900;
  };
  const requireEnabled = () => { if (!paymentsEnabled(env)) throw coded('PAYMENTS_DISABLED', 'Payments are not available.', 503); };
  const summary = async householdId => {
    const { paid, used } = await repository.counts(householdId);
    const allowed = FREE_SLOTS + paid;
    return { enabled: paymentsEnabled(env), used, allowed, canAdd: used < allowed, pricePaise: price(), currency: 'INR' };
  };

  return Object.freeze({
    enabled: () => paymentsEnabled(env),

    async status({ principal, householdId }) {
      await access.requireHousehold(principal, householdId);
      return summary(householdId);
    },

    async createOrder({ principal, householdId }) {
      requireEnabled();
      await access.requireHousehold(principal, householdId, { write: true });
      const now = await summary(householdId);
      if (now.canAdd) throw coded('POLICY_SLOT_AVAILABLE', 'You can add a policy without paying.', 409);
      const order = await razorpay().createOrder({ amountPaise: price(), receipt: `slot-${Date.now()}` });
      await repository.createOrder({ householdId, adultId: principal.adultId, orderId: order.orderId, amountPaise: order.amountPaise, currency: order.currency });
      return { orderId: order.orderId, amountPaise: order.amountPaise, currency: order.currency, keyId: razorpay().keyId };
    },

    async verify({ principal, householdId, orderId, paymentId, signature }) {
      requireEnabled();
      await access.requireHousehold(principal, householdId, { write: true });
      if (![orderId, paymentId, signature].every(v => typeof v === 'string' && v.length > 0)) throw coded('PAYMENT_FIELDS_REQUIRED', 'Order, payment and signature are required.', 400);
      const order = await repository.findOrder(householdId, orderId);
      if (!order) throw coded('PAYMENT_ORDER_NOT_FOUND', 'That order was not found.', 404);
      if (order.status === 'paid') {
        if (order.paymentId !== paymentId) throw coded('PAYMENT_SIGNATURE_INVALID', 'The payment could not be verified.', 400);
        return { paid: true, ...(await summary(householdId)) };
      }
      if (!razorpay().verifySignature({ orderId, paymentId, signature })) throw coded('PAYMENT_SIGNATURE_INVALID', 'The payment could not be verified.', 400);
      await repository.markPaid({ id: order.id, paymentId });
      return { paid: true, ...(await summary(householdId)) };
    },

    /** Upload gate for a policy schedule. A repeat of a schedule already held is not a new policy. Throws 402 when no slot is free. */
    async assertCanAddSchedule({ householdId, contentSha256 }) {
      if (!paymentsEnabled(env)) return;
      if (contentSha256 && await repository.hasSchedule(householdId, contentSha256)) return;
      const now = await summary(householdId);
      if (!now.canAdd) throw Object.assign(coded('PAYMENT_REQUIRED', 'Adding another policy needs a payment.', 402), { pricePaise: now.pricePaise });
    },
  });
}
