import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, openDatabase } from '../../src/backend/database/index.js';

// Test databases. Default: PGlite cloned from one migrated template per process (fast, isolated).
// With TEST_DATABASE_URL set (CI service container, Postgres 16), every test gets its own schema in that
// server instead, which is what proves FOR UPDATE SKIP LOCKED and advisory locks across real connections.

let templatePromise = null;
const template = () => {
  templatePromise ??= (async () => {
    const base = await openDatabase({ pglite: true });
    const dump = await base.dumpTemplate();
    await base.close();
    return dump;
  })();
  return templatePromise;
};

export const usingRealPostgres = Boolean(process.env.TEST_DATABASE_URL);

export async function createTestDatabase() {
  if (usingRealPostgres) {
    const schema = `t_${randomUUID().replaceAll('-', '')}`;
    const admin = await createDatabase({ connectionString: process.env.TEST_DATABASE_URL, poolMax: 1 });
    await admin.exec(`CREATE SCHEMA ${schema}`);
    await admin.close();
    const database = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, schema, poolMax: 8 });
    const close = database.close.bind(database);
    database.close = async () => {
      await close();
      const cleaner = await createDatabase({ connectionString: process.env.TEST_DATABASE_URL, poolMax: 1 });
      await cleaner.exec(`DROP SCHEMA ${schema} CASCADE`);
      await cleaner.close();
    };
    return database;
  }
  return openDatabase({ pglite: true, loadDataDir: await template() });
}

/** A database persisted in a temp directory, for tests that restart the "server" against the same data. */
export async function createDurableTestDatabase() {
  const directory = mkdtempSync(join(tmpdir(), 'knowvia-pglite-'));
  const open = () => openDatabase({ pglite: true, dataDir: directory });
  return {
    directory,
    open,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

/** SQL helpers that keep test fixtures terse: `?` placeholders become $1..$n. */
const numbered = sql => { let index = 0; return sql.replace(/\?/g, () => `$${++index}`); };
export const sql = Object.freeze({
  run: (database, text, ...params) => database.run(numbered(text), params),
  get: (database, text, ...params) => database.one(numbered(text), params),
  all: (database, text, ...params) => database.query(numbered(text), params),
});
