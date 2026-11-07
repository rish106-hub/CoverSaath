// db:init: applies the PostgreSQL migrations, then validates the schema. It connects with MIGRATION_DATABASE_URL (the
// migrator role, docs/runbooks/db-roles.md) when that is set, otherwise with DATABASE_URL.
// DATABASE_SSL_CA_PATH optionally names a PEM CA for a hosted database. Output never contains
// the connection string or driver text.
import {
  createPostgresPool, migrationPoolOptionsFromEnv, runPostgresMigrations, validatePostgresSchema,
} from '../src/backend/database/postgres/index.js';

let options;
try {
  options = migrationPoolOptionsFromEnv(process.env);
} catch (error) {
  process.stderr.write(`${error.code === 'DATABASE_URL_REQUIRED'
    ? 'DATABASE_URL is required: set it to a postgres:// URL before running db:init.'
    : `Database configuration is invalid (${error.code ?? 'UNKNOWN'}).`}\n`);
  process.exit(1);
}

const pool = createPostgresPool(options);
try {
  const applied = await runPostgresMigrations(pool);
  const schema = await validatePostgresSchema(pool);
  process.stdout.write(`${JSON.stringify({ applied, ...schema }, null, 2)}\n`);
  if (!schema.valid) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`Database initialisation failed (${typeof error?.code === 'string' ? error.code : 'UNKNOWN'}).\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
