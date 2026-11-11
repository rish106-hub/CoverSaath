import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { postgresTestOptions, freshDatabase } from './support/pg.mjs';
import { seedDemo, assertLoopbackDatabaseUrl } from '../scripts/seed-demo.mjs';

// `npm run seed:demo` (H-B4). Synthetic data only. Needs TEST_DATABASE_URL (REQUIRE_POSTGRES=1 turns a skip into a failure).

const opts = postgresTestOptions();
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = {
  DATA_ENCRYPTION_KEY_BASE64: randomBytes(32).toString('base64'),
  DOCUMENT_ENCRYPTION_KEY_BASE64: randomBytes(32).toString('base64'),
};
const TABLES = [
  'adult_users', 'households', 'household_members', 'insurers', 'policies', 'policy_members', 'document_uploads',
  'policy_holdings', 'member_declarations', 'premium_payments', 'consent_grants', 'service_cases',
];
// Real Indian insurer brand names. Matched case-insensitively; the seed and fixtures must contain none.
const DENYLIST = [
  'Star Health', 'HDFC Ergo', 'ICICI Lombard', 'Niva Bupa', 'Care Health', 'Bajaj Allianz', 'Tata AIG', 'Aditya Birla',
  'Manipal Cigna', 'New India', 'United India', 'Oriental', 'National Insurance', 'Reliance General', 'SBI General',
];

async function counts(database) {
  const out = {};
  for (const table of TABLES) out[table] = Number((await database.one(`SELECT count(*) AS n FROM ${table}`)).n);
  return out;
}

test('seed:demo is idempotent: a second run adds no rows', opts, async t => {
  const { db } = await freshDatabase(t);
  const first = await seedDemo(db, { env });
  const afterFirst = await counts(db);
  assert.equal(afterFirst.insurers, 2);
  assert.equal(afterFirst.policies, 3);
  assert.equal(afterFirst.document_uploads, 7);
  assert.equal(afterFirst.policy_holdings, 3);
  assert.equal(afterFirst.premium_payments, 3);
  assert.equal(afterFirst.member_declarations, 2);
  assert.equal(afterFirst.household_members, 3);
  assert.equal(afterFirst.households, 1);
  assert.equal((await db.one(`SELECT count(*) AS n FROM document_uploads WHERE lifecycle_state = 'active' AND malware_status = 'clean'`)).n, 7);

  const second = await seedDemo(db, { env });
  assert.deepEqual(await counts(db), afterFirst, 'row counts unchanged after a second run');
  assert.equal(second.householdId, first.householdId, 'same household');
  assert.equal(second.adultId, first.adultId, 'same owner');
});

test('seed:demo refuses any database host other than localhost or 127.0.0.1', () => {
  assert.equal(assertLoopbackDatabaseUrl('postgres://coversaath@localhost:54329/knowvia_b4'), true);
  assert.equal(assertLoopbackDatabaseUrl('postgresql://u@127.0.0.1:5432/x'), true);
  for (const url of [
    'postgres://u@db.example.invalid:5432/x',
    'postgres://u@10.0.0.5:5432/x',
    'postgres://u@localhost/x?host=db.example.invalid',
    'postgres://u@localhost.example.invalid/x',
    'mysql://u@localhost/x',
    'not a url',
    '',
    undefined,
  ]) {
    assert.throws(() => assertLoopbackDatabaseUrl(url), { code: 'SEED_TARGET_REFUSED' }, `refuses ${String(url)}`);
  }
});

test('seed:demo fixtures and seed code contain no real insurer brand names', () => {
  const dirs = [join(root, 'tests', 'fixtures', 'demo'), join(root, 'scripts', 'demo')];
  const files = [join(root, 'scripts', 'seed-demo.mjs')];
  for (const dir of dirs) for (const name of readdirSync(dir)) files.push(join(dir, name));
  assert.equal(files.length, 11, '7 PDFs, hospitals.json and 3 seed code files are present');
  const hits = [];
  for (const file of files) {
    const text = readFileSync(file).toString('latin1').toLowerCase();
    for (const brand of DENYLIST) if (text.includes(brand.toLowerCase())) hits.push(`${file}: ${brand}`);
  }
  assert.deepEqual(hits, []);
});
