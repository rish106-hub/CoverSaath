import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { freshDatabase, postgresTestOptions } from './support/pg.mjs';
import { createApiServer } from '../src/server/server.js';
import { createBackendServices } from '../src/backend/services/index.js';
import { ProviderUnavailableError } from '../src/integrations/index.js';
import {
  createLogger, describeError, initSentry, isSensitiveKey, sanitizedError, scrubSentryEvent, scrubText, scrubValue,
} from '../src/shared/logging/index.js';

// M1 leak test: synthetic identifiers pushed through every log path (request, error, audit, provider, Sentry) must never be
// printed. All values below are fabricated (the card number is a public test number).
const PAN = 'ABCDE1234F';
const AADHAAR_SPACED = '2345 6789 0123';
const AADHAAR = '234567890123';
const PHONE = '9876543210';
const PHONE_INTL = '+91 98765 43210';
const EMAIL = 'asha.synthetic@example.test';
const CARD = '4111111111111111';
const BODY_MARKER = 'synthetic-body-marker-zq';
const IDENTIFIERS = [PAN, AADHAAR_SPACED, AADHAAR, PHONE, PHONE_INTL, EMAIL, CARD, 'synthetic.asha', '98765 43210'];
const bootstrapToken = 'coversaath-test-bootstrap-token-m1log';

const everything = `${PAN} ${AADHAAR_SPACED} ${AADHAAR} ${PHONE} ${PHONE_INTL} ${EMAIL} ${CARD}`;

function sink() {
  const chunks = [];
  return { write: chunk => { chunks.push(String(chunk)); }, text: () => chunks.join(''), lines: () => chunks.join('').split('\n').filter(Boolean).map(line => JSON.parse(line)) };
}

function assertClean(text, label) {
  for (const value of [...IDENTIFIERS, BODY_MARKER]) assert.ok(!text.includes(value), `${label}: leaked ${JSON.stringify(value)} in ${text.slice(0, 400)}`);
  assert.ok(!/Bearer\s+\S{8,}/i.test(text), `${label}: leaked a bearer credential`);
}

test('scrubText removes PAN, Aadhaar, phone, card, e-mail and credentials, and leaves ordinary text', () => {
  const scrubbed = scrubText(`x ${everything} Bearer abcdefgh12345678 eyJabcdef.eyJabcdef.sig end`);
  assertClean(scrubbed, 'scrubText');
  assert.ok(!scrubbed.includes('abcdefgh12345678') && !scrubbed.includes('eyJabcdef'));
  assert.equal(scrubText('document_scan_exhausted after 3 attempts, port 8080, exit 1'), 'document_scan_exhausted after 3 attempts, port 8080, exit 1');
  assert.equal(scrubText(`pan-like ${PAN.toLowerCase()}`).includes(PAN.toLowerCase()), false);
});

test('sensitive keys lose their value whatever it holds; metrics keep theirs', () => {
  for (const key of ['email', 'contactPhone', 'authorization', 'Cookie', 'body', 'displayName', 'aadhaar_number', 'panNumber', 'prompt', 'ocrText', 'policyNumber', 'apiKey', 'idempotencyKey']) {
    assert.equal(isSensitiveKey(key), true, key);
  }
  for (const key of ['inputTokens', 'outputTokens', 'durationMs', 'status', 'route', 'requestId', 'errorCode', 'costMicroUsd', 'event']) {
    assert.equal(isSensitiveKey(key), false, key);
  }
  const scrubbed = scrubValue({ email: 'x', nested: { list: [{ secret: 1 }], note: everything }, inputTokens: 12, fn() {} });
  assert.equal(scrubbed.email, '[REDACTED]');
  assert.equal(scrubbed.nested.list[0].secret, '[REDACTED]');
  assert.equal(scrubbed.inputTokens, 12);
  assertClean(JSON.stringify(scrubbed), 'scrubValue');
});

test('every logger method strips identifiers from every argument, and lines stay valid JSON', () => {
  const out = sink();
  const logger = createLogger({ destination: out, level: 'trace' });
  const hostile = { requestId: everything, method: everything, route: `/${everything}`, status: everything, durationMs: everything, errorCode: everything };
  logger.request(hostile);
  logger.info(`event_${PAN}`, { note: everything, [EMAIL]: PAN, headers: { authorization: `Bearer ${CARD}abcdefgh` }, body: { phone: PHONE }, nested: { deep: { deeper: everything } } });
  logger.warn('plain_event', { detail: everything, list: [everything, { x: everything }] });
  logger.error('plain_event', { req: { body: BODY_MARKER, headers: { cookie: PAN } } });
  logger.debug('plain_event', { text: BODY_MARKER, prompt: everything });
  logger.audit({ action: everything, resourceType: everything, resourceId: everything, actorType: everything, householdId: everything, caseId: everything, actorId: EMAIL, payload: { pan: PAN } });
  logger.provider({ provider: everything, task: everything, outcome: everything, code: everything, latencyMs: 5, inputTokens: 1, outputTokens: 2, costMicroUsd: 3, prompt: PAN });
  const message = Object.assign(new Error(`failed for ${everything} ${BODY_MARKER}`), { code: 'SOME_CODE', detail: everything, query: `SELECT '${PAN}'`, parameters: [EMAIL], statusCode: 500 });
  logger.failure(message, { requestId: 'req_abc', status: 500 });
  logger.failure(Object.assign(new Error(everything), { code: everything, name: everything }), { requestId: everything, status: 422 });
  const text = out.text();
  assertClean(text, 'logger');
  assert.ok(out.lines().length >= 9);
  const failureLine = out.lines().find(line => line.event === 'request_failed' && line.errorCode === 'SOME_CODE');
  assert.ok(failureLine, 'the code of an error is kept for correlation');
  assert.ok(!('message' in failureLine) && !('detail' in failureLine));
});

test('LOG_LEVEL is validated and silent writes nothing', () => {
  assert.throws(() => createLogger({ env: { LOG_LEVEL: 'loud' }, destination: sink() }), /LOG_LEVEL/);
  const out = sink();
  createLogger({ env: { LOG_LEVEL: 'silent' }, destination: out }).error('x_event', { a: PAN });
  assert.equal(out.text(), '');
  const warnOnly = sink();
  const quiet = createLogger({ env: { LOG_LEVEL: 'warn' }, destination: warnOnly });
  quiet.info('hidden_event', {});
  quiet.warn('shown_event', {});
  assert.deepEqual(warnOnly.lines().map(line => line.event), ['shown_event']);
});

test('describeError and sanitizedError never carry the message, detail or cause', () => {
  const error = Object.assign(new Error(`boom ${everything}`), { code: '23505', detail: everything, cause: new Error(PAN) });
  assertClean(JSON.stringify(describeError(error, { frames: true })), 'describeError');
  const stand = sanitizedError(error);
  assertClean(`${stand.message} ${stand.name} ${stand.stack}`, 'sanitizedError');
  assert.equal(stand.message, 'UNEXPECTED_ERROR');
  assert.equal(sanitizedError(Object.assign(new Error(PAN), { code: 'DATABASE_UNAVAILABLE' })).message, 'DATABASE_UNAVAILABLE');
});

// ---- HTTP: request log and error log through the real server ------------------------------------------------

function failingServices(error) {
  // Only what the households route touches before it fails: a service that throws a hostile error.
  return { access: { requireBootstrap() { throw error; }, bootstrapConfigured: true } };
}

async function startFailing(t, error, extra = {}) {
  const out = sink();
  const reports = [];
  const server = createApiServer({
    database: {}, backendServices: failingServices(error), env: { KNOWVIA_BOOTSTRAP_TOKEN: bootstrapToken, RATE_LIMIT_BACKEND: 'memory' }, logger: createLogger({ destination: out }),
    errorReporter: { enabled: true, captureError: (reported, context) => reports.push({ reported, context }) }, ...extra,
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { out, reports, base: `http://127.0.0.1:${server.address().port}` };
}

const hostileRequest = base => fetch(`${base}/api/v1/households?phone=${PHONE}&email=${EMAIL}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CARD}abcdefgh`, Cookie: `sid=${PAN}`, 'User-Agent': `agent ${AADHAAR}`, 'X-Request-Id': `${PAN}-${AADHAAR}`, 'X-Forwarded-For': PHONE },
  body: JSON.stringify({ displayName: BODY_MARKER, owner: { contactEmail: EMAIL, contactPhone: PHONE, pan: PAN, aadhaar: AADHAAR_SPACED } }),
});

test('request and error logs for an unexpected 500 carry codes and a request id, never identifiers or bodies', async t => {
  const driverError = Object.assign(new Error(`duplicate key value (email)=(${EMAIL}) ${everything}`), {
    code: '23505', detail: `Key (pan)=(${PAN}) already exists.`, query: `INSERT ... '${PAN}'`, parameters: [EMAIL, PHONE], statusCode: 500,
  });
  const app = await startFailing(t, driverError);
  const response = await hostileRequest(app.base);
  assert.equal(response.status, 500);
  const requestId = response.headers.get('x-request-id');
  assert.match(requestId, /^req_[A-Za-z0-9_-]{16}$/, 'ids are generated, not echoed from X-Request-Id');
  const text = app.out.text();
  assertClean(text, 'request/error log');
  assertClean(await response.text(), 'client response');
  const lines = app.out.lines();
  const failure = lines.find(line => line.event === 'request_failed');
  const request = lines.find(line => line.event === 'http_request');
  assert.equal(failure.requestId, requestId);
  assert.equal(request.requestId, requestId);
  assert.equal(failure.errorCode, '23505');
  assert.equal(request.route, '/api/v1/households');
  assert.equal(request.status, 500);
  assert.equal(request.method, 'POST');
  assert.ok(Array.isArray(failure.frames), 'unexpected failures keep top frames for debugging');
  assert.equal(app.reports.length, 1, 'a 5xx is reported');
  assert.equal(app.reports[0].context.requestId, requestId);
});

test('a provider error with a hostile message is logged by class and code only', async t => {
  const providerError = new ProviderUnavailableError(`Sarvam ${everything}`, 'PROVIDER_NOT_CONFIGURED', `provider is not configured for ${everything}.`);
  const app = await startFailing(t, providerError);
  const response = await hostileRequest(app.base);
  assert.equal(response.status, 503);
  assertClean(app.out.text(), 'provider error log');
  const failure = app.out.lines().find(line => line.event === 'request_failed');
  assert.equal(failure.errorType, 'ProviderUnavailableError');
  assert.equal(failure.errorCode, 'PROVIDER_NOT_CONFIGURED');
});

test('guard failures (host, rate limit) and unknown routes log without the URL or headers', async t => {
  const out = sink();
  const server = createApiServer({ database: {}, backendServices: failingServices(new Error('x')), env: { KNOWVIA_BOOTSTRAP_TOKEN: bootstrapToken, RATE_LIMIT_BACKEND: 'memory', RATE_LIMIT_PER_MINUTE: '3' }, logger: createLogger({ destination: out }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (let index = 0; index < 5; index += 1) await fetch(`${base}/${PAN}/${AADHAAR}?email=${EMAIL}`, { headers: { Cookie: `a=${PAN}`, Authorization: `Bearer ${CARD}abcdefgh` } });
  await fetch(`${base}/api/v1/health`, { headers: { Origin: `https://${PAN}.example.test` } });
  assertClean(out.text(), 'guard log');
  const requests = out.lines().filter(line => line.event === 'http_request');
  assert.equal(requests.length, 6);
  assert.ok(requests.every(line => line.route === '/other' || line.route.startsWith('/api/v1')));
});

test('the default logger is silent: embedding the server writes nothing', async t => {
  const original = process.stdout.write;
  let wrote = '';
  process.stdout.write = (chunk, ...rest) => { wrote += String(chunk); return original.call(process.stdout, chunk, ...rest); };
  try {
    const server = createApiServer({ database: {}, backendServices: failingServices(new Error('x')), env: { KNOWVIA_BOOTSTRAP_TOKEN: bootstrapToken, RATE_LIMIT_BACKEND: 'memory' } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    await fetch(`http://127.0.0.1:${server.address().port}/api/v1/health`);
    await new Promise(resolve => server.close(resolve));
  } finally { process.stdout.write = original; }
  assert.ok(!wrote.includes('http_request'));
});

// ---- Audit through the real services and database ---------------------------------------------------------------

test('audit log lines name the action and record only; payload and actor id never appear', postgresTestOptions(), async t => {
  const { db } = await freshDatabase(t);
  const out = sink();
  const logger = createLogger({ destination: out });
  const services = createBackendServices(db, { onAudit: entry => logger.audit(entry) });
  await services.audit.append({
    action: 'CONSENT_GRANTED', resourceType: 'consent', resourceId: 'consent-1', actorType: 'adult_user', actorId: EMAIL,
    payload: { pan: PAN, phone: PHONE, text: BODY_MARKER },
  });
  await services.audit.append({ action: everything, resourceType: 'record', resourceId: everything, actorType: 'system', actorId: PHONE, payload: { aadhaar: AADHAAR } });
  assertClean(out.text(), 'audit log');
  const lines = out.lines().filter(line => line.event === 'audit_event');
  assert.equal(lines.length, 2);
  assert.equal(lines[0].action, 'CONSENT_GRANTED');
  assert.equal(lines[0].resourceId, 'consent-1');
  assert.ok(!('actorId' in lines[0]) && !('payload' in lines[0]));
  // A throwing hook does not fail the audit write.
  const hooked = createBackendServices(db, { onAudit() { throw new Error(PAN); } });
  assert.ok((await hooked.audit.append({ action: 'X_EVENT', resourceType: 'r', resourceId: 'r-1' })).id);
});

test('a full household sign-up through the server logs requests and audits without identifiers', postgresTestOptions(), async t => {
  const { db } = await freshDatabase(t);
  const out = sink();
  const server = createApiServer({ database: db, env: { KNOWVIA_BOOTSTRAP_TOKEN: bootstrapToken, DATA_ENCRYPTION_KEY_BASE64: randomBytes(32).toString('base64') }, logger: createLogger({ destination: out }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/households`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bootstrapToken}` },
    body: JSON.stringify({ displayName: 'Synthetic home', owner: { displayName: 'synthetic.asha', contactEmail: EMAIL, contactPhone: PHONE } }),
  });
  assert.equal(response.status, 201);
  const session = (await response.json()).session.token;
  await server.appEvents.flush();
  const text = out.text();
  assertClean(text, 'sign-up log');
  assert.ok(!text.includes(bootstrapToken) && !text.includes(session), 'tokens never appear');
  assert.ok(out.lines().some(line => line.event === 'http_request' && line.status === 201));
  assert.ok(out.lines().some(line => line.event === 'audit_event'), 'sign-up appends audit events and the log names them');
});

// ---- Sentry ---------------------------------------------------------------------------------------------------

const hostileEvent = () => ({
  event_id: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', timestamp: 1_800_000_000, platform: 'node', level: 'error', release: 'r1', environment: 'test',
  server_name: `host-${PAN}`, user: { email: EMAIL, ip_address: '203.0.113.9', username: PAN, id: AADHAAR },
  request: { method: 'post', url: `http://x/api?phone=${PHONE}`, query_string: `email=${EMAIL}`, cookies: { sid: PAN }, headers: { authorization: `Bearer ${CARD}abcdefgh`, cookie: PAN }, data: { pan: PAN, note: BODY_MARKER } },
  message: `failed ${everything}`,
  exception: { values: [{ type: `Error ${PAN}`, value: `bad ${everything} ${BODY_MARKER}`, mechanism: { type: 'generic', handled: false, data: { x: PAN } },
    stacktrace: { frames: [{ filename: `/Users/${PAN}/app/src/server/x.js`, function: `fn_${PHONE}`, lineno: 3, colno: 4, in_app: true, vars: { pan: PAN }, pre_context: [PAN], context_line: `const pan = '${PAN}'`, post_context: [EMAIL] }] } }] },
  breadcrumbs: [{ category: 'console', message: everything, data: { url: `http://x/?${EMAIL}` } }],
  extra: { body: BODY_MARKER, pan: PAN }, contexts: { custom: { pan: PAN }, trace: { trace_id: 'a'.repeat(32), span_id: 'b'.repeat(16) } },
  tags: { requestId: 'req_abc', pan: PAN, other: everything }, modules: { x: PAN }, transaction: `POST /${PAN}`, fingerprint: [PAN],
});

test('beforeSend rebuilds the event from an allowlist: no identifier, body, user, request data or breadcrumb survives', () => {
  const scrubbed = scrubSentryEvent(hostileEvent());
  assertClean(JSON.stringify(scrubbed), 'beforeSend');
  assert.equal(scrubbed.event_id, 'a1b2c3d4e5f60718293a4b5c6d7e8f90', 'ids are not pattern-scrubbed');
  assert.equal(scrubbed.exception.values[0].value, '[message removed]');
  assert.deepEqual(scrubbed.request, { method: 'POST' });
  for (const gone of ['user', 'breadcrumbs', 'extra', 'server_name', 'modules', 'transaction']) assert.ok(!(gone in scrubbed), gone);
  assert.deepEqual(scrubbed.tags, { requestId: 'req_abc' });
  assert.equal(scrubbed.exception.values[0].stacktrace.frames[0].lineno, 3);
  assert.equal(scrubSentryEvent(null), null);
  assert.equal(scrubSentryEvent({ exception: { values: [{ type: 'Error', value: 'DATABASE_UNAVAILABLE' }] } }).exception.values[0].value, 'DATABASE_UNAVAILABLE');
});

test('Sentry is off without a DSN, rejects a malformed DSN without echoing it, and never loads the SDK when off', async () => {
  const trap = new Proxy({}, { get() { throw new Error('SDK must not be touched'); } });
  const off = await initSentry({ env: {}, sentryModule: trap });
  assert.equal(off.enabled, false);
  off.captureError(new Error(PAN));
  await off.flush();
  await assert.rejects(initSentry({ env: { SENTRY_DSN: `not-a-dsn-${PAN}` }, sentryModule: trap }), error => error.code === 'SENTRY_DSN_INVALID' && !error.message.includes(PAN));
});

test('the real Sentry SDK, wired with the production options, sends no identifier from a hostile error or uncaught exception', async () => {
  const sent = [];
  const transport = () => ({ send: async envelope => { sent.push(JSON.stringify(envelope)); return {}; }, flush: async () => true });
  const reporter = await initSentry({ env: { SENTRY_DSN: 'https://0123456789abcdef@o1.ingest.example.test/42', SENTRY_ENVIRONMENT: 'test' }, transport });
  assert.equal(reporter.enabled, true);
  const driverError = Object.assign(new Error(`duplicate ${everything}`), { code: '23505', detail: everything, query: PAN, parameters: [EMAIL], extra: { body: BODY_MARKER } });
  reporter.captureError(driverError, { requestId: `req_${PAN}` });
  reporter.captureError(Object.assign(new Error(PAN), { code: 'DATABASE_UNAVAILABLE', name: 'DbError' }), { requestId: 'req_ok123' });
  // An exception that reaches the SDK without our stand-in (a third-party throw) is still scrubbed by beforeSend.
  const Sentry = await import('@sentry/node');
  Sentry.captureException(Object.assign(new Error(`raw ${everything} ${BODY_MARKER}`), { name: 'RawError' }), { extra: { pan: PAN, body: BODY_MARKER }, user: { email: EMAIL } });
  Sentry.captureMessage(`message ${everything}`);
  Sentry.addBreadcrumb({ message: everything, data: { pan: PAN } });
  await reporter.flush(2_000);
  assert.ok(sent.length >= 3, `expected envelopes, got ${sent.length}`);
  const text = sent.join('\n');
  assertClean(text, 'sentry envelopes');
  assert.ok(text.includes('DATABASE_UNAVAILABLE'), 'the machine code is reported');
  // Every event payload was rebuilt: no breadcrumbs, user, extras or request data, and the third-party throw lost its message.
  const payloads = sent.flatMap(envelope => JSON.parse(envelope)[1].map(item => item[1])).filter(payload => payload && typeof payload === 'object' && !Array.isArray(payload));
  assert.ok(payloads.length >= 4, `expected 4 event payloads, got ${payloads.length}`);
  for (const payload of payloads) {
    for (const gone of ['breadcrumbs', 'user', 'extra', 'server_name', 'modules']) assert.ok(!(gone in payload), `${gone} present in ${JSON.stringify(payload).slice(0, 200)}`);
    assert.ok(!payload.request?.data && !payload.request?.headers && !payload.request?.url);
  }
  // An error name outside the closed class list (RawError, DbError) is reported as plain Error, never forwarded.
  assert.ok(!text.includes('RawError') && !text.includes('DbError'), 'an unlisted error name never reaches Sentry');
  const raw = payloads.find(payload => payload.exception?.values?.[0]?.value === '[message removed]');
  assert.ok(raw, 'the third-party throw lost its message');
  assert.equal(raw.exception.values[0].type, 'Error');
  assert.ok(payloads.some(payload => payload.message === '[message removed]'), 'captureMessage text is removed');
  await reporter.close(1_000);
});
