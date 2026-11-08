# ADR 0021: Reference data without a second service (insurance-data-api hosting)

- Status: Accepted-pending-owner (2026-11-08). **Needs owner acceptance before merge or any non-synthetic import.** Code: import path and contract test on branch `feat/ida-integration`. No cloud resource, account or secret was created.
- Synthetic data only. Statements about licences and source rights are an engineering reading and are **FOR LEGAL REVIEW**.
- Related: ADR 0011 (Supabase + Fly, one database, one schema per segment), X1 audit `docs/architecture/insurance-data-api-audit.md`, B3 port `src/backend/services/reference-data-port.js`, D3 cache (migration 033), runbook `docs/runbooks/ida-integration.md`.

## Context

- The insurance-data-api (IDA) is a separate TypeScript/Fastify service with its own PostgreSQL schema (17 migrations, 35 tables). It serves read-only insurer, product, version and verified-fact endpoints behind a per-tenant bearer key.
- Run locally on 2026-11-08 against PostgreSQL 17: all 56 of its tests pass, typecheck, lint, format and OpenAPI lint pass. It holds only 30 fictional products. Its `/facts` route can never return a fact today: synthetic facts cannot be published (schema CHECK), and no real source has an approved rights record.
- The zip has no LICENSE file. CoverSaath has no written right to copy, modify or host the IDA code (X1 section 2). **FOR LEGAL REVIEW.**
- CoverSaath already has the consumer side: an allow-listed read-only client (`src/integrations/insurance-data/`), the ReferenceDataPort and the D3 reference cache. Every response is validated against pinned schemas and unusable facts become `unknown`.
- So a hosted IDA would today serve only fictional products and no facts, and hosting its code is legally unclear.

## Options (prototype, synthetic data, rough monthly USD; prices are list prices as understood on 2026-11-08 and must be checked before buying)

| Option | New accounts | New paid resource | Rough cost per month | Notes |
| --- | --- | --- | --- | --- |
| (a) Second Fly app (shared-cpu-1x 256 MB, scale to zero) plus its own small Fly Postgres | none (Fly org exists) | 2 machines, 1 volume | about 2 to 5 (Postgres VM about 2 always on, app cents to 2, volume about 0.15 per GB) | Most moving parts. Cold start after scale-to-zero (plus tsx compile) can exceed the client's 2 s timeout; the first call after idle fails closed and is served from cache. |
| (b) Second Fly app, data in a new schema `ida` inside the existing Supabase `coversaath` database | none | 1 machine | about 0 to 2 (app only) | Allowed by ADR 0011 (one schema per segment, own service, own role). Verified: IDA migrations, seed and import run unchanged with `search_path=ida` and leave `public.schema_migrations` untouched (both use an unqualified `schema_migrations` table, so the search path is load-bearing). Needs a dedicated role with `search_path = ida` and no grants on `public`; the transaction pooler may drop a startup `options` search path, so set it on the role. |
| (c) Second free Supabase project plus a Fly app | none if under the free 2-project limit | 1 machine | about 0 to 2 (app only); about 10 more if the org is on a paid plan | Free projects pause after about a week idle; a second project means a second set of credentials and backups. |
| (d) No second service: import reference responses into the existing reference cache | none | none | 0 | Chosen. `scripts/reference-import.mjs` loads a validated file; the port serves it. IDA runs only on a developer machine for contract checks. |

AWS was not considered further: it adds an account and paid resources and is not cheaper for a single small API.

## Decision

- **D1 Option (d).** No second service and no new resource. `REFERENCE_DATA_ENABLED=true` with `REFERENCE_DATA_BASE_URL` empty is import-only mode: the port reads the D3 cache, never calls a service, and a cache miss fails closed with a coded error.
- **D2 Import contract.** The file (`format: reference-import-v1`) holds IDA-shaped responses keyed by an allow-listed endpoint and its parameters. Every entry passes the client allow-list and the pinned parsers before anything is written; one bad entry writes nothing; writes run in one transaction; re-import is idempotent. `data_class: synthetic` may not carry verified-looking data (products must be `synthetic_test`, versions `test_fixture`, fact headers `version_synthetic: true`). `data_class: owner_approved` needs a `rights_reference` and the explicit `--allow-owner-approved` option. The `owner_approved` gate is a placeholder (an option flag plus a free-text `rights_reference`) until the legal rights register exists; it is honour-system and **FOR LEGAL REVIEW**. The data class is recorded in the cache `etag` marker (`import-<class>-<digest>`) and printed in the CLI summary. A synthetic import also fails if any parsed fact is `verified`. The CLI prints the target host and needs `--yes` for a non-loopback database. Import files are capped at 8 MB. In import-only mode a stale read returns code `REFERENCE_DATA_NOT_CONFIGURED` (HTTP 503). `textList` in `src/integrations/insurance-data/schemas.js` deliberately accepts a bare string as a one-item list (older pinned shape).
- **D3 Service mode stays available.** Setting `REFERENCE_DATA_BASE_URL` (https, or http on loopback) plus `REFERENCE_DATA_API_KEY` switches the port to the live client. Startup fails if the base URL is set without the key. Use it only against a local IDA until the licence and hosting are settled.
- **D4 Contract pinned to the IDA OpenAPI.** `tests/insurance-data-contract.test.mjs` pins the spec's required fields and enums and runs on local stubs. With `IDA_OPENAPI_PATH` set it also checks the pinned lists against a checkout's `openapi.yaml`. Writing the test found and fixed two parser faults: `uin_raw` is required but nullable, and fact `conditions`/`exceptions` are string arrays (both made valid responses fail closed).
- **D5 Upgrade path.** When the licence is granted and at least one source has approved rights, move to option (b): one scale-to-zero Fly app, schema `ida` in the existing database, a dedicated role. Record that change as an addendum here.

## Consequences

- Zero running cost and no new account. The cost is manual refresh: imported rows go stale after `--ttl-days` (default 30) and are then served labelled stale until the next import.
- No new table, migration or derived store. `reference_cache` is already classified (global, public data, no household link) in the purpose registry and data lifecycle, so no new erasure path is needed.
- Nothing household-related can reach the cache: import keys come from the client's normaliser, and the parsers drop every field outside the pinned shape.
- Reference data stays context only. It never decides eligibility, money, consent or release (X1 rule 8).

## Rollback

Set `REFERENCE_DATA_ENABLED=false` (the default). To clear imported rows: `DELETE FROM reference_cache WHERE etag LIKE 'import-%';` (owner approval: this deletes data, though only public reference data). Reverting the branch removes the import script and service; the cache tables stay (migration 033).
