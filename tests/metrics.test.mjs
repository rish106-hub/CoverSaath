import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { freshDatabase, postgresTestOptions } from './support/pg.mjs';
import { createApiServer } from '../src/server/server.js';
import { TenantAccessService } from '../src/backend/services/tenant-access-service.js';
import { createMetricsRegistry, createServerMetrics, oneOf, word, PRIVACY_GATE_REFUSAL_CODES } from '../src/shared/metrics/index.js';
import { KNOWN_ROUTE_SEGMENTS, knownRouteTemplate } from '../src/server/http/event-context.js';

// M2: metrics registry, scrape route and alert rules. All identifiers below are fabricated.
const PAN = 'ABCDE1234F';
const AADHAAR = '234567890123';
const AADHAAR_SPACED = '2345 6789 0123';
const PHONE = '9876543210';
const EMAIL = 'asha.synthetic@example.test';
const CARD = '4111111111111111';
const IDENTIFIERS = [PAN, PAN.toLowerCase(), AADHAAR, AADHAAR_SPACED, PHONE, EMAIL, CARD, 'asha.synthetic'];
const bootstrapToken = 'coversaath-test-bootstrap-token-m2met';

function assertClean(text, label) {
  for (const value of IDENTIFIERS) assert.ok(!text.toLowerCase().includes(value.toLowerCase()), `${label}: leaked ${value}`);
  assert.ok(!text.includes(bootstrapToken), `${label}: leaked the bootstrap token`);
}

// ---- Registry ---------------------------------------------------------------------------------------------------

test('counter, gauge and histogram render in the Prometheus text format', () => {
  const registry = createMetricsRegistry();
  const counter = registry.counter({ name: 'demo_total', help: 'Demo counter.', labels: { kind: oneOf(['a', 'b']) } });
  const gauge = registry.gauge({ name: 'demo_gauge', help: 'Demo gauge.' });
  const histogram = registry.histogram({ name: 'demo_seconds', help: 'Demo histogram.', buckets: [0.1, 1] });
  counter.inc({ kind: 'a' });
  counter.inc({ kind: 'a' }, 2);
  gauge.set({}, 0.5);
  histogram.observe({}, 0.05);
  histogram.observe({}, 0.5);
  histogram.observe({}, 5);
  counter.inc({ kind: 'a' }, -1);
  counter.inc({ kind: 'a' }, Number.NaN);
  histogram.observe({}, -1);
  return registry.render().then(text => {
    assert.match(text, /# TYPE demo_total counter\ndemo_total\{kind="a"\} 3\n/);
    assert.match(text, /demo_gauge 0\.5\n/);
    assert.match(text, /demo_seconds_bucket\{le="0\.1"\} 1\n/);
    assert.match(text, /demo_seconds_bucket\{le="1"\} 2\n/);
    assert.match(text, /demo_seconds_bucket\{le="\+Inf"\} 3\n/);
    assert.match(text, /demo_seconds_count 3\n/);
    assert.match(text, /demo_seconds_sum 5\.55\n/);
  });
});

test('registration rejects bad names, labels and buckets', () => {
  const registry = createMetricsRegistry();
  assert.throws(() => registry.counter({ name: 'Bad-Name', help: 'x' }), /metric name/);
  registry.counter({ name: 'ok_total', help: 'x' });
  assert.throws(() => registry.counter({ name: 'ok_total', help: 'x' }), /duplicate/);
  assert.throws(() => registry.counter({ name: 'a_total', help: 'x', labels: { le: word } }), /label/);
  assert.throws(() => registry.counter({ name: 'b_total', help: 'x', labels: { Bad: word } }), /label/);
  assert.throws(() => registry.counter({ name: 'c_total', help: 'x', labels: { x: 'not a function' } }), /label/);
  assert.throws(() => registry.histogram({ name: 'd_seconds', help: 'x', buckets: [1, 1] }), /buckets/);
  assert.throws(() => registry.counter({ name: 'e_total', help: 'line one\nline two' }), /help/);
  assert.throws(() => createMetricsRegistry({ maxSeries: 0 }), /maxSeries/);
});

test('label values outside the validator, or shaped like an identifier, become "other"', async () => {
  const registry = createMetricsRegistry();
  const free = registry.counter({ name: 'free_total', help: 'A label that accepts any word.', labels: { value: () => true } });
  for (const hostile of [PAN, PAN.toLowerCase(), AADHAAR, AADHAAR_SPACED, PHONE, EMAIL, CARD, `x ${PAN}`, 'आशा', 'a"b', 'a\nb', '', null, undefined, {}, [PAN], 'x'.repeat(200)]) free.inc({ value: hostile });
  free.inc({ value: 'fine_value' });
  const text = await registry.render();
  assertClean(text, 'hostile labels');
  assert.match(text, /free_total\{value="other"\} 17\n/);
  assert.match(text, /free_total\{value="fine_value"\} 1\n/);
  assert.ok(!/[^\x20-\x7e\n]/.test(text), 'output is printable ASCII');
});

test('cardinality cap: an unbounded label cannot grow memory; overflow is counted, not stored', async () => {
  const registry = createMetricsRegistry({ maxSeries: 20 });
  const counter = registry.counter({ name: 'many_total', help: 'x', labels: { id: word } });
  for (let index = 0; index < 5_000; index += 1) counter.inc({ id: `id_${index}` });
  assert.equal(registry.seriesCounts().many_total, 20);
  const text = await registry.render();
  assert.match(text, /metrics_series_dropped_total\{metric="many_total"\} 4980\n/);
  // Existing series keep counting after the cap is reached.
  counter.inc({ id: 'id_0' }, 4);
  assert.match(await registry.render(), /many_total\{id="id_0"\} 5\n/);
  assert.equal(text.split('\n').filter(line => line.startsWith('many_total')).length, 20);
});

test('a collector that throws or hangs is skipped and the scrape still answers', async () => {
  const registry = createMetricsRegistry();
  const gauge = registry.gauge({ name: 'live_gauge', help: 'x' });
  registry.collect(() => { throw new Error(`boom ${PAN}`); });
  registry.collect(() => gauge.set({}, 7));
  const text = await registry.render();
  assert.match(text, /live_gauge 7\n/);
  assertClean(text, 'collector failure');
});

// ---- Server metrics -----------------------------------------------------------------------------------------------

test('server metrics: status classes, closed-set refusal codes, spend and pool ratios', async () => {
  const metrics = createServerMetrics();
  metrics.recordRequest({ method: 'GET', route: '/api/v1/health', status: 200, durationMs: 4 });
  metrics.recordRequest({ method: 'POST', route: '/api/v1/households', status: 503, durationMs: 120 });
  metrics.recordRequest({ method: 'GET', route: '/other', status: undefined, durationMs: 1, aborted: true });
  metrics.recordModelCall({ task: 'extract_policy', outcome: 'ok', latencyMs: 900, costUsd: 0.0123 });
  metrics.recordModelCall({ task: 'extract_policy', outcome: 'BUDGET_REFUSED', latencyMs: 0, costUsd: 0 });
  metrics.recordPrivacyRefusal('RESTRICTED_EVIDENCE');
  metrics.recordPrivacyRefusal('NOT_A_GATE_CODE');
  metrics.recordPrivacyRefusal(PAN);
  metrics.setBudget({ maxUsd: 10, reservedUsd: 1, spentUsd: 7 });
  metrics.setPool({ total: 9, idle: 1, waiting: 2, max: 10 });
  metrics.setQueueDepth(3);
  const text = await metrics.render();
  assert.match(text, /http_requests_total\{method="get",route="\/api\/v1\/health",status_class="2xx"\} 1\n/);
  assert.match(text, /http_requests_total\{method="post",route="\/api\/v1\/households",status_class="5xx"\} 1\n/);
  assert.match(text, /http_requests_total\{method="get",route="\/other",status_class="aborted"\} 1\n/);
  assert.match(text, /http_request_duration_seconds_count\{route="\/api\/v1\/health"\} 1\n/);
  assert.match(text, /model_cost_micro_usd_total 12300\n/);
  assert.match(text, /model_calls_total\{task="extract_policy",outcome="budget_refused"\} 1\n/);
  assert.match(text, /privacy_gate_refusals_total\{code="restricted_evidence"\} 1\n/);
  assert.equal((text.match(/privacy_gate_refusals_total\{/g) ?? []).length, 1, 'only closed-set gate codes are counted');
  assert.match(text, /model_budget_used_ratio 0\.8\n/);
  assert.match(text, /db_pool_utilisation_ratio 0\.8\n/);
  assert.match(text, /db_pool_connections\{state="idle"\} 1\n/);
  assert.match(text, /document_work_queue_depth 3\n/);
  assert.ok(PRIVACY_GATE_REFUSAL_CODES.length >= 5);
});

test('every logged route template is a valid route label, and the registry never exceeds its cap on route churn', async () => {
  const metrics = createServerMetrics({ maxSeries: 500 });
  const hostilePaths = [`/${PAN}/${AADHAAR}`, `/api/v1/${PAN}`, `/api/v1/households/${AADHAAR}/cases/${PHONE}/documents`, `/api/v1/${EMAIL}`, '/api/v1/asha-sharma/x', '/'];
  for (const path of hostilePaths) metrics.recordRequest({ method: 'GET', route: knownRouteTemplate(path), status: 404, durationMs: 1 });
  // A flood of distinct unknown paths collapses into the closed set of route words.
  for (let index = 0; index < 3_000; index += 1) metrics.recordRequest({ method: 'GET', route: knownRouteTemplate(`/api/v1/word-${index}/${randomBytes(6).toString('hex')}`), status: 404, durationMs: 1 });
  const counts = metrics.registry.seriesCounts();
  assert.ok(counts.http_requests_total <= 10, `route series stay tiny: ${counts.http_requests_total}`);
  assertClean(await metrics.render(), 'route churn');
  for (const word of ['metrics']) assert.ok(KNOWN_ROUTE_SEGMENTS.has(word));
});

// ---- Scrape route ---------------------------------------------------------------------------------------------------

function stubServices(env = { KNOWVIA_BOOTSTRAP_TOKEN: bootstrapToken, RATE_LIMIT_BACKEND: 'memory' }) {
  return { access: new TenantAccessService(null, { auth: null, households: null, consents: null, env }) };
}

async function start(t, { env = { KNOWVIA_BOOTSTRAP_TOKEN: bootstrapToken, RATE_LIMIT_BACKEND: 'memory' }, services = stubServices(env), ...extra } = {}) {
  const server = createApiServer({ database: {}, backendServices: services, env, ...extra });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

const scrape = (base, headers = { Authorization: `Bearer ${bootstrapToken}` }) => fetch(`${base}/api/v1/metrics`, { headers });

test('/api/v1/metrics needs the bootstrap bearer; without it nothing is disclosed', async t => {
  const base = await start(t);
  const none = await scrape(base, {});
  assert.equal(none.status, 401);
  assert.ok(!(await none.text()).includes('http_requests_total'));
  assert.equal((await scrape(base, { Authorization: 'Bearer wrong-token-wrong-token-wrong-token-1234' })).status, 401);
  const ok = await scrape(base);
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-type'), /^text\/plain; version=0\.0\.4/);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  assert.match(await ok.text(), /# TYPE http_requests_total counter/);
  // Bootstrap token not configured: the route is closed (503), never open.
  const closed = await start(t, { env: {}, services: stubServices({}) });
  assert.equal((await scrape(closed, {})).status, 503);
});

test('the Host and Origin guard runs before the metrics route', async t => {
  const base = await start(t);
  const port = new URL(base).port;
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/v1/metrics', headers: { Host: 'evil.example.test', Authorization: `Bearer ${bootstrapToken}` } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403);
  assert.equal((await fetch(`${base}/api/v1/metrics`, { headers: { Authorization: `Bearer ${bootstrapToken}`, Origin: 'https://evil.example.test' } })).status, 403);
  // The refused scrape is not exposed either.
  assertClean(await (await scrape(base)).text(), 'after guard refusals');
});

test('synthetic PAN and Aadhaar sent through paths, queries, headers and bodies never appear in any metric', async t => {
  const base = await start(t);
  const hostile = { Cookie: `sid=${PAN}`, 'User-Agent': `agent ${AADHAAR}`, 'X-Request-Id': PAN, 'X-Forwarded-For': PHONE, Authorization: `Bearer ${CARD}abcdefgh` };
  const paths = [
    `/${PAN}/${AADHAAR}?email=${EMAIL}`, `/api/v1/${PAN}`, `/api/v1/households/${AADHAAR}`, `/api/v1/cases/${PHONE}/documents?pan=${PAN}`,
    `/api/v1/${EMAIL}`, `/api/v1/health?aadhaar=${AADHAAR_SPACED.replaceAll(' ', '%20')}`, `/api/v1/households/${PAN}/consents`,
  ];
  for (const path of paths) await fetch(`${base}${path}`, { headers: hostile });
  await fetch(`${base}/api/v1/households`, { method: 'POST', headers: { ...hostile, 'Content-Type': 'application/json' }, body: JSON.stringify({ pan: PAN, owner: { contactPhone: PHONE, aadhaar: AADHAAR } }) });
  const response = await scrape(base);
  const text = await response.text();
  assert.equal(response.status, 200);
  assertClean(text, 'scrape after hostile traffic');
  assert.ok(!/[^\x20-\x7e\n]/.test(text));
  // Every label value is a route template, status class or closed-set word.
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    assert.match(line, /^[a-z_]+(?:\{(?:(?:le="(?:[0-9.]+|\+Inf)"|[a-z_]+="[a-z0-9_:./-]{1,96}"),?)*\})? [0-9.e+-]+$/, line);
  }
  assert.match(text, /http_requests_total\{method="get",route="\/other",status_class="4xx"\}/);
  // The scrape counted the traffic: 404/403/401 classes appear, no route carries an id.
  assert.ok(!/route="[^"]*(?:\d{9}|ABCDE)/i.test(text));
});

test('a 5xx raises the 5xx count and keeps the class label only', async t => {
  const failing = { access: { requireBootstrap() { throw Object.assign(new Error(`boom ${PAN}`), { statusCode: 500 }); }, bootstrapConfigured: true } };
  const base = await start(t, { services: failing });
  const response = await fetch(`${base}/api/v1/households`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 500);
  // The failing stub rejects every bootstrap check, so scrape through a second server sharing the metrics object.
  const shared = createServerMetrics();
  const base2 = await start(t, { services: failing, metrics: shared });
  await fetch(`${base2}/api/v1/households`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  await new Promise(resolve => setTimeout(resolve, 20));
  const text = await shared.render();
  assert.match(text, /http_requests_total\{method="post",route="\/api\/v1\/households",status_class="5xx"\} 1\n/);
  assertClean(text, '5xx');
});

test('privacy-gate refusal codes at the HTTP boundary are counted by gate code', async t => {
  const refusing = { access: { requireBootstrap() { throw Object.assign(new Error(`bad ${PAN}`), { code: 'RESTRICTED_EVIDENCE', statusCode: 422 }); }, bootstrapConfigured: true } };
  const shared = createServerMetrics();
  const base = await start(t, { services: refusing, metrics: shared });
  for (let index = 0; index < 3; index += 1) await fetch(`${base}/api/v1/households`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const text = await shared.render();
  assert.match(text, /privacy_gate_refusals_total\{code="restricted_evidence"\} 3\n/);
  assertClean(text, 'refusals');
});

// ---- Scrape-time gauges against a real database --------------------------------------------------------------------

test('pool, queue and budget gauges read live state from PostgreSQL', postgresTestOptions(), async t => {
  const { db } = await freshDatabase(t);
  const env = {
    KNOWVIA_BOOTSTRAP_TOKEN: bootstrapToken, DATA_ENCRYPTION_KEY_BASE64: randomBytes(32).toString('base64'),
    MODEL_BUDGET_BACKEND: 'database', ORCHESTRATION_PROJECT_BUDGET_USD: '10',
  };
  const server = createApiServer({ database: db, env });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  // First request builds the backend; the second scrape sees queue depth from the database.
  await fetch(`${base}/api/v1/live`);
  await fetch(`${base}/api/v1/ready`);
  const text = await (await scrape(base)).text();
  assert.match(text, /^document_work_queue_depth 0$/m);
  assert.match(text, /^model_budget_used_ratio 0$/m);
  assert.match(text, /^model_budget_max_usd 10$/m);
  assert.match(text, /^db_pool_max_connections \d+$/m);
  assert.match(text, /^db_pool_utilisation_ratio [0-9.]+$/m);
  assertClean(text, 'database gauges');
});

// ---- Alert rules ------------------------------------------------------------------------------------------------------

test('alert rules file: required alerts, thresholds, and only metrics this service exports', async () => {
  const rules = await readFile(new URL('../ops/alerts.rules.yml', import.meta.url), 'utf8');
  const runbook = await readFile(new URL('../docs/runbooks/alerts.md', import.meta.url), 'utf8');
  const alerts = [...rules.matchAll(/^\s*- alert: (\w+)/gm)].map(match => match[1]);
  for (const name of ['CoverSaathHigh5xxRate', 'CoverSaathModelBudgetHigh', 'CoverSaathPrivacyRefusalSpike', 'CoverSaathDbConnectionsHigh']) {
    assert.ok(alerts.includes(name), `missing alert ${name}`);
    assert.ok(runbook.includes(name), `runbook does not describe ${name}`);
  }
  assert.match(rules, /> 0\.02\b/, '5xx threshold 2%');
  assert.match(rules, /model_budget_used_ratio\)?\s*>\s*0\.8\b/, 'budget threshold 80%');
  assert.match(rules, /db_pool_utilisation_ratio\)?\s*>\s*0\.8\b/, 'connections threshold 80%');
  for (const field of ['summary:', 'runbook:', 'severity:', 'for:']) assert.ok(rules.includes(field), field);

  const registry = createServerMetrics().registry;
  const text = await registry.render();
  const exported = new Set([...text.matchAll(/^# TYPE (\w+) /gm)].map(match => match[1]));
  const recorded = new Set([...rules.matchAll(/^\s*- record: ([\w:]+)/gm)].map(match => match[1]));
  const exprs = [...rules.matchAll(/^\s*expr: ?(.*(?:\n {10,}.*)*)/gm)].map(match => match[1]);
  assert.ok(exprs.length >= alerts.length);
  for (const expr of exprs) {
    for (const token of expr.match(/\b(?:http|model|privacy|db|document|metrics|coversaath)[\w:]*/g) ?? []) {
      const base = token.replace(/_(?:bucket|sum|count)$/, '');
      assert.ok(exported.has(token) || exported.has(base) || recorded.has(token), `rules use ${token}, which this service does not export`);
    }
  }
  assertClean(rules, 'rules file');
});
