// Async database interface over the S3.1 pool (S3.2 design, section 1).
//
//   db.query(sql, params)  -> { rows, rowCount }
//   db.one(sql, params)    -> first row | null          (was .get())
//   db.many(sql, params)   -> row[]                     (was .all())
//   db.run(sql, params)    -> { changes }               (was .run().changes)
//   db.transaction(fn, { locks }) -> result of fn
//   db.lock(namespace, key)        pg_advisory_xact_lock; throws outside a transaction
//   db.inTransaction               (was DatabaseSync.isTransaction)
//   db.close()
//
// SQL uses `?` placeholders (converted to $n). The transaction's client travels in
// AsyncLocalStorage: every query issued while `fn` runs, however deep, uses that client. A nested
// transaction() is a savepoint; its failure rolls back only the savepoint. Isolation is READ
// COMMITTED. The outermost level retries the whole `fn` up to TRANSACTION_RETRIES times on
// serialization failure (40001) or deadlock (40P01), so `fn` must not have effects outside the
// database. A failed statement aborts the transaction; recover from an expected failure by running
// that statement in a nested transaction.
//
// Guards (all PostgresDatabaseError):
//   TX_CONCURRENT_USE  two queries at once on one transaction (no Promise.all inside a
//                      transaction), a query from an outer level while a savepoint is open, or a
//                      query or savepoint still running when `fn` returned (a missed await). The
//                      transaction rolls back.
//   TX_RELEASED        a query from a transaction that already committed or rolled back.
//   TX_REQUIRED        lock() outside a transaction.
//   DATABASE_SQL_INVALID      bad SQL text, $n placeholders or a parameter-count mismatch.
//   DATABASE_INTEGER_UNSAFE   an int8 value outside Number.MIN/MAX_SAFE_INTEGER.
//
// Driver errors are rethrown as they are (with their SQLSTATE `code`) so repositories can react to
// a specific SQLSTATE; the route boundary maps them with classifyDatabaseError and never returns
// their text.
import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import { PostgresDatabaseError, isRetryableTransactionError, markDatabaseError } from './errors.js';
import { advisoryLockKey } from './locks.js';
import { convertPlaceholdersCached } from './placeholders.js';

export const TRANSACTION_RETRIES = 3;

const INT8 = 20;
const INT8_ARRAY = 1016;
const BRAND = Symbol.for('cover_saath.database_interface');

function parseInt8(text) {
  const value = Number(text);
  if (!Number.isSafeInteger(value)) {
    throw new PostgresDatabaseError('DATABASE_INTEGER_UNSAFE', 'A database integer is outside the safe integer range.');
  }
  return value;
}

const parseInt8ArrayText = pg.types.getTypeParser(INT8_ARRAY, 'text');
const mapInt8 = value => (Array.isArray(value) ? value.map(mapInt8) : value === null ? null : parseInt8(value));

// Passed on every query, so the parser applies to this interface's pool only and never changes
// the process-wide pg defaults.
export const typeParsers = Object.freeze({
  getTypeParser(oid, format = 'text') {
    if (format === 'text' && oid === INT8) return parseInt8;
    if (format === 'text' && oid === INT8_ARRAY) return text => mapInt8(parseInt8ArrayText(text));
    return pg.types.getTypeParser(oid, format);
  },
});

const guard = (code, message) => new PostgresDatabaseError(code, message);
const concurrentUse = () => guard('TX_CONCURRENT_USE', 'A transaction runs one query at a time; await each query in order.');
const released = () => guard('TX_RELEASED', 'The transaction has already finished.');

function statement(sql, params = []) {
  if (!Array.isArray(params)) throw guard('DATABASE_SQL_INVALID', 'Query parameters must be an array.');
  const { text, count } = convertPlaceholdersCached(sql);
  if (count !== params.length) throw guard('DATABASE_SQL_INVALID', 'The number of parameters does not match the SQL placeholders.');
  return { text, values: params, types: typeParsers };
}

async function send(root, query) {
  root.busy = true;
  const pending = root.client.query(query);
  root.inflight = pending;
  try {
    return await pending;
  } catch (error) {
    throw markDatabaseError(error);
  } finally {
    root.busy = false;
    root.inflight = null;
  }
}

// Transaction-control statements wait for an in-flight query instead of failing.
async function control(root, text, values = []) {
  while (root.busy) await root.inflight.catch(() => {});
  return send(root, { text, values, types: typeParsers });
}

// Waits until no savepoint and no query started under `frame` is still running.
async function waitIdle(frame) {
  while (frame.children.size > 0 || frame.root.inflight) {
    await Promise.allSettled([...frame.children.values(), frame.root.inflight].filter(Boolean));
  }
}

// After `fn` resolved: anything still running is a missed await.
async function settle(frame) {
  const leaked = frame.children.size > 0 || frame.root.busy || frame.root.active !== frame;
  await waitIdle(frame);
  if (leaked) {
    throw guard('TX_CONCURRENT_USE', 'A query was still running when the transaction finished; await every query in a transaction.');
  }
}

function newFrame(root, parent) {
  return { root, parent, released: false, children: new Map() };
}

const delay = attempt => new Promise(done => setTimeout(done, 5 * 2 ** attempt + Math.floor(Math.random() * 10)));

/** Wraps a pool from createPostgresPool. close() ends the pool. */
export function createDatabase(pool) {
  if (!pool || typeof pool.connect !== 'function' || typeof pool.query !== 'function') {
    throw new TypeError('A PostgreSQL pool is required.');
  }
  const storage = new AsyncLocalStorage();
  let closed = false;

  function lockKeys(locks) {
    if (!Array.isArray(locks)) throw guard('DATABASE_LOCK_INVALID', 'Transaction locks must be a list of [namespace, key] pairs.');
    return locks.map(lock => {
      if (!Array.isArray(lock) || lock.length !== 2) throw guard('DATABASE_LOCK_INVALID', 'Transaction locks must be a list of [namespace, key] pairs.');
      return advisoryLockKey(lock[0], lock[1]);
    });
  }

  async function execute(sql, params) {
    const query = statement(sql, params);
    const frame = storage.getStore();
    if (!frame) {
      try {
        return await pool.query(query);
      } catch (error) {
        throw markDatabaseError(error);
      }
    }
    if (frame.released) throw released();
    const { root } = frame;
    if (root.active !== frame || root.busy) throw concurrentUse();
    return send(root, query);
  }

  async function takeLocks(root, keys) {
    for (const key of keys) await control(root, 'SELECT pg_advisory_xact_lock($1::bigint)', [key]);
  }

  function savepoint(parent, fn, keys) {
    const { root } = parent;
    if (root.active !== parent || root.busy) return Promise.reject(concurrentUse());
    const frame = newFrame(root, parent);
    const name = `cover_saath_sp_${(root.savepoints += 1)}`;
    const token = {};
    root.active = frame;
    const work = (async () => {
      try {
        await control(root, `SAVEPOINT ${name}`);
        await takeLocks(root, keys);
        const result = await storage.run(frame, fn);
        await settle(frame);
        await control(root, `RELEASE SAVEPOINT ${name}`);
        return result;
      } catch (error) {
        await waitIdle(frame);
        try {
          await control(root, `ROLLBACK TO SAVEPOINT ${name}`);
          await control(root, `RELEASE SAVEPOINT ${name}`);
        } catch {
          // The outer level rolls back the whole transaction.
        }
        throw error;
      } finally {
        frame.released = true;
        root.active = parent;
        parent.children.delete(token);
      }
    })();
    parent.children.set(token, work);
    return work;
  }

  async function outermost(fn, keys) {
    let client;
    try {
      client = await pool.connect();
    } catch (error) {
      throw markDatabaseError(error);
    }
    const root = { client, busy: false, inflight: null, active: null, savepoints: 0 };
    const frame = newFrame(root, null);
    root.active = frame;
    let healthy = true;
    // pg-pool removes its error listener from a checked-out client. Without this one, a session
    // the server ends between statements (terminated backend, idle-in-transaction timeout) would
    // emit an unhandled 'error' and crash the process. The next query then fails as a lost
    // connection and the client is discarded.
    const onClientError = () => { healthy = false; };
    client.on('error', onClientError);
    try {
      await control(root, 'BEGIN ISOLATION LEVEL READ COMMITTED');
      await takeLocks(root, keys);
      const result = await storage.run(frame, fn);
      await settle(frame);
      await control(root, 'COMMIT');
      return result;
    } catch (error) {
      await waitIdle(frame);
      try {
        await control(root, 'ROLLBACK');
      } catch {
        healthy = false;
      }
      throw error;
    } finally {
      frame.released = true;
      client.removeListener('error', onClientError);
      client.release(healthy ? undefined : true);
    }
  }

  const db = {
    [BRAND]: true,
    pool,

    async query(sql, params) {
      const { rows, rowCount } = await execute(sql, params);
      return { rows, rowCount: rowCount ?? 0 };
    },

    async one(sql, params) {
      return (await execute(sql, params)).rows[0] ?? null;
    },

    async many(sql, params) {
      return (await execute(sql, params)).rows;
    },

    async run(sql, params) {
      return { changes: (await execute(sql, params)).rowCount ?? 0 };
    },

    async transaction(fn, { locks = [] } = {}) {
      if (typeof fn !== 'function') throw new TypeError('A transaction function is required.');
      const keys = lockKeys(locks);
      const parent = storage.getStore();
      if (parent) {
        if (parent.released) throw released();
        return savepoint(parent, fn, keys);
      }
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await outermost(fn, keys);
        } catch (error) {
          if (attempt >= TRANSACTION_RETRIES || !isRetryableTransactionError(error)) throw error;
          await delay(attempt);
        }
      }
    },

    async lock(namespace, key) {
      const frame = storage.getStore();
      if (!frame || frame.released) throw guard('TX_REQUIRED', 'An advisory lock needs a transaction.');
      const lockKey = advisoryLockKey(namespace, key);
      await execute('SELECT pg_advisory_xact_lock(CAST(? AS bigint))', [lockKey]);
    },

    get inTransaction() {
      const frame = storage.getStore();
      return Boolean(frame && !frame.released);
    },

    async close() {
      if (closed) return;
      closed = true;
      await pool.end();
    },
  };
  return Object.freeze(db);
}

/** True for an interface built by createDatabase (as opposed to a node:sqlite DatabaseSync). */
export function isDatabaseInterface(value) {
  return Boolean(value && value[BRAND] === true);
}
