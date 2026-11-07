// Retention sweep (S3). DRY RUN by default: prints candidate counts and changes nothing. Usage:
//   node --env-file-if-exists=.env.local scripts/retention-sweep.mjs [--apply] [--allow-development-key]
// Periods come from RETENTION_* variables (src/server/config.js readRetentionConfig); an unset period is not scheduled. Needs
// DATABASE_URL. A dry run only counts rows and needs no encryption key; --apply needs a real DATA_ENCRYPTION_KEY_BASE64 (--allow-development-key lifts that for a local database).
// Prints counts only, never an id, name or value. Document bytes of erased cases are removed by the running server's document
// worker on its next sweep (this script has no storage access). Periods are placeholders, FOR LEGAL REVIEW.
import { createPostgresPool, postgresPoolOptionsFromEnv } from '../src/backend/database/postgres/index.js';
import { createDatabase } from '../src/backend/database/postgres/db.js';
import { createBackendServices } from '../src/backend/services/index.js';
import { createRetentionService } from '../src/backend/services/retention-service.js';
import { readRetentionConfig } from '../src/server/config.js';
import { readDataEncryptionConfig } from '../src/backend/security/column-crypto.js';

const args = process.argv.slice(2);
if (args.some(arg => !['--apply', '--allow-development-key'].includes(arg))) {
  process.stderr.write('Unknown option. Use --apply and --allow-development-key.\n');
  process.exit(2);
}
const apply = args.includes('--apply');
let pool;
try {
  const retention = readRetentionConfig(process.env);
  pool = createPostgresPool(postgresPoolOptionsFromEnv(process.env));
  const database = createDatabase(pool);
  let sweep;
  if (apply) {
    const env = args.includes('--allow-development-key') ? process.env : { ...process.env, DATA_ENCRYPTION_REQUIRED: 'true' };
    readDataEncryptionConfig(env);
    const services = createBackendServices(database, { env });
    sweep = createRetentionService({ database, erasure: services.erasure, appEvents: services.appEvents, userData: services.userDataRepository, documents: services.documents, retention });
  } else {
    // Dry run: counts only, through the database. Nothing is erased or sealed, so no service (and no key) is needed.
    sweep = createRetentionService({ database, erasure: null, appEvents: null, userData: null, documents: null, retention });
  }
  process.stdout.write(`${JSON.stringify(await sweep.sweep({ apply }), null, 2)}\n`);
} catch (error) {
  process.stderr.write(`Retention sweep failed (${typeof error?.code === 'string' ? error.code : 'UNKNOWN'}).\n`);
  process.exitCode = 1;
} finally {
  await pool?.end();
}
