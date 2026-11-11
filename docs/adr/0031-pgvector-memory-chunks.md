# ADR 0031: pgvector memory chunks, embeddings and chat v1 retrieval (migrations 053 and 054)

Status: accepted for the prototype (synthetic data only). Consent, privacy and notice wording here is a draft that is not final and needs legal review before any real user data. Plan: `docs/exec-plans/active/complete.md` sections 3.1 to 3.3 and 9.4 (S-B1).

## Context

Chat v1 answers from a household's own memory: its confirmed facts (ADR 0023, 0032) and the passages of its own policy PDFs. Facts are looked up by key. Passages need similarity search, which needs embeddings, and pgvector cannot index ciphertext.

## Decisions

**D1. pgvector in the same PostgreSQL (ADR 0011), no second store.** `CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions` (the Supabase convention; the schema is created if missing). Every reference is schema-qualified (`extensions.vector`, `OPERATOR(extensions.<=>)`). `memory_chunks.embedding` is `extensions.vector(1024)` with an HNSW cosine index, partial over the household scopes, and the main btree index starts with `household_id`. Supabase allows the extension; CI and local databases need a PostgreSQL 17 image that ships pgvector (the stock `postgres:17` image does not).

**D2. The embedding is plaintext, and that is a recorded leak.** An embedding reveals some of the content it encodes (topic, and to a determined attacker with the model, approximate wording). It cannot be sealed and still searched. Mitigations, all enforced in code: (a) every passage goes through the household privacy gate BEFORE it is embedded, and the stored `chunk_text_enc` is the redacted text (names, numbers and identifiers are placeholders); (b) own-PDF text is redacted exactly like chat text; (c) chunks are household scoped and every read filters `household_id` first; (d) rows are deleted, never redacted, with the holding, the source document, the consent grant and the household (`memory-erasure.js`), and a chat thread whose trace names an erased holding, fact or chunk is deleted with them; (e) the column is classified in the data-purpose registry as not sealed, with this reason.

**D3. Embeddings are provider calls, through the existing gateway.** Task `embed`, sealed input only, per-household daily budget, one `provider_calls` row with counts and a digest (ADR 0030). Provider: Voyage (`src/integrations/voyage`, `voyage-3.5`, 1024 dimensions, endpoint and body per the Voyage embeddings API reference), enabled with `MODEL_PROVIDERS=anthropic,voyage` and `VOYAGE_API_KEY`; the rate `VOYAGE_INPUT_USD_PER_MILLION` is never guessed. One attempt, a hard timeout, no retry (the pipeline job retries with backoff and every write after it is idempotent). With no key, rate, flag or budget the gateway answers a typed `unknown` and nothing is embedded; retrieval falls back to facts and a keyword match over `policy_clauses`, so chat works on day one. No live call is made by any test.

**D4. What is embedded.** The `memorise` step (complete.md 3.2 step 6) embeds the resolved facts that are `user_confirmed` or `reviewed_reference` (as one sentence each) and the household's own-PDF clauses. A passage is re-embedded only when its redacted text changes (sha256); a passage that no longer holds is deleted. Consent is re-checked inside the write transaction against the document's processing grant; a revoked grant writes nothing. Insurer wording is not stored here (it is shared by reference cache id, never per household).

**D5. Retrieval for a turn.** Confirmed facts and declarations of the household's holdings, open conflicts, then the vector top-k of the question (when embeddings are available and no confirmed fact answers the topic), else a keyword match over clauses. A trace row stores the ids it rested on.

**D6. Deterministic code decides; the model only words.** Intent is classified by keyword rules. Waiting period against policy start, sub-limit, room-rent cap and co-payment are integer arithmetic in `src/features/insurance-rules/procedure-planning.js`. Every answer carries `facts_used` (ids of the memory rows). The model (`CHAT_MODEL_ENABLED` exactly `true`, budget available) drafts prose over redacted facts and may only cite supplied fact aliases; its output status is `extracted_unverified` or `unknown`. Any refusal, unavailability, budget stop or failed check falls back to the deterministic answer (chat v0 behaviour). Names are tokenised by the gate from its own household loader and restored in the reply only. No UIN, policy number or sealed value is ever in a prompt or a response body.

**D7. Streaming.** `POST /api/v1/chat/threads/{id}/turns` answers `text/event-stream` (events `meta`, `delta`, `answer`, `done`, or one `error`). The model call is not token-streamed: the finished answer is chunked into deltas. Token streaming is a later change.

## Known limits

- A live Voyage call is unverified (no key was used). Embedding quality over Indian-language policy text is unmeasured.
- Passages are not reranked and the keyword fallback is the existing English stemmer.
- Vector search filters by household after the index scan; at more than about 1M rows per project partition by household hash and use `hnsw.iterative_scan` (`// SCALE:`).
- The chat consent scope (`recipient: anthropic`) is still the draft of ADR 0030. FOR LEGAL REVIEW.

## Rollback

Expand-only. Turn `MEMORY_ENABLED` and `CHAT_MODEL_ENABLED` off and revert the code; a synthetic-only project may drop `memory_chunks`, `chat_threads`, `chat_turns` and `retrieval_traces`.
