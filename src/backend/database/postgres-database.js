import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';

// Async Postgres adapter. One interface over two drivers:
//   - `pg` Pool when a connection string is configured (Cloud SQL Postgres 16+).
//   - PGlite (embedded Postgres, single connection) for tests and local development.
//
// Type parsing is identical in both drivers so repositories see the same JS values:
//   timestamptz -> ISO-8601 string (new Date(v).toISOString())
//   json/jsonb  -> raw JSON text (callers JSON.parse *_json columns)
//   int8        -> Number when safe, otherwise the decimal string
//
// Inside `transaction(fn)` every call on this adapter (and on `tx`) joins the transaction through
// AsyncLocalStorage, so repository code never has to thread a connection and PGlite cannot deadlock.

const OID = Object.freeze({ INT8: 20, JSON: 114, JSONB: 3802, TIMESTAMPTZ: 1184 });

const PARSERS = Object.freeze({
  [OID.TIMESTAMPTZ]: value => (value == null ? value : new Date(value).toISOString()),
  [OID.JSON]: value => value,
  [OID.JSONB]: value => value,
  [OID.INT8]: value => {
    if (value == null) return value;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : value;
  },
});

/** Keeps the message; moves the SQLSTATE out of `.code` so API and job error codes never leak driver codes. */
function normalizeError(error) {
  if (error && typeof error === 'object' && typeof error.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code)) {
    error.sqlState = error.code;
    try { delete error.code; } catch { /* non-configurable: leave as is */ }
  }
  return error;
}

function toResult(raw) {
  return { rows: raw.rows ?? [], rowCount: raw.rowCount ?? raw.affectedRows ?? 0 };
}

export function readDatabaseConfig(env = process.env) {
  const integer = (value, fallback) => {
    if (value === undefined || value === '') return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) throw new Error('Database numeric settings must be positive integers.');
    return parsed;
  };
  return Object.freeze({
    connectionString: env.DATABASE_URL || null,
    poolMax: integer(env.DATABASE_POOL_MAX, 10),
    statementTimeoutMs: integer(env.DATABASE_STATEMENT_TIMEOUT_MS, 15_000),
    pgliteDataDir: env.PGLITE_DATA_DIR || '.local/pglite',
    production: env.NODE_ENV === 'production',
  });
}

/**
 * @param options.connectionString  Postgres URL; selects the `pg` Pool driver.
 * @param options.pglite            true selects embedded PGlite.
 * @param options.dataDir           PGlite directory; omitted keeps the database in memory.
 * @param options.loadDataDir       PGlite template (Blob/File from dumpDataDir) to clone from; tests only.
 * @param options.schema            pg only: search_path for every connection (isolated test schemas).
 */
export async function createDatabase({
  connectionString = null,
  pglite = false,
  dataDir,
  loadDataDir,
  poolMax = 10,
  statementTimeoutMs = 15_000,
  schema = null,
} = {}) {
  if (!connectionString && !pglite) throw new TypeError('createDatabase needs a connectionString or pglite: true.');
  const storage = new AsyncLocalStorage();
  let driver;
  let closed = false;

  if (connectionString) {
    const pool = new pg.Pool({
      connectionString,
      max: poolMax,
      statement_timeout: statementTimeoutMs,
      options: schema ? `-c timezone=UTC -c search_path=${schema}` : '-c timezone=UTC',
      types: { getTypeParser: (oid, format) => PARSERS[oid] ?? pg.types.getTypeParser(oid, format) },
    });
    pool.on('error', () => { /* idle client errors must not crash the process; the next query reports them */ });
    driver = {
      kind: 'pg',
      async query(sql, params) { return toResult(await pool.query(sql, params)); },
      async exec(sql) { await pool.query(sql); },
      async connection() {
        const client = await pool.connect();
        return {
          query: async (sql, params) => toResult(await client.query(sql, params)),
          exec: async sql => { await client.query(sql); },
          release: () => client.release(),
        };
      },
      close: () => pool.end(),
    };
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    const db = new PGlite({ ...(dataDir ? { dataDir } : {}), ...(loadDataDir ? { loadDataDir } : {}), parsers: PARSERS });
    await db.waitReady;
    await db.exec("SET timezone = 'UTC'");
    // PGlite has one connection: serialise every statement and transaction through a promise chain.
    let tail = Promise.resolve();
    const acquire = () => {
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      const turn = tail.then(() => release);
      tail = tail.then(() => gate);
      return turn;
    };
    const direct = {
      query: async (sql, params) => toResult(await db.query(sql, params)),
      exec: async sql => { await db.exec(sql); },
    };
    driver = {
      kind: 'pglite',
      raw: db,
      async query(sql, params) { const release = await acquire(); try { return await direct.query(sql, params); } finally { release(); } },
      async exec(sql) { const release = await acquire(); try { await direct.exec(sql); } finally { release(); } },
      async connection() { const release = await acquire(); return { ...direct, release }; },
      close: () => db.close(),
    };
  }

  const scoped = connection => ({
    query: async (sql, params = []) => (await connection.query(sql, params).catch(error => { throw normalizeError(error); })).rows,
    one: async (sql, params = []) => (await connection.query(sql, params).catch(error => { throw normalizeError(error); })).rows[0] ?? null,
    run: async (sql, params = []) => connection.query(sql, params).catch(error => { throw normalizeError(error); }),
    exec: async sql => connection.exec(sql).catch(error => { throw normalizeError(error); }),
  });

  const context = () => {
    const store = storage.getStore();
    return store?.alive ? store : null;
  };

  const root = {
    driver: driver.kind,
    query: (sql, params = []) => {
      const tx = context();
      return tx ? tx.api.query(sql, params) : driver.query(sql, params).then(result => result.rows, error => { throw normalizeError(error); });
    },
    one: async (sql, params = []) => (await root.query(sql, params))[0] ?? null,
    run: (sql, params = []) => {
      const tx = context();
      return tx ? tx.api.run(sql, params) : driver.query(sql, params).catch(error => { throw normalizeError(error); });
    },
    exec: sql => {
      const tx = context();
      return tx ? tx.api.exec(sql) : driver.exec(sql).catch(error => { throw normalizeError(error); });
    },
    /** Runs `fn(tx)` atomically. Nested calls become savepoints. Any thrown error rolls back and rethrows. */
    async transaction(fn) {
      const outer = context();
      if (outer) {
        const name = `sp_${++outer.savepoints}`;
        await outer.api.exec(`SAVEPOINT ${name}`);
        try {
          const result = await fn(outer.api);
          await outer.api.exec(`RELEASE SAVEPOINT ${name}`);
          return result;
        } catch (error) {
          await outer.api.exec(`ROLLBACK TO SAVEPOINT ${name}`).catch(() => {});
          throw error;
        }
      }
      const connection = await driver.connection();
      const tx = { alive: true, savepoints: 0, api: scoped(connection) };
      try {
        await tx.api.exec('BEGIN');
        let result;
        try {
          result = await storage.run(tx, () => fn(tx.api));
          await tx.api.exec('COMMIT');
        } catch (error) {
          await tx.api.exec('ROLLBACK').catch(() => {});
          throw error;
        }
        return result;
      } finally {
        // Work started inside the transaction (setImmediate, floating promises) must fall back to the root.
        tx.alive = false;
        connection.release();
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      await driver.close();
    },
    /** PGlite only: snapshot used by tests as a migrated template. */
    async dumpTemplate() {
      if (driver.kind !== 'pglite') throw new Error('Templates are available only with PGlite.');
      return driver.raw.dumpDataDir('none');
    },
  };
  return root;
}

/** Chooses the driver from the environment. Production must never fall back to a private embedded database. */
export async function createDatabaseFromEnv(env = process.env, overrides = {}) {
  const config = readDatabaseConfig(env);
  if (config.connectionString) {
    return createDatabase({ connectionString: config.connectionString, poolMax: config.poolMax, statementTimeoutMs: config.statementTimeoutMs, ...overrides });
  }
  if (config.production) throw new Error('DATABASE_URL is required in production; refusing to start an embedded database.');
  return createDatabase({ pglite: true, dataDir: config.pgliteDataDir, ...overrides });
}
