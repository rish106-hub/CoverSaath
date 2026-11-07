// Fails when a PostgreSQL migration is edited, renamed or deleted instead of appended.
// Usage: node scripts/check-migrations-append-only.mjs --base <git-ref> [--repo <dir>]
// An all-zero base (GitHub push that has no previous commit) skips the check.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const migrationsDir = 'src/backend/database/postgres/migrations';
const newMigration = /^\d{3}_[a-z0-9_]+\.sql$/;
const zeroSha = /^0{40}$/;

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index > 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const repo = resolve(argValue('--repo', '.'));
const base = argValue('--base', '');

if (!base) {
  process.stderr.write('migration check: --base <git-ref> is required.\n');
  process.exit(2);
}
if (zeroSha.test(base)) {
  process.stdout.write('migration check: no previous commit (all-zero base); nothing to compare.\n');
  process.exit(0);
}

try {
  git(repo, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]);
} catch {
  process.stderr.write(`migration check: base ref "${base}" not found. Fetch full history (fetch-depth: 0).\n`);
  process.exit(2);
}

// --no-renames turns a rename into a delete plus an add, so a moved migration is caught as a delete.
const diff = git(repo, ['diff', '--no-renames', '--name-status', `${base}...HEAD`, '--', migrationsDir]);
const violations = [];
let appended = 0;

for (const line of diff.split('\n').filter(Boolean)) {
  const [status, path] = line.split('\t');
  const name = path.slice(migrationsDir.length + 1);
  if (status !== 'A') {
    violations.push(`${path}: ${status === 'M' ? 'edited' : status === 'D' ? 'deleted' : `changed (${status})`}. Migrations are append-only; add a new file instead.`);
  } else if (!newMigration.test(name)) {
    violations.push(`${path}: new migration must be named NNN_snake_case.sql.`);
  } else {
    appended += 1;
  }
}

if (violations.length > 0) {
  process.stderr.write(`migration check failed:\n${violations.map(v => `  ${v}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`migration check passed: ${appended} migration(s) appended, none edited.\n`);
