// Test stack: fake Sarvam + fake Gemini (in this process) and the real API server (child process) wired to them.
// The API child runs with a scrubbed environment (no real keys can leak in) and the egress guard preloaded.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { startFakeSarvamServer } from '../../fakes/fake-sarvam-server.mjs';
import { startFakeGeminiServer } from '../../fakes/fake-gemini-server.mjs';
import { startFakePostHogServer } from '../../fakes/fake-posthog-server.mjs';
import { loadSyntheticPack, buildSyntheticPdf } from '../../fixtures/policy-breakdown/synthetic-pack.mjs';

export const repoRoot = resolve(new URL('../../../', import.meta.url).pathname);
export const bootstrapToken = 'knowvia-e2e-bootstrap-token-000001';

export const freePort = () => new Promise((resolvePort, reject) => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolvePort(port)); });
  server.on('error', reject);
});

/** Starts fakes, loads the synthetic pack into them and spawns the API. Returns helpers and stop(). */
export async function startStack({ env = {}, pack = 'a', apiPort = null, posthogPort = 0, geminiPort = 0, sarvamPort = 0, staticDir = null } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'knowvia-e2e-'));
  const sarvam = await startFakeSarvamServer({ apiKey: 'e2e-dummy-sarvam-key', port: sarvamPort });
  const gemini = await startFakeGeminiServer({ pack, apiKey: 'e2e-dummy-gemini-key', port: geminiPort });
  const posthog = await startFakePostHogServer({ port: posthogPort });
  const loaded = loadSyntheticPack({ pack });
  sarvam.registerDocument(loaded);
  const port = apiPort ?? await freePort();
  const webPort = Number(process.env.E2E_WEB_PORT ?? 5273);
  const egressLog = join(directory, 'egress.log');
  const childEnv = {
    PATH: process.env.PATH, HOME: directory, NODE_ENV: 'test',
    KNOWVIA_BOOTSTRAP_TOKEN: bootstrapToken,
    PGLITE_DATA_DIR: join(directory, 'pglite'),
    DOCUMENT_STORAGE_PATH: join(directory, 'documents'),
    DOCUMENT_ENCRYPTION_KEY_BASE64: randomBytes(32).toString('base64'),
    DOCUMENT_SCAN_MODE: 'structural_only',
    API_RATE_LIMIT_PER_MINUTE: '100000',
    LLM_PROVIDER: 'google', GEMINI_API_KEY: 'e2e-dummy-gemini-key', LLM_MODEL: 'fake-gemini-model',
    BREAKDOWN_INPUT_USD_PER_MILLION: '0.3', BREAKDOWN_OUTPUT_USD_PER_MILLION: '2.5',
    BREAKDOWN_JOB_BUDGET_USD: '5', BREAKDOWN_TIMEOUT_MS: '20000',
    BREAKDOWN_LLM_BASE_URL: gemini.baseUrl,
    SARVAM_API_KEY: 'e2e-dummy-sarvam-key', SARVAM_BASE_URL: sarvam.baseUrl,
    SARVAM_DOWNLOAD_HOST_SUFFIXES: 'sarvam-fake.test',
    POSTHOG_TEST_UPSTREAM: posthog.origin,
    // The browser reaches the API through the E2E Vite proxy, which keeps the page's Host and Origin.
    ALLOWED_HOSTS: `127.0.0.1:${webPort},localhost:${webPort}`,
    ALLOWED_ORIGINS: `http://127.0.0.1:${webPort},http://localhost:${webPort}`,
    ...(staticDir ? { STATIC_DIR: staticDir } : {}),
    E2E_SARVAM_FAKE_ORIGIN: sarvam.origin, E2E_EGRESS_LOG: egressLog, E2E_API_PORT: String(port),
    ...env,
  };
  const child = spawn(process.execPath, ['--import', join(repoRoot, 'tests/e2e/helpers/egress-guard.mjs'), join(repoRoot, 'tests/e2e/helpers/api-launcher.mjs')], { cwd: repoRoot, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error(`API did not start:\n${output}`)), 20_000);
    child.stdout.on('data', () => { if (output.includes('E2E_API_READY')) { clearTimeout(timer); resolveReady(); } });
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`API exited early (${code}):\n${output}`)); });
  });
  const base = `http://127.0.0.1:${port}`;
  const call = async (path, { method = 'GET', body, idempotencyKey, token } = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: await response.json() };
  };
  return {
    base, port, call, sarvam, gemini, posthog, pack: loaded, directory, output: () => output,
    egressViolations: () => (existsSync(egressLog) ? readFileSync(egressLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []),
    async stop() {
      child.kill('SIGTERM');
      await new Promise(resolveExit => { if (child.exitCode !== null) resolveExit(); else { child.on('exit', resolveExit); setTimeout(() => { child.kill('SIGKILL'); resolveExit(); }, 3000); } });
      await sarvam.close(); await gemini.close(); await posthog.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

export async function syntheticPolicyPdf(pack) { return buildSyntheticPdf(pack); }

// ---- Journey helpers (HTTP only, per docs/api/policy-breakdown-api.md) ----
export async function bootstrapHousehold(stack, name = 'Kumar household') {
  const identity = await stack.call('/api/v1/households', { method: 'POST', token: bootstrapToken, body: { displayName: name, owner: { displayName: 'Ram Kumar' } } });
  if (identity.status !== 201) throw new Error(`bootstrap failed: ${JSON.stringify(identity.data)}`);
  return { token: identity.data.session.token, householdId: identity.data.household.id, adultId: identity.data.owner.id };
}

export const FAMILY = [
  { displayName: 'Sita Kumar', relationship: 'spouse', dateOfBirth: '1991-02-02' },
  { displayName: 'Luv Kumar', relationship: 'son', dateOfBirth: '2018-09-30' },
  { displayName: 'Kaushalya Devi', relationship: 'mother', dateOfBirth: '1962-07-21' },
];

export async function grantConsent(stack, who, purpose, scopes) {
  const grant = await stack.call('/api/v1/consents', { method: 'POST', token: who.token, body: { householdId: who.householdId, subjectAdultId: who.adultId, purpose, scopes } });
  if (grant.status !== 201) throw new Error(`consent failed: ${JSON.stringify(grant.data)}`);
  return grant.data.id;
}

export async function uploadPolicy(stack, who, bytes, filename = 'policy-pack.pdf') {
  const consentGrantId = await grantConsent(stack, who, 'document_processing', [{ resourceType: 'document', action: 'collect', dataCategory: 'insurance_document' }]);
  return stack.call(`/api/v1/households/${who.householdId}/documents`, { method: 'POST', token: who.token, body: { consentGrantId, documentKind: 'policy_wording', filename, mimeType: 'application/pdf', contentBase64: bytes.toString('base64') } });
}

export async function startBreakdown(stack, who, documentId, key = 'e2e-breakdown-key-0001') {
  const consentGrantId = await grantConsent(stack, who, 'coverage_reconstruction', [
    { resourceType: 'policy', action: 'derive', dataCategory: 'insurance_document' },
    { resourceType: 'document', action: 'share', dataCategory: 'insurance_document' },
  ]);
  const created = await stack.call(`/api/v1/households/${who.householdId}/policy-records`, { method: 'POST', token: who.token, idempotencyKey: key, body: { documentIds: [documentId], consentGrantId, modelPermission: true } });
  return { created, consentGrantId };
}

export async function pollJob(stack, who, jobId, { timeoutMs = 90_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await stack.call(`/api/v1/breakdown-jobs/${jobId}`, { token: who.token });
    if (['succeeded', 'failed', 'interrupted'].includes(job.data.status)) return job.data;
    if (Date.now() > deadline) throw new Error(`job ${jobId} still ${job.data.status} after ${timeoutMs} ms`);
    await new Promise(resolveWait => setTimeout(resolveWait, intervalMs));
  }
}
