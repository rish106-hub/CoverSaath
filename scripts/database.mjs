import { openDatabase, validateSchema } from '../src/backend/database/index.js';

// Migrates and validates the configured database. DATABASE_URL selects Postgres; without it the embedded
// PGlite database under PGLITE_DATA_DIR (default .local/pglite) is used, and never in production.
const database = await openDatabase();

try {
  const schema = await validateSchema(database);
  process.stdout.write(`${JSON.stringify({ driver: database.driver, ...schema }, null, 2)}\n`);
  if (!schema.valid) process.exitCode = 1;
} finally {
  await database.close();
}
