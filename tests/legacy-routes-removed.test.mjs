import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiServer } from '../src/server/server.js';

// The memory-only demo API was removed. ENABLE_LEGACY_DEMO_API is no longer read,
// so an old .env.local that still sets it must not bring any legacy route back.
test('former legacy demo routes return ROUTE_NOT_FOUND even when ENABLE_LEGACY_DEMO_API=true', async t => {
  const server = createApiServer({ env: { ENABLE_LEGACY_DEMO_API: 'true' } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => {
    const response = await fetch(base + path, {
      method,
      headers: { Host: '127.0.0.1:8787', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { response, data: await response.json() };
  };
  const caseId = '00000000-0000-4000-8000-000000000000';
  const formerRoutes = [
    ['GET', '/api/health'],
    ['GET', '/api/orchestration/config'],
    ['POST', '/api/cases', { trigger: 'planned_care', consent: true }],
    ['GET', `/api/cases/${caseId}`],
    ['POST', `/api/cases/${caseId}/orchestration`, { mode: 'fixture', modelConsent: false }],
    ['POST', `/api/cases/${caseId}/revoke-consent`],
  ];
  for (const [method, path, body] of formerRoutes) {
    const { response, data } = await call(method, path, body);
    assert.equal(response.status, 404, `${method} ${path}`);
    assert.equal(data.error.code, 'ROUTE_NOT_FOUND', `${method} ${path}`);
    assert.equal(response.headers.get('set-cookie'), null, `${method} ${path} must not start a legacy session`);
  }
});
