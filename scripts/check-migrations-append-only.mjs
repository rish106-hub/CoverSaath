// Fails when a PostgreSQL migration is edited, renamed or deleted instead of appended.
// Usage: node scripts/check-migrations-append-only.mjs --base <git-ref> [--repo <dir>]
// The caller skips the step when GitHub gives an all-zero base (a push with no previous commit); here it is just an unknown ref.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const migrationsDir = 'src/backend/database/postgres/migrations';
// Non-empty alphanumeric segments joined by single underscores (no `030_.sql`, no `030__x.sql`).
const newMigration = /^(\d{3})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;
// A base is a commit SHA or a git ref name. It must not start with '-' (option injection), hold '..', whitespace, control
// characters or the characters git forbids in refs. '+', '@' and '#' are legal in refs, so they are allowed.
const safeBase = /^[A-Za-z0-9][^\s\x00-\x1f\x7f~^:?*[\\]{0,199}$/;

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
const isSha = /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(base);
let validRef = safeBase.test(base) && !base.includes('..');
if (validRef && !isSha) {
  // Git's own rules for ref names (no '//', '/.', '@{', trailing '.lock' and so on). The value cannot start with '-'.
  try { execFileSync('git', ['check-ref-format', '--allow-onelevel', base], { stdio: 'ignore' }); } catch { validRef = false; }
}
if (!validRef) {
  process.stderr.write('migration check: --base must be a commit SHA or a valid git ref name.\n');
  process.exit(2);
}

try {
  git(repo, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]);
} catch {
  process.stderr.write(`migration check: base ref "${base}" not found. Fetch full history (fetch-depth: 0).\n`);
  process.exit(2);
}

// A new migration must sort after every migration already in the base tree, or it could run before schema it depends on.
let highestBase = 0;
for (const line of git(repo, ['ls-tree', '--name-only', base, `${migrationsDir}/`]).split('\n').filter(Boolean)) {
  const match = line.slice(migrationsDir.length + 1).match(/^(\d{3})_/);
  if (match) highestBase = Math.max(highestBase, Number(match[1]));
}

// Endpoints are compared directly (not merge-base): after a force-push the previous tip may not be an ancestor of HEAD.
// --no-renames turns a rename into a delete plus an add, so a moved migration is caught as a delete.
const diff = git(repo, ['diff', '--no-renames', '--name-status', base, 'HEAD', '--', migrationsDir]);
const violations = [];
const seenNumbers = new Set();
let appended = 0;

for (const line of diff.split('\n').filter(Boolean)) {
  const [status, path] = line.split('\t');
  const name = path.slice(migrationsDir.length + 1);
  if (status !== 'A') {
    violations.push(`${path}: ${status === 'M' ? 'edited' : status === 'D' ? 'deleted' : `changed (${status})`}. Migrations are append-only; add a new file instead.`);
  } else if (!newMigration.test(name)) {
    violations.push(`${path}: new migration must be named NNN_snake_case.sql.`);
  } else if (Number(name.slice(0, 3)) <= highestBase) {
    violations.push(`${path}: new migration number must be higher than the highest existing migration (${String(highestBase).padStart(3, '0')}).`);
  } else if (seenNumbers.has(name.slice(0, 3))) {
    violations.push(`${path}: another new migration already uses number ${name.slice(0, 3)}.`);
  } else {
    seenNumbers.add(name.slice(0, 3));
    appended += 1;
  }
}

if (violations.length > 0) {
  process.stderr.write(`migration check failed:\n${violations.map(v => `  ${v}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`migration check passed: ${appended} migration(s) appended, none edited.\n`);
