# ADR 0017: Branded gated text at the model boundary

Status: implemented on branch patch/s2-gatedtext (S2 build, 2026-11-06, from main 23ab6d6), pending the independent security review that AGENTS.md requires. Owner decisions: Q1 yes (ABHA and OCR-noise gaps fixed in gate v10), Q2 yes (opaque clause and document aliases). Synthetic data only. Every statement here about DPDP Act 2023, DPDP Rules, consent, notice, retention or cross-border transfer is a draft **FOR LEGAL REVIEW** and is not final.

Companion specs:

- `docs/architecture/privacy-gate-golden-corpus.md`: the 300+ case corpus, fuzz and second detector.
- `docs/architecture/dpdp-purpose-registry.md`: the field-to-purpose registry.
- `docs/architecture/gated-text-test-plan.md`: work packages and tests for the build agent.

## Context

Model calls already go through one gateway (`model-gateway.js`) and one privacy gate (`privacy-evidence-gate.js`). But for three of the four model paths, "the text was gated" is a **convention**, not a check:

- `structuring-runtime.js:10-11` says "Chunk text reaches this module already privacy-gated (policy-structuring gateChunks)". Nothing verifies it. `gateway.execute` (`model-gateway.js:77-82`) accepts any `input` that passes the shape check in `schemas.js:225-229`. That check looks only at array keys and bounds, not at where the strings came from.
- `investigate.js:415-417` notes that the fallback FTS search returns stored **ungated** clauses and that "only clauses that passed the gate are used". That holds only because the code is currently written that way.
- The reconcile payload (`reconciler.js:137-139`) and the sweep payload (`investigate.js:460-464`) send back strings the **model** produced (`value`, `subject`, `quote`, `findings[].subject`). Those strings are not re-gated.
- `investigate.js:53` (`toWire`) sends the raw database `clause_id` and `document_id` to the provider. The coverage path replaces ids with opaque aliases (`privacy-evidence-gate.js:70-77`); this path does not.

The coverage path (`live-coverage-runtime.js:419-431`) is the only one where the gate builds the entire request. Even there, the gateway cannot tell a sanitised request from a hand-built one.

### Measured gaps in gate v9

These are synthetic probes run against `sanitizeEvidenceTextForStorage` at 23ab6d6 with `knownIdentifiers` set. They become `known_gap` rows in the corpus:

| Probe (synthetic) | Output | Gap |
| --- | --- | --- |
| `ABHA Number: 91-2345-6789-0123` | unchanged | 14-digit ABHA number not detected (shape 2-4-4-4 or contiguous 14) |
| `ABHA 91234567890123` | unchanged | same |
| `Aadhaar 2345 6789 O123` (OCR O for 0) | `Aadhaar: <GOV_ID_1> O123` | last group leaks |
| `PAN: ABCPE 1234 F` | unchanged | PAN split by spaces not detected |
| `call 98765-432I0` (OCR I for 1) | unchanged | confusable digit defeats phone rule |
| known `Rahul Sharma`; text `Rahul Sarma` / `R. Sharma` / `राहुल शर्मा` | unchanged | no transliteration, initial or cross-script matching for known names |
| `abha address meera.synthetic@abdm` | `<UPI_1>` | redacted, but under the bank/UPI reason, not as a health id |

These were handled correctly: Devanagari digits under `आधार`, masked Aadhaar, a pipe member table, a numbered member row, reversed known names, and Devanagari-digit phones.

## Threat model (upload → Sarvam → gate → Gemini → store → erase)

| # | Stage | Threat | Control after this ADR |
| --- | --- | --- | --- |
| T1 | any | New code adds a model call path that skips the gate (the current guard is only a convention) | **Brand**: the gateway refuses input that is not sealed (D1, D3) |
| T2 | payload build | A raw value travels in a slot that is not "text": a title, a subject, `document_id`, a registry label | **Field allow-list** per task. Every slot has a type, and free text must be `GatedText` (D2) |
| T3 | reconcile / sweep | Model-produced strings are sent back without gating | Model-derived slots are typed `GatedText`, so they must be re-gated (`regate: true`) (D2) |
| T4 | gate | Detector misses (ABHA, OCR confusables, transliteration, member tables) | Golden corpus, fuzzing, and a second detector that runs only in CI (D6) |
| T5 | gate | A truncation cuts an identifier into an unrecognisable fragment | Already refused. `gateText` never returns truncated text (D1) |
| T6 | audit | The audit or telemetry row becomes a side channel: per-source digests, version strings, or reason codes that reveal "this household has a health condition" | The audit row keeps the gate version and counts only (D5) |
| T7 | brand | Forgery: copy the brand symbol onto a hand-built object | The brand's authority is a module-private `WeakSet`/`WeakMap`, not the symbol (D1) |
| T8 | brand | The object is mutated after gating (TOCTOU) | `seal` builds a fresh deep-frozen graph from validated values (D2) |
| T9 | brand | Text gated by an older gate version | The brand records the gate version, and the gateway requires the current one (D3) |
| T10 | gateway | Fixture mode or a test-only path hides a missing seal | The brand is enforced in both `fixture` and `live` mode (D3) |
| T11 | ids | Raw database row ids (`clause_id`, `document_id`) reach the provider | The allow-list types them `record_id` now. Phase 3 replaces them with opaque aliases (D2, open question Q2) |
| T12 | upload → Sarvam | Sarvam receives the raw document | Out of scope for the gate. It is governed by `document_processing` consent with recipient `sarvam` (`src/integrations/sarvam/ocr-provider.js:33`). FOR LEGAL REVIEW |
| T13 | store / erase | Derived outputs survive a revocation | Unchanged (existing erasure paths). The new audit counts live in `app_events.payload_enc`; see D5 for redaction |
| T14 | prompt injection | Document text instructs the model | Unchanged: the untrusted-evidence prompt section (`prompts.js`) and the output authority (`src/contracts/ai-authority.js`) |

## Decisions

### D1. `GatedText`: a branded, frozen gate output

Add the following to `src/features/ai-analysis/privacy-evidence-gate.js`. It is the only module allowed to mint the brand.

```js
const GATED = Symbol('coversaath.gatedText');      // module-private; never exported
const GATED_TEXT = new WeakSet();                  // authority for GatedText
const SEALED = new WeakMap();                      // authority for sealed inputs: object -> { task, gateVersion, counts }

/**
 * @typedef {Readonly<{
 *   text: string,                 // gated text, never truncated
 *   gateVersion: string,          // PRIVACY_EVIDENCE_GATE_VERSION at mint time
 *   placeholderCount: number,     // placeholders minted or kept in this value
 *   reasonCodeCount: number,      // distinct reason codes (codes themselves stay in memory only)
 *   inputBytes: number,
 *   outputBytes: number,
 * }>} GatedText
 * Also carries a non-enumerable [GATED] = gateVersion (diagnostics only; not the authority).
 */

/** Gates one text value for a model slot. Throws (fail closed) on refusal or truncation; never returns raw text. */
export function gateText(text, { maxBytes = 16_000, knownIdentifiers, regate = false } = {}) // -> GatedText

/** True only for an object minted by gateText in this process at the current gate version. */
export function isGatedText(value) // -> boolean

/** Builds a fresh deep-frozen model input from a draft payload, validated against MODEL_INPUT_FIELDS[task]. */
export function sealModelInput(task, draft) // -> SealedModelInput (frozen plain object, registered in SEALED)

/** True only for an object returned by sealModelInput / sanitizeEvidenceForModel for this exact task and current gate version. */
export function isSealedModelInput(value, task) // -> boolean

/** Counts-only gate summary for a sealed input (D5). */
export function sealedInputCounts(value) // -> Readonly<{ gateVersion, gatedSlots, placeholders, reasonCodes, gatedBytes }>
```

Rules:

- `gateText` wraps the existing `sanitizeEvidenceTextForStorage` logic (`privacy-evidence-gate.js:1578-1596`) and adds no new redaction rules. If `truncated` would be true, it throws `EVIDENCE_SOURCE_LIMIT` instead of returning text. The returned object is `Object.freeze`d. The `[GATED]` symbol is defined with `enumerable: false`. The object is added to `GATED_TEXT`.
- `isGatedText(v)` returns `GATED_TEXT.has(v) && v[GATED] === PRIVACY_EVIDENCE_GATE_VERSION && Object.isFrozen(v)`.
- Why a `WeakSet` and not the symbol alone: `Object.getOwnPropertySymbols(real)` exposes the symbol, so any code could copy it onto a forged object. Identity membership in a module-private `WeakSet` cannot be forged from outside the module. The symbol stays so that the version can be inspected and so the "module-private symbol + gate version" requirement holds.
- `sanitizeEvidenceTextForStorage` keeps returning a plain object. Its output is persisted, and a brand would not survive the database anyway. **Invariant:** text read from storage is untrusted, and the model boundary always gates it again in the current request with `regate: true`.
- `sanitizeEvidenceForModel` (`privacy-evidence-gate.js:1718-1821`) keeps its signature. Its `input` becomes a `SealedModelInput` for `task`, sealed through the same allow-list (D2) as a second check. Its `audit` stays in memory for pre-dispatch (`live-coverage-runtime.js:342-354`) and is never persisted (D5).
- `gateChunks` (`policy-structuring/index.js:50-72`) and `gateClauses`/`gate` (`investigate.js:33-51`) switch from `sanitizeEvidenceTextForStorage` to `gateText`. Each sent chunk or clause keeps `text: gated.text`, a plain string so that the validator, sectioner and token estimates are unchanged, and gains `gated: GatedText` and `gatedTitle: GatedText | null`. An invariant test checks `chunk.text === chunk.gated.text`.

### D2. The field allow-list (`MODEL_INPUT_FIELDS`)

`MODEL_INPUT_FIELDS` is a frozen table in `privacy-evidence-gate.js`, keyed by task. `sealModelInput(task, draft)` walks the draft against it and builds a **new** object. Slot types:

| Type | Accepts | Emits |
| --- | --- | --- |
| `gated` | an object with `isGatedText(v) === true` | `v.text` |
| `gated?` | `gated` or `null` | string or `null` |
| `id` | string matching the slot's regex | the same string |
| `record_id` | string matching `^[A-Za-z0-9_-]{1,100}$` (T11; Phase 3 changes this to an opaque alias) | the same string |
| `int` | an integer within the slot's `[min, max]` | the same number |
| `enum` | a member of the slot's frozen list | the same string |
| `static` | a string matching `^[A-Za-z0-9 ()/,.%&'+-]{1,120}$` that the gate leaves unchanged (`gateText(s).text === s`) | the same string |
| `array<T>` | a plain array of length `[min, max]` | a new frozen array |
| `object{...}` | a plain object (`Object.getPrototypeOf === Object.prototype`) with **exactly** the listed keys | a new frozen object |

The tables:

```
policy_structuring_extract   (input envelope: { payload })
  payload.registry[0..500]: { key: id /^[a-z][a-z0-9_]{0,79}$/, label: static, valueType: enum(POLICY_PARAMETER_VALUE_TYPES) }
  payload.chunks[1..500]:   { chunk_id: id /^p[1-9]\d{0,4}-b\d{1,5}(?:-part\d{1,3})?$/ (sectioner.js:51,67,70), page: int[1,10000],
                              block_indexes: array<int[0,100000]>[1..500], kind: enum(sectioner chunk kinds; the builder lists them from sectioner.js),
                              title: gated?, text: gated }
policy_structuring_reconcile (input envelope: { payload })
  payload.groups[1..500]:   { group_id: id /^[A-Za-z0-9_.:-]{1,120}$/, target: id /^[a-z][a-z0-9_]{0,79}$/, subject: gated,
                              readings: array<{ value: gated, quote: gated, page: int[1,10000] }>[1..50] }
policy_evidence_investigate  (input envelope: { payload })
  payload.questions[1..1]:  { text: gated }
  payload.checklist[1..20]: enum(BASE_KINDS + 'procedure')
  payload.clauses[1..500]:  { clause_id: record_id, document_id: record_id, page: int[1,10000] | null,
                              kind: enum(CLAUSE_KINDS from src/contracts/policy-evidence.js), title: gated?, text: gated }
policy_evidence_override_sweep (input envelope: { payload })
  payload.questions[1..1]:  { text: gated }
  payload.findings[1..60]:  { finding_id: id /^[A-Za-z0-9_.:-]{1,64}$/, subject: gated, quote: gated, clause_ids: array<record_id>[1..50] }
  payload.clauses[1..500]:  same as investigate
coverage tasks (profile_extraction, group_cover_extraction, personal_cover_extraction, evidence_synthesis, question_drafting)
  context: { caseId: id /^case_[0-9a-f]{24}$/, subjectId: id /^subject_[0-9a-f]{24}$/, purpose: gated, requestedFields: array<id /^[A-Za-z][A-Za-z0-9_.-]{0,119}$/>[0..40] }
  sources[1..30]: { id: id /^source_[0-9a-f]{24}$/, version: gated, page: int[1,..] | null, text: gated, status: enum(known, unknown, conflict) }
  upstream[0..20]: structured (sanitizeStructured output; sealed internally by the gate only)
```

Notes:

- Model-derived strings (`subject`, `value`, `quote`, `findings[].subject`, `findings[].quote`) are typed `gated`, so the reconciler and the sweep must call `gateText(s, { knownIdentifiers, regate: true })` on them (T3). A refused reading or finding is dropped and counted under its existing rejection reasons. It is never sent raw.
- The `enum` lists are imported constants, not copies. `CLAUSE_KINDS` comes from `src/contracts/policy-evidence.js`, which ai-analysis may import. The sectioner chunk kinds and the investigate checklist kinds (`investigate.js` `BASE_KINDS` plus `procedure`) move into `src/features/ai-analysis/structuring-contract.js`, and their current owners import them from there. That avoids an import cycle from ai-analysis into policy-structuring or policy-evidence. `POLICY_PARAMETER_VALUE_TYPES` is read the same way `live-coverage-runtime.js` reads the registry today. If that import is not allowed, the builder adds the list to `structuring-contract.js` with a test that checks it equals the registry's list.
- `sealModelInput` refuses, with code `MODEL_INPUT_NOT_ALLOWED` and status 500 (it is a server defect, not a client error), in these cases: unknown task; a missing or extra key; a symbol key; an accessor (getter or setter) property; a Proxy (`util.types.isProxy`); a non-plain prototype; a cycle; `__proto__`/`constructor`/`prototype` keys; a slot type mismatch; a `GatedText` from another version; a serialised size over `MODEL_INPUT_MAX_BYTES` (96 000, the gate's existing total ceiling).
- Error messages name the path (`payload.chunks[3].title`) and never the value.

### D3. The gateway refuses unbranded input

In `model-gateway.js`, inside `execute` (line 77), immediately after `assertModelTask(task)` (line 78) and **before** any reservation, contract build or dispatch:

```js
if (!isSealedModelInput(input, task)) {
  emit({ task, outcome: 'ungated_model_input', latencyMs: 0, dispatched: false, inputTokens: 0, outputTokens: 0, costUsd: 0 });
  fail('ungated_model_input', 'Model input did not come from the privacy gate.');
}
```

- This applies in **both** modes (T10). Fixture runs prove the seal as well.
- `buildPromptContract` (line 81), the `structuredClone(input)` handed to the runner (line 101) and the fixture call (line 128) all receive the sealed object. `structuredClone` drops symbol keys and freezing, so the runner and the provider see a plain object.
- The gateway is the only consumer of `isSealedModelInput`. It is not re-exported from `ai-analysis/index.js`, which exports `gateText`, `isGatedText` and `sealModelInput` only.
- `structuring-runtime.js:65-69` changes the call signature from `call({ task, payload })` to `call({ task, input })`, where `input` is a sealed `{ payload }` envelope passed straight to `gateway.execute`. Wrapping it in a new object would break the brand, which is intended.
- `liveRunner` and `createAiSdkRunner` stay internal to `structuring-runtime.js` and `live-coverage-runtime.js`. An architecture rule (D7) enforces this.

### D4. Fail closed, everywhere

| Situation | Behaviour |
| --- | --- |
| Gate refuses a chunk or clause | Skipped with its existing reason (`privacy_gate_refused`, `privacy_truncated`); never sent |
| Gate refuses a title | `gatedTitle: null`; the raw title is never sent |
| Gate refuses the question | `INVESTIGATION_QUESTION_REFUSED` (existing, `investigate.js:412`) |
| Gate refuses a model-derived reading or finding (re-gate) | Dropped; counted as `privacy_gate_refused` in that stage's rejected reasons |
| Seal refuses a draft | `MODEL_INPUT_NOT_ALLOWED`, no reservation, no dispatch, counted as an `ungated_model_input` event |
| Gateway receives an unsealed input | `ungated_model_input`, no reservation, no dispatch |
| `knownIdentifiers` missing | Existing refusal (`privacy-evidence-gate.js:1580`, `live-coverage-runtime.js:398-409`) |
| Gate throws an unexpected error | Treated as a refusal; never retried with a weaker gate |

### D5. Audit row: gate version and counts only

- Nothing about the gate is persisted except a counts-only summary added to the existing `provider_call` app event payload (`create-server.js:123-130`, stored sealed in `app_events.payload_enc`, migration 022):
  `gateVersion` (string, matches `PAYLOAD_TEXT` in `app-event-repository.js:17`), `gatedSlots`, `placeholders`, `reasonCodes` (a count, not codes), `gatedBytes`.
- The gateway gets these from `sealedInputCounts(input)` and adds them to its `onEvent` event, which today carries metadata only (`model-gateway.js:43-44`).
- **Never persisted:** per-source digests, reason-code strings, placeholder kinds, per-kind counts, source versions, or text. Reason codes such as `SENSITIVE_HEALTH_CONDITION` reveal on their own that a household's document mentions a diagnosis. That is health data by inference. FOR LEGAL REVIEW.
- The existing in-memory `audit` from `sanitizeEvidenceForModel`, which includes digests, stays in memory for the pre-dispatch digest check and is dropped with the request.
- `provider_call` events currently carry no `consent_grant_id`, so consent revocation does not redact them (`app-event-repository.js:111-114`). Because the new fields are counts only this is acceptable, but it is recorded as open question Q4.
- No migration is needed. The payload stays within `MAX_PAYLOAD_KEYS = 20` (5 existing keys plus 5 new).

### D6. Proof: golden corpus, fuzzing and a second detector (CI only)

- A synthetic golden corpus of 336 cases in 13 categories. The spec is in `docs/architecture/privacy-gate-golden-corpus.md`. `enforced` rows must pass with zero leaks. `known_gap` rows are `todo` tests and their total may not grow.
- Seeded fuzzing: 5 000 mutations per run over fixed seeds, using mutators for separators, Unicode digits, zero-width characters, line breaks, confusables, case and table embedding.
- A second detector written independently of the gate, using a different technique (a skeleton stream plus windowed shape scans plus known-name fuzzy matching). It runs only in `npm test` and CI over the gate's **output**. It is never imported by `src/` and never runs at request time. Presidio and other new dependencies are rejected for now (AGENTS.md: dependencies only for measured need).

### D7. Architecture rules

Add to `scripts/check-architecture.mjs`:

- Only `src/features/ai-analysis/structuring-runtime.js` and `live-coverage-runtime.js` may call `createModelGateway(` or `createAiSdkRunner(`.
- No file under `src/` outside `src/features/ai-analysis/` may import `@ai-sdk/*` or `ai`.
- `isSealedModelInput` may be imported only by `model-gateway.js`.
- The string `GATED_TEXT`/`SEALED` registry may not be exported (no `export` of those identifiers).

### D8. Gate version

`PRIVACY_EVIDENCE_GATE_VERSION` stays `knowvia-privacy-evidence-v9` for the brand-only change (Phase 1 and 2), because no redaction rule changes. Any rule change, such as the ABHA work in Phase 4, bumps it to `-v10` and reruns the full corpus. Renaming the `knowvia` prefix needs a compatibility plan (AGENTS.md) and is out of scope.

## Call sites (file:line at 23ab6d6)

**Gate producers**

| Site | Today | Change |
| --- | --- | --- |
| `src/features/ai-analysis/privacy-evidence-gate.js:1578` `sanitizeEvidenceTextForStorage` | storage gate, plain output | unchanged; `gateText` wraps it |
| `src/features/ai-analysis/privacy-evidence-gate.js:1718` `sanitizeEvidenceForModel` | returns `{ input, audit }` | `input` sealed for `task` (D1, D2) |
| `src/features/policy-structuring/index.js:50-72` `gateChunks` (title 56, text 64) | storage gate per chunk | `gateText`; adds `gated`, `gatedTitle` |
| `src/features/policy-evidence/investigate.js:33-39` `gate`, `:41-51` `gateClauses`, `:411` question | storage gate | `gateText`; adds `gated`, `gatedTitle`; question becomes `GatedText` |
| `src/features/coverage-analysis/source-input.js:215, 221` | storage gate for the source pack | unchanged (stored; gated again at `sanitizeEvidenceForModel` with `regated: true`) |
| `src/evaluation/safety-evaluator.js:73` | storage gate probe | unchanged; add a brand probe (test plan WP6) |

**Payload builders (must seal)**

| Site | Payload | Change |
| --- | --- | --- |
| `src/features/policy-structuring/extractor.js:104-106`, call `:110` | `{ registry, chunks }` | build the draft with `text: chunk.gated`, `title: chunk.gatedTitle`; `call({ task, input: sealModelInput(task, { payload }) })` |
| `src/features/policy-structuring/reconciler.js:137-139`, call `:149` | `{ groups }` with model-derived `subject`, `value`, `quote` | re-gate those three (`regate: true`); seal |
| `src/features/policy-evidence/investigate.js:53` `toWire`, `:443` investigate call, `:460-468` sweep | `{ questions, checklist, clauses }`, `{ questions, findings, clauses }` | `toWire` emits `gated` / `gatedTitle`; findings re-gated; seal both; `run` (`:426-436`) passes `input` |
| `src/features/ai-analysis/live-coverage-runtime.js:419-431` | `sanitizeEvidenceForModel(...)` | none (already sealed by D1); `requestCache` holds the sealed object |

**Gateway and runners**

| Site | Change |
| --- | --- |
| `src/features/ai-analysis/model-gateway.js:77-82` `execute` | brand check before reservation (D3); counts on `onEvent` (D5) |
| `src/features/ai-analysis/model-gateway.js:101, 128` | receive the sealed object; unchanged otherwise |
| `src/features/ai-analysis/structuring-runtime.js:65-69` | `call({ task, input })`; pass `input` to `execute` unchanged |
| `src/features/ai-analysis/runtime-adapter.js:15` | none (`build` returns the sealed input) |
| `src/features/ai-analysis/live-coverage-runtime.js:464-475` | none |
| `src/features/ai-analysis/structuring-runtime.js:57` | none |

**Composition, services and scripts**

| Site | Change |
| --- | --- |
| `src/server/create-server.js:123-130` `onProviderEvent` | copy the five D5 count fields into the payload |
| `src/server/create-server.js:131, 144` | none |
| `src/backend/services/policy-structuring-service.js:122-128` | none (call factory signature change is internal) |
| `src/backend/services/policy-evidence-service.js:357-362` | none |
| `scripts/structure-policy.mjs:176, 187` | dry run unchanged; the live path calls Gemini through `createStructuringModelCallFactory` (gateway, seal, budget). It no longer builds its own fetch caller, which would have read the old `payload` call shape and sent an empty request |
| `src/features/policy-evidence/recall-eval.js:31` | none (gating only, no call); `.gated` is ignored |
| `src/features/ai-analysis/index.js` | export `gateText`, `isGatedText`, `sealModelInput`; do **not** export `isSealedModelInput` |

**Tests that call the gateway or the call factories directly and must move to sealed inputs**

- Gateway: `tests/ai-analysis.test.mjs` (7 `execute` calls), `tests/review3-fixes.test.mjs` (2), `tests/runtime-limits.test.mjs` (2), `tests/policy-evidence-budget.test.mjs` (1).
- Factories: `tests/analysis-subject-consent.test.mjs`, `consent-race-fixes`, `consent-scope-stop`, `known-identifier-e2e`, `live-coverage-runtime`, `live-evidence-selection`, `model-boundary-safety`, `pre-dispatch-consent`, `privacy-evidence-gate`, `review3-fixes`, `round3-runtime-integration`, `round4-runtime`.
- Fake `call` functions in structuring and investigation tests that read `payload` must read `input.payload`.

## Migration path (each phase ships green; no database migration)

1. **Phase 1, additive.** Add `gateText`, `isGatedText`, `sealModelInput`, `isSealedModelInput`, `sealedInputCounts` and `MODEL_INPUT_FIELDS`. `sanitizeEvidenceForModel` seals. The gateway runs the check in **warn mode**: it counts `ungated_model_input` events but still dispatches. This mode exists only on the branch and never in a merged commit with live flags on. The corpus, fuzz and second detector land here.
2. **Phase 2, enforce.** Switch the builders (extractor, reconciler, investigate and sweep) and `structuring-runtime.js` to sealed inputs. Move the tests. Turn the gateway check to **enforce** in both modes. Remove warn mode in the same commit. Add the architecture rules (D7).
3. **Phase 3, opaque ids (decision Q2).** Replace `record_id` slots with aliases (`clause_[0-9a-f]{24}`, `doc_[0-9a-f]{24}`) and map them back deterministically, as `opaqueSourceId` does.
4. **Phase 4, gate v10 (optional, owner decision Q1).** Close the measured ABHA gap. Optionally close the split-PAN and confusable gaps. Bump the gate version and promote the affected `known_gap` rows to `enforced`.

**Rollback:** each phase is one revert. Phase 2's enforcement can be reverted on its own, which brings back the Phase 1 warn mode. No stored data changes shape.

## Consequences

- An ungated model call becomes a runtime error instead of a review finding, and it fails before any money is reserved.
- Re-gating model-derived strings costs a little CPU per reconcile or sweep call. That cost is bounded by the existing 16 KB scan cap per value.
- Test churn: about 16 test files move to sealed inputs. Fake `call`s change from reading `payload` to reading `input.payload`.
- The gate module grows by about 200 lines. A split (`gated-text.js`) is possible, but the brand registry must stay in the same module as the minting code.

## Open questions

- **Q1.** Is the ABHA number gap (14 digits) fixed in this S2 build (Phase 4) or tracked as a gap? Recommendation: fix it. It is a health identifier under ABDM. FOR LEGAL REVIEW on classification.
- **Q2.** Should raw `clause_id` and `document_id` stop reaching Gemini (Phase 3)? Recommendation: yes. They are pseudonymous internal keys, and the coverage path already aliases ids.
- **Q3.** Is any fictional or reserved Indian mobile number range usable in fixtures? None is known. The corpus uses seeded generated values and a do-not-dial rule.
- **Q4.** Should `provider_call` events carry `consent_grant_id` so that revocation redacts them? That needs the grant id threaded into `onProviderEvent`.
- **Q5.** Cross-border processing by Gemini (where Google processes the data) and the DPDP section 16 position. FOR LEGAL REVIEW; not a code decision.
- **Q6.** ADR numbering: there is no 0016 on main at 23ab6d6. This ADR takes 0017 as instructed, which assumes 0016 is reserved by a parallel run.

## Implementation notes (S2 build)

Written after the build. Where the design above and the code differ, the code is right and this section says why.

- **Phase order.** The branch was built in this order: primitives, allow-list and seal, builders, gateway enforcement, architecture rules, corpus, registry, gate v10. The gateway enforces from its first commit-ready state; the Phase 1 warn mode was never written, because the branch has no merged commit with live flags on. Rollback is one revert per work package.
- **Allow-list file.** `MODEL_INPUT_FIELDS` lives in `src/features/ai-analysis/model-input-fields.js` (data only). The seal engine and every registry (`GATED_TEXT`, `SEALED`, `SAFE_STRUCTURED`) stay in `privacy-evidence-gate.js`, unexported; `scripts/check-architecture.mjs` fails the build if any is exported.
- **Slot patterns corrected against real values.** Registry keys carry a category prefix (`a.policy_type`), so `target` and `payload.registry[].key` allow `.`. Registry labels contain an en or em dash (`Co-pay — general`), so `static` allows U+2013 and U+2014. `group_id` is `<registry|proposed>:<key>|<member vocabulary subject>` (it holds a lower-cased `<name_1>` placeholder or a member word, never free text), not the plain id pattern in D2.
- **Coverage tasks.** `sanitizeEvidenceForModel` mints `GatedText` internally from the values it already redacted and registers its sanitised `upstream` in a private set; `sealModelInput` accepts the `structured` slot only for that object, so a hand-built coverage input can never be sealed. A task name with no allow-list (probes) keeps the old plain clone, which the gateway refuses.
- **Opaque ids (Phase 3).** `record_id` was never shipped: `clause_id` is `clause_<24 hex>` and `document_id` is `doc_<24 hex>` from the start (`opaqueClauseId`, `opaqueDocumentId`). `investigate` maps a cited alias back to the stored clause; a stored id, an invented alias or anything else names no clause and the finding is dropped.
- **Seal failures.** A `MODEL_INPUT_NOT_ALLOWED` from a builder is a server defect: it propagates from the extractor, reconciler and investigation (`passThrough`), it is not reported as a provider error, and it happens before the consent check and any reservation. `ungated_model_input` is emitted by the gateway only for input that reaches it unsealed.
- **Reconcile.** `reconcile()` now requires `knownIdentifiers` (an empty array is explicit). Quotes the model returns are translated back to the original quote, so a re-gated quote that differs from the stored one still grounds.
- **Safety evaluator probe.** `createModelGateway(` may be called only by the two runtimes (D7), so the evaluator probe calls the check the gateway itself runs first, `assertGatewayInput` exported from `model-gateway.js`, instead of building a second gateway.
- **Counts.** `provider_call` events carry `gateVersion`, `gatedSlots`, `placeholders`, `reasonCodes`, `gatedBytes`. `create-server.js` passes them through `sanitizePayload` unchanged.
- **Gate v10 (Phase 4).** Version `knowvia-privacy-evidence-v10`. New: ABHA number rules (`HEALTH_ID`, `DIRECT_IDENTIFIER_HEALTH_ID`; labelled and unlabelled); confusable letters inside a number that reads as an identifier once folded are folded before the rules run; combining marks after a digit and a hyphen at a line end inside a number are normalised; labelled Aadhaar and phone values accept every Unicode hyphen, `/`, `_`, the middle dot and one line break; a PAN split by spaces or dashes is found; dates accept the same separators; a bracketed STD phone accepts `/` and the middle dot.
- **Corpus result.** 336 rows in the 13 categories of the spec. Gate v9 started with 61 known gaps (the 49 designed in advance plus 12 the corpus found: Devanagari labels, member tables with generic headers, a first name alone, a PAN after a name-like label, a line break inside an Aadhaar). Gate v10 closed 28; 33 remain and `KNOWN_GAP_CEILING` is 33. Seeded fuzzing (5 000 or more enforced mutations per run) found line-break, Unicode-hyphen and middle-dot gaps that v10 closes, and three it does not (`FUZZ_KNOWN_GAPS` in `tests/privacy-gate-fuzz.test.mjs`).
- **Open items for the reviewer.** Q3 to Q6 are unchanged. New: no erasure function exists for `adult_users.phone_ciphertext` (registry R6 gap list); the second detector was written after the gate source had been read for the design, so it is independent in technique but not in authorship.

### Review fixes (S2 review round)

- **P1-1.** `scripts/structure-policy.mjs` live path now uses `createStructuringModelCallFactory`; a static test forbids the direct caller there.
- **P1-2.** `createGeminiCaller` left `src/`. Its replacement `createGeminiEvalCaller` is in `scripts/lib/gemini-eval-caller.mjs`, marked EVAL ONLY: it still bypasses the gate and the gateway, for the opt-in local field-adjudication experiment only. A new architecture rule fails the build for any `fetch(` call or Gemini endpoint literal under `src/` outside `src/integrations/`.
- **P2-1.** Factory rule now matches any mention (alias, namespace, import, re-export); `createAiSdkRunner` is no longer exported from the module index; registry rule also covers `export default` and `module.exports`. The runner itself refuses any request the gateway did not build (`isGatewayRequest`), so a stray runner cannot be driven without the seal check.
- **P2-2.** Registry slots are membership checks, not shapes: `registry[]` must equal one registry entry (key, label and value type together). Reconcile groups go out as `g1, g2, ...` (the stored group id embeds a model-written key); only an alias the provider was shown names a group on the way back. `target` is now a `gated` slot: a model-written key is spaced out, gated, and replaced by `proposed_item` if the gate would change it. `finding_id` must be `f<n>`.
- **P2-3.** The bare split-PAN rule is upper case only, individual PANs only (fourth letter P) and skips year-like digit groups; a labelled split PAN (`PAN`, `Permanent Account Number`) accepts every holder type and any case. Four preserve rows guard it (corpus is 340 rows). Trade-off, tracked in the fuzz test: a bare lower-case split PAN is not found.
- **P2-4.** An ABHA number is any 14 digits in one to five groups of two or more digits.
- **P2-5.** A labelled phone value may span up to six whitespace or line-break characters between digit groups ("Ph: 98765\n\n43210").
- **P2-6.** Quote translation is per group, and one returned quote expands to every original quote that gated to the same text, so a conflict between two quotes that differ only by a removed name is no longer dropped as ungrounded.
- **P2-7.** Findings the sweep re-gate refuses are excluded from the sweep payload, from the sweep's context selection, and from the set of valid override targets (validated against the findings actually shown).
