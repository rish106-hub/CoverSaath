// PostgreSQL test harness (ADR 0004, D9).
//
// TEST_DATABASE_URL points at a server whose role may create databases. The harness builds one
// TEMPLATE database per migration-set digest (coversaath_tpl_<12 hex>) under an advisory lock, so
// parallel test processes build it once, and clones a fresh database per test from it. Clones are
// always dropped. Without TEST_DATABASE_URL the tests skip with a visible reason; with
// REQUIRE_POSTGRES=1 (CI) a missing URL is an error instead.
//
// COVERSAATH_PG_MIGRATIONS_DIR points the harness at another migration directory. Mutation checks
// use it to prove a test fails when a trigger is broken; its digest selects its own template.
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import pg from 'pg';
import {
  createPostgresPool, postgresMigrationDirectory, postgresMigrationFiles, runPostgresMigrations,
} from '../../src/backend/database/postgres/index.js';

export const SKIP_REASON = 'TEST_DATABASE_URL not set';

const TEMPLATE_PREFIX = 'coversaath_tpl_';
const BUILD_PREFIX = 'coversaath_tplb_';
const CLONE_PREFIX = 'coversaath_test_';
// Serialises template builds and clone creation across test processes.
const HARNESS_LOCK_KEY = '7283541900101';
const OBJECT_IN_USE = '55006';

export function testDatabaseUrl() {
  const url = process.env.TEST_DATABASE_URL?.trim();
  if (url) return url;
  if (process.env.REQUIRE_POSTGRES === '1') {
    throw new Error('REQUIRE_POSTGRES=1 but TEST_DATABASE_URL is not set.');
  }
  return null;
}

// Spread into a test or suite: test('name', postgresTestOptions(), async t => { ... }).
export function postgresTestOptions() {
  return testDatabaseUrl() ? {} : { skip: SKIP_REASON };
}

export function migrationDirectory() {
  const configured = process.env.COVERSAATH_PG_MIGRATIONS_DIR;
  if (!configured) return postgresMigrationDirectory;

  const root = resolve(postgresMigrationDirectory);
  const candidate = resolve(configured);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    throw new Error('COVERSAATH_PG_MIGRATIONS_DIR must resolve inside the default migrations directory.');
  }
  return candidate;
}

export function migrationSetDigest(directory = migrationDirectory()) {
  const hash = createHash('sha256');
  for (const name of postgresMigrationFiles(directory)) {
    hash.update(name).update('\0').update(readFileSync(resolve(directory, name))).update('\0');
  }
  return hash.digest('hex').slice(0, 12);
}

function urlForDatabase(url, database) {
  const copy = new URL(url);
  copy.pathname = `/${database}`;
  return copy.toString();
}

async function withAdmin(work) {
  const admin = new pg.Client({ connectionString: testDatabaseUrl(), application_name: 'coversaath-test-admin' });
  await admin.connect();
  try {
    return await work(admin);
  } finally {
    await admin.end();
  }
}

async function withHarnessLock(admin, work) {
  await admin.query('SELECT pg_advisory_lock($1::bigint)', [HARNESS_LOCK_KEY]);
  try {
    return await work();
  } finally {
    await admin.query('SELECT pg_advisory_unlock($1::bigint)', [HARNESS_LOCK_KEY]);
  }
}

const quote = identifier => `"${identifier.replaceAll('"', '""')}"`;
const isSafeHarnessDatabaseName = (name, digest) => {
  const expectedPrefix = `${BUILD_PREFIX}${digest}_`;
  return typeof name === 'string'
    && name.startsWith(expectedPrefix)
    && /^[0-9]+$/.test(name.slice(expectedPrefix.length));
};

// A session that just closed can linger for a moment; retry while the server reports "in use".
async function retryWhileInUse(operation, attempts = 40) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (error.code !== OBJECT_IN_USE || attempt >= attempts) throw error;
      await new Promise(done => setTimeout(done, 100));
    }
  }
}

async function databaseExists(admin, name) {
  return (await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).rowCount > 0;
}

async function buildTemplate(admin, digest, directory) {
  const finalName = `${TEMPLATE_PREFIX}${digest}`;
  const stale = await admin.query('SELECT datname FROM pg_database WHERE datname LIKE $1', [`${BUILD_PREFIX}${digest}\\_%`]);
  for (const { datname } of stale.rows) {
    if (!isSafeHarnessDatabaseName(datname, digest)) {
      throw new Error(`Refusing to drop unexpected database name: ${String(datname)}`);
    }
    await admin.query(`DROP DATABASE IF EXISTS ${quote(datname)} WITH (FORCE)`);
  }
  const buildName = `${BUILD_PREFIX}${digest}_${process.pid}`;
  await admin.query(`CREATE DATABASE ${quote(buildName)} TEMPLATE template0 ENCODING 'UTF8' LOCALE 'C'`);
  try {
    const pool = createPostgresPool({
      connectionString: urlForDatabase(testDatabaseUrl(), buildName),
      max: 2,
      statementTimeoutMs: 60_000,
      applicationName: 'coversaath-test-template',
    });
    try {
      await runPostgresMigrations(pool, { directory });
    } finally {
      await pool.end();
    }
    await retryWhileInUse(() => admin.query(`ALTER DATABASE ${quote(buildName)} RENAME TO ${quote(finalName)}`));
    // Nothing connects to a template: clones copy it and tests never open it.
    await admin.query(`ALTER DATABASE ${quote(finalName)} WITH ALLOW_CONNECTIONS false`);
  } catch (error) {
    await admin.query(`DROP DATABASE IF EXISTS ${quote(buildName)} WITH (FORCE)`).catch(() => {});
    throw error;
  }
}

const templates = new Map();

// Returns the template database name for a migration directory, building it once per digest.
export function ensureTemplate(directory = migrationDirectory()) {
  const digest = migrationSetDigest(directory);
  if (!templates.has(digest)) {
    templates.set(digest, withAdmin(async admin => {
      const name = `${TEMPLATE_PREFIX}${digest}`;
      // The final name only exists once a build finished (the build is renamed into place).
      if (!(await databaseExists(admin, name))) {
        await withHarnessLock(admin, async () => {
          if (!(await databaseExists(admin, name))) await buildTemplate(admin, digest, directory);
        });
      }
      return name;
    }).catch(error => {
      templates.delete(digest);
      throw error;
    }));
  }
  return templates.get(digest);
}

let counter = 0;
const cloneName = () => `${CLONE_PREFIX}${process.pid}_${(counter += 1)}_${randomBytes(3).toString('hex')}`;

function makeHandle(name, { applicationName } = {}) {
  const url = urlForDatabase(testDatabaseUrl(), name);
  const pool = createPostgresPool({
    connectionString: url,
    max: 6,
    statementTimeoutMs: 30_000,
    lockTimeoutMs: 5_000,
    idleInTransactionTimeoutMs: 30_000,
    applicationName: applicationName ?? 'coversaath-test',
  });
  let dropped = false;
  return {
    pool,
    url,
    name,
    async drop() {
      if (dropped) return;
      dropped = true;
      await pool.end().catch(() => {});
      await withAdmin(admin => admin.query(`DROP DATABASE IF EXISTS ${quote(name)} WITH (FORCE)`));
    },
  };
}

// A fresh database cloned from the migrated template: { pool, url, name, drop() }.
export async function createTestDatabase({ directory } = {}) {
  const template = await ensureTemplate(directory);
  const name = cloneName();
  await withAdmin(admin => withHarnessLock(admin, () => retryWhileInUse(
    () => admin.query(`CREATE DATABASE ${quote(name)} TEMPLATE ${quote(template)}`),
  )));
  return makeHandle(name);
}

// An empty database (C collation unless `locale` says otherwise) with no migrations, for runner tests.
export async function createBlankDatabase({ locale = 'C', localeProvider, icuLocale } = {}) {
  const name = cloneName();
  const safeLocale = locale.replaceAll("'", '');
  const provider = localeProvider === undefined ? '' : ` LOCALE_PROVIDER ${['builtin', 'icu', 'libc'].includes(localeProvider) ? localeProvider : 'invalid'}`;
  const icu = icuLocale === undefined ? '' : ` ICU_LOCALE '${icuLocale.replaceAll("'", '')}'`;
  await withAdmin(admin => admin.query(
    `CREATE DATABASE ${quote(name)} TEMPLATE template0 ENCODING 'UTF8'${provider}${icu} LOCALE '${safeLocale}'`,
  ));
  return makeHandle(name);
}

// Same as createTestDatabase / createBlankDatabase and registers the drop with the test context.
export async function useTestDatabase(t, options) {
  const handle = await createTestDatabase(options);
  t.after(() => handle.drop());
  return handle;
}

export async function useBlankDatabase(t, options) {
  const handle = await createBlankDatabase(options);
  t.after(() => handle.drop());
  return handle;
}

export async function adminQuery(sql, params) {
  return withAdmin(admin => admin.query(sql, params));
}
