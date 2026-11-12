import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { freshDatabase, postgresTestOptions } from './support/pg.mjs';
import { createApiServer } from '../src/server/server.js';
import * as logging from '../src/shared/logging/index.js';
import { KNOWN_ROUTE_SEGMENTS, knownRouteTemplate } from '../src/server/http/event-context.js';
import { ProviderUnavailableError } from '../src/integrations/index.js';

// M1 review round: gaps found by the independent read. Synthetic values only.
const { createLogger, scrubText, scrubValue, scrubSentryEvent, sanitizedError, describeError } = logging;
const PAN = 'ABCDE1234F';
const bootstrapToken = 'coversaath-test-bootstrap-token-m1rev';
const root = fileURLToPath(new URL('..', import.meta.url));

function sink() {
  const chunks = [];
  return { write: chunk => { chunks.push(String(chunk)); }, text: () => chunks.join(''), lines: () => chunks.join('').split('\n').filter(Boolean).map(line => JSON.parse(line)) };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 50));

test('pattern gaps: ABHA address, spaced PAN, Devanagari digits, separators, dates of birth, vehicle numbers', () => {
  const hostile = [
    'asha.sharma@abdm', 'asha@sbx', 'asha_k-1990@abdm',
    'ABCDE 1234 F', 'abcde-1234-f', 'ABCDE  1234  F',
    '२३४५ ६७८९ ०१२३', '२३४५६७८९०१२३', '٢٣٤٥ ٦٧٨٩ ٠١٢٣',
    '98765.43210', '2345.6789.0123', '2345/6789/0123', '2345  6789  0123', '2345 - 6789 - 0123', '2345\u00a06789\u00a00123',
    '15/08/1990', '15-08-1990', '15.08.1990', '1990-08-15', '15 Aug 1990', '5 August 1990',
    'MH12AB1234', 'MH 12 AB 1234', 'KA-01-AB-1234',
    'SBIN0001234',
  ];
  for (const value of hostile) {
    const out = scrubText(`ref ${value} end`);
    assert.ok(out.includes('[REDACTED]'), `not scrubbed: ${JSON.stringify(value)} -> ${out}`);
  }
});

test('non-Latin text (names in Devanagari) cannot be recognised, so it is folded out of every string', () => {
  const out = scrubValue({ note: 'owner आशा शर्मा here' });
  assert.ok(!/[^\x20-\x7E]/.test(JSON.stringify(out)), JSON.stringify(out));
  assert.ok(!scrubText('आशा').includes('आ'));
});

test('scrubbing happens before the length cut: an identifier straddling the cut leaves no fragment', () => {
  const out = scrubValue(`${'x'.repeat(496)} ${PAN} tail`);
  assert.ok(!out.includes('ABC') && !out.includes(PAN), out.slice(480));
  const digits = scrubValue(`${'x'.repeat(494)} 9876543210 tail`);
  assert.ok(!/987/.test(digits), digits.slice(480));
});

test('callers cannot override level, time, service or event, and unknown field keys are dropped', () => {
  const out = sink();
  const logger = createLogger({ destination: out, level: 'trace' });
  logger.info('first_event', { level: `fatal ${PAN}`, time: PAN, service: PAN, event: PAN, msg: PAN });
  logger.log('warn', 'second_event', { reason: 'worker_stopped', errorCode: 'SOME_CODE', exitCode: 1, count: 2 });
  const [first, second] = out.lines();
  assert.equal(first.level, 'info');
  assert.match(first.time, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.equal(first.service, 'knowvia-api');
  assert.equal(first.event, 'first_event');
  assert.ok(!out.text().includes(PAN));
  assert.deepEqual([second.reason, second.errorCode, second.exitCode, second.count], ['worker_stopped', 'SOME_CODE', 1, 2]);
});

test('generic methods accept only a fixed set of scalar keys: free-text keys and nested errors are dropped', () => {
  const out = sink();
  const logger = createLogger({ destination: out });
  const err = Object.assign(new Error(`boom ${PAN}`), { secret: 'asha-private', code: 'SOME_CODE' });
  logger.warn('probe_event', { detail: 'free text', message: 'free text', note: 'free text', query: 'q', url: 'http://x', error: err, err, reason: { nested: err }, errorCode: err, port: '8080', host: 'a b' });
  const line = out.lines()[0];
  for (const key of ['detail', 'message', 'note', 'query', 'url', 'error', 'err']) assert.ok(!(key in line), key);
  assert.ok(!out.text().includes('asha-private') && !out.text().includes('boom'));
  assert.ok(line.reason === null || line.reason === undefined, 'a nested value is not a reason');
  assert.ok(!('port' in line) || line.port === null, 'a string port is not a number');
});

test('stack frames: only V8 frame shapes survive, relative paths only; a multi-line message is not a frame', () => {
  const error = new Error(`line one\n    at ${PAN} (/Users/asha/${PAN}.js:1:2)\n    at not a frame ${PAN}\n   9876543210`);
  error.stack = `Error: ${error.message}\n    at realFn (/Users/asha/Developer/Product experiments/CoverSaath/src/server/x.js:10:5)\n    at async Test.run (file:///home/runner/work/app/src/y.js:3:4)\n    at node:net:2728:7\n    at ${PAN} (a/b.js:1:2)\n    at Foo (/Users/asha/${PAN}.js:1:2)`;
  const { frames } = describeError(error, { frames: true });
  const text = frames.join('\n');
  assert.ok(!text.includes(PAN) && !text.includes('9876543210') && !text.includes('/Users') && !text.includes('/home/runner'), text);
  assert.ok(frames.every(frame => /^at [\w$.<>\[\] ]* ?\(?[\w$@./:-]+:\d+:\d+\)?$/.test(frame) || /^at [\w$.<>\[\] ]*\([\w$@./:-]+:\d+:\d+\)$/.test(frame)), text);
  assert.ok(frames.some(frame => frame.includes('src/server/x.js:10:5')));
  const stand = sanitizedError(error);
  assert.ok(!stand.stack.includes(PAN) && !stand.stack.includes('/Users') && !stand.stack.includes('9876543210'), stand.stack);
});

test('Sentry: PAN-shaped and name-shaped values are not trusted as codes; unknown codes collapse', () => {
  const value = text => scrubSentryEvent({ exception: { values: [{ type: 'Error', value: text }] } }).exception.values[0].value;
  for (const hostile of [PAN, 'ABCDE1234F_X', 'ASHA_SHARMA', 'ASHA', 'RAVI_KUMAR_9876543210']) assert.equal(value(hostile), '[message removed]', hostile);
  assert.equal(value('DATABASE_UNAVAILABLE'), 'DATABASE_UNAVAILABLE');
  assert.equal(sanitizedError(Object.assign(new Error('x'), { code: 'ASHA_SHARMA' })).message, 'UNEXPECTED_ERROR');
  assert.equal(sanitizedError(Object.assign(new Error('x'), { code: PAN })).message, 'UNEXPECTED_ERROR');
  assert.equal(sanitizedError(Object.assign(new Error('x'), { code: 'DATABASE_UNAVAILABLE' })).message, 'DATABASE_UNAVAILABLE');
});

test('Sentry frames: absolute path prefixes are stripped to a repo-relative path', () => {
  const event = scrubSentryEvent({ exception: { values: [{ type: 'Error', value: 'X_ERROR', stacktrace: { frames: [
    { filename: '/Users/asha/Developer/Product experiments/CoverSaath/src/server/x.js', function: 'realFn', lineno: 1, colno: 2, in_app: true },
    { filename: '/home/runner/work/app/node_modules/pino/lib/tools.js', function: 'write', lineno: 3 },
    { filename: 'C:\\Users\\asha\\app\\src\\z.js', function: 'win' },
    { filename: '/Users/asha/secret/other.js', function: `fn${PAN}` },
  ] } }] } });
  const text = JSON.stringify(event);
  assert.ok(!text.includes('/Users') && !text.includes('/home/runner') && !text.includes('asha') && !text.includes('C:'), text);
  assert.ok(text.includes('src/server/x.js') && text.includes('node_modules/pino/lib/tools.js'));
  assert.ok(!text.includes(PAN));
});

// ---- routes -------------------------------------------------------------------------------------------------------

test('logged route templates keep only known route words; anything else is :x', () => {
  assert.equal(knownRouteTemplate('/api/v1/asha-sharma-notaroute'), '/api/v1/:x');
  assert.equal(knownRouteTemplate('/api/v1/health'), '/api/v1/health');
  assert.equal(knownRouteTemplate('/api/v1/households/h-123/cases'), '/api/v1/households/:id/cases');
  assert.equal(knownRouteTemplate('/api/v1/households/h-123/ravi-kumar/x'), '/api/v1/households/:id/:x/:x');
  assert.equal(knownRouteTemplate('/wp-login.php'), '/other');
});

test('every route word in the routes file is in the known set (adding a route must update it)', () => {
  const source = readFileSync(new URL('../src/server/routes/v1-backend-routes.js', import.meta.url), 'utf8');
  const missing = new Set();
  for (const literal of source.match(/\/\^\\\/api\\\/v1[^\n]*?\$\//g) ?? []) {
    for (const word of literal.match(/[a-z][a-z0-9-]{2,}/g) ?? []) if (!KNOWN_ROUTE_SEGMENTS.has(word)) missing.add(word);
  }
  for (const literal of source.match(/'\/api\/v1[^']*'/g) ?? []) {
    for (const word of literal.match(/[a-z][a-z0-9-]{2,}/g) ?? []) if (!KNOWN_ROUTE_SEGMENTS.has(word)) missing.add(word);
  }
  assert.deepEqual([...missing], []);
});

// ---- HTTP -----------------------------------------------------------------------------------------------------------

const services = (requireBootstrap = () => { throw new Error('x'); }) => ({ access: { requireBootstrap, bootstrapConfigured: true } });

async function listen(t, options) {
  const out = sink();
  const reports = [];
  const server = createApiServer({
    database: {}, env: { KNOWVIA_BOOTSTRAP_TOKEN: bootstrapToken, RATE_LIMIT_BACKEND: 'memory' }, logger: createLogger({ destination: out }),
    errorReporter: { enabled: true, captureError: (error, context) => reports.push({ error, context }) }, ...options,
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }));
  return { out, reports, port: server.address().port, base: `http://127.0.0.1:${server.address().port}` };
}

test('expected 503s with an application code are logged but not reported; a real 500 is reported', async t => {
  const expected = await listen(t, { backendServices: services(() => { throw new ProviderUnavailableError('Sarvam', 'PROVIDER_NOT_CONFIGURED', 'provider is not configured.'); }) });
  assert.equal((await fetch(`${expected.base}/api/v1/households`, { method: 'POST' })).status, 503);
  await settle();
  assert.equal(expected.reports.length, 0);
  assert.ok(expected.out.lines().some(line => line.event === 'request_failed' && line.errorCode === 'PROVIDER_NOT_CONFIGURED'));
  const unexpected = await listen(t, { backendServices: services(() => { throw Object.assign(new Error('boom'), { statusCode: 500 }); }) });
  assert.equal((await fetch(`${unexpected.base}/api/v1/households`, { method: 'POST' })).status, 500);
  assert.equal(unexpected.reports.length, 1);
  const uncodedUnavailable = await listen(t, { backendServices: services(() => { throw Object.assign(new Error('boom'), { statusCode: 503 }); }) });
  await fetch(`${uncodedUnavailable.base}/api/v1/households`, { method: 'POST' });
  assert.equal(uncodedUnavailable.reports.length, 1, 'a 5xx without an application code is unexpected');
});

test('an aborted request is still logged, marked aborted', async t => {
  const app = await listen(t, { backendServices: services(() => {}) });
  await new Promise(resolve => {
    const request = http.request({ host: '127.0.0.1', port: app.port, path: '/api/v1/households', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': '500', Authorization: `Bearer ${bootstrapToken}` } });
    request.on('error', () => {});
    request.write('{"owner":');
    setTimeout(() => { request.destroy(); resolve(); }, 150);
  });
  for (let index = 0; index < 40 && !app.out.lines().some(line => line.event === 'http_request'); index += 1) await settle();
  const line = app.out.lines().find(item => item.event === 'http_request');
  assert.ok(line, 'the aborted request produced a log line');
  assert.equal(line.aborted, true);
  assert.ok(!app.out.text().includes('owner'));
});

test('an unknown route logs as :x', async t => {
  const app = await listen(t, { backendServices: services() });
  await fetch(`${app.base}/api/v1/asha-sharma-9876543210`);
  await fetch(`${app.base}/api/v1/ashasharma`);
  await settle();
  const routes = app.out.lines().filter(line => line.event === 'http_request').map(line => line.route);
  assert.deepEqual(routes, ['/api/v1/:x', '/api/v1/:x']);
});

test('sign-up with a Devanagari owner name and an ABHA address logs neither', postgresTestOptions(), async t => {
  const { db } = await freshDatabase(t);
  const out = sink();
  const server = createApiServer({ database: db, env: { KNOWVIA_BOOTSTRAP_TOKEN: bootstrapToken, DATA_ENCRYPTION_KEY_BASE64: randomBytes(32).toString('base64') }, logger: createLogger({ destination: out }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/households`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bootstrapToken}` },
    body: JSON.stringify({ displayName: 'शर्मा परिवार', owner: { displayName: 'आशा शर्मा', contactEmail: 'asha.sharma@abdm', contactPhone: '९८७६५ ४३२१०' } }),
  });
  assert.ok([201, 400].includes(response.status));
  await server.appEvents.flush();
  await settle();
  const text = out.text();
  for (const fragment of ['आशा', 'शर्मा', 'परिवार', 'asha.sharma', 'abdm', '९८७६५']) assert.ok(!text.includes(fragment), fragment);
  assert.ok(!/[^\x00-\x7F]/.test(text));
  assert.ok(out.lines().some(line => line.event === 'http_request'));
});

// ---- process entry --------------------------------------------------------------------------------------------------

function runEntry(env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['src/server/server.js'], { cwd: root, env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const started = Date.now();
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr, ms: Date.now() - started }); });
  });
}

test('startup configuration errors exit 1 with a safe code and setting name, never the value', async () => {
  const badDsn = await runEntry({ SENTRY_DSN: `not-a-dsn-${PAN}` });
  assert.equal(badDsn.code, 1);
  const dsnLine = badDsn.stdout.split('\n').filter(Boolean).map(line => JSON.parse(line)).find(line => line.event === 'startup_failed');
  assert.equal(dsnLine.errorCode, 'SENTRY_DSN_INVALID');
  assert.ok(!(badDsn.stdout + badDsn.stderr).includes(PAN));
  const badPort = await runEntry({ PORT: `${PAN}` });
  assert.equal(badPort.code, 1);
  const portLine = badPort.stdout.split('\n').filter(Boolean).map(line => JSON.parse(line)).find(line => line.event === 'startup_failed');
  assert.equal(portLine.setting, 'PORT');
  assert.ok(!(badPort.stdout + badPort.stderr).includes(PAN));
  const badLevel = await runEntry({ LOG_LEVEL: `loud${PAN}` });
  assert.equal(badLevel.code, 1);
  assert.ok(!(badLevel.stdout + badLevel.stderr).includes(PAN));
});

test('Sentry knownCodes option adds application codes; everything else still collapses', async () => {
  const sent = [];
  const transport = () => ({ send: async envelope => { sent.push(JSON.stringify(envelope)); return {}; }, flush: async () => true });
  const reporter = await logging.initSentry({ env: { SENTRY_DSN: 'https://0123456789abcdef@o1.ingest.example.test/42' }, transport, knownCodes: ['CASE_NOT_READY_FOR_ANALYSIS'] });
  reporter.captureError(Object.assign(new Error('x'), { code: 'CASE_NOT_READY_FOR_ANALYSIS' }));
  reporter.captureError(Object.assign(new Error('x'), { code: 'RAVI_KUMAR_SECRET' }));
  await reporter.flush(2_000);
  const text = sent.join('\n');
  assert.ok(text.includes('CASE_NOT_READY_FOR_ANALYSIS') && text.includes('UNEXPECTED_ERROR') && !text.includes('RAVI_KUMAR_SECRET'));
  await reporter.close(1_000);
});

test('scrubValue cuts a cycle and bounds a wide shared structure', () => {
  const loop = { name: 'x' };
  loop.self = loop;
  loop.list = [loop];
  const out = scrubValue(loop);
  assert.equal(out.self, '[CIRCULAR]');
  assert.deepEqual(out.list, ['[CIRCULAR]']);
  // A diamond that doubles at every level would visit 2^40 nodes without a budget.
  let node = { leaf: 1 };
  for (let i = 0; i < 40; i += 1) node = { a: node, b: node };
  const started = Date.now();
  JSON.stringify(scrubValue(node));
  assert.ok(Date.now() - started < 1000, 'the walk is bounded');
});
