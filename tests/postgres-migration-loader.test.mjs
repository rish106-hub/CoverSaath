import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPostgresMigrations, postgresTestMigrationRoot } from '../src/backend/database/postgres/index.js';

test('migration loader accepts fixed regular files and ignores links and malformed names', t => {
  mkdirSync(postgresTestMigrationRoot, { recursive: true });
  const parent = mkdtempSync(join(postgresTestMigrationRoot, 'loader-'));
  const directory = join(parent, 'migrations');
  const outside = join(parent, 'outside.sql');
  t.after(() => rmSync(parent, { recursive: true, force: true }));

  mkdirSync(directory);
  writeFileSync(outside, 'SELECT 99;\n');
  writeFileSync(join(directory, '002_second.sql'), 'SELECT 2;\n');
  writeFileSync(join(directory, '001_first.sql'), 'SELECT 1;\n');
  writeFileSync(join(directory, '3_bad.sql'), 'SELECT 3;\n');
  symlinkSync(outside, join(directory, '003_escape.sql'));

  assert.deepEqual(loadPostgresMigrations(directory), [
    { version: '001_first.sql', sql: 'SELECT 1;\n' },
    { version: '002_second.sql', sql: 'SELECT 2;\n' },
  ]);
});

test('migration loader rejects directories outside its fixed production and test roots', t => {
  const directory = mkdtempSync(join(tmpdir(), 'coversaath-pg-outside-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, '001_outside.sql'), 'SELECT 1;\n');

  assert.throws(() => loadPostgresMigrations(directory), { code: 'POSTGRES_MIGRATION_PATH_NOT_ALLOWED' });
});

test('migration loader rejects an allowed-root directory link that resolves outside', t => {
  mkdirSync(postgresTestMigrationRoot, { recursive: true });
  const allowedParent = mkdtempSync(join(postgresTestMigrationRoot, 'linked-loader-'));
  const outside = mkdtempSync(join(tmpdir(), 'coversaath-pg-linked-outside-'));
  const linkedDirectory = join(allowedParent, 'migrations');
  t.after(() => rmSync(allowedParent, { recursive: true, force: true }));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, '001_outside.sql'), 'SELECT 1;\n');
  symlinkSync(outside, linkedDirectory);

  assert.throws(() => loadPostgresMigrations(linkedDirectory), { code: 'POSTGRES_MIGRATION_PATH_NOT_ALLOWED' });
});
