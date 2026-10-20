# Runbook: policy structuring

Scope: whole-document policy structuring (ADR 0006) through the local API. Real documents stay under `.local/`.

## Prerequisites

- `POLICY_STRUCTURING_ENABLED=true`. Off by default; the routes return `503 STRUCTURING_DISABLED` when off.
- Gemini: `LLM_PROVIDER=google`, a server-only key on a **billing-enabled** project (the free tier may use
  content for training and human review), `LLM_MODEL`, and current prices in `LLM_INPUT_USD_PER_MILLION` /
  `LLM_OUTPUT_USD_PER_MILLION` from the provider's pricing page. Wrong prices make every budget cap wrong.
- `ORCHESTRATION_RUN_BUDGET_USD` must cover one reservation:
  `(STRUCTURING_MAX_INPUT_BYTES x input price + STRUCTURING_MAX_OUTPUT_TOKENS x output price) / 1e6`
  (defaults 64,000 bytes and 16,000 tokens).
- Sarvam OCR and ClamAV as in [clamav.md](clamav.md). Uploads with JavaScript or embedded content are refused
  (`PDF_ACTIVE_CONTENT`); ask for a plain copy.

## Run one document

1. Upload under a `document_processing` grant; wait for `accepted`.
2. Sarvam grant (document scope, recipient `sarvam`); `POST /api/v1/documents/:id/ocr-jobs`, then
   `POST /api/v1/ocr-jobs/:id/refresh` until `succeeded`. Content type defaults to `printed`.
3. An analysis run for the case (`POST /api/v1/cases/:id/analysis-runs`) pins the registry version.
4. Gemini grant: document scope naming the document, action `derive`, data category `insurance_document`,
   recipient `google-gemini`, held by the adult who starts the run.
5. `POST /api/v1/documents/:id/structuring-runs` with `workflowRunId` and `consentGrantId` (202 running,
   200 when already stored). Poll `GET /api/v1/documents/:id/structuring-runs?workflowRunId=...`.
6. Read `processingStatus` and `evidenceOutcome` separately:
   - `running`: wait. `finished` with `complete`: every chunk was read and every model-allowed critical key has a
     reading. `finished` with `partial_review_required` (`requiresReview: true`): some chunks were skipped or a
     critical key is missing (`outcomeReasons`, `missingCriticalKeys`); review before relying on it.
   - `finished` with `failed` (`STRUCTURING_EVIDENCE_INSUFFICIENT`): too little evidence; nothing was stored.
   - `failed_processing`: the run stopped with `errorCode`; nothing was stored.
   - `interrupted`: the server restarted mid-run; nothing was stored and nothing was re-sent.
   Thresholds are provisional and unmeasured; an outcome is not an accuracy claim.
7. Review: nothing in the result is proven. Contradictions and model selections need household confirmation.
   Check `skippedChunks`: `privacy_gate_refused` chunks (member and health tables) are never sent and their facts
   are not captured.

## Restart a failed or interrupted run

A new attempt is a new paid run. After `failed_processing`, `interrupted` or an evidence `failed` outcome,
`POST .../structuring-runs` returns `409 STRUCTURING_RESTART_REQUIRED` until the body adds `"restart": true`.
A run already stored for the current pipeline version is replayed and never paid again, with or without the flag.

## Documents OCR'd without blocks (knowvia.ocr.v1)

Structuring answers `409 STRUCTURING_BLOCKS_UNAVAILABLE`. Running OCR again does not help: the stored v1 success
is reused. Request the explicit, paid upgrade:
`POST /api/v1/documents/:id/ocr-jobs` with `{ "mode": "blocks_upgrade", "acknowledgeProviderCharge": true,
"consentGrantId": "<sarvam grant>" }`, then refresh the job until `succeeded`.
- Without the acknowledgement: `409 OCR_UPGRADE_CHARGE_UNACKNOWLEDGED`, no provider call.
- Pages already have blocks: `409 OCR_UPGRADE_NOT_NEEDED`, no provider call. A repeat request returns the same job.
- `OCR_UPGRADE_TEXT_CHANGED`: Sarvam read the document differently this time. The v1 pages are kept and no blocks
  are attached. Re-upload the document as a new version and OCR it normally; that re-upload is a new paid call.

## Revoke

`POST /api/v1/consents/:gemini-grant/revoke` erases the document's structuring runs, proposals and the
observations they wrote. Revoking the Sarvam or upload grant erases pages and blocks as before.

## Roll back

1. Set `POLICY_STRUCTURING_ENABLED=false` and restart. Upload, OCR and analysis are unaffected.
2. Migrations SQLite 011/012 and PostgreSQL 007/008/009 are additive; older code ignores the new tables,
   column and triggers. Do not drop them while stored data must stay erasable.
3. SQLite 013 / PostgreSQL 010 (`policy_structuring_jobs`) are additive; older code ignores the table. SQLite 014 /
   PostgreSQL 011 (blocks upgrade column and narrowed trigger) are forward-only: roll back by reverting code and
   re-initialising the local database (no production data exists).
4. To remove structuring output for a document without revoking consent, call
   `PolicyStructuringRepository.eraseDerived({ documentIds, reasonCode: 'data_subject_request' })`. It also
   stamps the document's structuring jobs erased.

## Logs

Server logs carry event names and codes only (`policy_structuring_failed` with `code`). Audit rows carry counts.
Never log prompts, provider responses, quotes or page text.

## Database location move (DATABASE_LEGACY_PATH)

Older builds resolved `DATABASE_PATH=.local/knowvia.sqlite` to `.local/.local/knowvia.sqlite`. The path now resolves
to `<cwd>/.local/knowvia.sqlite`. If both the legacy file exists and the target does not, startup fails with
`DATABASE_LEGACY_PATH`. Nothing is moved automatically. With the server stopped, move the database and its
`-wal` and `-shm` files by hand from `.local/.local/` to `.local/`, then start again.
