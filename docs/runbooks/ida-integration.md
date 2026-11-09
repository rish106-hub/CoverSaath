# Runbook: insurance-data-api (IDA) integration

Decision: ADR 0021 (no second service; import into the reference cache). Audit: `docs/architecture/insurance-data-api-audit.md`.
Synthetic data only. Never set IDA's `REMOTE_FETCH_ENABLED` or `SOURCE_REVALIDATION_ENABLED`; never fetch insurer sites or PDFs. Source rights and the missing IDA licence are **FOR LEGAL REVIEW**.

## 1. Run IDA locally (developer machine only)

IDA lives outside this repository (local copy: `../insurance-data-api`, never pushed). Node 22+ and PostgreSQL 17.

With Docker: `npm install && npm run setup:local && npm run dev` (Postgres on port 55432).

Without Docker, use the local PostgreSQL 17 from `docs/runbooks/local-postgres.md` (port 54329 here):

```sh
cd ../insurance-data-api
npm install
createdb -h localhost -p 54329 -U coversaath ida_local
export DATABASE_URL=postgres://coversaath@localhost:54329/ida_local
npm run fixtures:generate && npm run db:migrate && npm run db:seed && npm run registry:import
npm run db:seed        # run seed again: the first run grants entitlements before the products exist
npm run dev            # http://127.0.0.1:3000
IDA_DEV_KEY=local-sandbox-key   # fixed, documented, fictional-data-only key (see below)
curl -H "Authorization: Bearer $IDA_DEV_KEY" 'http://127.0.0.1:3000/v1/products?limit=2'
```

`local-sandbox-key` is IDA's fixed, documented development key for fictional data. It is not a secret and must never exist on a hosted IDA.

IDA tests: `createdb ... insurance_data_test`, migrate it, then `DATABASE_URL=postgres://coversaath@localhost:54329/insurance_data_test npm test` (56 tests; the integration tests skip unless the database is named `insurance_data_test`). Also `npm run typecheck`, `npm run lint`, `npm run openapi:lint`. `npm run test:pdf-worker` needs Python 3.10 or later.

Expected: `/v1/versions/{id}/facts` answers 404 for every version. The sandbox tenant has no fact entitlement and synthetic facts cannot be published. That is correct, not a fault.

## 2. Point CoverSaath at a local IDA (service mode)

In `.env.local` (never commit):

```sh
REFERENCE_DATA_ENABLED=true
REFERENCE_DATA_BASE_URL=http://127.0.0.1:3000
REFERENCE_DATA_API_KEY=local-sandbox-key
```

Only https, or http on a loopback host, is accepted. If the base URL is set without the key, startup fails. The first call after IDA starts can exceed the 2 s timeout while IDA compiles; it fails closed with `REFERENCE_DATA_UNAVAILABLE` and the next call succeeds.

Contract drift check against your IDA checkout:

```sh
IDA_OPENAPI_PATH=../insurance-data-api/specifications/openapi.yaml node --test tests/insurance-data-contract.test.mjs
```

## 3. Hosted or shared environments (import mode, ADR 0021)

No IDA runs anywhere hosted. Set `REFERENCE_DATA_ENABLED=true` and leave `REFERENCE_DATA_BASE_URL` empty. Then load a file:

```sh
node scripts/reference-import.mjs --file scripts/fixtures/reference-import-synthetic.json --dry-run   # validates, no database
node --env-file-if-exists=.env.local scripts/reference-import.mjs --file scripts/fixtures/reference-import-synthetic.json --ttl-days 30
```

- The file format is described at the top of `src/backend/services/reference-data-import.js`. Each entry is an allow-listed endpoint, its parameters, and the IDA response body.
- One invalid entry rejects the whole file and writes nothing. The output gives counts and an entry index only.
- `data_class: synthetic` cannot carry verified-looking data. Real data needs `data_class: owner_approved`, a `rights_reference` from the IDA rights register, and `--allow-owner-approved`. This gate is a placeholder pending the legal rights register: it is honour-system, not proof of rights. **FOR LEGAL REVIEW**: do not import real insurer data until the owner has recorded the source rights. The class is stored in the cache `etag` marker (`import-<class>-<digest>`) and printed, with a short printable `rights_reference`, in the summary.
- The CLI prints the target database host only. Writing to a non-loopback host (not localhost, 127.0.0.1, ::1) needs `--yes`; without it the CLI exits non-zero with `REFERENCE_IMPORT_CONFIRM_REQUIRED`. Option values starting with `--` are rejected and files over 8 MB are refused.
- Import-only mode: once rows pass `--ttl-days`, a read returns code `REFERENCE_DATA_NOT_CONFIGURED` (HTTP 503) until the next import. `textList` in `schemas.js` deliberately accepts a bare string as a one-item list.
- A hosted import is a change to a remote database. It needs owner approval.
- After `--ttl-days` the rows are served labelled stale. Re-run the import to refresh them.

## 3a. Offline flow: IDA export -> convert -> import (admin tooling, no beta counterpart)

Who does what: the IDA operator runs the export (IDA repo, `DATABASE_URL` only); the CoverSaath operator runs convert, dry-run and import. Nothing here is reachable from the app or the beta; it is local admin tooling only. No network call, no new dependency, no migration.

```sh
# 1. In the IDA repo (offline): rights-gated export of one product. Add --allow-synthetic only to rehearse with synthetic rows.
npm run export:product -- <product-id> --out /secure/path/export.json
# 2. In CoverSaath: convert (export-v2 only), mode 0600, refuses to overwrite without --force, prints counts only.
node scripts/reference-import-convert.mjs --in /secure/path/export.json --out /secure/path/import.json
# 3. Validate again with the importer, no database.
node scripts/reference-import.mjs --file /secure/path/import.json --dry-run [--allow-owner-approved]
# 4. Import (owner approval for any hosted database; see section 3).
node --env-file-if-exists=.env.local scripts/reference-import.mjs --file /secure/path/import.json --ttl-days 30 [--allow-owner-approved]
```

Rehearsal with the shipped synthetic fixture: `node scripts/reference-import-convert.mjs --in scripts/fixtures/ida-export-v2-synthetic.json --out <new file>`.

What is checked: `export_schema_version` is exactly 2; the export, product, versions and facts all carry the same `data_class`; at least one `uin` identifier exists (one `products.search` entry per UIN); `latest_snapshot_id` is present and only facts of that snapshot are kept (IDA lists newest first; older snapshots are dropped and counted); after conversion the object runs through the importer's own validator (`prepareReferenceImport`) and the convert fails if it is invalid. Errors are coded (`IDA_EXPORT_SCHEMA_UNSUPPORTED`, `IDA_EXPORT_INVALID`, `IDA_EXPORT_IDENTIFIER_MISSING`, `IDA_EXPORT_DATA_CLASS_REFUSED`, `IDA_EXPORT_RIGHTS_REFERENCE_INVALID`, `IDA_EXPORT_OUTPUT_EXISTS`, `IDA_EXPORT_SELF_CHECK_FAILED`, `IDA_EXPORT_UNREADABLE`) and never print a value.

Mapping rules (**FOR LEGAL REVIEW**):
- `data_class: synthetic` becomes `verification_status: synthetic_test`, `freshness: test_fixture`, `version_synthetic: true`. The importer then refuses anything verified-looking.
- `data_class: owner_approved` needs the export's `rights_reference` to be 1 to 200 printable ASCII characters. The converter refuses a longer value with `IDA_EXPORT_RIGHTS_REFERENCE_INVALID`; it never truncates. Imported labels are the least trusted real ones (`source_observed`, `unknown`, fact `candidate`, empty coverage), so a converted fact is never `verified`. The import still needs `--allow-owner-approved`, which is honour-system, not proof of rights.
- Quotes are never carried: the importer has no field for quote text. Evidence keeps document id, page number and document sha256 only. Quote text on evidence with `quote_included: false` makes the export invalid.
- Only `value_json.text` (a string) is carried as the fact value; other `value_json` kinds are dropped (the importer drops values of non-usable facts anyway). Nothing else is invented.
- Imported reference data is context only (X1 rule 8). It must not feed eligibility, money, consent or release.

Rollback: the converted file is a local artefact; delete it. Cache rows expire by `--ttl-days` (served labelled stale, never refreshed) and can be removed with the delete marker in section 4. No code or schema change is needed to undo an import.

## 4. Rollback

- Turn it off: `REFERENCE_DATA_ENABLED=false` (the default) and restart. The port then refuses every read, cached or not.
- Remove imported rows (owner approval; public reference data only): `DELETE FROM reference_cache WHERE etag LIKE 'import-%';`
- Code: revert the `feat/ida-integration` commits. No migration was added.
- API: `GET /api/v1/reference/products?uin=|insurerId=|q=` (bearer auth, read-only, context only). Disabled, stale or uncached data answers 503 `REFERENCE_DATA_NOT_CONFIGURED`; a bad query answers 400 `REFERENCE_DATA_REQUEST_INVALID`. The route never accepts or returns household data and its result must not feed eligibility, money, consent or release.
