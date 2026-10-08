import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDatabase } from './helpers/test-database.js';
import { createApiServer, installGracefulShutdown } from '../src/server/server.js';
import { readHttpConfig } from '../src/server/config.js';
import { clientKey, createRequestGuard } from '../src/shared/http/index.js';
import { hasAnalyticsConsent } from '../src/server/http/analytics-proxy.js';

// M2: the server can run behind Cloud Run's front end (configured hosts, proxy-aware rate limiting,
// probes, SIGTERM drain), serve the built UI same-origin and proxy consented analytics to a fixed upstream.

function request(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function start(t, { env = {}, ...options } = {}) {
  const database = options.database ?? await createTestDatabase();
  const server = createApiServer({ database, env: { KNOWVIA_BOOTSTRAP_TOKEN: 'knowvia-test-bootstrap-token-00001', ...env }, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { if (server.listening) await new Promise(resolve => server.close(resolve)); await database.close(); });
  return { server, port: server.address().port };
}

function buildDist() {
  const directory = mkdtempSync(join(tmpdir(), 'knowvia-dist-'));
  mkdirSync(join(directory, 'assets'));
  writeFileSync(join(directory, 'index.html'), '<!doctype html><title>Knowvia</title><div id="app"></div>');
  writeFileSync(join(directory, 'assets', 'index-abc123.js'), 'console.log("app");');
  writeFileSync(join(directory, '..', `secret-${process.pid}.txt`), 'outside the build');
  return directory;
}

test('http config defaults to loopback and validates deployed settings', () => {
  const defaults = readHttpConfig({});
  assert.equal(defaults.host, '127.0.0.1');
  assert.equal(defaults.port, 8787);
  assert.equal(defaults.trustProxyHops, 0);
  assert.equal(defaults.posthogUpstream, null);
  assert.throws(() => readHttpConfig({ HOST: '0.0.0.0' }), /ALLOWED_HOSTS is required/);
  assert.throws(() => readHttpConfig({ ALLOWED_HOSTS: 'https://a.run.app' }), /Invalid ALLOWED_HOSTS/);
  assert.throws(() => readHttpConfig({ ALLOWED_ORIGINS: 'https://a.run.app/' }), /Invalid ALLOWED_ORIGINS/);
  assert.throws(() => readHttpConfig({ PORT: '70000' }), /Invalid PORT/);
  assert.throws(() => readHttpConfig({ TRUST_PROXY_HOPS: '9' }), /Invalid TRUST_PROXY_HOPS/);
  assert.throws(() => readHttpConfig({ POSTHOG_REGION: 'attacker.example' }), /Invalid POSTHOG_REGION/);
  assert.throws(() => readHttpConfig({ POSTHOG_TEST_UPSTREAM: 'https://eu.i.posthog.com' }), /Invalid POSTHOG_TEST_UPSTREAM/);
  assert.throws(() => readHttpConfig({ NODE_ENV: 'production', POSTHOG_TEST_UPSTREAM: 'http://127.0.0.1:9' }), /Invalid POSTHOG_TEST_UPSTREAM/);
  const deployed = readHttpConfig({ HOST: '0.0.0.0', PORT: '8080', ALLOWED_HOSTS: 'Knowvia-x.a.run.app', ALLOWED_ORIGINS: 'https://knowvia-x.a.run.app', TRUST_PROXY_HOPS: '1', POSTHOG_REGION: 'eu' });
  assert.deepEqual([deployed.host, deployed.port, deployed.allowedHosts, deployed.trustProxyHops], ['0.0.0.0', 8080, ['knowvia-x.a.run.app'], 1]);
  assert.equal(deployed.posthogUpstream.api, 'https://eu.i.posthog.com');
});

test('host guard accepts configured hosts and still refuses unknown hosts and origins', () => {
  const guard = createRequestGuard({ allowedHosts: ['knowvia.a.run.app'], allowedOrigins: ['https://knowvia.a.run.app'] });
  const req = (host, origin) => ({ socket: { localPort: 8080 }, headers: { host, ...(origin ? { origin } : {}) } });
  assert.doesNotThrow(() => guard(req('knowvia.a.run.app', 'https://knowvia.a.run.app')));
  assert.doesNotThrow(() => guard(req('127.0.0.1:8080')));
  assert.throws(() => guard(req('evil.example')), /Host not permitted/);
  assert.throws(() => guard(req('knowvia.a.run.app', 'https://evil.example')), /Origin not permitted/);
});

test('rate-limit key uses the proxy hop, not client-supplied X-Forwarded-For entries', () => {
  const req = { socket: { remoteAddress: '169.254.1.1' }, headers: { 'x-forwarded-for': '1.1.1.1, 203.0.113.9' } };
  assert.equal(clientKey(req), '169.254.1.1');
  assert.equal(clientKey(req, { trustProxyHops: 1 }), '203.0.113.9');
  assert.equal(clientKey({ socket: { remoteAddress: '169.254.1.1' }, headers: {} }, { trustProxyHops: 1 }), '169.254.1.1');
});

test('probes: /live skips the database and host guard; /ready checks the database and drains', async t => {
  const { server, port } = await start(t);
  const live = await request(port, '/live', { headers: { host: '10.0.0.7:8080' } });
  assert.equal(live.status, 200);
  assert.deepEqual(JSON.parse(live.body), { status: 'ok' });
  assert.equal((await request(port, '/ready')).status, 200);
  assert.equal((await request(port, '/api/v1/households', { headers: { host: '10.0.0.7:8080' } })).status, 403);
  server.draining = true;
  assert.deepEqual(JSON.parse((await request(port, '/ready')).body), { status: 'draining' });
});

test('/ready reports not_ready without leaking the database error', async t => {
  const database = await createTestDatabase();
  const realQuery = database.query.bind(database);
  let broken = false;
  database.query = (sql, params) => (broken && sql === 'select 1' ? Promise.reject(new Error('connection refused: secret-host:5432')) : realQuery(sql, params));
  const { port } = await start(t, { database });
  broken = true;
  const ready = await request(port, '/ready');
  assert.equal(ready.status, 503);
  assert.doesNotMatch(ready.body, /secret-host/);
});

test('static build is served same-origin with a strict CSP, immutable assets and SPA fallback', async t => {
  const dist = buildDist();
  t.after(() => { rmSync(dist, { recursive: true, force: true }); rmSync(join(dist, '..', `secret-${process.pid}.txt`), { force: true }); });
  const { port } = await start(t, { env: { STATIC_DIR: dist } });
  const index = await request(port, '/');
  assert.equal(index.status, 200);
  assert.match(index.headers['content-type'], /text\/html/);
  assert.match(index.headers['content-security-policy'], /connect-src 'self'/);
  assert.match(index.headers['content-security-policy'], /script-src 'self'/);
  assert.equal(index.headers['cache-control'], 'no-cache');
  const asset = await request(port, '/assets/index-abc123.js');
  assert.equal(asset.status, 200);
  assert.match(asset.headers['cache-control'], /immutable/);
  assert.equal(asset.headers['content-security-policy'], undefined);
  assert.equal((await request(port, '/household/123')).body, index.body);
  assert.equal((await request(port, '/assets/missing.js')).status, 404);
  for (const path of ['/../secret-' + process.pid + '.txt', '/%2e%2e/secret-' + process.pid + '.txt', '/assets/..%2f..%2fsecret-' + process.pid + '.txt']) {
    const escaped = await request(port, path);
    assert.doesNotMatch(escaped.body, /outside the build/, path);
  }
  assert.equal((await request(port, '/', { method: 'POST' })).status, 404);
});

test('consent cookie parsing only accepts an explicit analytics grant', () => {
  const req = cookie => ({ headers: cookie ? { cookie } : {} });
  assert.equal(hasAnalyticsConsent(req()), false);
  assert.equal(hasAnalyticsConsent(req('knowvia_consent=analytics%3Ddenied')), false);
  assert.equal(hasAnalyticsConsent(req('other=1; knowvia_consent=v1%7Canalytics%3Dgranted')), true);
  assert.equal(hasAnalyticsConsent(req('xknowvia_consent=analytics%3Dgranted')), false);
});

test('/ingest forwards only consented analytics to the fixed upstream, without cookies or auth', async t => {
  const calls = [];
  const analyticsFetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response('{"status":1}', { status: 200, headers: { 'content-type': 'application/json', 'set-cookie': 'tracker=1' } });
  };
  const { port } = await start(t, { env: { POSTHOG_REGION: 'eu' }, analyticsFetch });
  const body = JSON.stringify({ event: 'landing_viewed' });

  const denied = await request(port, '/ingest/e/?ver=1', { method: 'POST', body, headers: { 'content-type': 'application/json' } });
  assert.equal(denied.status, 204);
  assert.equal(calls.length, 0, 'no upstream call without consent');

  const consented = await request(port, '/ingest/e/?ver=1', { method: 'POST', body, headers: {
    'content-type': 'application/json', cookie: 'knowvia_consent=v1%7Canalytics%3Dgranted; __Host-knowvia_session=secret',
    authorization: 'Bearer secret', 'x-forwarded-for': '203.0.113.9',
  } });
  assert.equal(consented.status, 200);
  assert.equal(consented.headers['set-cookie'], undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://eu.i.posthog.com/e/?ver=1');
  assert.equal(calls[0].init.redirect, 'manual');
  for (const name of ['cookie', 'authorization', 'x-forwarded-for', 'host']) assert.equal(calls[0].init.headers[name], undefined, name);
  assert.equal(calls[0].init.body.toString(), body);

  await request(port, '/ingest/static/array.js', { headers: { cookie: 'knowvia_consent=analytics%3Dgranted' } });
  assert.equal(calls[1].url, 'https://eu-assets.i.posthog.com/static/array.js');

  const oversized = await request(port, '/ingest/e/', { method: 'POST', body: 'x'.repeat(600 * 1024), headers: { 'content-type': 'text/plain', cookie: 'knowvia_consent=analytics%3Dgranted' } });
  assert.equal(oversized.status, 413);
});

test('/ingest is closed when analytics is not configured', async t => {
  const { port } = await start(t);
  assert.equal((await request(port, '/ingest/e/', { method: 'POST', body: '{}', headers: { cookie: 'knowvia_consent=analytics%3Dgranted' } })).status, 404);
});

test('SIGTERM drain marks the server draining, closes the listener and exits', async t => {
  const { server } = await start(t);
  let exitCode = null;
  const exited = new Promise(resolve => { installGracefulShutdown(server, { graceMs: 2000, exit: code => { exitCode = code; resolve(); }, signals: [] })('SIGTERM'); });
  assert.equal(server.draining, true);
  await exited;
  assert.equal(exitCode, 0);
  assert.equal(server.listening, false);
});
