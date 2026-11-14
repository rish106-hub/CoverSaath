// Live-run launcher (docs/runbooks/live-run.md). Loads .env.local (provider keys) exactly like `npm run dev`, then
// points the app at a disposable local database, the local FSS stub and clamd with the P0 flags on.
// Prints nothing from the env file. Run from the repo root:
//   LIVE_RUN_BOOTSTRAP_TOKEN=<32+ chars> LIVE_RUN_ENCRYPTION_KEY_BASE64=<32 bytes, base64> \
//   node scripts/live-run/launch.mjs initdb|server|worker
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

const role = process.argv[2];
const target = { server: 'src/server/server.js', worker: 'src/server/worker.js', initdb: 'scripts/database.mjs' }[role];
if (!target) { console.error('usage: node scripts/live-run/launch.mjs initdb|server|worker'); process.exit(2); }
const token = process.env.LIVE_RUN_BOOTSTRAP_TOKEN;
const key = process.env.LIVE_RUN_ENCRYPTION_KEY_BASE64;
if (!token || token.length < 32 || !key) { console.error('Set LIVE_RUN_BOOTSTRAP_TOKEN (32+ chars) and LIVE_RUN_ENCRYPTION_KEY_BASE64.'); process.exit(2); }
const databaseUrl = process.env.LIVE_RUN_DATABASE_URL ?? 'postgres://coversaath@localhost:54329/coversaath_live';
// Local only: refuse any database that is not on loopback, so initdb can never migrate a hosted database.
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(databaseUrl).hostname)) { console.error('LIVE_RUN_DATABASE_URL must be a loopback database.'); process.exit(2); }
const fssUrl = process.env.LIVE_RUN_FSS_URL ?? 'http://127.0.0.1:3999';
const fssKey = process.env.LIVE_RUN_FSS_URL ? process.env.LIVE_RUN_FSS_API_KEY : 'local-stub-key-not-real';
if (!fssKey) { console.error('Set LIVE_RUN_FSS_API_KEY with LIVE_RUN_FSS_URL.'); process.exit(2); }

if (existsSync('.env.local')) process.loadEnvFile('.env.local');
delete process.env.DATABASE_SSL_CA_PATH; // a hosted-database setting; the live run uses local PostgreSQL only
Object.assign(process.env, {
  DATABASE_URL: databaseUrl, MIGRATION_DATABASE_URL: databaseUrl,
  KNOWVIA_BOOTSTRAP_TOKEN: token, DOCUMENT_ENCRYPTION_KEY_BASE64: key,
  PORT: '8787', HOST: '127.0.0.1', NODE_ENV: 'development',
  HOLDINGS_ENABLED: 'true', POLICY_FACTS_ENABLED: 'true', REFERENCE_DATA_ENABLED: 'true', SARVAM_OCR_ENABLED: 'true',
  MEMORY_ENABLED: 'true', CHAT_MODEL_ENABLED: 'true', CHAT_ENABLED: 'true', DOCUMENT_READBACK_ENABLED: 'true',
  REFERENCE_DATA_BASE_URL: fssUrl, REFERENCE_DATA_API_KEY: fssKey,
  DOCUMENT_SCAN_MODE: 'clamd', CLAMD_HOST: '127.0.0.1', CLAMD_PORT: '3310',
  ANALYTICS_ENABLED: 'false', RATE_LIMIT_BACKEND: 'database',
});
const child = spawn(process.execPath, [resolve(target)], { env: process.env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', code => process.exit(code ?? 1));
