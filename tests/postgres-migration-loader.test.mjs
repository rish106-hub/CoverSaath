import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPostgresMigrations, postgresMigrationDirectory } from '../src/backend/database/postgres/index.js';
import { scratchMigrationDirectory } from './support/postgres.mjs';

function outsideDirectory(t) {
  const parent = mkdtempSync(join(tmpdir(), 'coversaath-pg-loader-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  return parent;
}

function assertNotAllowed(fn) {
  assert.throws(fn, error => {
    assert.equal(error.code, 'POSTGRES_MIGRATION_PATH_NOT_ALLOWED');
    assert.doesNotMatch(error.message, /\/|\\/);
    return true;
  });
}

test('migration loader accepts fixed regular files and ignores links, subdirectories and malformed names', t => {
  const outside = outsideDirectory(t);
  writeFileSync(join(outside, 'outside.sql'), 'SELECT 99;\n');
  const directory = scratchMigrationDirectory(t, {
    '002_second.sql': 'SELECT 2;\n',
    '001_first.sql': 'SELECT 1;\n',
    '3_bad.sql': 'SELECT 3;\n',
    '004_UPPER.sql': 'SELECT 4;\n',
  });
  symlinkSync(join(outside, 'outside.sql'), join(directory, '003_escape.sql'));
  mkdirSync(join(directory, '005_nested.sql'));

  assert.deepEqual(loadPostgresMigrations(directory), [
    { version: '001_first.sql', sql: 'SELECT 1;\n' },
    { version: '002_second.sql', sql: 'SELECT 2;\n' },
  ]);
});

test('migration loader refuses a directory outside the repository migration root', t => {
  const outside = outsideDirectory(t);
  writeFileSync(join(outside, '001_outside.sql'), 'SELECT 1;\n');
  assertNotAllowed(() => loadPostgresMigrations(outside));
  assertNotAllowed(() => loadPostgresMigrations(join(postgresMigrationDirectory, '..')));
  assertNotAllowed(() => loadPostgresMigrations(join(postgresMigrationDirectory, '..', '..', '..')));
});

test('migration loader refuses a directory link inside the root that points outside it', t => {
  const outside = outsideDirectory(t);
  writeFileSync(join(outside, '001_outside.sql'), 'SELECT 1;\n');
  const holder = scratchMigrationDirectory(t);
  const link = join(holder, 'escape');
  symlinkSync(outside, link, 'dir');
  assertNotAllowed(() => loadPostgresMigrations(link));
});

test('the repository migration set loads and scratch sets never join it', t => {
  scratchMigrationDirectory(t, { '999_scratch.sql': 'SELECT 1;\n' });
  const versions = loadPostgresMigrations().map(migration => migration.version);
  assert.ok(versions.length > 0);
  assert.ok(!versions.includes('999_scratch.sql'));
  assert.ok(versions.every(version => /^\d{3}_[a-z0-9_]+\.sql$/.test(version)));
});

test('a missing migration directory is refused with a coded error that carries no path', () => {
  assert.throws(() => loadPostgresMigrations('/nonexistent-coversaath-migrations'), error => {
    assert.equal(error.code, 'POSTGRES_MIGRATION_PATH_NOT_ALLOWED');
    assert.doesNotMatch(error.message, /nonexistent|\//);
    return true;
  });
});
