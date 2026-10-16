# Runbook: local SQLite database

Scope: a developer's local database only. It does not cover production; no deployment, managed database, backup service or recovery target exists (see [data.md](../architecture/data.md)). Use synthetic data only.

Facts this runbook relies on (`src/backend/database/database.js`):

- Default file `.local/knowvia.sqlite`; the `DATABASE_PATH` environment variable overrides it. `.local/` is git-ignored.
- Opening a file database enables WAL (`PRAGMA journal_mode = WAL`), so a running or unclean-stopped server leaves `<file>-wal` and `<file>-shm` next to the file.
- Migrations `001`-`006` run on open. The API opens the database lazily on its first `/api/v1` request.

## Create or migrate

```bash
npm run db:init
```

- Reads `.env.local` if present (`node --env-file-if-exists=.env.local`), so `DATABASE_PATH` can live there. Set only the variable name in `.env.local`; never paste secrets into a shell history or this document.
- Creates the directory (mode 0700), applies any new migrations and prints JSON: `path`, `valid`, `missingTables`, `missingViews`, `missingTriggers`, `missingIndexes`, `missingColumns`, `foreignKeyErrors`, `integrity`, `migrationCount`.
- Healthy output: `"valid": true`, `"integrity": "ok"`, `"migrationCount": 6`.
- The command exits 0 even when `valid` is `false`. Read the JSON, do not rely on the exit code. `GET /api/v1/ready` also returns 503 with the same detail when the schema is invalid or `KNOWVIA_BOOTSTRAP_TOKEN` is not set.

## "Applied migration changed"

Symptom: `Migration failed: <NNN_name.sql>: Applied migration changed: <NNN_name.sql>` from `db:init` or the first API request. The stored checksum in `schema_migrations` differs from the file on disk. The migration is rolled back and nothing is half-applied.

1. Check the file: `git status` and `git diff -- src/backend/database/migrations/`. A merged migration must never be edited (`src/backend/database/AGENTS.md`). If you edited it, restore it with `git checkout -- <file>` and add a new numbered migration instead.
2. If the file is unchanged, the database was created by a different version of that migration (for example an earlier draft). `docs/exec-plans/completed/p0-baseline-intake.md` records that an earlier draft of migration 005 was never released and a local database that applied it must be recreated. Back up the file (below), then reset (below).
3. Do not edit `schema_migrations` by hand and do not add checksums to `legacyMigrationChecksums` to silence the error. That list is a reviewed exception for one known `002` checksum only.

## Missing critical trigger, table, index or column

Symptom: `db:init` prints `"valid": false` with a non-empty `missingTriggers` (or other) list, or `/api/v1/ready` returns 503 `not_ready`. Opening the database does not itself fail; the API stays up but is not ready.

- The names come from `criticalTriggers`, `expectedTables`, `criticalIndexes` and `requiredColumns` in `database.js`. All six migrations are recorded as applied, so the objects were removed or never created outside the migration runner.
- Do not recreate triggers by hand. Triggers carry consent and authority invariants (`docs/architecture/data.md`); a hand-made copy can drift from the migration. Reset from the migrations instead (below), or restore a known-good backup and rerun `npm run db:init`.
- `foreignKeyErrors` or `integrity` other than `ok` mean file damage. Restore a backup, or reset if the data is synthetic.

## Back up and restore

Stop the API (and `npm run dev`) first. A copy taken while the server runs can miss pages that are still in the WAL.

```bash
# Replace the path if DATABASE_PATH points elsewhere. Do not print the .env.local contents.
mkdir -p .local/backups
stamp=$(date -u +%Y%m%dT%H%M%SZ)
for f in .local/knowvia.sqlite .local/knowvia.sqlite-wal .local/knowvia.sqlite-shm; do
  [ -e "$f" ] && cp -p "$f" ".local/backups/$(basename "$f").$stamp"
done
```

Copy the main file and whichever `-wal` and `-shm` files exist, as one set. Do not copy only the main file. The `.local/` directory is git-ignored; the backup is unencrypted, so keep it local and synthetic.

Restore, with the server stopped:

```bash
cp -p ".local/backups/knowvia.sqlite.$stamp" .local/knowvia.sqlite
rm -f .local/knowvia.sqlite-wal .local/knowvia.sqlite-shm   # stale WAL files must not be replayed onto the restored file
[ -e ".local/backups/knowvia.sqlite-wal.$stamp" ] && cp -p ".local/backups/knowvia.sqlite-wal.$stamp" .local/knowvia.sqlite-wal
[ -e ".local/backups/knowvia.sqlite-shm.$stamp" ] && cp -p ".local/backups/knowvia.sqlite-shm.$stamp" .local/knowvia.sqlite-shm
npm run db:init
```

Then confirm `"valid": true`. Restoring revives sessions and consent state as they were at backup time; a revocation made after the backup is lost, so re-apply revocations before using the data. No restore drill is automated or tested.

Note: `.env.example` lists `DOCUMENT_STORAGE_PATH`, but no code under `src/` reads it, so there are no stored document files to back up today.

## Reset a local database

This deletes all local households, sessions, cases, consents and audit events. Synthetic data only.

1. Stop the API and `npm run dev`.
2. Confirm the target: `DATABASE_PATH` from `.env.local` or the default `.local/knowvia.sqlite`. Make sure it is inside `.local/`.
3. Optionally back up first (above).
4. Remove the file set:

   ```bash
   rm -f .local/knowvia.sqlite .local/knowvia.sqlite-wal .local/knowvia.sqlite-shm
   ```

5. `npm run db:init`, then check `"valid": true` and `"migrationCount": 6`.
6. Start the app and use `KNOWVIA_BOOTSTRAP_TOKEN` (32 to 256 characters, set in `.env.local`) to create a new household. Old session tokens no longer work.

Tests do not touch this file: they use `:memory:` or temporary databases.

## Not covered

- Production or shared environments, PostgreSQL (planned in ADR 0002, not built), replication, point-in-time recovery, encrypted backups, restore drills, RPO/RTO (Not decided).
- Retention execution and legal-hold handling (Not decided; see `docs/architecture/data.md`).
- Rolling back a migration. Migrations are forward-only; the repository rules prefer expand-only changes with a forward fix or restore path (`src/backend/database/AGENTS.md`).
- Incident response and credential rotation.
