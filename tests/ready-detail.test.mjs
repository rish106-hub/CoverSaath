import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { testTempRoot as tmpdir } from './support/temp-root.mjs';
import { openDatabase } from '../src/backend/database/index.js';
import { createBackendServices } from '../src/backend/services/index.js';
import { createApiServer } from '../src/server/server.js';
import { handleV1BackendRoute } from '../src/server/routes/v1-backend-routes.js';
import { isLoopbackRequest } from '../src/shared/http/index.js';

// GET /api/v1/ready is unauthenticated. Only a loopback caller that also passes the local request
// guard may see schema detail; anyone else gets { status, checks } with booleans only.
const env = { KNOWVIA_BOOTSTRAP_TOKEN: 'knowvia-test-bootstrap-token-00001' };

function backend(t) {
  const directory = mkdtempSync(join(tmpdir(), 'knowvia-ready-'));
  const database = openDatabase({ path: join(directory, 'knowvia.sqlite') });
  t.after(() => {
    try { database.close(); } catch {}
    rmSync(directory, { recursive: true, force: true });
  });
  return { database, services: createBackendServices(database, { env }) };
}

const fakeRequest = ({ remoteAddress, host }) => ({
  method: 'GET',
  url: '/api/v1/ready',
  headers: { host },
  socket: { remoteAddress, localPort: 8787 },
});

async function ready(t, req) {
  const { database, services } = backend(t);
  return handleV1BackendRoute({ req, url: new URL(req.url, 'http://127.0.0.1:8787'), database, services, integrations: {}, config: {} });
}

function assertNoDetail(result) {
  assert.equal(result.status, 200);
  assert.deepEqual(Object.keys(result.body).sort(), ['checks', 'status']);
  assert.equal(result.body.status, 'ready');
  assert.deepEqual(result.body.checks, { database: true, authentication: true });
}

test('a non-loopback caller gets readiness booleans and no schema detail', async t => {
  // A public peer that forwards a local-looking Host header (as a misconfigured proxy might).
  assertNoDetail(await ready(t, fakeRequest({ remoteAddress: '203.0.113.7', host: '127.0.0.1:8787' })));
  assertNoDetail(await ready(t, fakeRequest({ remoteAddress: '::ffff:198.51.100.4', host: 'localhost:8787' })));
  // A reverse proxy on the same machine connects from loopback but carries the public Host.
  assertNoDetail(await ready(t, fakeRequest({ remoteAddress: '127.0.0.1', host: 'coversaath-staging.example' })));
  assertNoDetail(await ready(t, fakeRequest({ remoteAddress: undefined, host: '127.0.0.1:8787' })));
  // A same-host proxy that rewrites Host to 127.0.0.1 still adds a forwarding header.
  for (const header of ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'x-client-ip', 'x-original-host']) {
    const proxied = fakeRequest({ remoteAddress: '127.0.0.1', host: '127.0.0.1:8787' });
    proxied.headers[header] = '203.0.113.7';
    assertNoDetail(await ready(t, proxied));
  }
  const noSocket = fakeRequest({ host: '127.0.0.1:8787' });
  delete noSocket.socket;
  assertNoDetail(await ready(t, noSocket));
});

test('a proxied request through the real server gets no schema detail', async t => {
  const { database } = backend(t);
  const server = createApiServer({ database, env });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/ready`, { headers: { 'X-Forwarded-For': '203.0.113.7' } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ready', checks: { database: true, authentication: true } });
});

test('a not-ready response to a non-loopback caller still carries no detail', async t => {
  const { database } = backend(t);
  const services = createBackendServices(database, { env: {} });
  const req = fakeRequest({ remoteAddress: '203.0.113.7', host: '127.0.0.1:8787' });
  const result = await handleV1BackendRoute({ req, url: new URL(req.url, 'http://127.0.0.1:8787'), database, services, integrations: {}, config: {} });
  assert.equal(result.status, 503);
  assert.deepEqual(result.body, { status: 'not_ready', checks: { database: true, authentication: false } });
});

test('a loopback caller through the real server gets the schema detail', async t => {
  const { database } = backend(t);
  const server = createApiServer({ database, env });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/ready`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body.checks, { database: true, authentication: true });
  assert.equal(body.database.valid, true);
  assert.equal(body.externalProviderCalls, false);
});

test('isLoopbackRequest needs both a loopback peer and the local request guard', () => {
  for (const remoteAddress of ['127.0.0.1', '127.8.9.10', '::1', '::ffff:127.0.0.1']) {
    assert.equal(isLoopbackRequest(fakeRequest({ remoteAddress, host: '127.0.0.1:8787' })), true, remoteAddress);
  }
  for (const remoteAddress of ['10.0.0.1', '::ffff:10.0.0.1', '0.0.0.0', '::', '127.0.0.1.example', '', undefined]) {
    assert.equal(isLoopbackRequest(fakeRequest({ remoteAddress, host: '127.0.0.1:8787' })), false, String(remoteAddress));
  }
  const crossSite = fakeRequest({ remoteAddress: '127.0.0.1', host: '127.0.0.1:8787' });
  crossSite.headers['sec-fetch-site'] = 'cross-site';
  assert.equal(isLoopbackRequest(crossSite), false);
  const foreignOrigin = fakeRequest({ remoteAddress: '127.0.0.1', host: '127.0.0.1:8787' });
  foreignOrigin.headers.origin = 'https://attacker.example';
  assert.equal(isLoopbackRequest(foreignOrigin), false);
});
