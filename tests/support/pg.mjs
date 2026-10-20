// Test helpers for the S3.2 async database interface (design section 5). Builds on the isolated
// database harness in ./postgres.mjs: each freshDatabase() call clones the migrated template into
// a throwaway database that is dropped after the test.
//
//   test('name', postgresTestOptions(), async t => {
//     const { db, services } = await freshDatabase(t, { clock });
//   });
//
// `db.prepare(sql).get/all/run(...params)` is a test-only facade that returns Promises, for
// porting SQLite-shaped assertions. Application code uses db.one/many/run.
// Importing this module makes an unhandled rejection fail the test run: a missed `await` must not
// pass silently.
import assert from 'node:assert/strict';
import { createDatabase } from '../../src/backend/database/postgres/db.js';
import { createBackendServices } from '../../src/backend/services/index.js';
import { useTestDatabase } from './postgres.mjs';

export { postgresTestOptions, SKIP_REASON } from './postgres.mjs';

if (!globalThis.__coverSaathUnhandledRejectionHook) {
  globalThis.__coverSaathUnhandledRejectionHook = true;
  process.on('unhandledRejection', reason => {
    throw reason instanceof Error ? reason : new Error(`Unhandled rejection: ${String(reason)}`);
  });
}

function withPrepare(db) {
  const facade = Object.create(db);
  facade.prepare = sql => ({
    get: (...params) => db.one(sql, params),
    all: (...params) => db.many(sql, params),
    run: (...params) => db.run(sql, params),
  });
  return Object.freeze(facade);
}

/**
 * A fresh migrated database for one test: { db, services, handle }. `services` is built on first
 * use; until WP1-WP3 convert the repositories, only `services.audit` works on PostgreSQL.
 */
export async function freshDatabase(t, { clock, directory } = {}) {
  const handle = await useTestDatabase(t, directory ? { directory } : undefined);
  const db = withPrepare(createDatabase(handle.pool));
  let services;
  return {
    db,
    handle,
    get services() {
      services ??= createBackendServices(db, clock ? { clock } : {});
      return services;
    },
  };
}

/** Asserts that `promise` rejects with a driver error of `sqlstate` whose message matches. */
export async function assertDbError(promise, { sqlstate, message } = {}) {
  await assert.rejects(promise, error => {
    if (sqlstate !== undefined) assert.equal(error.code, sqlstate, `expected SQLSTATE ${sqlstate}, got ${error.code}`);
    if (message instanceof RegExp) assert.match(error.message, message);
    else if (typeof message === 'string') assert.ok(error.message.includes(message), `expected message to include ${message}`);
    return true;
  });
}
