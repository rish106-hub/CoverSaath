import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPostgresMigrations } from '../src/backend/database/postgres/index.js';

test('migration loader accepts fixed regular files and ignores links and malformed names', t => {
  const parent = mkdtempSync(join(tmpdir(), 'coversaath-pg-loader-'));
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
