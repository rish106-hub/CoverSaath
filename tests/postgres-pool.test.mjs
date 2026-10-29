import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresPool, postgresPoolOptionsFromEnv } from '../src/backend/database/postgres/index.js';
import { postgresTestOptions, testDatabaseUrl } from './support/postgres.mjs';

// These need no server: the factory validates before it builds anything.
test('the pool factory requires a URL and never echoes it', () => {
  for (const value of [undefined, '', '   ', 42]) {
    assert.throws(() => createPostgresPool({ connectionString: value }), { code: 'DATABASE_URL_REQUIRED' });
  }
  assert.throws(() => createPostgresPool(), { code: 'DATABASE_URL_REQUIRED' });
  for (const url of ['not a url with secret-token', 'http://user:secret-token@host/db', 'mysql://user:secret-token@host/db']) {
    assert.throws(() => createPostgresPool({ connectionString: url }), error => {
      assert.equal(error.code, 'DATABASE_URL_INVALID');
      assert.ok(!error.message.includes('secret-token'), 'the message must not contain the URL');
      return true;
    });
  }
  for (const bad of [
    { max: 0 }, { statementTimeoutMs: 0 }, { lockTimeoutMs: 0 }, { lockTimeoutMs: 1.5 },
    { idleInTransactionTimeoutMs: 0 }, { idleInTransactionTimeoutMs: '5' }, { connectionTimeoutMs: 0 },
    { applicationName: '' },
  ]) {
    assert.throws(() => createPostgresPool({ connectionString: 'postgres://u:p@localhost/db', ...bad }), { code: 'DATABASE_POOL_OPTION_INVALID' });
  }
});

test('the pool factory builds without connecting or logging', async t => {
  const logged = [];
  for (const method of ['log', 'info', 'warn', 'error']) t.mock.method(console, method, (...args) => logged.push(args.join(' ')));
  const pool = createPostgresPool({ connectionString: 'postgres://user:secret-token@127.0.0.1:1/db' });
  assert.equal(pool.totalCount, 0, 'no connection is opened at construction');
  await pool.end();
  assert.deepEqual(logged, []);
});

test('every pooled connection carries the timeouts and application name, whatever the URL says', postgresTestOptions(), async t => {
  const url = new URL(testDatabaseUrl());
  url.searchParams.set('options', '-c statement_timeout=1');
  url.searchParams.set('application_name', 'from-the-url');
  url.searchParams.set('statement_timeout', '1');
  url.searchParams.set('lock_timeout', '1');
  url.searchParams.set('idle_in_transaction_session_timeout', '1');
  url.searchParams.set('replication', 'database');
  const pool = createPostgresPool({
    connectionString: url.toString(), max: 3, statementTimeoutMs: 12_345, lockTimeoutMs: 2_345, idleInTransactionTimeoutMs: 34_567,
    applicationName: 'coversaath-pool-test',
  });
  t.after(() => pool.end());
  const settings = await Promise.all(Array.from({ length: 3 }, () => pool.query(`SELECT current_setting('statement_timeout') AS statement,
    current_setting('lock_timeout') AS lock, current_setting('idle_in_transaction_session_timeout') AS idle,
    current_setting('application_name') AS name, pg_sleep(0.1)`)));
  for (const { rows: [row] } of settings) {
    assert.deepEqual(
      { statement: row.statement, lock: row.lock, idle: row.idle, name: row.name },
      { statement: '12345ms', lock: '2345ms', idle: '34567ms', name: 'coversaath-pool-test' },
    );
  }
  // A replication connection rejects the extended protocol that parameterised queries use.
  assert.equal((await pool.query('SELECT $1::int AS value', [7])).rows[0].value, 7);
  assert.equal(pool.options.max, 3);
});

test('defaults apply and the statement timeout cancels a slow query', postgresTestOptions(), async t => {
  const pool = createPostgresPool({ connectionString: testDatabaseUrl(), statementTimeoutMs: 200 });
  t.after(() => pool.end());
  const { rows: [row] } = await pool.query("SELECT current_setting('lock_timeout') AS lock, current_setting('application_name') AS name");
  assert.deepEqual({ ...row }, { lock: '5s', name: 'cover_saath' });
  await assert.rejects(pool.query('SELECT pg_sleep(5)'), { code: '57014' });
});

test('a CA certificate turns on verified TLS and URL ssl parameters cannot weaken it', async () => {
  const pem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';
  const pool = createPostgresPool({ connectionString: 'postgres://u:p@127.0.0.1:1/db?sslmode=disable&ssl=false&sslrootcert=/x', sslCa: pem });
  try {
    assert.deepEqual(pool.options.ssl, { ca: pem, rejectUnauthorized: true });
    assert.ok(!/ssl/i.test(new URL(pool.options.connectionString).search), 'ssl URL parameters are dropped');
  } finally {
    await pool.end();
  }
  for (const bad of ['', 'not a pem', 42, null]) {
    assert.throws(() => createPostgresPool({ connectionString: 'postgres://u:p@localhost/db', sslCa: bad }), { code: 'DATABASE_POOL_OPTION_INVALID' });
  }
});

test('remote hosts always get verified TLS, local hosts none, and PGSSLMODE cannot change either', async () => {
  const previous = process.env.PGSSLMODE;
  process.env.PGSSLMODE = 'disable';
  const pools = [];
  try {
    const make = connectionString => { const pool = createPostgresPool({ connectionString }); pools.push(pool); return pool; };
    // A remote host asking for no TLS, or for require, still gets certificate and host verification.
    assert.deepEqual(make('postgres://u:p@db.example.test:5432/db?sslmode=disable').options.ssl, { rejectUnauthorized: true });
    assert.deepEqual(make('postgres://u:p@db.example.test:5432/db?sslmode=require').options.ssl, { rejectUnauthorized: true });
    assert.deepEqual(make('postgres://u:p@db.example.test:5432/db').options.ssl, { rejectUnauthorized: true });
    // Loopback and Unix-socket databases run without TLS, set explicitly so PGSSLMODE cannot apply.
    for (const url of ['postgres://u@localhost/db', 'postgres://u@127.0.0.1/db', 'postgres://u@[::1]/db', 'postgres:///db?host=/tmp']) {
      assert.equal(make(url).options.ssl, false, url);
    }
    process.env.PGSSLMODE = 'no-verify';
    assert.deepEqual(make('postgres://u:p@db.example.test/db').options.ssl, { rejectUnauthorized: true });
  } finally {
    if (previous === undefined) delete process.env.PGSSLMODE; else process.env.PGSSLMODE = previous;
    await Promise.all(pools.map(pool => pool.end()));
  }
});

test('pool options come from the environment without echoing values', () => {
  assert.throws(() => postgresPoolOptionsFromEnv({}), { code: 'DATABASE_URL_REQUIRED' });
  assert.deepEqual(postgresPoolOptionsFromEnv({ DATABASE_URL: 'postgres://u:p@h/db' }), { connectionString: 'postgres://u:p@h/db' });
  assert.throws(() => postgresPoolOptionsFromEnv({ DATABASE_URL: 'postgres://u:secret-token@h/db', DATABASE_SSL_CA_PATH: '/nonexistent/ca.pem' }), error => {
    assert.equal(error.code, 'DATABASE_POOL_OPTION_INVALID');
    assert.ok(!error.message.includes('secret-token') && !error.message.includes('/nonexistent'));
    return true;
  });
});
