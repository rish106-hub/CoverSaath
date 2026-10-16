# Runbook: local PostgreSQL (Homebrew)

Scope: a developer's machine. Synthetic data only. Decisions: [ADR 0004](../adr/0004-postgresql-runtime.md). The runtime still uses SQLite until Section 3 slice S3.2 lands ([exec plan](../exec-plans/active/p1b-postgres.md)); today PostgreSQL serves the PostgreSQL tests.

Facts: PostgreSQL 17 from Homebrew (`postgresql@17`), one project-local cluster in `.local/postgres` (git-ignored), port 54329, loopback only, `C` locale. No background service is installed, nothing starts at login.

## Install (once)

```bash
brew install postgresql@17
```

The binaries are keg-only: use `/opt/homebrew/opt/postgresql@17/bin/…` (or add that directory to `PATH`).

## Create the cluster (once)

```bash
/opt/homebrew/opt/postgresql@17/bin/initdb -D .local/postgres -U coversaath --auth=trust --encoding=UTF8 --locale=C
```

`--auth=trust` is acceptable only because the server listens on loopback and a Unix socket, and holds synthetic data. Never reuse this cluster for real data.

## Start and stop

```bash
LC_ALL=C.UTF-8 /opt/homebrew/opt/postgresql@17/bin/pg_ctl -D .local/postgres -l .local/postgres.log -o "-p 54329 -k /tmp -c listen_addresses=localhost" start
```

```bash
/opt/homebrew/opt/postgresql@17/bin/pg_ctl -D .local/postgres stop -m fast
```

Without `LC_ALL`, macOS start-up fails with `FATAL: postmaster became multithreaded during startup` (logged in `.local/postgres.log`).

## Check

```bash
/opt/homebrew/opt/postgresql@17/bin/psql -h localhost -p 54329 -U coversaath -d postgres -Atc "select version()"
```

Every database must have collation `C` (ADR 0004 D4):

```bash
/opt/homebrew/opt/postgresql@17/bin/psql -h localhost -p 54329 -U coversaath -d postgres -Atc "select datname, datcollate from pg_database"
```

## Run the PostgreSQL tests

Set `TEST_DATABASE_URL=postgres://coversaath@localhost:54329/postgres` in your shell (the URL has no password; still keep real credentials out of shell history). Then:

```bash
npm test
```

Without `TEST_DATABASE_URL` the PostgreSQL tests are skipped with a visible reason. CI runs them against a `postgres:17.11` service container with `REQUIRE_POSTGRES=1`, where a missing database is a failure.

Tests create one template database per migration set (`coversaath_tpl_…`) and one throwaway database per test, and drop the throwaway ones.

## Reset

Stops the server and deletes every local PostgreSQL database. Synthetic data only.

```bash
/opt/homebrew/opt/postgresql@17/bin/pg_ctl -D .local/postgres stop -m fast
```

```bash
rm -rf .local/postgres .local/postgres.log
```

Then create the cluster and start it again (above).

## Not covered

Production, TLS, roles and least privilege, backups and restore drills (S3.3), connection pooling limits under load (no workload numbers exist).
