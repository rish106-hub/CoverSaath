// Applies pending PostgreSQL migrations and validates the schema, as MIGRATION_DATABASE_URL when set, else DATABASE_URL.
// Run with a direct or session-mode connection: the runner holds a session advisory lock.
import { createPostgresPool, migrationPoolOptionsFromEnv, runPostgresMigrations, validatePostgresSchema } from '../src/backend/database/postgres/index.js';

const pool = createPostgresPool(migrationPoolOptionsFromEnv());
try {
  const applied = await runPostgresMigrations(pool);
  const schema = await validatePostgresSchema(pool);
  process.stdout.write(`${JSON.stringify({ applied, ...schema }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error.code ?? 'ERROR'}: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
