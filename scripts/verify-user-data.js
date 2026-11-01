// Read-only check of the user-data store (ADR 0015). Usage: `DATABASE_URL=... node scripts/verify-user-data.js`. It refuses unless
// DATABASE_URL names a loopback database other than `coversaath_dev`, reads in a READ ONLY transaction, and prints counts and
// pass/fail only, never a stored value. For each table it reports the row count and, for every column named *_ciphertext, how
// many non-null values do not start with a sealed prefix (enc1. or enc2., the column-crypto envelope). Exit code 1 when any
// such value exists (a plaintext leak) or the tables are missing; 2 when the target is refused or the check could not run.
import { pathToFileURL } from 'node:url';
import pg from 'pg';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const PROTECTED_DATABASE = 'coversaath_dev';
export const USER_DATA_TABLES = Object.freeze(['device_permissions', 'household_places', 'adult_preferences', 'onboarding_progress', 'tool_scenarios', 'adult_users', 'profile_answers']);

export function assertSafeVerifyTarget(databaseUrl) {
  const refuse = reason => { throw Object.assign(new Error(`Verify refused: ${reason}.`), { code: 'VERIFY_TARGET_REFUSED' }); };
  if (typeof databaseUrl !== 'string' || !databaseUrl.trim()) refuse('DATABASE_URL is not set');
  let url;
  try { url = new URL(databaseUrl); } catch { refuse('DATABASE_URL is not a valid URL'); }
  if (!LOOPBACK.has(url.hostname.toLowerCase())) refuse('the database is not on this machine');
  // pg-connection-string copies every query parameter (host, database, ...) over the URL parts, which would bypass this guard.
  if (url.search || url.hash) refuse('DATABASE_URL must not carry query parameters');
  const name = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!name) refuse('DATABASE_URL names no database');
  if (name === PROTECTED_DATABASE) refuse(`${PROTECTED_DATABASE} is protected`);
  return name;
}

/** The validated target as discrete pg options, so nothing in the original string can override the checked parts. */
export function safeClientOptions(databaseUrl) {
  const name = assertSafeVerifyTarget(databaseUrl);
  const url = new URL(databaseUrl);
  return { host: url.hostname.replace(/^\[|\]$/g, ''), port: url.port ? Number(url.port) : 5432, database: name,
    user: decodeURIComponent(url.username) || undefined, password: decodeURIComponent(url.password) || undefined };
}

/** Runs the check on a connected pg client. Resolves { tables: [{ table, rows, ciphertextColumns: [{ column, nonNull, notSealed }] }], ok }. */
export async function verifyUserData(client) {
  await client.query('BEGIN READ ONLY');
  try {
    const present = new Set((await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'")).rows.map(row => row.table_name));
    const columns = (await client.query(`SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name LIKE '%\\_ciphertext' ORDER BY table_name, column_name`)).rows;
    const tables = [];
    let ok = true;
    for (const table of USER_DATA_TABLES) {
      if (!present.has(table)) { tables.push({ table, rows: null, ciphertextColumns: [], missing: true }); ok = false; continue; }
      const rows = Number((await client.query(`SELECT count(*) AS c FROM public."${table}"`)).rows[0].c);
      const ciphertextColumns = [];
      for (const { column_name: column } of columns.filter(item => item.table_name === table)) {
        const result = (await client.query(`SELECT count("${column}") AS non_null,
          count("${column}") FILTER (WHERE "${column}" !~ '^enc[12][.]') AS not_sealed FROM public."${table}"`)).rows[0];
        ciphertextColumns.push({ column, nonNull: Number(result.non_null), notSealed: Number(result.not_sealed) });
        if (Number(result.not_sealed) > 0) ok = false;
      }
      tables.push({ table, rows, ciphertextColumns });
    }
    return { tables, ok };
  } finally {
    await client.query('ROLLBACK');
  }
}

async function main() {
  let client;
  try {
    const options = safeClientOptions(process.env.DATABASE_URL);
    const name = options.database;
    client = new pg.Client({ ...options, application_name: 'coversaath-verify-user-data' });
    await client.connect();
    const report = await verifyUserData(client);
    for (const item of report.tables) {
      if (item.missing) { process.stdout.write(`${item.table}: MISSING\n`); continue; }
      const detail = item.ciphertextColumns.map(col => `${col.column} ${col.nonNull - col.notSealed}/${col.nonNull} sealed${col.notSealed ? ' FAIL' : ''}`).join('; ');
      process.stdout.write(`${item.table}: ${item.rows} rows${detail ? `; ${detail}` : ''}\n`);
    }
    process.stdout.write(`database ${name}: ${report.ok ? 'PASS' : 'FAIL'}\n`);
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${typeof error?.code === 'string' && error.code.startsWith('VERIFY_') ? error.message : 'Verify could not run.'}\n`);
    process.exitCode = 2;
  } finally {
    await client?.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
