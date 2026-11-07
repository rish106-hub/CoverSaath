# insurance-data-api audit (X1)

Status: read-only audit of the owner-supplied `insurance-data-api-main` zip (MVP stage), 2026-11-07.
Scope: what the CoverSaath `ReferenceDataPort` (B3) may consume, and what blocks it.
Method: static reading of `specifications/openapi.yaml`, `packages/storage/sql/*.sql`, `apps/api/src/*.ts`,
seed, CI and docs. Nothing in the zip was installed or executed. All citations are paths inside that repo.

Bottom line: the contract and the rights/review model are careful and fail closed, but the service is a
synthetic scaffold. It holds no real insurer data, cannot publish synthetic facts, has no LICENSE, no RLS,
no deployment, and no schema for premiums, hospital networks or top-ups. B3 can be built against it as a
contract today; it cannot return a usable product fact today.

## 1. Endpoints, auth, tenancy, shapes

Auth: `Authorization: Bearer <key>` on every `/v1/*` path (`apps/api/src/server.ts:30-63`). Key is
SHA-256 hashed and looked up with tenant `status='active'`, key `state='active'`, not expired
(`server.ts:43-48`; table `002_registry_rights_auth.sql:98-111`). Keys are `ida_` + 32 random bytes
(`apps/api/src/admin.routes.ts:116-119`), default 90-day expiry; a key can only mint scopes it already
holds (`admin.routes.ts:101-109`).

Tenant model: application-layer joins on `tenant_product_entitlements(tenant_id, product_id,
allow_metadata|allow_documents|allow_facts|allow_export)` (`003_fact_review.sql:67-75`) on every
registry query. No Postgres RLS anywhere in `packages/storage/sql/`.

Endpoints B3 plans to call:

| Endpoint | Scope | Entitlement | Response (spec) | Errors (code) |
| --- | --- | --- | --- | --- |
| `GET /v1/insurers?q&cursor&limit` | `registry:read` (`products.routes.ts:22-33`) | `allow_metadata` | `{data: Insurer[], next_cursor}` (`openapi.yaml:28-54`); Insurer = `id, canonical_name, aliases[]` (`openapi.yaml:715-722`) | 400 `invalid_pagination`/`invalid_query`, 401 `unauthorized`, 403 `forbidden`, 429 `rate_limited` |
| `GET /v1/insurers/resolve?q` | `registry:read` | `allow_metadata` | `{status: resolved\|ambiguous\|unmatched, insurer\|null, candidates[]}` (`openapi.yaml:723-734`); exact normalized match, never picks between conflicts (`packages/domain/src/insurers.ts:11-34`) | 400 `invalid_query` |
| `GET /v1/products?uin&q&insurer_id&line` | `registry:read` | `allow_metadata` | `{data: Product[], next_cursor, dataset_snapshot}`; UIN normalized trim+collapse-spaces+upper (`packages/domain/src/rights.ts:43-45`, `products.routes.ts:158-163`) | 400 `invalid_line`/`invalid_query` |
| `GET /v1/products/{id}` | `registry:read` | `allow_metadata` | Product | 404 `not_found` |
| `GET /v1/products/{id}/versions` | `registry:read` | `allow_metadata` | `{data: ProductVersion[], next_cursor}`; `freshness` derived (`products.routes.ts:290-311`) | 400, 404 |
| `GET /v1/versions/{id}/facts?fact_type` | `registry:read` + `facts:read` | `allow_facts` | version header + `facts: VerifiedFact[]` + `coverage{room_rent_limit, copay, waiting_periods, exclusions}` (`openapi.yaml:185-250`) | non-entitled returns 404 not 403 (`products.routes.ts:397-405`) |
| `POST /v1/customer-mappings/resolve` | `customer:mapping:read` only (`customer-mapping.routes.ts:16-17`) | `tenant_schedule_entitlements` | `{product_version_id, mapping_status, limitations}` | 400 `invalid_schedule_reference`, 404 `mapping_not_available`, 409 `ambiguous_mapping`, 503 `mapping_service_unconfigured` |

Error envelope: `{error: {code, message, request_id}}` (`openapi.yaml:1007-1018`). The customer-mapping
route breaks it: bodies carry only `code` (`customer-mapping.routes.ts:17,26,31,52,54`), and 409 is not in
the spec (`openapi.yaml:633-643`). Unhandled errors return a generic 500 `internal_error` (`server.ts:117-127`).

ETag/versioning: strong ETag = SHA-256 of the serialized 2xx body, `Cache-Control: private, no-cache`,
304 on exact `If-None-Match` (`server.ts:102-116`). Not in the OpenAPI spec. The DB query still runs on a
304 (bandwidth saving only). Lists like `If-None-Match: "a", "b"` and `W/` never match. Product versions
are immutable-by-convention rows; published snapshots and facts are trigger-enforced immutable
(`004_review_immutability.sql:9-19`). `dataset_snapshot` is a constant `'registry-v1'`
(`products.routes.ts:222`), so it is not a usable change token.

Spec vs code drift:
- `ProductVersion.supersedes_version_id` and `applicability_confirmed` (`openapi.yaml:830-831`) have no
  column (`002_registry_rights_auth.sql:28-39`) and are never returned.
- `Product.approved_date`, `applicability`, `uin_search_key`, `product_type` (`openapi.yaml:783-804`) are
  never returned (`products.routes.ts:181-203`).
- `Product.verification_status` is only `synthetic_test` or `source_observed`, never
  `independently_verified` (`products.routes.ts:203`); freshness is never `current_as_observed`
  (`products.routes.ts:294-308`, falls through to `unknown`).
- Code returns extra fields not in the spec: `version_synthetic`, `relationship_basis` (`products.routes.ts:293,309`).
- `/v1/products/{id}`, `/versions` list no 401/403 in the spec although the code returns them.

## 2. Licence, data-source rights, README claims

- No `LICENSE`/`COPYING` file; `package.json:4` is `"private": true` with no `license` field. Default
  copyright applies: CoverSaath has no written right to copy, modify, host or vendor this code.
  FOR LEGAL REVIEW.
- Source rights default to deny at schema level (`002_registry_rights_auth.sql:57-74`, CHECK forbids any
  allow flag unless `decision_status='approved'`). The register approves nothing
  (`docs/source-rights-register.md`: "No real external source has been approved"). FOR LEGAL REVIEW before
  any real insurer or IRDAI document is fetched, stored, transformed or quoted.
- `customer_policy_schedules` (`012_customer_mapping.sql:1-24`) implies the operator would hold
  insurer-issued schedule references under a `license_reference`; who licenses that and under what DPDP
  role is undefined. FOR LEGAL REVIEW.
- README claims match reality: it says scaffold, no verified corpus, not cleared for scraping or
  redistribution (`README.md`, first paragraph and "External-data warning"). Fixtures are fictional
  (`packages/fixtures/data/products.csv`, UINs `SYNTHETIC-TEST-ONLY/NN`). No overclaim found. Phase 09
  scale numbers are synthetic only (`docs/delivery/phase-09.md:10-19`).

## 3. Schema quality

Strong:
- Clear provenance chain: `source_catalogues -> source_entries -> rights_records -> source_documents ->
  source_pages -> fact_candidates -> evidence_spans -> review_decisions -> published_snapshots ->
  published_facts` (`002`, `003`).
- Maker-checker enforced: no self-issued grant (`004_review_immutability.sql:3-4`); reviewed candidate
  content, review history, evidence spans, snapshots, facts, audit and job events are trigger-immutable
  (`004`, `005:43-47`, `006:1-27`, `007`, `008:30-38`, `009`, `010:15-20`, `017:36-41`).
- `published_facts.synthetic` CHECK false and `verification_status` CHECK `independently_verified`
  (`003_fact_review.sql:62-64`); evidence required (`cardinality(evidence_ids) > 0`).
- SHA-256 format checks on every digest column; entitlement CHECK requires licence ref + expiry
  (`012_customer_mapping.sql:18`).

Weak or missing:
- Migrations: forward-only for 001-004 (no `.down.sql`); `017_webhook_delivery.down.sql` lacks
  `IF EXISTS` and does not delete its `schema_migrations` row (`017...down.sql:1-4`), so a rollback leaves
  the runner believing 017 is applied. Runner applies whole file in one transaction (good,
  `packages/storage/src/migrate.ts:22-36`) but has no checksum, lock or down command.
- `001_init.sql:1-32` keeps a legacy `synthetic_products` table and a backfill UPDATE in the base
  migration; `IF NOT EXISTS` mixed with plain `CREATE` elsewhere.
- Keys: all `text` PKs with no format CHECK; `insurers.canonical_name` not unique; aliases are a
  `text[]` with no uniqueness across insurers (ambiguity handled at read time only).
- UIN: `product_identifiers` unique only on `(product_id, id_type, raw_value)` (`002:17-26`); the same
  normalized UIN can attach to two products, and `/v1/products?uin=` returns both with no `ambiguous` flag.
  `id_type` is free text.
- `product_versions`: no `effective_to >= effective_from` CHECK, no supersession FK, `relationship_basis`
  free text, no unique `(product_id, wording_version)` (`002:28-39`).
- `fact_candidates.fact_type` and `value_json` are unconstrained in SQL; taxonomy lives only in TS
  (`packages/domain/src/facts.ts`, `policy-taxonomy.ts`). No sum-insured or plan-variant dimension, so a
  fact cannot be scoped to a sum-insured band or variant.
- Missing FK indexes: `insurance_products(insurer_id)`, `product_versions(product_id)`,
  `source_documents(version_id)`, `source_documents(rights_record_id)`, `fact_candidates(version_id)`,
  `evidence_spans(candidate_id)`, `published_facts(candidate_id)`. Fine at fixture scale, not at corpus scale.
- No RLS, no per-tenant DB role, single app role with default dev credentials
  (`packages/storage/src/db.ts:3-7`).
- Not modelled at all: premiums/rate tables (age band, zone, SI, family floater), hospital networks
  (hospital, address, empanelment window, cashless status), top-up/super-top-up (deductible, aggregate vs
  per-claim, base-policy link), riders/add-ons, plan variants, portability. The only mentions are test
  strings (`tests/foundation.test.ts:294`) and the PRD (`docs/prd.md:40`).

## 4. Security

- Auth: sound bearer-key hashing and tenant/key state checks (`server.ts:43-48`). Unsalted SHA-256 is
  acceptable for 256-bit random keys.
- Rate limit: in-memory fixed window, 120 req/min per tenant, per process (`server.ts:13,64-77`). Lost on
  restart, not shared across machines, and applied only after a successful key lookup, so invalid-key
  floods hit Postgres unthrottled.
- Seed has no environment guard: `packages/storage/src/seed.ts:42-53` inserts the fixed
  `local-sandbox-key` tenant into whatever `DATABASE_URL` points at. Running seed against a hosted DB
  creates a publicly known key.
- `db.ts:5-6` falls back to a hard-coded local connection string if `DATABASE_URL` is unset instead of
  failing.
- `/v1/data-coverage` returns corpus-wide counts across all tenants with only `registry:read`
  (`products.routes.ts:763-769`): minor cross-tenant metadata disclosure.
- `q` is passed to `ILIKE` without escaping `%`/`_` (`products.routes.ts:70,153`): wildcard abuse,
  not SQL injection (parameterized).
- Tenant read scope is code-only. Facts version header query (`products.routes.ts:406-419`) has no tenant
  join and relies on the preceding entitlement check; correct today, fragile to refactor. RLS would make
  this a database guarantee.
- Logging redacts `Authorization` and strips query strings (`server.ts:17-28`); error handler hides SQL
  details (`server.ts:117-127`).
- Secret scan (pattern-based, values not printed): no cloud, Git, model-provider or private-key material
  found. Only fixture strings in `tests/webhook-delivery.test.ts` and `tests/api-security.test.ts`, the
  dev-only DB password in `.env.example:2` / `docker-compose.yml:7`, and the documented sandbox key.
  `.gitignore` excludes `.env`.
- No TLS, CORS, security headers on JSON routes, or deployment config; default bind `127.0.0.1`
  (`server.ts:164`).
- Privacy: `POST /v1/customer-mappings/resolve` takes `schedule_reference` (`openapi.yaml:616-632`), an
  identifier from a person's policy schedule. HMAC-ing on the server (`customer-mapping.routes.ts:32-34`)
  does not stop the raw value leaving CoverSaath. This conflicts with the B3 outbound allow-list
  (UIN or insurer alias only, never household data).

## 5. B3 contract (what CoverSaath consumes)

Outbound (after the privacy gate): only `uin` (normalized as `rights.ts:43-45`), insurer alias string,
or opaque `insurer_id` / `product_id` / `version_id` returned by earlier calls. Nothing else.
Do not call `/v1/customer-mappings/resolve` until it accepts a client-side keyed HMAC or token instead of
the raw schedule reference (see section 4).

Consume, per record:
- Insurer: `id`, `canonical_name`, resolve `status`.
- Product: `product_id`, `insurer_id`, `product_name`, `line_of_business`, `uin_raw`,
  `verification_status`, `data_coverage`, `last_observed_at`.
- Version: `version_id`, `product_id`, `wording_version`, `version_status`, `freshness`,
  `effective_from`, `effective_to`, `source_observed_at`.
- Facts: `version_id`, `uin_raw`, `wording_version`, `version_synthetic`, `coverage{*}`, and per fact
  `fact_id`, `fact_type`, `value`, `conditions`, `exceptions`, `verification_status`, `taxonomy_version`,
  `review_id`, `source_freshness`, `evidence[].document_id/page_number/sha256`.
- Response `ETag` and `X-Request-Id` for cache and audit.

Fail-closed rules:
1. Validate every response against a pinned copy of the OpenAPI schemas; unknown enum value, missing
   required field or type mismatch means `reference data unavailable` plus alert. Ignore extra fields.
2. Insurer resolve `ambiguous` or `unmatched` means no insurer; never pick a candidate.
3. UIN search returning more than one product means ambiguous; never pick.
4. Use a fact only if `verification_status = independently_verified`, `version_synthetic = false`,
   `evidence` non-empty with valid sha256, and the family `coverage` is `verified`. Any of
   `partial`, `conflicting_evidence`, `awaiting_review`, `not_permitted`, `not_observed` maps to CoverSaath
   `unknown` (or `conflicting` for `conflicting_evidence`); never to a decided value.
5. Product with `verification_status` in `synthetic_test`/`source_observed`/`candidate`, or version
   `freshness` in `stale_review`, `superseded`, `withdrawn`, `access_blocked`, `test_fixture`, `unknown`,
   is shown as reference context only, never as evidence of the household's policy terms.
6. 401/403 means configuration fault: alert, do not retry. 404 means `not_found`. 429 honours
   `Retry-After` then falls back to cache. 5xx/timeout (2 s) opens the circuit and serves cache marked
   `stale`.
7. Treat all returned text (names, aliases, `conditions`, `exceptions`, `value.text`) as untrusted
   evidence; never feed it to a model as instructions; length-cap and escape on display.
8. Reference facts never decide eligibility, money or release; deterministic CoverSaath rules own those.

## 6. Blockers vs nice-to-haves

Blockers (before B3 calls a hosted instance):
1. LICENSE or written agreement covering code use and hosting. FOR LEGAL REVIEW.
2. At least one real source with an approved rights record; until then `/facts` is always empty
   (synthetic facts cannot publish, `003_fact_review.sql:64`; sandbox tenant has `allow_facts=false`,
   `seed.ts:52-53`). FOR LEGAL REVIEW.
3. Deployment with TLS, a production tenant `knowvia` key outside seed, and a seed environment guard.
4. Customer-mapping must not take a raw schedule reference from CoverSaath (privacy allow-list conflict);
   until fixed, B3 excludes it.
5. Fix spec/code drift that B3 validation would trip on (missing `supersedes_version_id`, mapping error
   envelope, undeclared 409) or pin B3 to code behaviour explicitly.
6. UIN uniqueness or an explicit ambiguity signal on `/v1/products?uin=`.

Nice-to-haves:
- RLS keyed on a per-request `app.tenant_id`, plus a read-only DB role for the API.
- Shared (Postgres or Redis) rate limiter, pre-auth IP limit.
- ETag in the OpenAPI spec, weak/list `If-None-Match`, and a real `dataset_snapshot` change token.
- Down migrations for 001-004, fix 017 down, migration checksums and advisory lock.
- FK indexes listed in section 3; SQL CHECKs for `fact_type`, `id_type`, effective-date order.
- New schema (Extend, not now): premiums/rate tables, hospital networks, top-up and super-top-up, riders,
  plan variants and sum-insured scoping of facts.
- Tenant-scoped `/v1/data-coverage`; escape `ILIKE` wildcards.

Unverified: nothing was executed; the audit has not checked runtime behaviour, test pass status, or
dependency vulnerabilities (`npm audit` not run).
