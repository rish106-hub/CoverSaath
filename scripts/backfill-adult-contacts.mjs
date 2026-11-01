// Computes adult_users.contact_email_hash for adults created before migration 029 (ADR 0015). Usage:
//   node --env-file-if-exists=.env.local scripts/backfill-adult-contacts.mjs [--allow-development-key]
// Needs DATABASE_URL (the table owner) and a real DATA_ENCRYPTION_KEY_BASE64 (the hash key derives from it); --allow-development-key
// lifts that for a local throwaway database only. Prints counts only. Idempotent. An adult whose e-mail another adult already holds
// is skipped and counted, never merged.
import { createPostgresPool, postgresPoolOptionsFromEnv } from '../src/backend/database/postgres/index.js';
import { createDatabase } from '../src/backend/database/postgres/db.js';
import { createColumnCrypto, readDataEncryptionConfig } from '../src/backend/security/column-crypto.js';
import { UserDataRepository } from '../src/backend/repositories/user-data-repository.js';

const args = process.argv.slice(2);
if (args.some(arg => arg !== '--allow-development-key')) {
  process.stderr.write('Unknown option. Use --allow-development-key.\n');
  process.exit(2);
}
let pool;
try {
  const env = args.includes('--allow-development-key') ? process.env : { ...process.env, DATA_ENCRYPTION_REQUIRED: 'true' };
  const columnCrypto = createColumnCrypto(readDataEncryptionConfig(env));
  pool = createPostgresPool(postgresPoolOptionsFromEnv(process.env));
  const result = await new UserDataRepository(createDatabase(pool), { columnCrypto }).backfillContactHashes();
  process.stdout.write(`${JSON.stringify({ ...result, keyId: columnCrypto.keyId, developmentKey: columnCrypto.developmentKey }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`Contact hash backfill failed (${typeof error?.code === 'string' ? error.code : 'UNKNOWN'}).\n`);
  process.exitCode = 1;
} finally {
  await pool?.end();
}
