// Sandboxed PDF inspection (ADR 0005 amendment): the API process never parses untrusted PDF
// structure. These tests spawn real child processes with the same flag builder as production.
// Synthetic bytes only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANALYSIS_ERROR_CODES } from '../src/contracts/error-codes.js';
import {
  DocumentIntakeError,
  MAX_DOCUMENT_BYTES,
  createDocumentIntakeService,
  createFixtureMemoryByteStorage,
  createMemoryDocumentRepository,
  createSandboxedPdfInspector,
  inspectPdf,
} from '../src/features/input/index.js';
import {
  PDF_SANDBOX_CHILD,
  PDF_SANDBOX_EXIT_CODES,
  buildSandboxArgs,
  createPdfSandboxRunner,
  permissionFlag,
} from '../src/features/input/sandboxed-pdf-inspection.js';

const NET_SCOPE = process.allowedNodeEnvironmentFlags.has('--allow-net');
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const fixtureDir = realpathSync(mkdtempSync(join(tmpdir(), 'pdf-sandbox-test-')));
test.after(() => rmSync(fixtureDir, { recursive: true, force: true }));

function fixtureChild(name, source, { env } = {}) {
  const path = join(fixtureDir, `${name}.mjs`);
  writeFileSync(path, source);
  if (env && Object.keys(env).length > 0) {
    const wrapperPath = join(fixtureDir, `${name}.wrapper.mjs`);
    const envAssignments = Object.entries(env)
      .map(([key, value]) => `process.env[${JSON.stringify(key)}] = ${JSON.stringify(String(value))};`)
      .join('\n');
    // Keep the fixture in one permitted file. A static import would run before
    // these assignments, while a dynamic import would need a second read grant.
    writeFileSync(wrapperPath, `${envAssignments}\n${source}\n`);
    return wrapperPath;
  }
  return path;
}

function buildPdf(objects, { trailerExtra = '' } = {}) {
  let body = '%PDF-1.7\n%\xe2\xe3\xcf\xd3\n';
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailerExtra} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}
const catalog = (extra = '') => `<< /Type /Catalog /Pages 2 0 R ${extra} >>`;
const pages = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
const page = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>';
const VALID = buildPdf([catalog(), pages, page]);
const JAVASCRIPT = buildPdf([catalog('/OpenAction << /S /JavaScript /JS (synthetic) >>'), pages, page]);
const ENCRYPTED = buildPdf([catalog(), pages, page], { trailerExtra: '/Encrypt 9 0 R' });

const VALID_JSON = JSON.stringify({ ok: true, pageCount: 1, objectStreamCount: 0, pdfVersion: '1.7' });

// Runs a child with the production flag builder, an empty environment and optional stdin.
function runSandboxed(entry, { readPaths = [entry], input = Buffer.alloc(0), args } = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, args ?? buildSandboxArgs({ entry, readPaths }), { env: {}, stdio: ['pipe', 'pipe', 'pipe'], cwd: fixtureDir });
    const out = [];
    child.stdout.on('data', chunk => out.push(chunk));
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('close', (code, signal) => resolve({ code, signal, stdout: Buffer.concat(out).toString('utf8') }));
    child.stdin.end(input);
  });
}

async function rejectsWith(promise, code) {
  let caught;
  try { await promise; } catch (error) { caught = error; }
  assert.ok(caught, `expected ${code}`);
  assert.equal(caught.code, code);
  return caught;
}

function safeMessage(error) {
  assert.ok(error.message.length > 0 && error.message.length < 100);
  for (const leak of ['ENOENT', 'EACCES', 'ERR_', fixtureDir, repoRoot, 'node:', 'SIG']) {
    assert.equal(error.message.includes(leak), false, `message leaks ${leak}`);
  }
}

test('sandbox flags: the permission flag is detected for the running Node, with the older name as fallback', () => {
  assert.equal(permissionFlag(), '--permission');
  assert.equal(permissionFlag(new Set(['--experimental-permission'])), '--experimental-permission');
  assert.equal(permissionFlag(new Set()), null);
  assert.throws(() => buildSandboxArgs({ entry: PDF_SANDBOX_CHILD.entry, readPaths: [], flags: new Set() }), /permission model/);
  assert.throws(() => buildSandboxArgs({
    entry: PDF_SANDBOX_CHILD.entry,
    readPaths: [],
    flags: new Set(['--permission']),
  }), /network permission controls/);
  const args = buildSandboxArgs({ entry: PDF_SANDBOX_CHILD.entry, readPaths: PDF_SANDBOX_CHILD.readPaths });
  assert.equal(args[0], '--permission');
  assert.ok(args.includes('--max-old-space-size=128'));
  assert.ok(args.includes('--disallow-code-generation-from-strings'));
  assert.equal(args.at(-1), PDF_SANDBOX_CHILD.entry);
  // Only file grants for the child entry and its two imports. No other --allow-* flag.
  const grants = args.filter(arg => arg.startsWith('--allow-'));
  assert.deepEqual(grants, PDF_SANDBOX_CHILD.readPaths.map(path => `--allow-fs-read=${path}`));
  assert.equal(grants.length, 3);
  assert.throws(() => buildSandboxArgs({ entry: 'relative.mjs', readPaths: [] }), /absolute/);
  assert.throws(() => buildSandboxArgs({ entry: '/tmp/a,b.mjs', readPaths: [] }), /commas/);
  assert.throws(() => buildSandboxArgs({ entry: PDF_SANDBOX_CHILD.entry, maxOldSpaceMb: 1 }), /maxOldSpaceMb/);
});

test('sandbox denials: a probe child with the production flags cannot read, write, spawn, start workers, load addons, use WASI or generate code', async () => {
  process.env.PDF_SANDBOX_TEST_SENTINEL = 'parent-only-value';
  const probe = fixtureChild('probe', `
    import { readFileSync, writeFileSync } from 'node:fs';
    const results = {};
    const attempt = async (name, fn) => {
      try { await fn(); results[name] = 'allowed'; } catch (error) { results[name] = error.code ?? error.name; }
    };
    await attempt('readRepoFile', () => readFileSync(${JSON.stringify(join(repoRoot, 'package.json'))}));
    await attempt('readInspector', () => readFileSync(${JSON.stringify(join(repoRoot, 'src/features/input/pdf-inspection.js'))}));
    await attempt('readSystemFile', () => readFileSync('/etc/hosts'));
    await attempt('writeTemp', () => writeFileSync(${JSON.stringify(join(fixtureDir, 'written.txt'))}, 'x'));
    await attempt('childProcess', async () => (await import('node:child_process')).spawnSync(process.execPath, ['-v']));
    await attempt('worker', async () => { const { Worker } = await import('node:worker_threads'); new Worker('1', { eval: true }); });
    await attempt('addon', () => process.dlopen({ exports: {} }, ${JSON.stringify(join(fixtureDir, 'missing.node'))}));
    await attempt('wasi', async () => { const { WASI } = await import('node:wasi'); new WASI({ version: 'preview1' }); });
    await attempt('codeGeneration', () => new Function('return 1')());
    if (${NET_SCOPE}) {
      await attempt('network', async () => {
        const net = await import('node:net');
        await new Promise((resolve, reject) => {
          const socket = net.connect({ host: '127.0.0.1', port: 9 });
          socket.once('connect', () => { socket.destroy(); resolve(); });
          socket.once('error', reject);
        });
      });
    }
    results.permissionActive = typeof process.permission?.has === 'function';
    results.envKeys = Object.keys(process.env).filter(key => key !== '__CF_USER_TEXT_ENCODING');
    process.stdout.write(JSON.stringify(results));
  `);
  try {
    const { code, stdout } = await runSandboxed(probe);
    assert.equal(code, 0);
    const results = JSON.parse(stdout);
    for (const name of ['readRepoFile', 'readInspector', 'readSystemFile', 'writeTemp', 'childProcess', 'worker', 'wasi']) {
      assert.equal(results[name], 'ERR_ACCESS_DENIED', name);
    }
    assert.ok(['ERR_DLOPEN_DISABLED', 'ERR_ACCESS_DENIED'].includes(results.addon), `addon: ${results.addon}`);
    assert.equal(results.codeGeneration, 'EvalError');
    assert.equal(results.network, 'ERR_ACCESS_DENIED');
    assert.equal(results.permissionActive, true);
    assert.deepEqual(results.envKeys, [], 'no parent environment reaches the child');
  } finally {
    delete process.env.PDF_SANDBOX_TEST_SENTINEL;
  }
});

test('sandbox denials: the supported Node runtime exposes the network permission scope', () => {
  assert.equal(NET_SCOPE, true);
});

test('child self-check: the real child refuses to parse without the permission model or with an extra grant', async () => {
  const { entry, readPaths } = PDF_SANDBOX_CHILD;
  const withoutPermission = await runSandboxed(entry, { input: VALID, args: [entry] });
  assert.equal(withoutPermission.code, PDF_SANDBOX_EXIT_CODES.sandboxInactive);
  assert.equal(withoutPermission.stdout, '');
  const base = buildSandboxArgs({ entry, readPaths });
  for (const extra of ['--allow-child-process', '--allow-worker', '--allow-wasi', '--allow-addons', '--allow-fs-write=/', `--allow-fs-write=${PDF_SANDBOX_CHILD.directory}`, '--allow-fs-read=/', `--allow-fs-read=${PDF_SANDBOX_CHILD.directory}`, `--allow-fs-read=${join(PDF_SANDBOX_CHILD.directory, '..')}`, ...(NET_SCOPE ? ['--allow-net'] : [])]) {
    const result = await runSandboxed(entry, { input: VALID, args: [...base.slice(0, -1), extra, entry] });
    assert.equal(result.code, PDF_SANDBOX_EXIT_CODES.sandboxInactive, extra);
    assert.equal(result.stdout, '', extra);
  }
  const ok = await runSandboxed(entry, { input: VALID, args: base });
  assert.equal(ok.code, 0);
  assert.deepEqual(JSON.parse(ok.stdout), JSON.parse(VALID_JSON));
});

test('child input cap: more than 15 MiB on stdin exits without a result', async () => {
  const { entry, readPaths } = PDF_SANDBOX_CHILD;
  const result = await runSandboxed(entry, { readPaths, input: Buffer.alloc(MAX_DOCUMENT_BYTES + 1, 0x20) });
  assert.equal(result.code, PDF_SANDBOX_EXIT_CODES.inputTooLarge);
  assert.equal(result.stdout, '');
});

test('sandboxed inspector: results and rejections match in-process inspectPdf', async () => {
  const inspector = createSandboxedPdfInspector();
  try {
    assert.deepEqual(await inspector.inspect(VALID), inspectPdf(VALID));
    for (const [bytes, code] of [
      [JAVASCRIPT, 'PDF_ACTIVE_CONTENT'],
      [ENCRYPTED, 'PDF_PASSWORD_REQUIRED'],
      [Buffer.from('%PDF-1.7\nno trailer'), 'PDF_STRUCTURE_INVALID'],
    ]) {
      assert.throws(() => inspectPdf(bytes), { code });
      const error = await rejectsWith(inspector.inspect(bytes), code);
      assert.ok(error instanceof DocumentIntakeError);
      safeMessage(error);
    }
    await rejectsWith(inspector.inspect(Buffer.alloc(MAX_DOCUMENT_BYTES + 1)), 'FILE_TOO_LARGE');
    await rejectsWith(inspector.inspect('not bytes'), 'INVALID_BYTES');
  } finally {
    inspector.close();
  }
});

test('sandboxed inspector: the child gets an empty environment', async () => {
  process.env.PDF_SANDBOX_TEST_SENTINEL = 'parent-only-value';
  const entry = fixtureChild('env-check', `
    const keys = Object.keys(process.env).filter(key => key !== '__CF_USER_TEXT_ENCODING');
    if (keys.length) process.exit(1);
    process.stdout.write(${JSON.stringify(VALID_JSON)});
  `);
  const runner = createPdfSandboxRunner({ entry, readPaths: [entry] });
  try {
    assert.equal((await runner.inspect(VALID)).pageCount, 1);
  } finally {
    delete process.env.PDF_SANDBOX_TEST_SENTINEL;
    runner.close();
  }
});

test('sandboxed inspector: timeout kills the child with SIGKILL and fails closed', async () => {
  const entry = fixtureChild('hang', 'for (;;) {}');
  const events = [];
  const runner = createPdfSandboxRunner({ entry, readPaths: [entry], limits: { timeoutMs: 300 }, onEvent: event => events.push(event) });
  const started = Date.now();
  const error = await rejectsWith(runner.inspect(VALID), 'PDF_INSPECTION_FAILED');
  assert.ok(Date.now() - started < 3000);
  assert.equal(error.statusCode, 422);
  safeMessage(error);
  assert.equal(events.at(-1).reason, 'timeout');
  assert.equal(events.at(-1).signal, 'SIGKILL');
  assert.equal(runner.stats().active, 0);
  runner.close();
});

test('sandboxed inspector: oversized output is cut off and fails closed', async () => {
  const entry = fixtureChild('spam', `process.stdout.write(${JSON.stringify(VALID_JSON)} + ' '.repeat(1024 * 1024));`);
  const events = [];
  const runner = createPdfSandboxRunner({ entry, readPaths: [entry], onEvent: event => events.push(event) });
  await rejectsWith(runner.inspect(VALID), 'PDF_INSPECTION_FAILED');
  assert.equal(events.at(-1).reason, 'output_too_large');
  runner.close();
});

test('sandboxed inspector: crashes, non-zero exits and malformed output are never clean', async () => {
  const cases = {
    'clean-then-exit-1': `process.stdout.write(${JSON.stringify(VALID_JSON)}); process.exitCode = 1;`,
    'clean-then-abort': `process.stdout.write(${JSON.stringify(VALID_JSON)}, () => process.abort());`,
    'exit-3': 'process.exit(3);',
    'throws': 'throw new Error("synthetic crash");',
    'not-json': 'process.stdout.write("not json");',
    'empty': '',
    'zero-pages': `process.stdout.write(JSON.stringify({ ok: true, pageCount: 0, objectStreamCount: 0, pdfVersion: '1.7' }));`,
    'extra-key': `process.stdout.write(JSON.stringify({ ok: true, pageCount: 1, objectStreamCount: 0, pdfVersion: '1.7', note: 'x' }));`,
    'bad-version': `process.stdout.write(JSON.stringify({ ok: true, pageCount: 1, objectStreamCount: 0, pdfVersion: '<script>' }));`,
    'unknown-code': `process.stdout.write(JSON.stringify({ ok: false, code: 'PDF_LOOKS_FINE' }));`,
    'array': 'process.stdout.write("[]");',
    'out-of-memory': 'const keep = []; for (;;) keep.push({ a: Math.random(), b: [1, 2, 3] });',
  };
  for (const [name, source] of Object.entries(cases)) {
    const entry = fixtureChild(name, source);
    const runner = createPdfSandboxRunner({ entry, readPaths: [entry], limits: { maxOldSpaceMb: 16, timeoutMs: 4000 } });
    const error = await rejectsWith(runner.inspect(VALID), 'PDF_INSPECTION_FAILED');
    assert.equal(error.retryable, false, name);
    safeMessage(error);
    runner.close();
  }
});

test('sandboxed inspector: spawn errors and an inactive sandbox are retryable and unavailable, never clean', async () => {
  const missing = join(fixtureDir, 'no-such-directory', 'child.mjs');
  const runner = createPdfSandboxRunner({ entry: missing, readPaths: [missing] });
  const spawnError = await rejectsWith(runner.inspect(VALID), 'PDF_INSPECTION_UNAVAILABLE');
  assert.equal(spawnError.statusCode, 503);
  assert.equal(spawnError.retryable, true);
  safeMessage(spawnError);
  runner.close();

  const entry = fixtureChild('inactive', `process.exit(${PDF_SANDBOX_EXIT_CODES.sandboxInactive});`);
  const events = [];
  const inactive = createPdfSandboxRunner({ entry, readPaths: [entry], onEvent: event => events.push(event) });
  await rejectsWith(inactive.inspect(VALID), 'PDF_INSPECTION_UNAVAILABLE');
  assert.equal(events.at(-1).reason, 'sandbox_inactive');
  inactive.close();
});

test('sandboxed inspector: concurrency is bounded, a full queue is refused with a retryable code, close fails closed', async () => {
  const validJsonB64 = Buffer.from(VALID_JSON, 'utf8').toString('base64');
  const slow = fixtureChild(
    'slow',
    "setTimeout(() => process.stdout.write(Buffer.from(process.env.VALID_JSON_B64 ?? '', 'base64').toString('utf8')), 150);",
    { env: { VALID_JSON_B64: validJsonB64 } },
  );
  const runner = createPdfSandboxRunner({ entry: slow, readPaths: [slow], limits: { maxConcurrent: 2, maxQueued: 10 } });
  let peak = 0;
  const sampler = setInterval(() => { peak = Math.max(peak, runner.stats().active); }, 5);
  const results = await Promise.all(Array.from({ length: 6 }, () => runner.inspect(VALID)));
  clearInterval(sampler);
  assert.equal(results.length, 6);
  assert.ok(results.every(result => result.pageCount === 1));
  assert.ok(peak >= 1 && peak <= 2, `peak ${peak}`);
  runner.close();

  const hang = fixtureChild('hang-queue', 'setInterval(() => {}, 1000);');
  const full = createPdfSandboxRunner({ entry: hang, readPaths: [hang], limits: { maxConcurrent: 1, maxQueued: 1, timeoutMs: 10_000 } });
  // Settled with a handler attached now, so close() does not leave an unhandled rejection.
  const running = full.inspect(VALID).then(() => null, error => error);
  const queued = full.inspect(VALID).then(() => null, error => error);
  const refused = await rejectsWith(full.inspect(VALID), 'PDF_INSPECTION_BUSY');
  assert.equal(refused.statusCode, 429);
  assert.equal(refused.retryable, true);
  assert.deepEqual(full.stats(), { active: 1, queued: 1, closed: false });
  full.close();
  assert.equal((await running)?.code, 'PDF_INSPECTION_UNAVAILABLE');
  assert.equal((await queued)?.code, 'PDF_INSPECTION_UNAVAILABLE');
  await rejectsWith(full.inspect(VALID), 'PDF_INSPECTION_UNAVAILABLE');
  assert.equal(full.stats().active, 0);
});

test('sandbox error codes are registered with the statuses the runner returns', () => {
  assert.deepEqual(ANALYSIS_ERROR_CODES.PDF_INSPECTION_FAILED, { httpStatus: 422, category: 'request', retryable: false });
  assert.deepEqual(ANALYSIS_ERROR_CODES.PDF_INSPECTION_BUSY, { httpStatus: 429, category: 'capacity', retryable: true });
  assert.deepEqual(ANALYSIS_ERROR_CODES.PDF_INSPECTION_UNAVAILABLE, { httpStatus: 503, category: 'configuration', retryable: true });
});

const consent = (overrides = {}) => ({
  id: 'consent-1',
  householdId: 'household-1',
  subjectAdultId: 'adult-1',
  purpose: 'document_processing',
  status: 'granted',
  expiresAt: '2026-09-19T12:00:00.000Z',
  revokedAt: null,
  scopes: [{ resourceType: 'document', action: 'collect', dataCategory: 'insurance_document' }],
  ...overrides,
});
const upload = {
  householdId: 'household-1',
  caseId: 'case-1',
  uploadedByAdultId: 'adult-1',
  consentGrantId: 'consent-1',
  logicalDocumentId: 'policy-a',
  version: 1,
  documentKind: 'policy_schedule',
  filename: 'policy.pdf',
  mimeType: 'application/pdf',
  bytes: VALID,
};

function trackedStorage() {
  const storage = createFixtureMemoryByteStorage();
  let puts = 0;
  return { puts: () => puts, storage: Object.freeze({ ...storage, mode: storage.mode, protection: storage.protection, async put(input) { puts += 1; return storage.put(input); } }) };
}

test('intake: an asynchronous inspection failure stores nothing', async () => {
  const { storage, puts } = trackedStorage();
  const service = createDocumentIntakeService({
    repository: createMemoryDocumentRepository({ consents: [consent()] }),
    storage,
    mode: 'fixture',
    now: () => new Date('2026-09-18T12:00:00.000Z'),
    inspectFile: async () => { throw Object.assign(new Error('x'), { code: 'PDF_INSPECTION_FAILED' }); },
  });
  await rejectsWith(service.intake(upload), 'PDF_INSPECTION_FAILED');
  assert.equal(puts(), 0);
});

test('intake: consent revoked while the inspection runs stores nothing', async () => {
  const { storage, puts } = trackedStorage();
  const repository = createMemoryDocumentRepository({ consents: [consent()] });
  let calls = 0;
  const revoking = Object.freeze({
    ...repository,
    async getConsent(id) {
      calls += 1;
      const value = await repository.getConsent(id);
      return calls === 1 ? value : { ...value, status: 'revoked', revokedAt: '2026-09-18T12:00:00.000Z' };
    },
  });
  const inspector = createSandboxedPdfInspector();
  try {
    const service = createDocumentIntakeService({
      repository: revoking,
      storage,
      mode: 'fixture',
      now: () => new Date('2026-09-18T12:00:00.000Z'),
      inspectFile: validated => inspector.inspect(validated.bytes),
    });
    await rejectsWith(service.intake(upload), 'ACTIVE_CONSENT_REQUIRED');
    assert.equal(puts(), 0);
    assert.equal(calls, 2);
  } finally {
    inspector.close();
  }
});
