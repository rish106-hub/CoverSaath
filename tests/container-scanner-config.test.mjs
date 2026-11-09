import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MAX_DOCUMENT_BYTES } from '../src/features/input/contracts.js';

// Static guards for the files that make the container able to scan (no clamd, Docker or network needed).
// The runtime behaviour is checked by tests/clamd-integration.test.mjs against a real daemon, and by the deploy runbook.
const read = name => readFileSync(new URL(`../docker/${name}`, import.meta.url), 'utf8');
const directives = text => new Map(text.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'))
  .map(line => [line.split(/\s+/)[0], line.split(/\s+/).slice(1).join(' ')]));
const megabytes = value => Number.parseInt(value, 10) * 1024 * 1024;

test('clamd.conf makes "clean" mean "fully scanned" and listens on loopback only', () => {
  const conf = directives(read('clamd.conf'));
  assert.equal(conf.get('TCPAddr'), '127.0.0.1');
  assert.equal(conf.get('AlertExceedsMax'), 'yes');
  assert.equal(conf.get('AlertEncrypted'), 'yes');
  assert.equal(conf.get('AlertBrokenExecutables'), 'yes');
  assert.equal(conf.get('ScanPDF'), 'yes');
  // The stream and file caps must cover the largest accepted upload, or a legitimate PDF is refused instead of scanned.
  assert.ok(megabytes(conf.get('StreamMaxLength')) >= MAX_DOCUMENT_BYTES);
  assert.ok(megabytes(conf.get('MaxFileSize')) >= MAX_DOCUMENT_BYTES);
});

test('freshclam.conf keeps signatures current without exceeding the mirror rate limit', () => {
  const conf = directives(read('freshclam.conf'));
  assert.equal(conf.get('DatabaseDirectory'), directives(read('clamd.conf')).get('DatabaseDirectory'));
  assert.ok(Number(conf.get('Checks')) >= 1 && Number(conf.get('Checks')) <= 24);
});

test('entrypoint starts clamd and the updater only in clamd mode and lets only the API and clamd stop the container', () => {
  const script = read('entrypoint.sh');
  assert.match(script, /DOCUMENT_SCAN_MODE:-disabled\}" = "clamd"/);
  assert.match(script, /freshclam --config-file=\/app\/docker\/freshclam\.conf --daemon/);
  assert.match(script, /wait -n "\$node_pid" \$\{clamd_pid:\+"\$clamd_pid"\}/);
  // The API never runs as root.
  assert.match(script, /runuser -u node -- node \/app\/src\/server\/server\.js/);
});
