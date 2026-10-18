// S3.2 WP0: the async database interface (design section 1). Synthetic data only.
// Pure tests run everywhere; server tests need TEST_DATABASE_URL (they skip visibly without it).
import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import pg from 'pg';
import {
  TRANSACTION_RETRIES, createDatabase, isDatabaseInterface, typeParsers,
} from '../src/backend/database/postgres/db.js';
import { classifyDatabaseError, markDatabaseError, PostgresDatabaseError } from '../src/backend/database/postgres/errors.js';
import {
  LOCK_NAMESPACES, advisoryLockKey, householdLock, idempotencyLock, sessionCapacityLock,
} from '../src/backend/database/postgres/locks.js';
import { convertPlaceholders } from '../src/backend/database/postgres/placeholders.js';
import { errorResponse } from '../src/server/routes/v1-backend-routes.js';
import { assertDbError, freshDatabase, postgresTestOptions } from './support/pg.mjs';
import { adminQuery } from './support/postgres.mjs';

const at = '2026-10-18T09:00:00.000Z';
const pgOptions = postgresTestOptions();

function driverError(code, message = 'driver message with synthetic-secret-value') {
  const error = new pg.DatabaseError(message, message.length, 'error');
  Object.assign(error, {
    code, severity: 'ERROR', detail: 'Key (id)=(synthetic-secret-value) already exists.', hint: 'synthetic-hint',
    table: 'synthetic_table', column: 'synthetic_column', constraint: 'synthetic_constraint', where: 'PL/pgSQL synthetic_where',
    schema: 'public',
  });
  return error;
}

function fakePool() {
  const calls = [];
  return {
    calls,
    async query(config) { calls.push(config); return { rows: [], rowCount: 0 }; },
    async connect() { throw new Error('not used'); },
    async end() {},
  };
}

// ---------------------------------------------------------------- placeholders

test('placeholders: ? becomes $n in order', () => {
  assert.deepEqual(convertPlaceholders('SELECT * FROM t WHERE a = ? AND b IN (?, ?)'), {
    text: 'SELECT * FROM t WHERE a = $1 AND b IN ($2, $3)', count: 3,
  });
  assert.deepEqual(convertPlaceholders('SELECT 1'), { text: 'SELECT 1', count: 0 });
  assert.deepEqual(convertPlaceholders('SELECT ?::text,?'), { text: 'SELECT $1::text,$2', count: 2 });
});

test('placeholders: ? inside strings, identifiers, comments and dollar quotes is left alone', () => {
  const cases = [
    ["SELECT 'a?b', ?", "SELECT 'a?b', $1"],
    ["SELECT 'it''s ?', ?", "SELECT 'it''s ?', $1"],
    ["SELECT E'\\'?', ?", "SELECT E'\\'?', $1"],
    ["SELECT e'x\\\\', ?", "SELECT e'x\\\\', $1"],
    ['SELECT "col?" , "a""?" FROM t WHERE x = ?', 'SELECT "col?" , "a""?" FROM t WHERE x = $1'],
    ['SELECT ? -- trailing ? comment\n, ?', 'SELECT $1 -- trailing ? comment\n, $2'],
    ['SELECT ? -- comment at end ?', 'SELECT $1 -- comment at end ?'],
    ['SELECT /* a ? /* nested ? */ still ? */ ?', 'SELECT /* a ? /* nested ? */ still ? */ $1'],
    ['SELECT $$ ? $$, ?', 'SELECT $$ ? $$, $1'],
    ['SELECT $fn$ ? $$ ? $inner$ ? $fn$, ?', 'SELECT $fn$ ? $$ ? $inner$ ? $fn$, $1'],
    ['SELECT a$b, ?', 'SELECT a$b, $1'],
    ["SELECT name' ?'", "SELECT name' ?'"],
  ];
  for (const [input, expected] of cases) assert.equal(convertPlaceholders(input).text, expected, input);
});

test('placeholders: $n, unterminated quotes and comments are refused with a coded error', () => {
  for (const sql of [
    'SELECT $1', 'SELECT ?, $2', "SELECT 'open", 'SELECT "open', 'SELECT /* open', 'SELECT $$ open',
    'SELECT $tag$ open $other$', "SELECT E'\\'", '', '   ', null,
  ]) {
    assert.throws(() => convertPlaceholders(sql), error => {
      assert.equal(error.code, 'DATABASE_SQL_INVALID');
      if (typeof sql === 'string' && sql.trim()) assert.ok(!error.message.includes(sql.trim()), 'the message must not echo SQL');
      return true;
    }, String(sql));
  }
  // $1 inside a dollar-quoted body or a string is not a positional parameter.
  assert.equal(convertPlaceholders("SELECT '$1', $$ $1 $$, ?").text, "SELECT '$1', $$ $1 $$, $1");
});

// ---------------------------------------------------------------- int8 parser

test('int8 parser returns safe integers as numbers and refuses unsafe ones', () => {
  const parse = typeParsers.getTypeParser(20, 'text');
  assert.equal(parse('0'), 0);
  assert.equal(parse('1'), 1);
  assert.equal(parse('-9007199254740991'), -9007199254740991);
  assert.equal(parse('9007199254740991'), Number.MAX_SAFE_INTEGER);
  for (const unsafe of ['9007199254740992', '-9007199254740992', '9223372036854775807']) {
    assert.throws(() => parse(unsafe), { code: 'DATABASE_INTEGER_UNSAFE' });
  }
  const parseArray = typeParsers.getTypeParser(1016, 'text');
  assert.deepEqual(parseArray('{1,NULL,3}'), [1, null, 3]);
  assert.throws(() => parseArray('{9007199254740993}'), { code: 'DATABASE_INTEGER_UNSAFE' });
  // Other types keep the pg defaults, and the process-wide defaults are untouched.
  assert.equal(typeParsers.getTypeParser(23, 'text')('7'), 7);
  assert.equal(pg.types.getTypeParser(20, 'text')('42'), '42');
});

// ---------------------------------------------------------------- locks

test('lock keys are stable signed 64-bit values per namespace and key', () => {
  const key = advisoryLockKey(LOCK_NAMESPACES.HOUSEHOLD, 'household-a');
  assert.match(key, /^-?[0-9]{1,19}$/);
  assert.equal(key, advisoryLockKey(LOCK_NAMESPACES.HOUSEHOLD, 'household-a'));
  const big = BigInt(key);
  assert.ok(big >= -(2n ** 63n) && big < 2n ** 63n);
  assert.notEqual(key, advisoryLockKey(LOCK_NAMESPACES.HOUSEHOLD, 'household-b'));
  assert.notEqual(key, advisoryLockKey(LOCK_NAMESPACES.IDEMPOTENCY, 'household-a'));
  assert.deepEqual(householdLock('household-a'), ['household', 'household-a']);
  assert.deepEqual(householdLock(null), ['household_none', 'global']);
  assert.deepEqual(householdLock(undefined), householdLock(null));
  // The NULL-household key cannot collide with a household named "global".
  assert.notEqual(advisoryLockKey(...householdLock(null)), advisoryLockKey(...householdLock('global')));
  assert.deepEqual(idempotencyLock('analysis-run', 'key-1'), ['idempotency', 'analysis-run\0key-1']);
  assert.deepEqual(sessionCapacityLock('adult-1'), ['session_capacity', 'adult-1']);
  for (const [namespace, value] of [['unknown', 'x'], ['household', ''], ['household', 7], ['household', 'x'.repeat(513)]]) {
    assert.throws(() => advisoryLockKey(namespace, value), { code: 'DATABASE_LOCK_INVALID' });
  }
  assert.throws(() => idempotencyLock('', 'k'), { code: 'DATABASE_LOCK_INVALID' });
});

// ---------------------------------------------------------------- error classification

test('classifyDatabaseError maps SQLSTATEs to client-safe coded errors', () => {
  const expectations = [
    ['23505', 409, 'BACKEND_REQUEST_FAILED'], ['23503', 409, 'BACKEND_REQUEST_FAILED'],
    ['23514', 409, 'BACKEND_REQUEST_FAILED'], ['23502', 409, 'BACKEND_REQUEST_FAILED'],
    ['23P01', 409, 'BACKEND_REQUEST_FAILED'],
    ['P0001', 400, 'BACKEND_REQUEST_FAILED'], ['22P02', 400, 'BACKEND_REQUEST_FAILED'],
    ['22007', 400, 'BACKEND_REQUEST_FAILED'], ['42601', 400, 'BACKEND_REQUEST_FAILED'],
    ['42P18', 400, 'BACKEND_REQUEST_FAILED'], ['XX000', 400, 'BACKEND_REQUEST_FAILED'],
    ['40001', 503, 'DATABASE_UNAVAILABLE'], ['40P01', 503, 'DATABASE_UNAVAILABLE'],
    ['55P03', 503, 'DATABASE_UNAVAILABLE'], ['57014', 503, 'DATABASE_UNAVAILABLE'],
    ['53300', 503, 'DATABASE_UNAVAILABLE'], ['53200', 503, 'DATABASE_UNAVAILABLE'],
    ['08006', 503, 'DATABASE_UNAVAILABLE'], ['08P01', 503, 'DATABASE_UNAVAILABLE'],
    ['57P01', 503, 'DATABASE_UNAVAILABLE'], ['57P03', 503, 'DATABASE_UNAVAILABLE'],
    ['25P03', 503, 'DATABASE_UNAVAILABLE'],
  ];
  for (const [sqlstate, status, code] of expectations) {
    const result = classifyDatabaseError(driverError(sqlstate));
    assert.ok(result instanceof PostgresDatabaseError, sqlstate);
    assert.equal(result.statusCode, status, sqlstate);
    assert.equal(result.code, code, sqlstate);
    assert.equal(result.sqlstate, sqlstate);
    assert.equal(result.retryable, status === 503, sqlstate);
    const rendered = `${JSON.stringify(result)} ${inspect(result, { depth: 5, showHidden: true })} ${result.message}`;
    for (const secret of ['synthetic-secret-value', 'synthetic-hint', 'synthetic_table', 'synthetic_column', 'synthetic_constraint', 'synthetic_where', 'driver message']) {
      assert.ok(!rendered.includes(secret), `${sqlstate} result must not carry ${secret}`);
    }
    assert.equal(result.cause, undefined);
    // The route mapper returns the classified status and code with the generic message.
    const response = errorResponse(result);
    assert.equal(response.status, status, sqlstate);
    assert.equal(response.body.error.code, code);
    assert.ok(!JSON.stringify(response).includes('synthetic'), sqlstate);
  }
});

test('classifyDatabaseError leaves application errors alone and only trusts connection errors from db calls', () => {
  assert.equal(classifyDatabaseError(new Error('plain')), null);
  assert.equal(classifyDatabaseError(Object.assign(new Error('x'), { code: 'CONSENT_REQUIRED' })), null);
  assert.equal(classifyDatabaseError(new PostgresDatabaseError('TX_CONCURRENT_USE', 'x')), null);
  assert.equal(classifyDatabaseError(null), null);
  assert.equal(classifyDatabaseError('23505'), null);
  // A five-character code on an error that did not come from the database is not a SQLSTATE.
  assert.equal(classifyDatabaseError(Object.assign(new Error('x'), { code: '23505' })), null);
  const refused = () => Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED', errno: -61, syscall: 'connect' });
  assert.equal(classifyDatabaseError(refused()), null, 'an unrelated integration outage is not a database outage');
  for (const error of [
    refused(), Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
    new Error('Connection terminated unexpectedly'), new Error('timeout exceeded when trying to connect'),
    new Error('Client has encountered a connection error and is not queryable'),
  ]) {
    const result = classifyDatabaseError(markDatabaseError(error));
    assert.equal(result?.code, 'DATABASE_UNAVAILABLE', error.message);
    assert.equal(result.statusCode, 503);
    assert.ok(!result.message.includes('127.0.0.1'));
  }
  assert.equal(classifyDatabaseError(markDatabaseError(new Error('something else'))), null);
});

// ---------------------------------------------------------------- interface without a server

test('the interface validates SQL and parameters before touching the pool', async () => {
  assert.throws(() => createDatabase(), TypeError);
  assert.throws(() => createDatabase({}), TypeError);
  const pool = fakePool();
  const db = createDatabase(pool);
  assert.equal(isDatabaseInterface(db), true);
  assert.equal(isDatabaseInterface({ prepare() {} }), false);
  assert.equal(isDatabaseInterface(null), false);
  assert.equal(db.inTransaction, false);
  await assert.rejects(db.one('SELECT ?, ?', [1]), { code: 'DATABASE_SQL_INVALID' });
  await assert.rejects(db.one('SELECT ?', 'not-an-array'), { code: 'DATABASE_SQL_INVALID' });
  await assert.rejects(db.one('SELECT $1', [1]), { code: 'DATABASE_SQL_INVALID' });
  await assert.rejects(db.lock(LOCK_NAMESPACES.HOUSEHOLD, 'household-a'), { code: 'TX_REQUIRED' });
  await assert.rejects(db.transaction('not a function'), TypeError);
  await assert.rejects(db.transaction(async () => {}, { locks: [['unknown', 'x']] }), { code: 'DATABASE_LOCK_INVALID' });
  await assert.rejects(db.transaction(async () => {}, { locks: ['household'] }), { code: 'DATABASE_LOCK_INVALID' });
  assert.equal(pool.calls.length, 0);
  assert.equal(await db.one('SELECT ? AS v', [1]), null);
  assert.deepEqual(pool.calls[0].text, 'SELECT $1 AS v');
  assert.equal(pool.calls[0].types, typeParsers, 'every query carries the interface type parsers');
  assert.equal(TRANSACTION_RETRIES, 3);
});

// ---------------------------------------------------------------- server tests

async function seedHousehold(db, id) {
  await db.run('INSERT INTO households (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)', [id, 'Synthetic household', at, at]);
}

const householdIds = async db => (await db.many('SELECT id FROM households ORDER BY id')).map(row => row.id);

test('query, one, many and run return the documented shapes; bigint values are numbers', pgOptions, async t => {
  const { db } = await freshDatabase(t);
  assert.deepEqual(await db.run('INSERT INTO households (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?), (?, ?, ?, ?)',
    ['h-1', 'One', at, at, 'h-2', 'Two', at, at]), { changes: 2 });
  assert.deepEqual(await db.one('SELECT id, display_name FROM households WHERE id = ?', ['h-1']), { id: 'h-1', display_name: 'One' });
  assert.equal(await db.one('SELECT id FROM households WHERE id = ?', ['missing']), null);
  assert.deepEqual(await householdIds(db), ['h-1', 'h-2']);
  const result = await db.query('SELECT count(*) AS count FROM households');
  assert.deepEqual(result, { rows: [{ count: 2 }], rowCount: 1 });
  const flags = await db.one("SELECT CAST(1 AS bigint) AS emergency_mode, CAST(0 AS bigint) AS observations, CAST(? AS text) AS q, '?' AS literal", ['v']);
  assert.deepEqual(flags, { emergency_mode: 1, observations: 0, q: 'v', literal: '?' });
  assert.equal(flags.emergency_mode === 1, true);
  assert.deepEqual(await db.one('SELECT ARRAY[CAST(1 AS bigint), NULL] AS ids'), { ids: [1, null] });
  assert.deepEqual(await db.run('UPDATE households SET display_name = ? WHERE id = ?', ['Renamed', 'missing']), { changes: 0 });
  // The pool itself keeps pg's process-wide default (int8 as text): the parser is per interface.
  assert.equal((await db.pool.query('SELECT CAST(5 AS bigint) AS n')).rows[0].n, '5');
});

test('an int8 outside the safe range rejects instead of losing precision', pgOptions, async t => {
  const { db } = await freshDatabase(t);
  await assert.rejects(db.one('SELECT CAST(9007199254740993 AS bigint) AS n'), { code: 'DATABASE_INTEGER_UNSAFE' });
  await assert.rejects(db.transaction(() => db.one('SELECT CAST(-9007199254740993 AS bigint) AS n')), { code: 'DATABASE_INTEGER_UNSAFE' });
  assert.deepEqual(await db.one('SELECT CAST(9007199254740991 AS bigint) AS n'), { n: Number.MAX_SAFE_INTEGER });
});

test('a transaction keeps one backend across awaits and timers; queries outside it use other connections', pgOptions, async t => {
  const { db } = await freshDatabase(t);
  const outsidePid = async () => (await db.one('SELECT pg_backend_pid() AS pid')).pid;
  const seen = await db.transaction(async () => {
    assert.equal(db.inTransaction, true);
    const pids = [(await db.one('SELECT pg_backend_pid() AS pid')).pid];
    await new Promise(done => setTimeout(done, 10));
    pids.push((await db.one('SELECT pg_backend_pid() AS pid')).pid);
    await new Promise(done => setImmediate(done));
    pids.push(await new Promise((done, fail) => setTimeout(() => db.one('SELECT pg_backend_pid() AS pid').then(row => done(row.pid), fail), 5)));
    await seedHousehold(db, 'h-inside');
    // Another connection does not see the uncommitted row (READ COMMITTED, not the same client).
    const other = await db.pool.query("SELECT count(*)::int AS n, pg_backend_pid() AS pid FROM households WHERE id = 'h-inside'");
    assert.equal(other.rows[0].n, 0);
    assert.notEqual(other.rows[0].pid, pids[0]);
    const isolation = await db.one("SELECT current_setting('transaction_isolation') AS level");
    assert.equal(isolation.level, 'read committed');
    return pids;
  });
  assert.equal(new Set(seen).size, 1, 'every query in the transaction used the same backend');
  assert.equal(db.inTransaction, false);
  assert.deepEqual(await householdIds(db), ['h-inside']);
  assert.equal(typeof await outsidePid(), 'number');
  // Parallel transactions each get their own backend.
  const pids = await Promise.all([1, 2].map(() => db.transaction(async () => {
    const { pid } = await db.one('SELECT pg_backend_pid() AS pid');
    await db.one('SELECT pg_sleep(0.05)');
    assert.equal((await db.one('SELECT pg_backend_pid() AS pid')).pid, pid);
    return pid;
  })));
  assert.notEqual(pids[0], pids[1]);
});

test('a failed transaction rolls back and rethrows the original error', pgOptions, async t => {
  const { db } = await freshDatabase(t);
  const failure = new Error('synthetic failure');
  await assert.rejects(db.transaction(async () => {
    await seedHousehold(db, 'h-rolled-back');
    throw failure;
  }), error => error === failure);
  assert.deepEqual(await householdIds(db), []);
  // A driver error aborts the transaction; nothing commits.
  await assertDbError(db.transaction(async () => {
    await seedHousehold(db, 'h-a');
    await seedHousehold(db, 'h-a');
  }), { sqlstate: '23505' });
  assert.deepEqual(await householdIds(db), []);
  assert.equal(await db.transaction(async () => 'value'), 'value');
});

test('nested transactions are savepoints: an inner failure rolls back only the inner work', pgOptions, async t => {
  const { db } = await freshDatabase(t);
  await db.transaction(async () => {
    await seedHousehold(db, 'h-outer-1');
    await assert.rejects(db.transaction(async () => {
      await seedHousehold(db, 'h-inner-rolled-back');
      throw new Error('inner failure');
    }), /inner failure/);
    assert.equal(db.inTransaction, true);
    // An expected constraint failure inside a savepoint leaves the outer transaction usable.
    await assertDbError(db.transaction(() => seedHousehold(db, 'h-outer-1')), { sqlstate: '23505' });
    const inner = await db.transaction(async () => {
      await seedHousehold(db, 'h-inner-kept');
      return db.transaction(async () => {
        await seedHousehold(db, 'h-deep-kept');
        return 'deep';
      });
    });
    assert.equal(inner, 'deep');
    await seedHousehold(db, 'h-outer-2');
  });
  assert.deepEqual(await householdIds(db), ['h-deep-kept', 'h-inner-kept', 'h-outer-1', 'h-outer-2']);

  // An outer failure discards released savepoints too.
  await assert.rejects(db.transaction(async () => {
    await db.transaction(() => seedHousehold(db, 'h-discarded'));
    throw new Error('outer failure');
  }), /outer failure/);
  assert.equal((await householdIds(db)).includes('h-discarded'), false);
});

test('concurrent use of one transaction is refused and the transaction rolls back', pgOptions, async t => {
  const { db } = await freshDatabase(t);
  await assert.rejects(db.transaction(async () => {
    await seedHousehold(db, 'h-concurrent');
    await Promise.all([db.one('SELECT pg_sleep(0.05)'), db.one('SELECT 1 AS one')]);
  }), { code: 'TX_CONCURRENT_USE' });
  await assert.rejects(db.transaction(async () => {
    await seedHousehold(db, 'h-concurrent-savepoints');
    await Promise.all([
      db.transaction(() => db.one('SELECT pg_sleep(0.05)')),
      db.transaction(() => db.one('SELECT 1 AS one')),
    ]);
  }), { code: 'TX_CONCURRENT_USE' });
  // A query from the outer level while a savepoint is open.
  await assert.rejects(db.transaction(async () => {
    let release;
    const gate = new Promise(done => { release = done; });
    const inner = db.transaction(async () => { await gate; await db.one('SELECT 1 AS one'); });
    try {
      await db.one('SELECT 2 AS two');
    } finally {
      release();
      await inner;
    }
  }), { code: 'TX_CONCURRENT_USE' });
  assert.deepEqual(await householdIds(db), []);
});

test('a missed await inside a transaction rolls it back instead of committing late', pgOptions, async t => {
  const { db } = await freshDatabase(t);
  await assert.rejects(db.transaction(async () => {
    seedHousehold(db, 'h-missed-await');
  }), { code: 'TX_CONCURRENT_USE' });
  await assert.rejects(db.transaction(async () => {
    db.transaction(() => seedHousehold(db, 'h-missed-savepoint'));
  }), { code: 'TX_CONCURRENT_USE' });
  assert.deepEqual(await householdIds(db), []);
});

test('queries from a finished transaction throw instead of running elsewhere', pgOptions, async t => {
  const { db } = await freshDatabase(t);
  // An async continuation started inside the transaction (a timer, a pending promise chain) keeps
  // the transaction context; once the transaction finished, its queries are refused.
  await assert.rejects(new Promise((done, fail) => {
    db.transaction(async () => {
      setTimeout(() => db.one('SELECT 1 AS one').then(done, fail), 20);
    }).catch(fail);
  }), { code: 'TX_RELEASED' });
  let open;
  const gate = new Promise(done => { open = done; });
  let continuation;
  await db.transaction(async () => {
    continuation = gate.then(() => db.transaction(async () => 1));
  });
  open();
  await assert.rejects(continuation, { code: 'TX_RELEASED' });
  let openInner;
  const innerGate = new Promise(done => { openInner = done; });
  let fromSavepoint;
  await db.transaction(async () => {
    await db.transaction(async () => {
      fromSavepoint = innerGate.then(() => db.one('SELECT 1 AS one'));
    });
    openInner();
    await assert.rejects(fromSavepoint, { code: 'TX_RELEASED' });
    assert.equal((await db.one('SELECT 1 AS one')).one, 1, 'the outer level is still usable');
  });
  // A call made outside any transaction is not affected by a closure created inside one.
  let later;
  await db.transaction(async () => { later = () => db.one('SELECT 1 AS one'); });
  assert.deepEqual(await later(), { one: 1 });
});

test('advisory locks serialise transactions on one key and not on others', pgOptions, async t => {
  const { db } = await freshDatabase(t);
  const order = [];
  let releaseFirst;
  const holding = new Promise(done => { releaseFirst = done; });
  let firstLocked;
  const locked = new Promise(done => { firstLocked = done; });
  const first = db.transaction(async () => {
    order.push('first locked');
    firstLocked();
    await holding;
    order.push('first done');
  }, { locks: [householdLock('h-lock')] });
  await locked;
  const second = db.transaction(async () => {
    await db.lock(...householdLock('h-lock'));
    order.push('second locked');
  });
  const unrelated = db.transaction(async () => {
    await db.lock(...householdLock('h-other'));
    order.push('unrelated locked');
  });
  await unrelated;
  await new Promise(done => setTimeout(done, 100));
  assert.deepEqual(order, ['first locked', 'unrelated locked'], 'the second waits for the first');
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first locked', 'unrelated locked', 'first done', 'second locked']);
  // Locks are re-entrant inside one transaction, including from a savepoint.
  await db.transaction(async () => {
    await db.lock(...householdLock('h-lock'));
    await db.transaction(() => db.lock(...householdLock('h-lock')));
  }, { locks: [householdLock('h-lock')] });
});

test('a lock wait past lock_timeout is a transient 503', pgOptions, async t => {
  const { db } = await freshDatabase(t);
  let release;
  const holding = new Promise(done => { release = done; });
  let held;
  const ready = new Promise(done => { held = done; });
  const holder = db.transaction(async () => { held(); await holding; }, { locks: [householdLock('h-timeout')] });
  await ready;
  try {
    await assert.rejects(db.transaction(async () => {
      await db.run("SET LOCAL lock_timeout = '100ms'");
      await db.lock(...householdLock('h-timeout'));
    }), error => {
      assert.equal(error.code, '55P03');
      const classified = classifyDatabaseError(error);
      assert.equal(classified.statusCode, 503);
      assert.equal(classified.code, 'DATABASE_UNAVAILABLE');
      return true;
    });
  } finally {
    release();
    await holder;
  }
});

test('the outermost transaction retries the whole function on 40001 and 40P01', pgOptions, async t => {
  const { db } = await freshDatabase(t);
  let attempts = 0;
  const result = await db.transaction(async () => {
    attempts += 1;
    await seedHousehold(db, `h-retry-${attempts}`);
    if (attempts < 3) throw driverError(attempts === 1 ? '40001' : '40P01');
    return 'committed';
  });
  assert.equal(result, 'committed');
  assert.equal(attempts, 3);
  assert.deepEqual(await householdIds(db), ['h-retry-3'], 'failed attempts were rolled back');

  attempts = 0;
  await assert.rejects(db.transaction(async () => {
    attempts += 1;
    throw driverError('40001');
  }), { code: '40001' });
  assert.equal(attempts, 1 + TRANSACTION_RETRIES);

  attempts = 0;
  await assert.rejects(db.transaction(async () => {
    attempts += 1;
    throw driverError('23505');
  }), { code: '23505' });
  assert.equal(attempts, 1, 'other errors are not retried');

  // A retryable failure inside a savepoint retries the whole outer function, not the savepoint.
  let outer = 0;
  let inner = 0;
  await db.transaction(async () => {
    outer += 1;
    await db.transaction(async () => {
      inner += 1;
      if (inner === 1) throw driverError('40P01');
    });
  });
  assert.deepEqual({ outer, inner }, { outer: 2, inner: 2 });
});

test('a real deadlock is retried and both transactions commit', pgOptions, async t => {
  const { db } = await freshDatabase(t);
  const attempts = { a: 0, b: 0 };
  let arrived = 0;
  let open;
  const barrier = new Promise(done => { open = done; });
  const meet = async () => {
    arrived += 1;
    if (arrived === 2) open();
    await barrier;
  };
  const worker = (name, firstKey, secondKey) => db.transaction(async () => {
    attempts[name] += 1;
    await db.lock(LOCK_NAMESPACES.HOUSEHOLD, firstKey);
    if (attempts[name] === 1) await meet();
    await db.lock(LOCK_NAMESPACES.HOUSEHOLD, secondKey);
    await seedHousehold(db, `h-deadlock-${name}-${attempts[name]}`);
    return name;
  });
  const results = await Promise.all([worker('a', 'k1', 'k2'), worker('b', 'k2', 'k1')]);
  assert.deepEqual(results, ['a', 'b']);
  assert.equal(attempts.a + attempts.b, 3, 'exactly one deadlock victim retried once');
  assert.equal((await householdIds(db)).length, 2);
});

test('a statement timeout and a dropped connection are transient 503s and the pool recovers', pgOptions, async t => {
  const { db } = await freshDatabase(t);
  await assert.rejects(db.transaction(async () => {
    await db.run("SET LOCAL statement_timeout = '50ms'");
    await db.one('SELECT pg_sleep(1)');
  }), error => {
    assert.equal(error.code, '57014');
    assert.equal(classifyDatabaseError(error).code, 'DATABASE_UNAVAILABLE');
    return true;
  });

  let victimPid;
  await assert.rejects(db.transaction(async () => {
    await seedHousehold(db, 'h-lost');
    victimPid = (await db.one('SELECT pg_backend_pid() AS pid')).pid;
    await adminQuery('SELECT pg_terminate_backend($1)', [victimPid]);
    await db.one('SELECT 1 AS one');
  }), error => {
    const classified = classifyDatabaseError(error);
    assert.equal(classified?.code, 'DATABASE_UNAVAILABLE', `got ${error.code} ${error.message}`);
    assert.equal(classified.statusCode, 503);
    return true;
  });
  // The broken client was discarded; the next transaction runs on a live backend.
  const { pid } = await db.transaction(() => db.one('SELECT pg_backend_pid() AS pid'));
  assert.notEqual(pid, victimPid);
  assert.deepEqual(await householdIds(db), []);
});

test('constraint, trigger and data errors from the server classify without leaking values', pgOptions, async t => {
  const { db } = await freshDatabase(t);
  await seedHousehold(db, 'h-synthetic-secret-value');
  const checks = [
    [() => seedHousehold(db, 'h-synthetic-secret-value'), '23505', 409],
    [() => db.run("INSERT INTO households (id, display_name, status, created_at, updated_at) VALUES ('h-2', 'x', 'synthetic-secret-value', ?, ?)", [at, at]), '23514', 409],
    [() => db.run('INSERT INTO households (id, display_name, created_at, updated_at) VALUES (?, NULL, ?, ?)', ['h-3', at, at]), '23502', 409],
    [() => db.run("INSERT INTO audit_events (household_id, actor_type, actor_id, action, resource_type, resource_id, event_payload_json, event_hash, occurred_at) VALUES ('h-synthetic-secret-missing', 'system', 'a', 'b', 'c', 'd', '{}', ?, ?)", ['a'.repeat(64), at]), '23503', 409],
    [() => db.one("SELECT CAST('synthetic-secret-value' AS integer) AS n"), '22P02', 400],
  ];
  for (const [operation, sqlstate, status] of checks) {
    await assert.rejects(operation(), error => {
      assert.equal(error.code, sqlstate);
      const classified = classifyDatabaseError(error);
      assert.equal(classified.statusCode, status, sqlstate);
      assert.equal(classified.code, 'BACKEND_REQUEST_FAILED');
      const response = JSON.stringify(errorResponse(classified));
      assert.ok(!response.includes('synthetic-secret'), `${sqlstate} response leaked a value`);
      assert.ok(!inspect(classified, { showHidden: true }).includes('synthetic-secret'));
      return true;
    });
  }
  // An append-only trigger (P0001) is a 400 with the generic message.
  await db.run("INSERT INTO audit_events (household_id, actor_type, actor_id, action, resource_type, resource_id, event_payload_json, event_hash, occurred_at) VALUES (NULL, 'system', 'a', 'b', 'c', 'd', '{}', ?, ?)", ['b'.repeat(64), at]);
  await assert.rejects(db.run("UPDATE audit_events SET actor_id = 'synthetic-secret-value'"), error => {
    assert.equal(error.code, 'P0001');
    const response = errorResponse(classifyDatabaseError(error));
    assert.equal(response.status, 400);
    assert.deepEqual(response.body.error, { code: 'BACKEND_REQUEST_FAILED', message: 'The request could not be completed.' });
    return true;
  });
});

test('the test facade and close behave', pgOptions, async t => {
  const { db, handle } = await freshDatabase(t);
  await db.prepare('INSERT INTO households (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)').run('h-facade', 'Facade', at, at);
  assert.deepEqual(await db.prepare('SELECT id FROM households WHERE id = ?').get('h-facade'), { id: 'h-facade' });
  assert.deepEqual(await db.prepare('SELECT id FROM households').all(), [{ id: 'h-facade' }]);
  const own = createDatabase(handle.pool);
  await own.close();
  await own.close();
  await assert.rejects(own.one('SELECT 1 AS one'));
});
