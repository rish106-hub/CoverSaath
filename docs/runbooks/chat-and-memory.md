# Runbook: chat v1 and household memory

Decisions: ADR 0029 (voice transcripts), ADR 0030 (model gateway, Anthropic, redaction evidence), ADR 0031 (pgvector memory chunks, chat v1), ADR 0032 (holdings and memory facts). Tables: [data.md](../architecture/data.md). Chat v0 (deterministic, no model) stays documented in [chat-v0.md](chat-v0.md). Synthetic data only. All consent, privacy and notice wording here and in the code is a draft **FOR LEGAL REVIEW**. Nothing in this runbook is deployed.

## 1. Switches

Every flag is off unless exactly `true` (set in `.env.local` locally; never commit values).

| Flag | Effect |
|---|---|
| `HOLDINGS_ENABLED` | Holdings, memory facts and the worker jobs that feed memory |
| `MEMORY_ENABLED` | `memorise` step, `memory_chunks`, chat v1 routes |
| `CHAT_MODEL_ENABLED` | Model wording of a turn. Off: the turn answers from code and stored facts |
| `VOICE_AUDIO_RETAIN` | Keeps the audio document of a voice turn. Off: only the sealed transcript is stored |

Embeddings need `MODEL_PROVIDERS` to include `voyage`, plus `VOYAGE_API_KEY` and `VOYAGE_INPUT_USD_PER_MILLION` (see `.env.example` comments). The model answer needs the `anthropic` provider with `ANTHROPIC_API_KEY` and its two `ANTHROPIC_*_USD_PER_MILLION` prices. Without a key, a spent budget or a refusal, the gateway returns a typed `unknown` and chat falls back to facts and a keyword match over `policy_clauses`.

Model failover (FOR LEGAL REVIEW): chat tasks route Gemini, then anthropic, openai, deepseek, kimi (`MODEL_ROUTES`). A provider is used only if it is enabled in `MODEL_PROVIDERS`, has a key and rates, and the acting adult holds a current exact `coverage_reconstruction` grant whose scope names that provider as recipient (`gemini`, `anthropic`, ...). Without its grant a provider is skipped, never called; the next one is tried only after a typed unavailable or a failed call, and the grant is re-checked before each dispatch and again at commit (the stored turn names the provider that answered). Default `MODEL_PROVIDERS` is unchanged (`anthropic`); recommended `gemini,anthropic,openai,voyage`. Keep `deepseek` and `kimi` out until legal review (cross-border). All four have SDK adapters; without a key or rates one answers a typed unavailable (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, `MOONSHOT_API_KEY`; see fly-deploy.md). Embeddings stay on voyage.

No keys at all: no provider is called. The answer is the confirmed facts plus verbatim wording passages (with `sources` of document and page) found by keyword over the clauses of every active document in the holding's case (schedule and T&C), or `unknown`. No migration is needed for this path.

Kill switch: set the flag to `false` (or remove it) and restart. `CHAT_MODEL_ENABLED=false` alone stops every model call from chat; memory and deterministic answers keep working.

## 2. Local setup

1. PostgreSQL 17 with pgvector: [local-postgres runbook](local-postgres.md#pgvector-migration-053-adr-0031). Migration 053 runs `CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions`; a database without the extension files fails at 053.
2. `npm run db:init` (migrations 001 to 057).
3. `SEED_ALLOW=1 npm run seed:demo-household` (refuses production, a non-loopback database and `coversaath_dev`) to get a synthetic household with holdings.
4. `npm run dev` for the API and `npm run worker` for the jobs (memorise, analytics drain). Tests: `node --test tests/<file>.test.mjs`; the full suite needs `TEST_DATABASE_URL` and `REQUIRE_POSTGRES=1`.

## 3. API

Bearer session; household ownership is checked on every call (a foreign household is the same 404).

- `POST /api/v1/chat/threads` body `{ household_id, holding_id? }` returns 201 `{ thread }`.
- `POST /api/v1/chat/threads/{id}/turns` body `{ message, input_kind?, audio_document_id?, procedure? }` answers `text/event-stream`: events `meta`, `delta`, `answer`, `done`, or one `error`. The model call is not token-streamed; the finished answer is chunked.
- `procedure` carries `planned_date`, amounts and `stay_days`; the waiting-period, sub-limit, room-rent and co-payment arithmetic is integer code in `src/features/insurance-rules/procedure-planning.js`, never the model.
- Holding facts and conflicts: `GET /api/v1/holdings/{id}/facts`, `GET /api/v1/holdings/{id}/conflicts`, `POST /api/v1/holdings/{id}/conflicts/{cid}/resolve`.

Every answer carries `facts_used` (ids of memory rows). Model output is only `extracted_unverified`, `conflicting` or `unknown`; answer status is set by code.

## 4. What is stored and how it is erased

| Store | Content | Erased by |
|---|---|---|
| `chat_turns` | sealed content; sealed transcript for a voice turn; provider, model, token and paise summary and the sha256 of the redacted prompt | Household erasure, holding erasure, document erasure, consent revocation (threads naming an erased holding, fact or chunk are deleted whole) |
| `retrieval_traces` | ids only | Cascade with the thread |
| `memory_chunks` | redacted passage (sealed) and a plaintext embedding (ADR 0031 D2 records the leak) | Deleted, never redacted: with holding, source document, consent grant, household |
| `provider_calls` | counts, tokens, cost and prompt digest, no payload | Household erasure |

Provider consent (audit F1, migration 058; FOR LEGAL REVIEW): the chat model and the embedding provider each need a current grant of the acting adult with purpose `coverage_reconstruction` and a scope `household / derive / insurance_question` naming the exact recipient (`anthropic` for chat, `voyage` for embeddings). The server resolves it (`provider-consent.js`; request shapes are unchanged), re-checks it before dispatch, and re-checks it inside the commit transaction (`ChatRepository.appendExchange`, `MemoryChunkRepository.replace`). No grant: no provider call; chat answers deterministically (`model_status: consent_required`), embeddings are skipped. A model turn stores the grant id (`chat_turns.consent_grant_id`); revoking that grant deletes its threads. Grants are created through the existing consent API.

Code: `src/backend/repositories/memory-erasure.js`, `erasure-repository.js`; consent revocation calls `eraseMemoryForConsentGrant` in the same transaction.

## 5. Checks and diagnosis

- Provider spend: query `provider_calls` for counts per day and `status`; it never holds text.
- Chat answers unknown on day 1: expected without embeddings; check `MODEL_PROVIDERS`, `VOYAGE_API_KEY`, the daily budget, then `memory_chunks` row count for the holding.
- Migration 053 fails: pgvector is missing or installed outside the `extensions` schema; fix the extension, rerun `npm run db:init`.
- Never log prompts, responses or transcripts at the BFF or proxy.

## 6. Rollback

Flags off and restart. Code revert is safe: the tables are expand-only. A synthetic-only database may drop the tables; a database with real data needs owner approval and the erasure paths above first.

## 7. Known gaps

Procedure planning is not wired to `network_hospitals`. Analytics events `voice_turn` and `hospital_search` are not emitted. Not deployed, not reviewed.

Chat integrity (audit F5, F7; FOR LEGAL REVIEW where wording is concerned): a model answer is used only if every number in it appears in the formatted value of a cited fact or passage, or in a computed check of the turn; otherwise the deterministic answer stands with `model_status: numbers_unverified` (additive value of the existing free-form `model_status`). Holding facts, open conflicts and fact-derived passages in chat are owner-only, like `GET /holdings/{id}/facts`; a non-owner member with a write role chats without them (no fact reaches the model or `facts_used`).

Wording answers (owner scope): chat answers from the schedule facts and from the policy wording PDF (clauses). The answer carries an additive `sources` array of `{ kind: "wording", document_id, page, ref }` for each clause or passage it rests on (page null if the clause has none). The number check also accepts numbers in the cited wording passages. A question with no fact and no clause support is `status: unknown` with empty `sources` and `facts_used`; no number is invented.
