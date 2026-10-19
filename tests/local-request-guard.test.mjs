import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApiServer } from '../src/server/server.js';

// The API is loopback-only. Host, Origin and Sec-Fetch-Site checks (assertLocalRequest) stop
// DNS rebinding and cross-site browser calls before any route, session or database work.
function request(port, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/v1/integrations', method: 'GET', headers }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('the API refuses foreign Host, foreign Origin and cross-site requests before routing', async t => {
  const server = createApiServer({ env: {} });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { port } = server.address();
  const local = `127.0.0.1:${port}`;

  const rebinding = await request(port, { Host: 'attacker.example:8787' });
  assert.equal(rebinding.status, 403);
  assert.deepEqual(rebinding.body, { error: 'Local access only.' });

  const foreignOrigin = await request(port, { Host: local, Origin: 'https://attacker.example' });
  assert.equal(foreignOrigin.status, 403);
  assert.deepEqual(foreignOrigin.body, { error: 'Origin not permitted.' });

  const crossSite = await request(port, { Host: local, 'Sec-Fetch-Site': 'cross-site' });
  assert.equal(crossSite.status, 403);
  assert.deepEqual(crossSite.body, { error: 'Cross-site access is blocked.' });

  // Allowed local callers pass the guard and reach the route, which then requires a session.
  for (const headers of [{ Host: local }, { Host: 'localhost:8787', Origin: 'http://localhost:5173' }, { Host: local, 'Sec-Fetch-Site': 'same-origin' }]) {
    const allowed = await request(port, headers);
    assert.notEqual(allowed.status, 403, JSON.stringify(headers));
  }
});
