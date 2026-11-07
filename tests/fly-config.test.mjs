import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readServerConfig } from '../src/server/config.js';

// A deliberately small reader for fly.toml: section headers and `key = value` lines. It is enough for the flat file
// this repository ships, and it keeps the test free of a new dependency.
function parseFlyToml(text) {
  const sections = new Map([['', new Map()]]);
  let current = '';
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const header = line.match(/^\[{1,2}([^\]]+)\]{1,2}$/);
    if (header) {
      current = header[1];
      if (!sections.has(current)) sections.set(current, new Map());
      continue;
    }
    const pair = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/);
    if (!pair) continue;
    const value = pair[2].trim();
    sections.get(current).set(pair[1], /^".*"$/.test(value) ? value.slice(1, -1) : /^\d+$/.test(value) ? Number(value) : value);
  }
  return sections;
}

// Sections are Maps keyed by name, so a key read from the file can never reach an object prototype.
const sec = (name) => Object.fromEntries(fly.get(name) ?? []);

const text = readFileSync(new URL('../fly.toml', import.meta.url), 'utf8');
const fly = parseFlyToml(text);

test('fly.toml has no volume and no document file path (documents live in PostgreSQL)', () => {
  assert.equal(fly.has('mounts'), false);
  assert.doesNotMatch(text, /^\s*\[\[?mounts\]?\]/m);
  assert.doesNotMatch(text, /^\s*DOCUMENT_STORAGE_PATH\s*=/m);
  assert.doesNotMatch(text, /coversaath_data|\/data\b/);
  assert.equal(sec('env').DOCUMENT_STORAGE_BACKEND, 'database');
});

test('fly.toml runs two 1 GB machines in Singapore with no auto-stop', () => {
  assert.equal(sec('')['primary_region'], 'sin');
  assert.equal(sec('')['app'], 'knowvia-api');
  assert.equal(sec('vm').size, 'shared-cpu-1x');
  assert.equal(sec('vm').memory, '1gb');
  assert.equal(sec('http_service').min_machines_running, 2);
  assert.equal(sec('http_service').auto_stop_machines, 'off');
  assert.equal(sec('http_service').auto_start_machines, 'false');
  assert.equal(sec('http_service.concurrency').soft_limit, 40);
  assert.equal(sec('http_service.concurrency').hard_limit, 80);
});

test('fly.toml keeps the health check and shares limits through the database for two machines', () => {
  const check = sec('http_service.checks');
  assert.equal(check.path, '/api/v1/health');
  assert.equal(check.method, 'GET');
  const env = sec('env');
  assert.equal(env.RATE_LIMIT_BACKEND, 'database');
  assert.equal(env.MODEL_BUDGET_BACKEND, 'database');
  assert.equal(env.DOCUMENT_SCAN_MODE, 'disabled');
  assert.equal(env.TRUST_FLY_CLIENT_IP, 'true');
});

test('fly.toml [env] is accepted by the server configuration reader', () => {
  const config = readServerConfig({ ...sec('env') });
  assert.equal(config.documents.storageBackend, 'database');
  assert.equal(config.rateLimitBackend, 'database');
  assert.equal(config.budgetBackend, 'database');
  assert.deepEqual(config.network.publicHosts, ['knowvia-api.fly.dev']);
  assert.equal(config.network.trustFlyClientIp, true);
});

test('fly.toml carries no secret values', () => {
  const env = sec('env');
  for (const name of Object.keys(env)) {
    assert.doesNotMatch(name, /TOKEN|KEY|SECRET|PASSWORD|DATABASE_URL|API_KEY/);
  }
  assert.doesNotMatch(text, /postgres(?:ql)?:\/\//);
});
