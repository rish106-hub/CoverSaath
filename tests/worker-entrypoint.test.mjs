import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testTempRoot as tmpdir } from './support/temp-root.mjs';

// docker/entrypoint.sh runs the API and the job worker side by side and stops the container when either dies (Fly restarts it).
// The test puts fake `node`, `runuser`, `chown` and `mkdir` ahead of the real ones: no real process, database or provider is touched.
// Also guards the runtime SQL against what a Supabase transaction pooler (port 6543) breaks.

// The image runs bash 5. `wait -n` needs bash 4.3; macOS ships 3.2, so those tests skip there (CI and the image have it).
const [major, minor] = spawnSync('/bin/bash', ['-c', 'echo "${BASH_VERSINFO[0]} ${BASH_VERSINFO[1]}"'], { encoding: 'utf8' }).stdout.trim().split(' ').map(Number);
const waitN = { skip: major > 4 || (major === 4 && minor >= 3) ? false : 'bash 4.3+ needed for wait -n' };

const ENTRYPOINT = fileURLToPath(new URL('../docker/entrypoint.sh', import.meta.url));

function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), 'coversaath-entrypoint-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin');
  const log = join(dir, 'started.log');
  const script = (name, body) => { writeFileSync(join(dir, name), `#!/bin/bash\n${body}\n`); };
  script('runuser', 'shift 3; exec "$@"'); // runuser -u node -- <cmd>
  script('chown', 'exit 0');
  script('node', `echo "$1" >> "${log}"; case "$1" in *worker.js) sleep "\${FAKE_WORKER_LIFE:-30}"; exit "\${FAKE_WORKER_EXIT:-0}";; *) sleep 30;; esac`);
  for (const name of ['runuser', 'chown', 'node']) chmodSync(join(dir, name), 0o755);
  return { dir, bin, log, path: `${dir}:${process.env.PATH}` };
}

const run = (box, env) => new Promise(resolve => {
  const child = spawn('/bin/bash', [ENTRYPOINT], {
    env: { PATH: box.path, HOME: box.dir, DOCUMENT_STORAGE_PATH: join(box.dir, 'documents'), ...env }, stdio: 'ignore',
  });
  const started = Date.now();
  const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
  child.on('exit', code => { clearTimeout(timer); resolve({ code, ms: Date.now() - started }); });
  setTimeout(() => { if (env.STOP_AFTER_MS) child.kill('SIGTERM'); }, Number(env.STOP_AFTER_MS || 0));
});

const started = box => (existsSync(box.log) ? readFileSync(box.log, 'utf8').trim().split('\n') : []);

test('entrypoint starts the API and the worker; a dead worker stops the container with its exit status', waitN, async t => {
  const box = sandbox(t);
  const result = await run(box, { FAKE_WORKER_LIFE: '0.5', FAKE_WORKER_EXIT: '7' });
  assert.deepEqual(started(box).sort(), ['/app/src/server/server.js', '/app/src/server/worker.js']);
  assert.equal(result.code, 7, 'the container exits with the worker status');
  assert.ok(result.ms < 6000, 'the API did not keep the container alive');
});

test('WORKER_IN_CONTAINER=false starts the API only', waitN, async t => {
  const box = sandbox(t);
  const result = await run(box, { WORKER_IN_CONTAINER: 'false', STOP_AFTER_MS: '800' });
  assert.deepEqual(started(box), ['/app/src/server/server.js']);
  assert.notEqual(result.code, null);
});

test('SIGTERM stops both processes and the container exits', waitN, async t => {
  const box = sandbox(t);
  const result = await run(box, { STOP_AFTER_MS: '800' });
  assert.deepEqual(started(box).sort(), ['/app/src/server/server.js', '/app/src/server/worker.js']);
  assert.ok(result.ms < 6000, 'the container ended on SIGTERM, not on the timeout');
});

// Transaction pooler rules (ADR 0011 D3, docs/runbooks/fly-deploy.md): no session-level lock, LISTEN/NOTIFY, named prepared statement or
// session-scoped setting in anything the API or the worker runs. migrate.js is the one allowed session lock and runs on port 5432.
test('runtime SQL stays transaction-pooler safe (port 6543)', () => {
  const files = [];
  const walk = dir => { for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'migrations') walk(path); } else if (path.endsWith('.js') && !path.endsWith('migrate.js')) files.push(path);
  } };
  walk(fileURLToPath(new URL('../src', import.meta.url)));
  const banned = [/pg_advisory_lock\s*\(/, /pg_try_advisory_lock\s*\(/, /\bLISTEN\s+\w/, /\bNOTIFY\s+\w/, /\bPREPARE\s+\w+\s+(AS|\()/i, /set_config\([^)]*,\s*false\s*\)/];
  const hits = [];
  for (const file of files) for (const pattern of banned) if (pattern.test(readFileSync(file, 'utf8'))) hits.push(`${file}: ${pattern}`);
  assert.deepEqual(hits, []);
});
