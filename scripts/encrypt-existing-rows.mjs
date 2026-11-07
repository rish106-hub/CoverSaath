// Seals plaintext rows written before column encryption (ADR 0013). Usage:
//   node --env-file-if-exists=.env.local scripts/encrypt-existing-rows.mjs [--dry-run] [--rotate] [--unseal [--include-e1] --i-understand-this-writes-plaintext] [--batch=200] [--allow-development-key]
// Needs DATABASE_URL (run it as the table owner) and a real DATA_ENCRYPTION_KEY_BASE64: the key is required even outside production,
// because this script writes durable data and the development key is public. --allow-development-key lifts that for a local
// throwaway database only (a DATABASE_URL that is not on this machine is refused regardless). Prints counts only,
// never a stored value. Idempotent: a second run changes 0 rows. --dry-run changes nothing. --rotate also re-seals values
// sealed under a previous key id (set DATA_ENCRYPTION_KEY_ID to the new id and keep the old key in
// DATA_ENCRYPTION_PREVIOUS_KEYS_JSON until the run finishes). --unseal is the reverse direction, for rolling the code back to a
// build older than the sealed columns (docs/runbooks/migration-030-rollback.md): it writes readable data back, so it also needs
// --i-understand-this-writes-plaintext (not with --dry-run, which only counts). By default it unseals only the columns sealed by
// migration 030 (D2); --include-e1 also unseals the earlier ones (names, e-mail, text, answers), which a build from before D2 can
// still read. After an unseal never set DATA_ENCRYPTION_LEGACY_PLAINTEXT=false: that refuses plaintext on read.
// Rows with a value that cannot be decrypted are left as they are and counted in "unreadable"; the exit code is then 3.
import {
  createPostgresPool, postgresPoolOptionsFromEnv,
} from '../src/backend/database/postgres/index.js';
import { createDatabase } from '../src/backend/database/postgres/db.js';
import { createColumnCrypto, readDataEncryptionConfig } from '../src/backend/security/column-crypto.js';
import { encryptExistingRows } from '../src/backend/security/column-backfill.js';

const args = process.argv.slice(2);
const known = new Set(['--dry-run', '--rotate', '--unseal', '--include-e1', '--i-understand-this-writes-plaintext', '--allow-development-key']);
const batchArg = args.find(arg => arg.startsWith('--batch='));
if (args.some(arg => !known.has(arg) && arg !== batchArg)) {
  process.stderr.write('Unknown option. Use --dry-run, --rotate, --unseal, --include-e1, --i-understand-this-writes-plaintext, --batch=N, --allow-development-key.\n');
  process.exit(2);
}

if (args.includes('--unseal') && (args.includes('--rotate') || (!args.includes('--dry-run') && !args.includes('--i-understand-this-writes-plaintext')))) {
  process.stderr.write('--unseal writes plaintext: it needs --i-understand-this-writes-plaintext (or --dry-run) and cannot be combined with --rotate.\n');
  process.exit(2);
}

if (args.includes('--include-e1') && !args.includes('--unseal')) {
  process.stderr.write('--include-e1 only applies to --unseal.\n');
  process.exit(2);
}
if (args.includes('--unseal') && process.env.DATA_ENCRYPTION_LEGACY_PLAINTEXT === 'false') {
  process.stderr.write('Warning: DATA_ENCRYPTION_LEGACY_PLAINTEXT=false refuses plaintext on read; unset it before running code on unsealed data.\n');
}

let pool;
try {
  // Without --allow-development-key the key is required whatever NODE_ENV says, so a missing key stops the run before any write.
  const env = args.includes('--allow-development-key') ? process.env : { ...process.env, DATA_ENCRYPTION_REQUIRED: 'true' };
  const crypto = createColumnCrypto(readDataEncryptionConfig(env));
  if (crypto.developmentKey) process.stderr.write('Warning: sealing with the public development key. Local throwaway data only.\n');
  pool = createPostgresPool(postgresPoolOptionsFromEnv(process.env));
  const database = createDatabase(pool);
  const result = await encryptExistingRows({
    database, crypto, dryRun: args.includes('--dry-run'), rotate: args.includes('--rotate'), unseal: args.includes('--unseal'), includeE1: args.includes('--include-e1'),
    batchSize: batchArg ? Number(batchArg.slice('--batch='.length)) : 200,
  });
  process.stdout.write(`${JSON.stringify({ ...result, keyId: crypto.keyId, developmentKey: crypto.developmentKey }, null, 2)}\n`);
  if (result.unreadable > 0) {
    process.stderr.write(`${result.unreadable} row(s) hold a value that could not be decrypted (wrong key id or damaged) and were left as they are.\n`);
    process.exitCode = 3;
  }
} catch (error) {
  process.stderr.write(`Column encryption backfill failed (${typeof error?.code === 'string' ? error.code : 'UNKNOWN'}).\n`);
  if (error?.code === 'BACKFILL_LEGACY_PLAINTEXT_REFUSED') process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
} finally {
  await pool?.end();
}
