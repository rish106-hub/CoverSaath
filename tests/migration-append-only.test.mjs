import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, unlinkSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/check-migrations-append-only.mjs', import.meta.url));
const dirName = 'src/backend/database/postgres/migrations';

function git(repo, args) {
  return execFileSync('git', ['-C', repo, '-c', 'user.name=ci', '-c', 'user.email=ci@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
}

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'migration-append-only-'));
  git(repo, ['init', '-q']);
  mkdirSync(join(repo, dirName), { recursive: true });
  writeFileSync(join(repo, dirName, '001_base.sql'), 'create table a (id int);\n');
  writeFileSync(join(repo, dirName, '002_more.sql'), 'create table b (id int);\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'base']);
  const base = git(repo, ['rev-parse', 'HEAD']).trim();
  return { repo, base };
}

function commitAll(repo, message) {
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', message]);
}

function run(repo, base) {
  return spawnSync(process.execPath, [script, '--repo', repo, '--base', base], { encoding: 'utf8' });
}

test('appending a new migration passes', () => {
  const { repo, base } = makeRepo();
  try {
    writeFileSync(join(repo, dirName, '003_new.sql'), 'create table c (id int);\n');
    commitAll(repo, 'append');
    const result = run(repo, base);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /1 migration\(s\) appended, none edited/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('editing an existing migration fails', () => {
  const { repo, base } = makeRepo();
  try {
    writeFileSync(join(repo, dirName, '001_base.sql'), 'create table a (id bigint);\n');
    commitAll(repo, 'edit');
    const result = run(repo, base);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /001_base\.sql: edited/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('deleting an existing migration fails', () => {
  const { repo, base } = makeRepo();
  try {
    unlinkSync(join(repo, dirName, '002_more.sql'));
    commitAll(repo, 'delete');
    const result = run(repo, base);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /002_more\.sql: deleted/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('renaming an existing migration fails (seen as delete plus add)', () => {
  const { repo, base } = makeRepo();
  try {
    renameSync(join(repo, dirName, '002_more.sql'), join(repo, dirName, '002_renamed.sql'));
    commitAll(repo, 'rename');
    const result = run(repo, base);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /002_more\.sql: deleted/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a new migration with a bad name fails', () => {
  const { repo, base } = makeRepo();
  try {
    writeFileSync(join(repo, dirName, 'notes.sql'), '-- x\n');
    commitAll(repo, 'bad name');
    const result = run(repo, base);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /notes\.sql: new migration must be named NNN_snake_case\.sql/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('changes outside the migrations directory are ignored', () => {
  const { repo, base } = makeRepo();
  try {
    mkdirSync(join(repo, 'src/other'), { recursive: true });
    writeFileSync(join(repo, 'src/other/001_base.sql'), 'x\n');
    writeFileSync(join(repo, dirName, '001_base.sql'), 'create table a (id int);\n');
    commitAll(repo, 'unrelated');
    const result = run(repo, base);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('an all-zero base skips the check', () => {
  const { repo } = makeRepo();
  try {
    const result = run(repo, '0'.repeat(40));
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /nothing to compare/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('an unknown base ref fails closed', () => {
  const { repo } = makeRepo();
  try {
    const result = run(repo, 'does-not-exist');
    assert.equal(result.status, 2);
    assert.match(result.stderr, /not found/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a malformed base value fails closed before git runs', () => {
  const { repo } = makeRepo();
  try {
    for (const bad of ['--output=/tmp/x', 'main..HEAD', 'a b', 'x;rm -rf', '$(id)', '-n']) {
      const result = run(repo, bad);
      assert.equal(result.status, 2, `${bad}: ${result.stderr}`);
      assert.match(result.stderr, /commit SHA or a plain ref name/);
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
