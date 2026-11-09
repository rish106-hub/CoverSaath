# Runbook: chat v0 (deterministic, cited, no model)

`POST /api/v1/households/:id/chat`. Backend only; the BFF calls it server-side. Synthetic data only. All user-facing wording here and in `src/backend/services/chat-service.js` is DRAFT and **FOR LEGAL REVIEW**.

## What it does
- Bearer auth, `requireHousehold` (a foreign or unknown household is the same 404).
- Fixed keyword classification of the message (waiting period, sub-limit, exclusion, covered, product lookup, out of scope). The message is never forwarded, logged, audited, stored or echoed, and never becomes a search term: search terms and routes come from fixed lists (`src/contracts/chat.js`, `chat-service.js`).
- Fans out over the caller's own open cases (cap 5; `services.cases.listOpenedBy`), behind the same source-pack field gate as read-facts, and calls `PolicyEvidenceService.readFacts` and `searchPassages` (same consent re-check per document, same identity masking). Excluded documents and cases without a current grant are counted in the reply, never read.
- Product questions send only a UIN-shaped token to `ReferenceDataPort.searchProducts` (public data, context only). Any port failure degrades to a note.
- Reply is a template over retrieved text. It never states eligibility, claim approval, payable money or a consent outcome. No hits gives `unknown` plus a route hint. No model, no stored history, no table, no migration.

## Switches
`CHAT_ENABLED` exactly `true` (default off; off gives 503 `CHAT_NOT_CONFIGURED`) and `DOCUMENT_READBACK_ENABLED=true` (off gives 503 `READBACK_DISABLED`). Kill switch: set `CHAT_ENABLED=false` and restart. Optional: `REFERENCE_DATA_ENABLED` for product questions.

## Contract
Request `{ message: string 1..500 trimmed, page?: /^\/[a-z0-9/_-]{0,64}$/ }`, unknown keys give 400 `CHAT_REQUEST_INVALID`. Response 200 `{ reply, steps[3], route?, goLabel?, pageRef?, answerStatus: evidence_found|unknown|out_of_scope, sources[{tier: household_evidence|reference|none, label, page?, quote?, evidenceId?}], contextOnly: true }`. `route` and `goLabel` come only from `CHAT_ROUTES`. `page` is validated and not otherwise used in v0.

## Privacy and logging
The request path is logged by template (`/api/v1/households/:id/chat`) only. Passages are read from stored OCR text, so a logged response body would hold policy text: do not log response bodies at the BFF or proxy. No new purpose: reuses `coverage_reconstruction` and the existing reading grants. Whether that purpose and the notice text suit a chat surface is a legal-review item.

## Chat v1 (model) would need
A model path is out of scope here. It would need: the P4 memory store or an explicit no-history decision, a consent purpose and notice text for sending a question to a model (legal review), the privacy gate and per-question exact consent (as for `/questions`), a budget and timeout policy, a stored-answer or no-store decision with an erasure path, model output limited to `extracted_unverified`, `conflicting` or `unknown`, and safety evals for injection through documents and questions.
