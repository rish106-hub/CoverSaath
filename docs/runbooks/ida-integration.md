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

## 4. Rollback

- Turn it off: `REFERENCE_DATA_ENABLED=false` (the default) and restart. The port then refuses every read, cached or not.
- Remove imported rows (owner approval; public reference data only): `DELETE FROM reference_cache WHERE etag LIKE 'import-%';`
- Code: revert the `feat/ida-integration` commits. No migration was added.
