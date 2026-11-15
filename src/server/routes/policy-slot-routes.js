// Paid policy slots (migration 067). Off unless PAYMENTS_ENABLED is exactly "true" (status still answers, with enabled false).
//   GET  /api/v1/households/{id}/policy-slots          -> 200 { enabled, used, allowed, canAdd, pricePaise, currency }
//   POST /api/v1/households/{id}/policy-slots/orders   -> 201 { orderId, amountPaise, currency, keyId }   (409 POLICY_SLOT_AVAILABLE)
//   POST /api/v1/households/{id}/policy-slots/verify   { orderId, paymentId, signature } -> 200 { paid: true, ...status }
// Ownership through the household (write for orders and verify). The key secret never leaves the server; keyId is the public key id.
const STATUS = /^\/api\/v1\/households\/([^/]+)\/policy-slots$/;
const ORDERS = /^\/api\/v1\/households\/([^/]+)\/policy-slots\/orders$/;
const VERIFY = /^\/api\/v1\/households\/([^/]+)\/policy-slots\/verify$/;

/** Resolves a response, or null when the path is not this route. */
export async function handlePolicySlotRoute({ req, url, principal, services, readBody }) {
  let match;
  if (req.method === 'GET' && (match = STATUS.exec(url.pathname))) {
    return { status: 200, body: await services.policySlots.status({ principal, householdId: match[1] }) };
  }
  if (req.method === 'POST' && (match = ORDERS.exec(url.pathname))) {
    return { status: 201, body: await services.policySlots.createOrder({ principal, householdId: match[1] }) };
  }
  if (req.method === 'POST' && (match = VERIFY.exec(url.pathname))) {
    const body = await readBody(req);
    return { status: 200, body: await services.policySlots.verify({ principal, householdId: match[1], orderId: body?.orderId, paymentId: body?.paymentId, signature: body?.signature }) };
  }
  return null;
}
