# CI gates

Workflows: `.github/workflows/ci.yml` (CI) and `.github/workflows/dependency-review.yml`.
Required check today: `CI / verify`. Do not rename the workflow or the `verify` job without
updating the repository ruleset.

## Gates on main

| Gate | Where | What it needs | What it proves |
| --- | --- | --- | --- |
| Project checks | `CI / verify`, `npm run check` | Node 26, `npm ci`, PostgreSQL 17 service, `TEST_DATABASE_URL`, `REQUIRE_POSTGRES=1` | Architecture boundaries, all tests against real PostgreSQL, backend entry point |
| Safety evals | `CI / verify`, `npm run eval:safety` | none | Safety evaluation dataset passes its threshold |
| Node 25 permissions | `CI / node25-permissions` | Node 25, `npm ci` | PDF child sandbox denies permissions on Node 25 |
| Dependency review | `Dependency Review / dependency-review` | repo dependency graph enabled | No new dependency with high or critical advisory |
| Whitespace | `CI / hygiene`, `git diff --check <base> HEAD` | full history | No whitespace errors in the change |
| Migrations append-only | `CI / hygiene`, `scripts/check-migrations-append-only.mjs` | full history, base SHA | Migrations under `src/backend/database/postgres/migrations/` are only added (named `NNN_snake_case.sql`, numbered above the highest migration in the base). Edits, renames, deletes, a number that is not higher and a name with empty segments fail. |
| Secret scan | `CI / secret-scan`, `gitleaks git` with `.gitleaks.toml` | full history, gitleaks 8.30.1 (downloaded, sha256 pinned in the workflow) | No secret in any commit reachable from HEAD. The allowlist is read from the base revision, so a change to `.gitleaks.toml` applies after it merges. |

Base SHA for `hygiene`: pull request base tip (`github.event.pull_request.base.sha`), or the
previous tip on push. An all-zero base (first push of a branch) skips the diff and migration
checks. An unknown base fails closed (exit 2).

Local runs:

```sh
node --test tests/migration-append-only.test.mjs
node scripts/check-migrations-append-only.mjs --base origin/main
git diff --check origin/main HEAD   # rebase first: this compares endpoints
gitleaks git --config .gitleaks.toml --redact --no-banner --exit-code 1 .
```

## Gates not on main (enable at merge)

These tests or inputs live only on unmerged work. Do not add a CI job for them on main. When
the owning branch merges, add its command as a step in `CI / verify` (or in a new job) and
confirm the job is green on that branch first.

| Gate | Command to add at merge | Brought by |
| --- | --- | --- |
| Analytics allow-list (events and fields allowed to leave the app) | `node --test <analytics allow-list test file>` | Not found by name on any local or origin branch. Owner to confirm. |

Already on main and run inside `npm test` (no new step): `tests/rls-coverage.test.mjs`,
`tests/column-encryption-at-rest.test.mjs` (column encryption) and the `tests/privacy-gate-*.test.mjs`
files (privacy-gate corpus). The analytics allow-list test was not found by name on main; its name is a
placeholder until the owning branch is identified.

## Making the new checks required

`CI / hygiene` and `CI / secret-scan` run on every pull request and push to main. Add them to the
repository ruleset only after one green run on main. Keep the required check list minimal and
never mark a skipped job as required.

## Maintenance

- Bump gitleaks: change `GITLEAKS_VERSION` and `GITLEAKS_SHA256` in `secret-scan` together. Take the
  sha256 from the upstream `gitleaks_<version>_checksums.txt` for the same release.
- Changing the migration rule (for example allowing a squash before a release) is a decision: record it
  in an ADR first, then change `scripts/check-migrations-append-only.mjs` and its tests together.

## Rollback

Remove the `hygiene` and `secret-scan` jobs from `.github/workflows/ci.yml`. The `verify` job
steps can go back to the separate architecture, test and build steps. No data is affected.
