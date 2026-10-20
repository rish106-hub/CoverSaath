import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openDatabase } from '../src/backend/database/database.js';

const scratch = () => mkdtempSync(join(resolve('.local'), 'dbpath-'));

test('S7: a relative .local path resolves against the working directory, not .local twice', () => {
  const dir = scratch();
  const relativePath = join('.local', dir.split('/').pop(), 'x.sqlite');
  try {
    openDatabase({ path: relativePath }).close();
    assert.equal(existsSync(join(dir, 'x.sqlite')), true);
    assert.equal(existsSync(join(dir, '.local')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('S7: paths outside .local are rejected', () => {
  assert.throws(() => openDatabase({ path: '../x.sqlite' }), /within \.local/);
  assert.throws(() => openDatabase({ path: '/tmp/x.sqlite' }), /within \.local/);
});

test('S7: a legacy .local/.local database blocks startup with a coded error and is never moved', () => {
  const name = `legacy-${process.pid}.sqlite`;
  const legacy = resolve('.local', '.local', name);
  mkdirSync(resolve('.local', '.local'), { recursive: true });
  writeFileSync(legacy, '');
  try {
    assert.throws(() => openDatabase({ path: join('.local', name) }), { code: 'DATABASE_LEGACY_PATH' });
    assert.equal(existsSync(legacy), true);
    assert.equal(existsSync(resolve('.local', name)), false);
  } finally { rmSync(legacy, { force: true }); }
});
