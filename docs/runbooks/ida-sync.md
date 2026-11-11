# Runbook: IDA sync (reference products and network hospitals)

Extends [ida-integration.md](ida-integration.md) (ADR 0021: no second service; reference data is imported or read through the insurance-data client, context only). Synthetic data only. Source rights and the missing IDA licence are **FOR LEGAL REVIEW**. Nothing here is deployed.

## Where IDA lives

The insurance-data-api repository is a **local sibling checkout with no git remote**. It is run on a developer machine only and is never pushed or hosted. CoverSaath reaches it either as a local service (`REFERENCE_DATA_BASE_URL` on loopback) or through the offline export, convert and import flow in ida-integration section 3a.

## What the sync job does

Job kind `reference.import` is registered by the worker (`src/server/worker.js`) only while `HOLDINGS_ENABLED` is exactly `true`. The job payload `scope` picks one of three imports (`src/backend/jobs/holding-product-handlers.js`); anything else is a non-retryable `JOB_PAYLOAD_INVALID`:

- **registry**: `HoldingProductService.importRegistry()` builds the insurer and product registry from the reference source.
- **product**: `importReference` for one `policyProfileId` of a household (the fetch-reference step after insurer detection). It reads only through `ReferenceDataPort`; a failure degrades to unknown, never to a guess.
- **hospitals**: `NetworkHospitalService.importHospitals()` pages the `hospitals.export` reference endpoint (cursor, at most 100 pages per run) and upserts into `network_hospitals` (migration 055). Upserts are idempotent. It needs `REFERENCE_DATA_ENABLED=true` and a reachable reference source, else it fails with `REFERENCE_DATA_DISABLED` (503, not retryable).

`network_hospitals` is public reference data: no household, member or consent column. Household erasure does not touch it. A lookup skips rows outside `valid_from` and `valid_to` when the source gives them; `synced_at` is the last upsert.

## Run it locally

1. Start IDA (ida-integration section 1) and set in `.env.local`: `REFERENCE_DATA_ENABLED=true`, `REFERENCE_DATA_BASE_URL` (loopback), `REFERENCE_DATA_API_KEY`, `HOLDINGS_ENABLED=true`.
2. `npm run db:init`, then `npm run worker`. Detection and product jobs come from the holdings pipeline; hosted use is import mode only (no live IDA).
3. Lookup: `GET /api/v1/holdings/{id}/hospitals?pincode=560001` (bearer session; owner of the holding only; a non-6-digit pincode is 400 `HOSPITAL_PINCODE_INVALID`; flag off is 503 `HOLDINGS_DISABLED`).

Import mode (no IDA service): `node scripts/reference-import.mjs --file <path> --dry-run`, then `node --env-file-if-exists=.env.local scripts/reference-import.mjs --file <path> --ttl-days 30`. A non-loopback database needs `--yes` and owner approval. Details and the converter: ida-integration sections 3 and 3a.

## Rollback and scale

Set `HOLDINGS_ENABLED=false` or `REFERENCE_DATA_ENABLED=false` and restart; the port then refuses every read. Remove imported cache rows only with owner approval (ida-integration section 4). Hospitals: pincode equality is enough until rows exceed 100k or radius queries exceed 50 requests per second; PostGIS is then the next step (migration 055 note). Chat procedure planning does not use hospitals yet.
