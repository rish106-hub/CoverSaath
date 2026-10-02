import { readBody } from '../http/request.js';

// Policy breakdown endpoints. Authentication happens in the v1 handler; every method here enforces
// household scope server-side through the policy service.

const UPLOAD_BODY_LIMIT_BYTES = 22 * 1024 * 1024; // 15 MB file as base64 plus JSON envelope

function idempotencyKey(req) {
  const key = req.headers['idempotency-key'];
  if (typeof key !== 'string' || key.length < 8 || key.length > 200) {
    throw Object.assign(new Error('A stable Idempotency-Key header between 8 and 200 characters is required.'), { code: 'IDEMPOTENCY_KEY_REQUIRED', statusCode: 400 });
  }
  return key;
}

const ok = (body, status = 200) => ({ status, body });

const ROUTES = [
  ['POST', /^\/api\/v1\/households\/([^/]+)\/documents$/, async ({ req, policy, principal, match }) =>
    ok(await policy.uploadDocument(principal, match[1], await readBody(req, { limitBytes: UPLOAD_BODY_LIMIT_BYTES })), 201)],
  ['GET', /^\/api\/v1\/households\/([^/]+)\/documents$/, ({ policy, principal, match }) =>
    ok({ documents: policy.listDocuments(principal, match[1]) })],
  ['POST', /^\/api\/v1\/households\/([^/]+)\/members$/, async ({ req, policy, principal, match }) =>
    ok(policy.addMember(principal, match[1], await readBody(req)), 201)],
  ['PATCH', /^\/api\/v1\/households\/([^/]+)\/city$/, async ({ req, policy, principal, match }) =>
    ok(policy.setHouseholdCity(principal, match[1], await readBody(req, { limitBytes: 4_096 })))],
  ['POST', /^\/api\/v1\/households\/([^/]+)\/policy-records$/, async ({ req, policy, principal, match }) => {
    const result = policy.createPolicyRecord(principal, match[1], await readBody(req), idempotencyKey(req));
    return ok({ record: result.record, job: result.job, dispatchStatus: result.created ? 'started' : 'idempotent_existing_job' }, result.created ? 202 : 200);
  }],
  ['GET', /^\/api\/v1\/households\/([^/]+)\/policy-records$/, ({ policy, principal, match }) =>
    ok({ records: policy.listRecords(principal, match[1]) })],
  ['GET', /^\/api\/v1\/policy-records\/([^/]+)$/, ({ policy, principal, match }) =>
    ok(policy.getRecord(principal, match[1]))],
  ['GET', /^\/api\/v1\/policy-records\/([^/]+)\/sections$/, ({ policy, principal, match }) =>
    ok(policy.getSections(principal, match[1]))],
  ['GET', /^\/api\/v1\/policy-records\/([^/]+)\/sections\/(\d{1,2})$/, ({ policy, principal, match }) =>
    ok(policy.getSections(principal, match[1], { sectionNumber: Number(match[2]) }))],
  ['POST', /^\/api\/v1\/policy-records\/([^/]+)\/parameters\/([a-z0-9_]{3,64})\/review$/, async ({ req, policy, principal, match }) =>
    ok({ parameter: policy.reviewParameter(principal, match[1], match[2], await readBody(req)) })],
  ['POST', /^\/api\/v1\/policy-records\/([^/]+)\/readiness$/, ({ policy, principal, match }) =>
    ok(policy.checkReadiness(principal, match[1]))],
  ['GET', /^\/api\/v1\/policy-records\/([^/]+)\/emergency-card$/, ({ policy, principal, match }) =>
    ok(policy.emergencyCard(principal, match[1]))],
  ['POST', /^\/api\/v1\/policy-records\/([^/]+)\/procedure-checks$/, async ({ req, policy, principal, match }) =>
    ok(policy.procedureCheck(principal, match[1], await readBody(req, { limitBytes: 32_768 })))],
  ['GET', /^\/api\/v1\/policy-records\/([^/]+)\/policy-status$/, ({ policy, principal, match }) =>
    ok(policy.policyStatus(principal, match[1]))],
  ['POST', /^\/api\/v1\/policy-records\/([^/]+)\/estimates$/, async ({ req, policy, principal, match }) =>
    ok(policy.estimate(principal, match[1], await readBody(req, { limitBytes: 32_768 })))],
  ['GET', /^\/api\/v1\/breakdown-jobs\/([^/]+)$/, ({ policy, principal, match }) =>
    ok(policy.getJob(principal, match[1]))],
  ['POST', /^\/api\/v1\/breakdown-jobs\/([^/]+)\/resume$/, ({ policy, principal, match }) =>
    ok(policy.resumeJob(principal, match[1]), 202)],
];

/** Returns a response or null when the path is not a policy route. Throws service errors to the caller. */
export async function handlePolicyRoute({ req, url, policy, principal }) {
  for (const [method, pattern, handler] of ROUTES) {
    const match = url.pathname.match(pattern);
    if (!match) continue;
    if (req.method !== method) continue;
    if (!policy) throw Object.assign(new Error('Policy breakdown is not configured on this server.'), { code: 'POLICY_BREAKDOWN_UNAVAILABLE', statusCode: 503 });
    return handler({ req, url, policy, principal, match });
  }
  return null;
}

export const POLICY_ROUTE_COUNT = ROUTES.length;
