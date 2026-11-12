# Runbook: demo journey (P0): one household, one policy, two PDFs, grounded chat

Scope: run the P0 journey end to end on a local machine: schedule PDF plus terms-and-conditions (wording) PDF, one holding, facts, grounded chat. Synthetic documents and synthetic data only. All consent, privacy and notice wording on this path is a draft **FOR LEGAL REVIEW**.

Sources used: `src/server/config.js`, `src/server/worker.js`, `src/server/routes/*`, `src/backend/services/backend-services.js`, `package.json`, `fly.toml`, `docker/entrypoint.sh`, and `tests/prod-journey.test.mjs` (the same journey over local stubs). Anything not confirmed in code is marked **not verified**. This runbook was written from code and tests; it was not run against live providers, and no capacity or timing numbers exist.

## 0. What the journey is, in order

1. Create a household and a case (bootstrap token).
2. Grant `document_processing` consent, upload both PDFs.
3. The scanner (ClamAV) marks each PDF clean.
4. Grant `sarvam` consent per document, run OCR. OCR completion creates one holding per policy document and queues insurer detection.
5. The job worker detects the insurer; the owner confirms the product; the worker parses the own PDF, collates facts and memorises.
6. Link the wording PDF to the schedule's holding.
7. Read facts. Chat.

OCR creates one holding per policy document (`HOLDING_DOCUMENT_KINDS` in `backend-services.js`), so right after both uploads the household lists two. Linking the wording (step 6) makes it one: `POST /api/v1/holdings/{id}/documents` deletes the wording's own standalone holding in the same transaction (its derived data goes with it; its queued jobs are dropped), and a document that is already linked never gets a holding of its own (a late `holding.create` retry is a no-op). If the owner already acted on the standalone holding (confirmed a product, resolved a conflict, linked documents, payments, chat) the link answers `409 HOLDING_DOCUMENT_HAS_HOLDING` and changes nothing. Unlinking does not recreate the standalone holding. `GET .../holdings` then lists exactly one holding, with a `summary` (confirmed insurer and product name, sum insured, policy period, premium).

## 1. Processes

| Process | Command | Needed for |
|---|---|---|
| API (also runs the in-process document scan worker) | `npm run dev` (http://127.0.0.1:8787) | every route |
| Job worker | `npm run worker` (separate terminal; same `.env.local`) | detect insurer, reference import, parse, collate, memorise. Without it holdings stay in their first status. |
| ClamAV `clamd` | see [clamav.md](clamav.md), local (Homebrew) section | scan: uploads leave `quarantined` only when clamd answers |
| OCR | not a process: the API calls Sarvam over HTTPS | needs `SARVAM_OCR_ENABLED=true` and `SARVAM_API_KEY` |
| Reference service | local `insurance-data-api` ([ida-integration.md](ida-integration.md) section 1) | insurer candidates (see 3 below) |
| PostgreSQL 17 with pgvector | [local-postgres.md](local-postgres.md) | everything |

In the Fly container `docker/entrypoint.sh` starts clamd, the API and the worker together (`WORKER_IN_CONTAINER=false` turns the worker off). Fly is not deployed ([fly-deploy.md](fly-deploy.md)); this runbook is the local path.

## 2. Flags and settings

Every flag below must be exactly `true` (any other value is off). Put them in `.env.local` (git-ignored). The "demo-journey" block in `.env.example` lists them with placeholders.

| Setting | Why |
|---|---|
| `HOLDINGS_ENABLED=true` | holdings routes and every worker handler of the holdings pipeline (`holdingsEnabled`) |
| `POLICY_FACTS_ENABLED=true` | deterministic facts from the OCR text (`parse_own_pdf` calls the extractor only while this is on). No model call. |
| `REFERENCE_DATA_ENABLED=true` | insurer candidates and `confirm-product` (`REFERENCE_DATA_NOT_CONFIGURED` 503 without it) |
| `REFERENCE_DATA_BASE_URL` + `REFERENCE_DATA_API_KEY` | service mode against a local IDA; startup fails if the URL is set without the key. Leave the URL empty for import-only mode (see 3). |
| `SARVAM_OCR_ENABLED=true` + `SARVAM_API_KEY` | OCR. Without it OCR answers `503 OCR_PROVIDER_DISABLED` and **no holding is ever created**. |
| `MEMORY_ENABLED=true` | `memorise` step and the chat routes (`503 MEMORY_DISABLED` without it) |
| `DOCUMENT_SCAN_MODE=clamd`, `CLAMD_HOST=127.0.0.1`, `CLAMD_PORT=3310` | scan. With the default `disabled` nothing scans and the document stays pending. |
| `DOCUMENT_ENCRYPTION_KEY_BASE64` | uploads (`503 DOCUMENT_STORAGE_NOT_CONFIGURED` without it) |
| `DATABASE_URL`, `KNOWVIA_BOOTSTRAP_TOKEN` (32+ chars) | database and the first household |
| `DOCUMENT_READBACK_ENABLED=true` | set by `tests/prod-journey.test.mjs`; whether chat v1 needs it is **not verified** |

Optional model features (not needed for the P0 journey): `CHAT_MODEL_ENABLED=true`, `MODEL_PROVIDERS`, provider keys and per-million rates, `POLICY_STRUCTURING_ENABLED=true` with the Gemini settings ([policy-structuring.md](policy-structuring.md)). Embeddings need `voyage` in `MODEL_PROVIDERS`, `VOYAGE_API_KEY` and `VOYAGE_INPUT_USD_PER_MILLION` ([chat-and-memory.md](chat-and-memory.md)).

### What works with no model API key

- Upload, scan, OCR (needs the Sarvam key), insurer detection, facts from the own PDF, linking, and chat. With no model key and no embedding key, chat answers from confirmed facts plus verbatim wording passages with `sources` (document and page), or `unknown`; no provider is called (chat-and-memory.md, section 1; `ChatV1` no-key funnel).
- Not available without a key: OCR (Sarvam is the only OCR path), model wording of an answer, embeddings (vector retrieval is skipped; keyword search over clauses stays).
- Whether the no-key chat answer finds wording clauses on a live Sarvam OCR result is **not verified** (tests use a stubbed OCR).

## 3. Reference data (insurer candidates)

`GET /api/v1/holdings/{id}/product-candidates` needs a registry snapshot built by the worker job `reference.import`, which reads `registry.insurers` and `registry.products`. The first read queues the import and answers `503 HOLDING_REGISTRY_UNAVAILABLE` (retryable); run the worker and read again.

- Service mode (verified path in `tests/prod-journey.test.mjs`, over a stub): run a local IDA ([ida-integration.md](ida-integration.md) section 1) and set `REFERENCE_DATA_BASE_URL=http://127.0.0.1:3000`, `REFERENCE_DATA_API_KEY=local-sandbox-key` (IDA's documented fictional-data key).
- Import-only mode: `scripts/fixtures/reference-import-synthetic.json` carries `insurers.resolve`, `products.search`, `products.versions` and `versions.facts` only, no `registry.*` entries, so with that file the snapshot stays unavailable. Whether a hand-made import file with `registry.*`, `products.get` and `products.nameSearch` entries is accepted is **not verified**.
- The facts of the insurer tier are not wired in production: `emptyReferenceFacts` is the default (`holdings-service.js`; README "What is left"). Facts of the holding come from the own PDF only.

## 4. Steps

Base URL `http://127.0.0.1:8787`. Host must be loopback (otherwise 403). Every call except the first carries `Authorization: Bearer <session token>`. Use only synthetic PDFs (a generator exists: `buildSyntheticPolicyPdf` in `scripts/fixtures/synthetic-policy-pages.mjs`, `node scripts/demo/build-fixtures.mjs` writes `tests/fixtures/demo/*.pdf`). Never use a real policy.

```sh
npm ci
cp .env.example .env.local    # then fill the demo-journey block
npm run db:init               # migrations 001 to 065
clamd --foreground            # terminal 1 (clamav.md)
npm run dev                   # terminal 2
npm run worker                # terminal 3
```

**Step 1: household and case.**
`POST /api/v1/households` with `Authorization: Bearer $KNOWVIA_BOOTSTRAP_TOKEN`, body `{ "displayName": "Demo household", "owner": { "displayName": "Demo Owner" } }`. Response 201 carries `household.id`, `owner.id`, `ownerMember.id` and `session.token`.
`POST /api/v1/cases` body `{ "householdId", "subjectMemberId": <ownerMember.id>, "triggerType": "planned_care" }`. 201 carries `id` (case id).

**Step 2: consent and upload.**
`POST /api/v1/consents` body `{ "householdId", "subjectAdultId": <owner.id>, "purpose": "document_processing", "scopes": [ { "resourceType": "document", "action": "collect", "dataCategory": "insurance_document" }, { "resourceType": "case", "resourceId": <caseId>, "action": "read", "dataCategory": "source_pack_metadata", "recipient": <owner.id> } ] }`. 201 carries the grant `id`.
For each PDF (at most 15 MiB): `POST /api/v1/cases/{caseId}/documents`, `Content-Type: application/pdf`, headers `Idempotency-Key: <uuid>`, `X-Document-Kind: policy_schedule` (or `policy_wording`), `X-Consent-Grant-Id: <grant>`, `X-Filename: synthetic-policy.pdf`, raw bytes as the body. 201 carries `document.id`; status `received_pending_checks`.

**Step 3: scan.** Poll `GET /api/v1/cases/{caseId}/documents` until each is `accepted` (database: `lifecycle_state=active`, `malware_status=clean`).

**Step 4: OCR (paid provider call, FOR LEGAL REVIEW consent).**
Per document: `POST /api/v1/consents` body `{ householdId, subjectAdultId, "grantedToActor": "sarvam", "purpose": "document_processing", "scopes": [ { "resourceType": "document", "resourceId": <documentId>, "action": "derive", "dataCategory": "insurance_document", "recipient": "sarvam" } ] }`, then `POST /api/v1/documents/{id}/ocr-jobs` body `{ "consentGrantId": <grant> }` (202 with `job.id`), then `POST /api/v1/ocr-jobs/{jobId}/refresh` with the same body until `job.status` is `succeeded`.

**Step 5: holdings.**
`GET /api/v1/households/{householdId}/holdings` lists `{ id, documentId, ... }`; pick the schedule's `id` as `holdingId`.
Chat and memory provider consent: skip for a no-key run. With keys, add a `coverage_reconstruction` grant with one `household / derive / insurance_question` scope per recipient (`anthropic`, `voyage`, ...) as in chat-and-memory.md section 4 and the journey test.
Detect and confirm: `GET /api/v1/holdings/{holdingId}/product-candidates` (503 until the worker imported the registry; read again after the worker ran), then `POST /api/v1/holdings/{holdingId}/confirm-product` with header `Idempotency-Key: <unique>` and body `{ "candidateId", "expectedVersion": <profileVersion from the candidates read> }`. 200 `{ status: "product_reported" }`. This queues parse, reference and, after them, collate and memorise.

**Step 6: link the wording.**
`POST /api/v1/holdings/{holdingId}/documents` body `{ "documentId": <wordingDocumentId>, "kind": "wording" }`; 200 `{ linked: true }` (`false` on a repeat). `GET /api/v1/holdings/{holdingId}/documents` lists links. Linking queues `collate` and `memorise`: the wording's facts (waiting periods, exclusions, co-payment) join the holding's facts as `extracted_unverified`, whichever of link or fact reading finishes first. If the schedule and the wording state different values for the same fact, that fact is `conflicting` with both values and both sources (document kind and page); nothing is overwritten, and a confirmed fact stays. `GET .../documents` shows `factsState` per link (`included`, `none`, or `off` when `POLICY_FACTS_ENABLED` is off). `DELETE .../documents/{documentId}` removes the facts read only from that document.

**Step 7: facts and chat.**
`GET /api/v1/holdings/{holdingId}/facts` (owner only), `GET /api/v1/holdings/{holdingId}/conflicts`.
`POST /api/v1/chat/threads` body `{ "household_id", "holding_id" }` (201 `{ thread }`), then `POST /api/v1/chat/threads/{id}/turns` body `{ "message": "How long is the waiting period for pre-existing diseases?" }`. The answer is `text/event-stream` (`meta`, `delta`, `answer`, `done`, or one `error`); read the `answer` event.

## 5. How to tell each stage worked, and the usual failure

| Stage | Success looks like | Usual failure | Look at |
|---|---|---|---|
| Server boot | log line `server_listening`; `GET /api/v1/health` 200; `GET /api/v1/ready` 200 | startup error naming a setting (`Invalid ...`), `ready` 503 `not_ready` (migrations missing, or scanner required but down) | `.env.local`, `npm run db:init`, `/api/v1/ready` |
| Worker | log line `worker.started` with a non-empty `kinds` list | `kinds` empty: flags not exactly `true` in the worker's env | worker env (`buildJobHandlers` registers by flag) |
| Upload | 201, `received_pending_checks` | `503 DOCUMENT_STORAGE_NOT_CONFIGURED`; 403 consent; `503 DOCUMENT_SCANNER_NOT_CONFIGURED` after 20 pending | `DOCUMENT_ENCRYPTION_KEY_BASE64`, consent grant, scan mode |
| Scan | document `accepted` | stays pending: clamd down or `DOCUMENT_SCAN_MODE=disabled`; `rejected`: scanner hit or PDF with active content (`PDF_ACTIVE_CONTENT`) | [clamav.md](clamav.md) checks, API log `document_scanner_unreachable` |
| OCR | refresh returns `job.status: succeeded` | `OCR_PROVIDER_DISABLED` 503; `DOCUMENT_NOT_OCR_READY` 409 (not clean yet or consent missing); a provider failure | `SARVAM_*` settings, consent recipient `sarvam`, [policy-structuring.md](policy-structuring.md) OCR notes |
| Holding created | holdings list has one row per document | list empty: `HOLDINGS_ENABLED` not `true` in the API, OCR not succeeded, or the OCR completion hook failed (README "What is left", audit F6: nothing retries) | API log, `policy_holdings` rows |
| Candidates | 200 with `candidates` | 503 `HOLDING_REGISTRY_UNAVAILABLE` (worker not run or no registry); 409 `HOLDING_DOCUMENT_NOT_READABLE`; 404 `HOLDING_NOT_FOUND` for a non-owner | section 3, worker log, `job_queue` (`status`, `last_error_code`) |
| Confirm | 200 `product_reported` | 503 `REFERENCE_DATA_NOT_CONFIGURED`; 400 `HOLDING_PRODUCT_INVALID` (bad `expectedVersion`) | `REFERENCE_DATA_*`, candidates read |
| Pipeline | `job_queue` rows `holding.parse_own_pdf`, `holding.fetch_reference`, `holding.collate`, `holding.memorise` all `succeeded`; none `dead` | `dead` row: read `last_error_code` (`HOLDING_NOT_READY`, `POLICY_FACTS_DISABLED`, ...) | worker log, `job_queue` |
| Facts | `GET .../facts` 200 with `facts` (own-PDF readings are `extracted_unverified`) | empty list: `POLICY_FACTS_ENABLED` off in the worker, or no text matched the deterministic extractors | worker env, OCR text |
| Link | 200 `linked: true` | 404 `DOCUMENT_NOT_FOUND` (foreign, withdrawn or missing); 400 when linking the holding's own document | holding and document ids |
| Chat | `answer` event with `status` `evidence_found` or `unknown`; `sources` names document and page for wording | `503 MEMORY_DISABLED`; `consent_required` model status (no provider grant, chat still answers from code); `unknown` for everything: no facts or clauses yet | `MEMORY_ENABLED`, worker `memorise` job, chat-and-memory.md section 5 |

Money, consent and eligibility are decided by code; model output is only `extracted_unverified`, `conflicting` or `unknown`. A fact read from the schedule stays unverified until the owner confirms it.

## 6. Reset and rollback

Set the flags to `false` and restart. A synthetic-only local database may be dropped and recreated. Withdrawing a document or revoking its consent erases the derived data (links, chunks, facts); see chat-and-memory.md section 4.

## 7. Not verified

- A run with live Sarvam OCR, a live IDA or any live model; the tests use local stubs.
- No-key chat citing wording clauses from a live OCR result.
- Import-only reference mode producing a registry snapshot (section 3).
- Whether `DOCUMENT_READBACK_ENABLED` is required for chat v1.
- Timing, capacity and cost of any stage.
