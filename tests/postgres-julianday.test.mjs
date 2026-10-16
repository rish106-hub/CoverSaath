import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { postgresTestOptions, useTestDatabase } from './support/postgres.mjs';

// Inputs the schema accepts (ISO-8601 dates and datetimes, offsets, fractions) plus the odd forms
// SQLite also parses and the garbage it rejects. Every one is evaluated by SQLite and PostgreSQL.
const inputs = [
  null, '', ' ', 'abc', 'garbage-in', '2026-13-01', '2026-00-10', '2026-01-32', '2026-01-00', '2026-1-1', '26-01-01',
  '2026/01/01', '20260101', 'null', 'undefined',
  '2026-10-16', '2026-10-16T', '2026-10-16 ', '2024-02-29', '2023-02-29', '2100-02-29', '1900-03-01', '1582-10-10',
  '2026-02-30', '2026-04-31', '2026-02-30T24:00:00Z',
  '2026-10-16T10:00:00.000Z', '2026-10-16T10:00:00Z', '2026-10-16T10:00:00z', '2026-10-16 10:00:00', '2026-10-16 10:00',
  '2026-10-16T10:00', '2026-10-16T10:00:00Z ', '2026-10-16T10:00:00Zjunk', '2026-10-16Tjunk', '2026-01-01Z', '2026-01-01 Z',
  '2026-10-16T10:00:00.5', '2026-10-16T10:00:00.123', '2026-10-16T10:00:00.123456789Z', '2026-01-01T10:00:00.1235',
  '2026-01-01T10:00:00.0005', '2026-01-01T10:00:00.9995', '2026-01-01T10:00:00.', '2026-01-01T10:00:00.5.5',
  '2026-01-01T10:00:00+05:30', '2026-01-01T10:00:00-05:30', '2026-01-01T10:00:00+14:59', '2026-01-01T10:00:00+15:00',
  '2026-01-01T10:00:00+05:60', '2026-01-01T10:00:00 +05:30', '2026-01-01T10:00:00.250+02:00', '2026-01-01T10:00:00,5',
  '2026-01-01T24:00', '2026-01-01T24:01', '2026-01-01T25:00', '2026-01-01T10:60', '2026-01-01T10:00:60',
  '-4713-11-24', '-4713-11-24T12:00:00', '-4712-01-01', '-4714-01-01', '0000-01-01', '0001-01-01', '9999-12-31',
  '9999-12-31T23:59:59.999Z', '14711-12-31T23:59:59Z', '14712-01-01', '14712-12-31', '14712-12-31T23:59:59',
  '10:00', '10:00:00', '10:00:00.5', '10:00Z', '24:00', '25:00', '1:00', '10:00:00+01:00',
  '0', '1', '2451544.5', '2460000.5', '5373484.4', '5373484.5', '5373485', '-1', '1e3', '1e10', '1e999', '.5', '5.', '+5',
  ' 5 ', '5 5', '0x10', 'Inf', 'NaN', '1,5', '2026', ' 2026', '2026 ', ' 2026-01-01', '\t2026-01-01', '2026-01-01\n',
  '2026-01-01\v10:00', '2026-01-01TT10:00', '2026-01-01  T 10:00',
];

test('julianday(text) matches SQLite for every accepted and rejected input', postgresTestOptions(), async t => {
  const database = await useTestDatabase(t);
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  const sqliteValue = sqlite.prepare('SELECT julianday(?) AS value');
  const differences = [];
  for (const input of inputs) {
    const expected = sqliteValue.get(input).value;
    const actual = (await database.pool.query('SELECT julianday($1::text) AS value', [input])).rows[0].value;
    const same = expected === null || actual === null
      ? expected === actual
      : Math.abs(Number(expected) - Number(actual)) <= 1e-9;
    if (!same) differences.push({ input, sqlite: expected, postgres: actual });
  }
  assert.deepEqual(differences, []);
  console.log(`julianday parity: ${inputs.length} inputs, 0 differences`);
});

test('julianday never raises and returns NULL for unparseable input, including the text now', postgresTestOptions(), async t => {
  const { pool } = await useTestDatabase(t);
  for (const input of ['now', 'NOW', '1e999', '2026-01-01T10:00:00.' + '9'.repeat(400) + 'Z', 'x'.repeat(10_000)]) {
    const value = (await pool.query('SELECT julianday($1::text) AS value', [input])).rows[0].value;
    assert.equal(value, null, `expected NULL for ${input.slice(0, 20)}`);
  }
  assert.equal((await pool.query('SELECT julianday(NULL::text) AS value')).rows[0].value, null);
  const now = (await pool.query('SELECT julianday(coversaath_utc_now()) AS value')).rows[0].value;
  assert.ok(Math.abs(now - (Date.now() / 86400000 + 2440587.5)) < 1, 'coversaath_utc_now() parses as the current time');
  assert.match((await pool.query('SELECT coversaath_utc_now() AS value')).rows[0].value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('julianday is declared IMMUTABLE', postgresTestOptions(), async t => {
  const { pool } = await useTestDatabase(t);
  const row = (await pool.query("SELECT provolatile FROM pg_proc WHERE proname = 'julianday'")).rows[0];
  assert.equal(row.provolatile, 'i');
});
