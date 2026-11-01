// Seals plaintext rows written before column encryption (ADR 0013). Usage:
//   node --env-file-if-exists=.env.local scripts/encrypt-existing-rows.mjs [--dry-run] [--rotate] [--batch=200]
// Needs DATABASE_URL (run it as the table owner) and, outside development, DATA_ENCRYPTION_KEY_BASE64. Prints counts only,
// never a stored value. Idempotent: a second run changes 0 rows. --dry-run changes nothing. --rotate also re-seals values
// sealed under a previous key id (set DATA_ENCRYPTION_KEY_ID to the new id and keep the old key in
// DATA_ENCRYPTION_PREVIOUS_KEYS_JSON until the run finishes).
import {
  createPostgresPool, postgresPoolOptionsFromEnv,
} from '../src/backend/database/postgres/index.js';
import { createDatabase } from '../src/backend/database/postgres/db.js';
import { createColumnCrypto, readDataEncryptionConfig } from '../src/backend/security/column-crypto.js';
import { encryptExistingRows } from '../src/backend/security/column-backfill.js';

const args = process.argv.slice(2);
const known = new Set(['--dry-run', '--rotate']);
const batchArg = args.find(arg => arg.startsWith('--batch='));
if (args.some(arg => !known.has(arg) && arg !== batchArg)) {
  process.stderr.write('Unknown option. Use --dry-run, --rotate, --batch=N.\n');
  process.exit(2);
}

let pool;
try {
  const crypto = createColumnCrypto(readDataEncryptionConfig(process.env));
  pool = createPostgresPool(postgresPoolOptionsFromEnv(process.env));
  const database = createDatabase(pool);
  const result = await encryptExistingRows({
    database, crypto, dryRun: args.includes('--dry-run'), rotate: args.includes('--rotate'),
    batchSize: batchArg ? Number(batchArg.slice('--batch='.length)) : 200,
  });
  process.stdout.write(`${JSON.stringify({ ...result, keyId: crypto.keyId, developmentKey: crypto.developmentKey }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`Column encryption backfill failed (${typeof error?.code === 'string' ? error.code : 'UNKNOWN'}).\n`);
  process.exitCode = 1;
} finally {
  await pool?.end();
}
