# ADR 0030: Model gateway routing, Anthropic provider and redaction evidence (migration 056)

Status: accepted for the prototype (synthetic data only). Consent, privacy, cross-border and notice wording here is a draft that is not final and needs legal review before any real user data. Plan: `docs/exec-plans/active/complete.md` sections 3.4 and 9 (S-A2).

## Context

Chat v1, intent classification, fact extraction and embedding need a model provider other than Gemini, chosen by purpose, without opening a second path around the privacy gate. ADR 0017 already seals model input: only text minted by `privacy-evidence-gate.js` reaches `model-gateway.js`, and only the gateway builds a request the AI SDK runner accepts. This ADR extends that gateway; it does not add a parallel one.

## Decisions

**D1. Extend the existing gateway, one new dependency.** `@ai-sdk/anthropic` (`^4.0.102`, same major line as the installed `@ai-sdk/google` 4.x and `ai` 7.x) is added. It is the only new dependency. No raw `@anthropic-ai/sdk`. The provider SDKs are constructed in one place, `createProviderModelLoader` in `src/features/ai-analysis/ai-sdk-runner.js`; the two existing Gemini runtimes now use it too, so Gemini is wrapped, not rewritten.

**D2. Provider wiring is configuration under `src/integrations/`.** `anthropic/` (default `claude-sonnet-5-5`, classification tier `claude-haiku-5-5`), `gemini/`, and `deepseek/`, `kimi/`, `openai/` as config entries with no SDK (their model ids are placeholders, not verified). `model-routing/` resolves a purpose to a provider by a data table (`MODEL_ROUTES`) and the `MODEL_PROVIDERS` env list (default `anthropic`). A route that has no key, no price rates, no SDK adapter or no entry resolves to `unavailable`, and the gateway returns the task's typed `unknown` output: nothing is dispatched, the reservation is released, and the call is audited. Keys come from the environment only (`ANTHROPIC_API_KEY`, ...). Prices are never guessed: `ANTHROPIC_INPUT_USD_PER_MILLION` and `ANTHROPIC_OUTPUT_USD_PER_MILLION` (and a `CLASSIFY_` pair) must be set from the provider's price list.

**D3. New tasks.** `chat_answer`, `intent_classify`, `fact_extract` and `embed` are in the responsibility matrix, the authority matrix (`pipeline: model-gateway`), prompts, output schemas and the model-input allow-list. Their output `status` is only `extracted_unverified`, `conflicting` or `unknown`; code checks grounding (fact ids supplied, quotes verbatim in the supplied text, no unsupported insurance certainty). `embed` has no route until an embedding provider is chosen (ADR 0031), so it answers `unknown`. Prompt version is `knowvia-ai-analysis-v2`.

**D4. Flag.** `CHAT_MODEL_ENABLED` is off unless exactly `true`. Off: `createChatModelGateway().call` returns the typed unknown without a provider, key or database touch.

**D5. Only the gateway runner may import a provider SDK.** `scripts/check-architecture.mjs` now fails any file other than `src/features/ai-analysis/ai-sdk-runner.js` that imports `ai` or `@ai-sdk/*` (static, dynamic or require). `chat-runtime.js` joins the two existing runtimes as an allowed builder of a gateway. `tests/check-architecture.test.mjs` proves it with a scratch fixture: a deliberate direct import fails, and passes once removed.

**D6. Redaction gate hardened, not forked (gate v11).** `gateTextForHousehold(text, { householdId, loadKnownIdentifiers })`: the household's member names, dates of birth, phones and e-mails are opened inside the gate through a household-scoped loader the composition root supplies; no caller passes names in and no prompt builder sees them. Over the existing regex set (Aadhaar, PAN, phone, e-mail, DOB, policy number, member id) it adds: bare known first names, a pincode that keeps its first three digits when labelled (`560034` becomes `560XXX`), stable tokens (`{{PERSON_1}}`, `{{PHONE_1}}`), refusal of sealed-column ciphertext (`enc1.`/`enc2.`) and of raw token syntax, and a `rehydrate()` that restores only the `{{PERSON_n}}` tokens minted by that call. A ciphertext column is never decrypted into a prompt: the gate refuses an envelope, and every free-text slot must be a gate-minted `GatedText`. The sealed-input `WeakSet` invariant is unchanged: only gate-minted input passes the gateway, in fixture and live mode. Embedding calls take the same path and write the same audit row.

**D7. `provider_calls` (migration 056).** One append-only row per call that reaches the gateway, including refused, unavailable and failed ones: `id, household_id (nullable), purpose, provider, model, redaction_report_json, payload_sha256, input_tokens, output_tokens, cost_paise, status, created_at`. The report holds counts only (gate version, gated slots, placeholders, reason-code count, gated bytes). `payload_sha256` is the digest of the redacted outbound prompt. The payload and the response are never stored. Text ids, RLS on, Data API roles revoked (016 pattern), scope trigger when a household is named, update blocked, deleted by household erasure. `cost_paise` converts USD with `COST_PAISE_PER_USD` (accounting estimate, default 9000).

**D8. Budget.** Per household per day through the existing ledger scopes (`createHouseholdDayBudget`); a refused reservation fails the call before any provider.

## Evidence

`tests/model-gateway-chat.test.mjs`: a synthetic-PII fixture produces zero matches for the leak patterns in the outbound prompt (captured at the AI SDK agent boundary) and the audit row holds counts and a digest only; no key, flag off, unsealed input, routing, output status and grounding, ownership and erasure of `provider_calls`. `tests/data-erasure-proof.test.mjs` covers erasure of the new store.

## Known limits

- A live Anthropic call is unverified (no key was used). Price rates and the Anthropic model ids are as given by the plan.
- An unlabelled six-digit number is not treated as a pincode (it could be an amount); only a labelled pincode is cut to three digits.
- Names the household never typed (a hospital's doctor) are caught by the existing honorific and label rules only.
- Rate limit, budget and concurrency are per process (`// SCALE:`); the daily budget uses the database ledger when one is passed.
- Wording of the chat consent scope (`recipient: anthropic`) is a draft; the grant that opens it is built with chat v1 (S6). FOR LEGAL REVIEW.

## Rollback

Expand-only. Turn `CHAT_MODEL_ENABLED` off and revert the code; a synthetic-only project may drop `provider_calls`.
