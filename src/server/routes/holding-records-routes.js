import { readBody } from '../http/request.js';

// Member declarations and premium payments and dues (migrations 051-052, ADR 0032). Off unless HOLDINGS_ENABLED is exactly "true"
// (503 HOLDINGS_DISABLED). Ownership is checked inside the repositories: a foreign household, holding, member or row is the same
// 404 as a missing one. Bodies are allow-listed here (an unknown key is a 400), then validated again by the repository. Sealed values
// (declaration label, amount, agent name and code) are opened only for the acting adult of the owning household and are never logged
// or audited. The write consent grant (purpose profile_intake, the acting adult's own) is resolved server side; a body may name one.
// The grant, notice and wording are FOR LEGAL REVIEW.
//
//   GET    /api/v1/households/{id}/declarations[?memberId=]       { declarations: [...], truncated }
//   POST   /api/v1/households/{id}/declarations                   201 declaration
//   PUT    /api/v1/households/{id}/declarations/{did}             200 declaration (label, declaredOn, declaredToInsurer; ifMatch = revision)
//   DELETE /api/v1/households/{id}/declarations/{did}             200 { deleted: true }
//   GET    /api/v1/households/{id}/premiums[?holdingId=]          { premiums: [...] }
//   POST   /api/v1/households/{id}/premiums                       201 premium payment
//   DELETE /api/v1/households/{id}/premiums/{pid}                 200 { deleted: true }
//   GET    /api/v1/households/{id}/premium-dues[?holdingId=&state=]   { dues: [...] }
//   POST   /api/v1/households/{id}/premium-dues                   201 due (one per holding and day; a repeat returns the existing one)
//   POST   /api/v1/households/{id}/premium-dues/{did}/pay         200 due; body { paymentId }

const ROUTE = /^\/api\/v1\/households\/([^/]+)\/(declarations|premiums|premium-dues)(?:\/([^/]+)(\/pay)?)?$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const bad = message => Object.assign(new Error(message), { code: 'INVALID_REQUEST', statusCode: 400 });
const notFound = (code, message) => Object.assign(new Error(message), { code, statusCode: 404 });

const DECLARATION_KEYS = ['memberId', 'kind', 'label', 'declaredOn', 'declaredToInsurer', 'holdingId', 'consentGrantId'];
const DECLARATION_UPDATE_KEYS = ['label', 'declaredOn', 'declaredToInsurer', 'ifMatch'];
const PREMIUM_KEYS = ['holdingId', 'amountPaise', 'paidOn', 'channel', 'paidVia', 'payerMemberId', 'agentName', 'agentCode', 'receiptDocumentId', 'consentGrantId'];
const DUE_KEYS = ['holdingId', 'dueOn', 'amountPaise', 'consentGrantId'];

function object(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('The body must be a JSON object.');
  for (const key of Object.keys(body)) if (!allowed.includes(key)) throw bad(`${key} is not allowed.`);
  return body;
}

// Optional identifier: absent or null is null; anything else must look like an id.
function optionalId(value, name) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !ID.test(value)) throw bad(`${name} is invalid.`);
  return value;
}
const requiredId = (value, name) => optionalId(value, name) ?? (() => { throw bad(`${name} is required.`); })();

// The acting adult's current profile_intake grant in this household (newest first), or the one the body names. Null when none:
// the repository then answers CONSENT_REQUIRED (403).
async function writeGrant({ services, householdId, principal, named }) {
  if (named !== undefined && named !== null) return requiredId(named, 'consentGrantId');
  await services.households.requireAccess(householdId, principal.adultId, { write: false });
  const { consents } = await services.consents.listForSubject({ householdId, subjectAdultId: principal.adultId, limit: 50 });
  return consents.find(grant => grant.purpose === 'profile_intake' && grant.status === 'active')?.id ?? null;
}

const declarationBody = body => ({
  label: body.label, declaredOn: body.declaredOn ?? null, declaredToInsurer: body.declaredToInsurer ?? null,
});

/** Resolves a response, or null when the path is not one of these routes. Errors propagate to the caller's error mapper. */
export async function handleHoldingRecordsRoute({ req, url, principal, services }) {
  const match = ROUTE.exec(url.pathname);
  if (!match) return null;
  const [, householdId, resource, rowId, pay] = match;
  const method = req.method;
  const adultId = principal.adultId;
  const query = url.searchParams;
  const allowed = {
    declarations: rowId ? !pay && (method === 'PUT' || method === 'DELETE') : method === 'GET' || method === 'POST',
    premiums: rowId ? !pay && method === 'DELETE' : method === 'GET' || method === 'POST',
    'premium-dues': rowId ? pay === '/pay' && method === 'POST' : method === 'GET' || method === 'POST',
  }[resource];
  if (!allowed) return null;
  if (!services.holdingsEnabled()) throw Object.assign(new Error('Holdings are disabled.'), { code: 'HOLDINGS_DISABLED', statusCode: 503 });
  if (rowId && !ID.test(rowId)) throw notFound(resource === 'declarations' ? 'DECLARATION_NOT_FOUND' : 'PREMIUM_NOT_FOUND', 'Not found.');

  if (resource === 'declarations') {
    const repo = services.declarations;
    if (method === 'GET') return { status: 200, body: await repo.list({ householdId, adultId, memberId: optionalId(query.get('memberId'), 'memberId') }) };
    if (method === 'DELETE') { await repo.delete({ householdId, adultId, declarationId: rowId }); return { status: 200, body: { deleted: true } }; }
    if (method === 'PUT') {
      const body = object(await readBody(req), DECLARATION_UPDATE_KEYS);
      if (body.ifMatch !== undefined && !Number.isInteger(body.ifMatch)) throw bad('ifMatch is invalid.');
      return { status: 200, body: await repo.update({ householdId, adultId, declarationId: rowId, ...declarationBody(body), ifMatch: body.ifMatch ?? null }) };
    }
    const body = object(await readBody(req), DECLARATION_KEYS);
    const consentGrantId = await writeGrant({ services, householdId, principal, named: body.consentGrantId });
    return {
      status: 201,
      body: await repo.create({ householdId, adultId, memberId: requiredId(body.memberId, 'memberId'), kind: body.kind, ...declarationBody(body), holdingId: optionalId(body.holdingId, 'holdingId'), consentGrantId }),
    };
  }

  if (resource === 'premiums') {
    const repo = services.premiums;
    if (method === 'GET') return { status: 200, body: { premiums: await repo.listPayments({ householdId, adultId, holdingId: optionalId(query.get('holdingId'), 'holdingId') }) } };
    if (method === 'DELETE') { await repo.deletePayment({ householdId, adultId, paymentId: rowId }); return { status: 200, body: { deleted: true } }; }
    const body = object(await readBody(req), PREMIUM_KEYS);
    const consentGrantId = await writeGrant({ services, householdId, principal, named: body.consentGrantId });
    return {
      status: 201,
      body: await repo.recordPayment({
        householdId, adultId, holdingId: requiredId(body.holdingId, 'holdingId'), amountPaise: body.amountPaise, paidOn: body.paidOn,
        channel: body.channel ?? 'unknown', paidVia: body.paidVia ?? 'self', payerMemberId: optionalId(body.payerMemberId, 'payerMemberId'),
        agentName: body.agentName ?? null, agentCode: body.agentCode ?? null, receiptDocumentId: optionalId(body.receiptDocumentId, 'receiptDocumentId'), consentGrantId,
      }),
    };
  }

  const repo = services.premiums;
  if (method === 'GET') {
    return { status: 200, body: { dues: await repo.listDues({ householdId, adultId, holdingId: optionalId(query.get('holdingId'), 'holdingId'), state: query.get('state') }) } };
  }
  if (pay) {
    const body = object(await readBody(req), ['paymentId']);
    return { status: 200, body: await repo.markDuePaid({ householdId, adultId, dueId: rowId, paymentId: requiredId(body.paymentId, 'paymentId') }) };
  }
  const body = object(await readBody(req), DUE_KEYS);
  const consentGrantId = await writeGrant({ services, householdId, principal, named: body.consentGrantId });
  return { status: 201, body: await repo.addDue({ householdId, adultId, holdingId: requiredId(body.holdingId, 'holdingId'), dueOn: body.dueOn, amountPaise: body.amountPaise, consentGrantId }) };
}
