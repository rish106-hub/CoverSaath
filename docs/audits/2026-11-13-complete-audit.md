# Wave E audit: complete.md MVP run (O-E1)

Read-only staff-engineer audit of every PR landed by `docs/exec-plans/active/complete.md` (Waves A-D), done at backend `origin/main`
`378b1ee` (after #111 merged). Method: `gh pr diff` per PR plus reading code at HEAD. The full suite was not re-run. Nothing in this
PR changes code. **Every finding below is not fixed in this PR.** Not reviewed by a second agent.

Severity: P0 = an invariant is broken (block turning the flag on); P1 = a wrong answer or wrong decision shown to a user; P2 = a gap
with a bounded impact, fix soon; P3 = hygiene.

## 1. Summary

| PR | Repo | Scope | Verdict | Findings |
|---|---|---|---|---|
| #97 | backend | IDA reference fetch, insurer detection (S-A3) | pass | 0 |
| #98 | backend | model gateway, Anthropic adapter, household redaction gate, `provider_calls` (S-A2) | fail (latent, flags off) | 2 (F1 part, F5) |
| #99 | backend | collate, conflicts, pipeline (O-A4) | pass with findings | 2 (F4, F10) |
| #101 | backend | synthetic demo seed | pass | 0 |
| #102 | backend | memory chunks, Voyage embeddings, chat v1 (053-054) | fail (latent, flags off) | 3 (F1, F2, F7) |
| #104 | backend | declaration and premium routes, holding on OCR completion | pass with findings | 2 (F6, F9) |
| #105 | backend | network hospitals (055) | fail | 2 (F3, F11) |
| #106 | backend | analytics outbox, PostHog drain (057) | pass with findings | 2 (F12, F13) |
| #108 | backend | CI pgvector image (pinned by digest), gitleaks allowlist | pass | 0 |
| #109 | backend | gitleaks allowlist for `declarations/v1` label (path + exact regex) | pass | 0 |
| #110 | backend | docs, Wave D | pass | 0 |
| #111 | backend | consent on declaration PUT and due pay, drain shutdown (S-D4) | pass | 0 (open items judged in section 3) |
| FE#33 | frontend | evidence BFF routes consolidated | pass | 0 |
| FE#34 | frontend | screens 2-4 (Add cover, Declarations, Review) | pass | 0 |
| FE#35 | frontend | chat and hospitals screens, SSE BFF | pass | 0 (inherits F3 from #105) |
| FE#37 | frontend | analytics allowlist mirror and drift test | pass | 1 (F14) |
| FE#38 | frontend | BFF holdings routes aligned to backend (superseded by #39) | pass | 0 |
| FE#39 | frontend | same, landed on `main` | pass | 0 |
| Web#14 | website | delete BFF routes, keep landing and waitlist (deletions only) | pass | 0 |

Totals: **P0 1, P1 1, P2 7, P3 5.**

### Pass or fail per check

| Check | Result | Evidence |
|---|---|---|
| Invariant 1, ownership on every read and write | pass | Chat: `chat-repository.js:41,54` (`requirePerson`, foreign thread = same 404). Holdings: `holding-facts-routes.js:23-31`, `holding-product-routes.js:28-33` (owner role). Records: repositories call `requirePerson` (`declaration-repository.js:122`). Hospitals: `network-hospital-service.js:43-48`. BFF takes the household from the sealed session only (`chat-v1.ts` `ctx.session.h`, `covers.ts` `hh(ctx)`). See F7 for a role inconsistency. |
| Invariant 2, privacy gate and current exact consent before a provider call | **fail** | Gate: pass (every chat, history, fact and embed slot is a sealed `GatedText`; `embed-runner.js:15`, `model-gateway.js` seal check). Consent: fail, F1. |
| Invariant 3, erasure of every new derived store | pass | `memory-erasure.js:28-102` covers 048-054 for household, documents, grant and member; `erasure-repository.js:195-196` deletes `provider_calls` and `analytics_outbox`; document and case deletion reach `eraseMemoryForDocuments` through `consent-repository.js:571`. Tests: `tests/holdings-memory.test.mjs`, `tests/memory-chat.test.mjs`, `tests/model-gateway-chat.test.mjs:189`, `tests/analytics-outbox.test.mjs`, `tests/data-erasure-proof.test.mjs`. 055 holds no household data (public directory). Gaps: F1 (chat has no grant to erase by), F12. |
| Invariant 4, input validation and coded errors | pass | Allow-listed bodies: `chat-v1-service.js:42-66,166-186`, `holding-records-routes.js:27-36`. Body caps 1 KB and 4 KB on chat routes. |
| Invariant 5, synthetic data, no secrets | pass | `gitleaks git . --log-opts="54c5501..378b1ee" --redact` exit 0 over 51 commits. Seed refuses a non-loopback database (`scripts/seed-demo.mjs:20-31`); demo names are invented (`scripts/demo/demo-data.mjs`). |
| Invariant 6, legal wording marked | pass | `chat-v1-service.js:27`, `holding-records-routes.js:8`, `analytics-service.js:6`, `data-purpose-registry.js:21`, FE `covers.ts`, FE#37 docs. All consent, notice and resolution wording stays **FOR LEGAL REVIEW**. |
| Invariant 7, dependencies and ADRs | pass | `@ai-sdk/anthropic` only, inside the existing runner (`ai-sdk-runner.js:1-26`); ADRs 0027-0033 present. pgvector image pinned by digest. |
| Model output only `extracted_unverified` / `conflicting` / `unknown` | pass | `gateway-contract.js:13,34-60` (schema enum); collate never emits `user_confirmed` and refuses model-sourced `reviewed_reference` (`collate.js:149-156`, re-checked in the writer `holding-pipeline-repository.js:221`). See F5 on how the chat answer status is derived. |
| Deterministic decisions | pass with F4, F5 | Holding status is pure code (`holding-status.js`); collate is pure (`collate.js`); procedure arithmetic in code (`procedure-planning.js`). |
| Flags off unless exactly `"true"` | pass | `HOLDINGS_ENABLED` (`holdings-flag.js:2`), `MEMORY_ENABLED` (`memory-service.js:20`), `CHAT_MODEL_ENABLED` (`chat-runtime.js:19`), `ANALYTICS_ENABLED` (`analytics-service.js:7`), `VOICE_AUDIO_RETAIN` (`chat-v1-service.js:70`), `REFERENCE_DATA_ENABLED` (`insurance-data/client.js:130`). |
| UIN never in a UI or BFF payload | pass | Backend: candidates return `{candidateId, insurerName, productName, rank}` only (`holding-product-routes.js:6-9`); facts route returns no cache key or locator (`holdings-service.js` `facts`). BFF: every body and every SSE event goes through `containsUin` (`chat-v1.ts` `sanitiseSse`, `listHospitals`; `covers.ts`). |
| No ciphertext into prompts | pass | `privacy-evidence-gate.js` `CIPHERTEXT` refusal in `gateTextForHousehold`; stored passages are the redacted text and are re-gated with their tokens renamed (`chat-v1-service.js:123-129`). |
| Scale seams commented | pass with F13 | Per-household daily budget on the shared ledger, per-process fallback marked `SCALE` (`chat-runtime.js:26-36`); gateway concurrency 2 per process (`chat-runtime.js:16`); PostGIS note (`055`); outbox drain uses `FOR UPDATE SKIP LOCKED` (`analytics-outbox-repository.js:57`). |
| Redaction evidence (`provider_calls` sample) | **not verified** | No database was sampled. Code stores counts and `payload_sha256` only (`056`, `model-gateway.js` `audit`). |

## 2. Findings

### F1 (P0) Chat and embedding provider calls run with no consent check
- Where: `src/backend/services/chat-v1-service.js:102-141` (`modelAnswer` calls `gateway.call` with household facts, passages, history and the question); `src/backend/services/memory-service.js:64-86` (`embedQuery` sends the question to the embedding provider) and `:89-145` (`embedHolding` sends own-PDF clause text and confirmed facts to the embedding provider); `src/features/ai-analysis/chat-runtime.js:84-100` (no consent step); `src/backend/repositories/memory-chunk-repository.js:60-62`.
- Evidence: no `requireActive`, `requireGrant` or recipient check exists anywhere on the chat or embed path (`grep consent` in `chat-v1-service.js` and `chat-runtime.js` finds nothing). The registry declares the scope these slots need, `CHAT_SCOPE = { resourceType: 'household', action: 'derive', dataCategory: 'insurance_question', recipient: 'anthropic' }` (`data-purpose-registry.js:22,174-179`), and says "the grant that opens this scope is built with chat v1" (`:21`), but no grant type, route or check was built. The only consent check on the memory path happens after dispatch, at write time, and it checks that the **document's** grant is active (any purpose, any recipient; `memory-chunk-repository.js:60-61`), which is the `document_processing` grant whose scope names `sarvam`, not the embedding provider. Chat turns are then committed (`chat-repository.js:69-95`) with no consent re-check, so revoking consent cannot erase them except through facts and chunks their traces name.
- Impact: once `CHAT_MODEL_ENABLED=true` (and `MEMORY_ENABLED=true` with a Voyage key), household facts, user declarations shown as facts, clause text and free-text questions leave for Anthropic and Voyage with no current exact consent. This breaks invariant 2 (AI.md). Latent today: both flags default off.
- Suggested fix: add a household `derive / insurance_question` grant per recipient (Anthropic for chat, Voyage for embed), resolve it server side, check it with `consents.requireActive` (exact recipient) before `gateway.call`, re-check it inside `appendExchange` and `MemoryChunkRepository.replace` (purpose and recipient, not only "active"), store `consent_grant_id` on `chat_threads` / `chat_turns`, and erase by that grant on revoke. Tests: revoked, wrong recipient, foreign household, revoke between dispatch and commit. Consent wording FOR LEGAL REVIEW.
- Do not turn on `CHAT_MODEL_ENABLED` or Voyage embeddings in any environment until this is fixed.

### F3 (P1) Hospital lookup ignores the holding's insurer
- Where: `src/backend/services/network-hospital-service.js:50` calls `repository.byPincode({ pincode })`; the repository supports `insurerId` (`network-hospital-repository.js:32-38`) but receives null, so the filter is skipped.
- Evidence: with `insurerId` null the SQL clause `(?::text IS NULL OR ...)` is true for every row, so hospitals of every insurer come back, ordered cashless first.
- Impact: a user asking "which hospital near me is cashless" sees hospitals that are cashless for another insurer. That is a wrong, decision-relevant answer (FE#35 HospitalsView and chat both show it).
- Suggested fix: resolve the holding's insurer id server side (from the confirmed policy profile and the registry; never from the request) and pass it; with no confirmed insurer, return an empty list with a coded reason instead of every insurer's rows. Test: two insurers in one pincode.

### F2 (P2) Data-purpose registry does not match what is sent
- Where: `src/contracts/data-purpose-registry.js:174-179` lists `embed.payload.texts[].text` with recipient `anthropic`, but `src/integrations/model-routing/index.js` routes `embed` to `voyage`. `household_memory_facts.value_enc` and `memory_chunks.chunk_text_enc` say `recipients: ['none']` (`:122-136`) although their opened values are sent to the chat model and the embedding provider.
- Impact: the registry is the DPDP map; a notice built from it would name the wrong processor. FOR LEGAL REVIEW.
- Suggested fix: add `voyage` as the embed recipient, list `anthropic` / `voyage` on the stores whose values become model slots, and add a drift test between `MODEL_ROUTES` and the registry.

### F4 (P2) In-tier own-PDF conflicts get no conflict row
- Where: `src/features/insurance-rules/collate.js:58-68` computes `inTierReason` (`two_pages` / `model_disagree`), but `collateSlot` sets `conflict` only for `own_vs_insurer` and `own_vs_declaration` (`:117-139`); `inTierReason` is never read (`grep` finds no reader).
- Impact: an own-PDF slot that reads two values is stored `conflicting`, but no `memory_conflicts` row exists, so the holding can settle to `ready` (`holding-status.js:19`) while the slot resolves `conflicting`, and the owner has no conflict to resolve it from. Safe for chat (a conflicting slot is not served), but the Review screen undercounts.
- Suggested fix: record a conflict for in-tier disagreement. `candidate_fact_ids` needs at least 2 ids (`050:22`), so either cite the two `policy_facts` ids or write one memory row per alternative. Test with two pages that disagree.

### F5 (P2) Chat status "evidence_found" rests on ids the model chose
- Where: `src/backend/services/chat-v1-service.js:141-149,244`.
- Evidence: `usedFacts` is built from the model's `factsUsed` list, and code sets `status = 'evidence_found'` when that list is not empty. The answer text is model wording with no check that its numbers appear in the cited facts (the "never state a number that is not in a fact" rule is a prompt instruction only, `gateway-contract.js:27`).
- Impact: a model can cite a real fact id and state a different number, and the turn is shown as `evidence_found`. Model output stays `extracted_unverified` in the gateway, so the authority rule holds, but the label shown to the user is stronger than the check.
- Suggested fix: before using the model answer, check every number in it against the formatted values of the cited facts and computed checks; on a mismatch fall back to the deterministic answer (`model_status: numbers_unverified`).

### F6 (P2) A failed OCR hook leaves the document with no holding, and nothing retries it
- Where: `src/backend/repositories/ocr-repository.js:325-334`, `src/backend/services/backend-services.js:81-90`.
- Evidence: the hook runs in a savepoint (`db.js:14`), so a failure rolls back both the holding and the detect job together, then the error is swallowed with no log. A completion replay with the same digest returns early at `ocr-repository.js:284-286`, before the hook, so "until retried" in #111 is wrong: no path re-creates the holding (no other caller of `policyHoldings.create`).
- Impact: reliability only; the upload shows no cover. Not a consent issue (see 3.1).
- Suggested fix: log a coded event in the catch, and make the holding creation idempotent on replay (run the hook on the early-return path too, or add a sweep job for active policy documents without a holding).

### F7 (P2) Chat shows holding facts to roles the facts route refuses
- Where: `chat-repository.js:41,54` allow any adult with a write role; `holding-facts-routes.js:27-28` and `holding-product-routes.js:32-33` allow the `owner` role only.
- Impact: an account holder who is not the owner gets opened fact values through `facts_used` in chat, but a 404 on `GET /holdings/{id}/facts`. Inside one household, so not a tenant leak. Status: unsure whether intended; the plan does not say.
- Suggested fix: decide one rule for reading holding facts and apply it in both places; add a test for a non-owner member.

### F9 (P2, unsure) A failed-persistence OCR job can complete after revocation
- Where: `consent-repository.js:280-300` cancels only `queued / submitted / processing` jobs; `ocr-repository.js:315-321` still lets a job in `failed` with `OCR_PERSISTENCE_FAILED` complete.
- Evidence: revocation leaves such a job `failed` (it only clears `authorization_json`). A later completion would pass the status gate, store pages and run the hook with `consentGrantId` null. The holding insert then needs an active document (`policy-holding-repository.js:52`), which likely stops it, but this path has no test. This edge predates the plan; the hook makes it more visible.
- Suggested fix: add `failed` + `OCR_PERSISTENCE_FAILED` to the cancel set, or check the grant inside `completeJob`; add a revoke-then-complete test.

### F10 (P3) `parse_completed.facts` counts every memory row
- Where: `src/backend/services/holdings-service.js:152`, `(await repository.currentMemory(...)).length`.
- Impact: counts all tiers, scope keys and declarations rather than resolved slots, so the analytics number is inflated. Real, analytics only.
- Suggested fix: count `resolvedConfirmedFacts(rows)` or distinct `fact_key` with `scopeKey === ''`.

### F11 (P3) Hospital list has no pagination
- Where: `network-hospital-repository.js:4,38`, a hard `LIMIT 50` with no cursor and no `truncated` flag.
- Impact: a dense pincode silently drops rows (cashless first, so the useful rows survive). Real, low impact.
- Suggested fix: return `truncated: true` when 50 rows come back; add a cursor later with the PostGIS work.

### F12 (P3) Analytics revocation is lazy, and sent events stay in PostHog
- Where: `analytics-outbox-repository.js:53-78`. Revoking the analytics grant does not delete outbox rows at once; the next drain deletes unsent rows. Events already sent stay in PostHog; no PostHog-side deletion exists.
- Suggested fix: delete the household's unsent rows inside the revocation transaction, and record the PostHog retention and deletion path in ADR 0033. FOR LEGAL REVIEW.

### F13 (P3) Outbox drain holds row locks across the PostHog call
- Where: `analytics-outbox-repository.js:53-78`. `send()` runs inside the transaction that holds `FOR UPDATE SKIP LOCKED`, so a slow PostHog call keeps a database connection open.
- Suggested fix: claim rows (set a lease), commit, send, then mark them sent. Fine at MVP volume.

### F14 (P3) CodeQL alerts on test code in the frontend
- Where: FE `tests/lib/analytics-allowlist.test.ts:25` (alert 192, `js/regex/missing-regexp-anchor`); FE `tests/server/covers-bff.test.ts:285` (alerts 193 and 194, identity replacement).
- Verdict for 192: not a real security issue. The regex `/name|...|path|id$/i` is a deny check in a test, and the intended meaning is "contains any word, or ends in id". Rewrite it as `/(?:name|email|phone|mobile|uin|number|amount|text|message|url|path)|id$/i` to make the precedence explicit and clear the alert.

## 3. Open items judged

| Item | Verdict | Evidence |
|---|---|---|
| OCR `afterComplete` hook after revoke (`backend-services.js:81-82`, `ocr-repository.js:325-334`) | **not real** for the normal path; **unsure** for one edge (F9) | Completion and revocation both take the household lock. Revocation sets live jobs to `cancelled` (`consent-repository.js:280-300`); completion's `UPDATE ... WHERE status IN ('queued','submitted','processing')` then changes 0 rows and throws (`ocr-repository.js:315-321`) before the hook. If completion commits first, revocation erases the holding and the job through `eraseMemoryForDocuments` and `jobQueue.eraseDerived`. S-D4's "not P0" holds. |
| "Swallowed hook failure leaves a holding without a detect job" | **not real** as stated; a related gap **is real** (F6) | The hook runs in a savepoint, so the holding and the enqueue roll back together: you get neither, not a holding without a job. The real gap: nothing retries it. |
| Queue rollback claim ("enqueue failure rolls back the holding") | **real** (the claim is correct) | `db.js:14`: a nested `transaction()` is a savepoint; `jobQueue` and `policyHoldings` share the same `database`, and the transaction client travels in AsyncLocalStorage. |
| Hospitals search drops the insurer filter | **real**, P1 (F3) | `network-hospital-service.js:50`. |
| Hospitals search has no pagination | **real**, P3 (F11) | `network-hospital-repository.js:38`. |
| `holdings-service.js:152` facts count | **real**, P3 (F10) | Counts raw memory rows. |
| FE#37 CodeQL regex anchor | **not real** (test-only false positive), P3 tidy (F14) | `tests/lib/analytics-allowlist.test.ts:25`. |
| Migration 057 CHECK added without `NOT VALID` | **not real**; accept, no follow-up migration needed | The CHECKs only **widen** the allowed sets, so every existing row passes the validation scan. `DROP CONSTRAINT IF EXISTS` matches the default names of the inline CHECKs in `001_baseline_schema.sql:187,203` (`consent_grants_purpose_check`, `consent_scopes_resource_type_check`), so the old CHECK does go. The cost is an ACCESS EXCLUSIVE lock and one scan of two small tables, run once. `NOT VALID` would only add value on a large table under load. |
| #111 leaving declaration DELETE ungated by consent | **not real**; accept | Deleting is erasure. Requiring live consent to erase would block a user who has withdrawn consent from deleting their own data. Ownership and the member or guardian check still apply (`declaration-repository.js:119-129`), and the delete is audited (counts only). No memory row is derived from a `member_declarations` row, so nothing is left behind. |

## 4. Not verified

- The full test suite, `npm run check` and `npm run eval:safety` were not re-run for this audit. The audit relies on each PR's CI and on reading code.
- No `provider_calls` sample was taken (no database access). The redaction counts and the "no fixture PII in the outbound payload" claim (plan section 8 step 3) rest on `tests/model-gateway-chat.test.mjs` and `tests/memory-chat.test.mjs`, which were read but not run.
- No live provider call (Anthropic, Voyage, PostHog, IDA) was made or observed.
- Voice: no speech-to-text provider path was added by these PRs (only the `input_kind: voice` turn fields and `VOICE_AUDIO_RETAIN`). The STT consent and gate path therefore does not exist yet and was not audited.
- `fact_extract` and `intent_classify` gateway tasks are defined (#98) but no caller uses them; they were checked only as schemas.
- The deployment (Fly, Vercel, Supabase migrations 048-057) was not checked.
- Legal wording (consent, notices, conflict-resolution copy, analytics purpose) was not judged: all of it is FOR LEGAL REVIEW.
- Load beyond one machine: per-process limits (gateway concurrency, in-memory budget fallback, rate limit) were only checked for presence of the seam.
- `gitleaks` was run on the backend range only. The frontend and website repositories were not scanned here (H-D3 covered them).
