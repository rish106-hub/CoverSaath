// Applies pending PostgreSQL migrations to DATABASE_URL and validates the schema.
// Run with a direct or session-mode connection: the runner holds a session advisory lock.
import { createPostgresPool, postgresPoolOptionsFromEnv, runPostgresMigrations, validatePostgresSchema } from '../src/backend/database/postgres/index.js';

const pool = createPostgresPool(postgresPoolOptionsFromEnv());
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
