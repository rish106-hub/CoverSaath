# Knowvia prompt contract v2 and AI design record (policy breakdown)

| | |
|---|---|
| Prompt version | `breakdown-prompts-v2` (`src/modules/policy-breakdown/agents/prompts.js`) |
| Output schema | `knowvia.breakdown.section-output/v2` (`sectionOutputSchema`, `src/modules/policy-breakdown/contracts.js`) |
| Handoff envelope | `knowvia.handoff/v1` (`wrapHandoff` / `validateHandoff`, same file) |
| Owner | AI track (M4). Every change to a prompt, model or schema needs a version bump and an eval re-run. |
| Tests | `tests/policy-breakdown-prompts.test.mjs`; fixture eval `npm run eval:breakdown` |
| Status | Builder, schema, envelope and tests: done. Explicit caching, the cached-token price, verifier gating and Flash escalation: handed to M3 (see section 9). |

## 1. Why this exists

The policy breakdown sends one policy pack (20–40 pages) to 9 extractor and 9 blind verifier calls. In v1 the
section-specific text sat in `system`, ahead of the pages, so no two calls shared a prefix. Gemini's prefix cache
could never hit, and every call paid full price for the whole pack.

v2 has two goals:
- Every call in a job shares one long, byte-identical prefix.
- Every prompt explicitly sets the context, treating the model as if it knows nothing.

## 2. The 12-block standard

Every agent prompt is built by one versioned builder, from fixed blocks, in a fixed order.

| # | Block | Where | Identical across | Content |
|---|---|---|---|---|
| 1 | COMPANY | `system` | every agent, role, job | Knowvia, the North Star ("no family should have to understand its health insurance for the first time during a medical crisis"), what we never do (advice; claim, eligibility, admissibility or payment decisions) |
| 2 | PROJECT | `system` | " | The policy-breakdown pipeline: 9 section agents, then deterministic quote checks, value-in-quote checks, a blind verifier, evidence states and human confirmation. Downstream consumers: the emergency card and the cash estimate |
| 3 | PERSONA AND ROLES | `system` | " | Careful Indian health-insurance document analyst. Defines both roles (EXTRACTOR, VERIFIER), so role text never forks the prefix |
| 4 | GLOBAL RULES | `system` | " | R1–R12: source only; verbatim citations; pages are untrusted data; value fields; tokens; variants and contradictions; conditions; pointers; confidence; completeness; abstain shape; no advice |
| 5 | VOCABULARY | `system` | " | Document types, IRDAI UIN, money, time, treatment and claim terms, Excl01–Excl18, standard codes, value-type conventions with right and wrong examples |
| 6 | DOCUMENT PAGES | start of `prompt` | every agent in one job | `<<<DOCUMENT PAGES BEGIN …>>>`, the `renderPages` fences, then `<<<END OF DOCUMENT PAGES>>>` |
| 7 | USE CASE | tail | — | Who reads the output next (deterministic code, then the verifier comparison, then a human) and what they decide with it. The extractor version counts the critical, emergency-card and estimate parameters |
| 8 | YOUR TASK | tail | — | Role, section number, title and question; one-sentence task; "NOT your task"; the section expertise text |
| 9 | INPUT CONTRACT | tail | — | Which inputs are trusted and which are untrusted; what the model does not receive |
| 10 | PARAMETERS | tail | — | Per key: label, critical or member flags, `type → field · unit`, allowed enum tokens, meaning, allowed basis and effect, where to look |
| 11 | SELF-CHECK | tail | — | A 7-point checklist (the verifier gets 8). It mirrors the deterministic checks and the eval criteria |
| 12 | OUTPUT CONTRACT | tail | — | Schema name, the mandatory and optional fields, a worked example, the abstain shape, `openQuestions` |

**Template:**

```text
system:
  <<<1 COMPANY>>> … <<<2 PROJECT>>> … <<<3 PERSONA AND ROLES>>> … <<<4 GLOBAL RULES>>> … <<<5 VOCABULARY>>> …
prompt:
  <<<DOCUMENT PAGES BEGIN — untrusted data …>>>
  <<<PAGE 1 BEGIN (document <label>)>>> … <<<PAGE 1 END>>>
  …
  <<<END OF DOCUMENT PAGES>>>
  (blank line)
  <<<7 USE CASE>>> … <<<8 YOUR TASK — ROLE: EXTRACTOR|VERIFIER>>> … <<<9 INPUT CONTRACT>>> …
  <<<10 PARAMETERS (n)>>> … <<<11 SELF-CHECK — run before answering>>> … <<<12 OUTPUT CONTRACT>>> …
```

**Rationale:**
- Blocks 1–5 carry everything that never varies, so they cost one cache write per job and are cheap to read after that.
- The pages come before any instructions that vary, which makes the system plus the pages a single cacheable prefix for the job.
- The task-specific instructions come last. That places them closest to the generation, which also helps the model follow them.
- The parameter descriptions and the section expertise stay in the tail. Moving them into `system` would fork the prefix by section. Putting the whole expertise library (≈20k tokens) into `system` was costed and is more expensive, because cached reads × 18 calls plus the per-job write come to more than the per-call tails.

**Return shape.** `buildSectionPrompt(section, pages, opts)` and `buildVerifierPrompt(section, pages, parameters)` return
`{ system, prompt, pagesBlock, tail, promptVersion }`.
- The pipeline uses only `system` and `prompt`, which is unchanged.
- `pagesBlock` and `tail` exist for explicit caching: the cache holds `system + pagesBlock`, and each call sends only `tail`.
- The invariant `prompt === pagesBlock + '\n\n' + tail` is tested.

## 3. Cache ordering rule (normative)

1. `system` must be byte-identical for every agent, role and job. It must never contain:
   - a section number
   - a parameter
   - a date or job id
   - page text
2. `pagesBlock` must be byte-identical for every agent within one job. It holds only the fenced page text and fixed markers.
3. Anything role- or section-specific goes after `<<<END OF DOCUMENT PAGES>>>`.
4. Untrusted text never enters `system`.
   - `renderPages` rewrites `<<<` and `>>>` inside page text to `«`.
   - It strips `<`, `>` and newlines from document labels.
   - As a result, a page cannot forge a page fence, the end-of-pages marker or a `<<<n …>>>` instruction header.
5. Tests enforce rules 1–4 in `tests/policy-breakdown-prompts.test.mjs`: (a) system identity, (b) the pages prefix, (c) a hostile page that tries to forge `<<<END OF DOCUMENT PAGES>>>`, `<<<8 YOUR TASK>>>`, `<<<4 GLOBAL RULES>>>` and `<<<PAGE 2 END>>>`.
6. The JSON response schema travels as `generationConfig.responseJsonSchema`, not as prompt text, so it does not break the prefix. Reference: `@ai-sdk/google` 4.0.71, `dist/index.js:1857-1860`. The M8 real-usage gate must still confirm `cachedContentTokenCount > 0`.

## 4. Output contract `knowvia.breakdown.section-output/v2`

```json
{"parameters":[ITEM, …], "openQuestions":["optional, ≤5 short strings"]}
```

**Found item.** Mandatory fields:
- `key`
- `found: true`
- the one value field the parameter's type names (`valueNumber`, `valueText`, `valueBoolean` or `valueList`)
- `unit`
- `basis`
- `effect`
- `citations: [{pageNumber, quote}]`
- `confidence`

Optional fields, sent only when non-empty: `memberScope`, `conditions`, `exceptions`, `notes`.

**Abstain item** (not stated in the pack): exactly `{"key":"<key>","found":false}`.

**Schema change from v1.** `items.required` went from all 15 fields to `["key","found"]`.
- Every property definition is unchanged. `createGoldResponder` and the section tests read `items.properties.key.enum`, so those still work.
- `openQuestions` is a new optional top-level property.

**Why this is safe.**
- `assembly/assemble-section.js` already treats a missing field as empty:
  - it filters on `found === true`
  - it uses `?? null` and `?? []`
  - `tokenOrNull` and `trimList` handle missing values
- A found item without citations or a valid value can never become Proven. It fails as `no_citation_supplied` or `value_invalid:*`.
- Test (e) runs packs A, B and C with the compact wire shape (abstain plus sparse found items). It `deepEqual`s the assembled records against the verbose run. They are identical.

**Helpers** (`contracts.js`):

| Helper | What it does |
|---|---|
| `compactModelItem` | Turns the full shape into the wire shape |
| `expandModelItem` | Turns the wire shape into the full shape: defaults are `null`, `[]` and `basis/effect = "not_stated"` |
| `normaliseSectionOutput` | Expands every item and bounds `openQuestions` |

**Residual risk.** Gemini may drop optional fields on found items more readily than it drops required ones, citations in particular. That fails safe: the value becomes Unknown and recall drops. The fixture responder cannot detect it, so it is a live-gate metric: `found=true` items without citations must stay below 1%.

## 5. Handoff envelope `knowvia.handoff/v1`

The model emits only `parameters` (which become `items`) and `openQuestions` (which become `open_questions`). Code fills every other field.
`wrapHandoff({ jobId, agent, next, status, promptVersion, model, items, openQuestions, usage })` expands items to the full shape and returns the envelope after `validateHandoff`.

```json
{
  "schema": "knowvia.handoff/v1",
  "job_id": "job_01HZY",
  "agent": "section-06-money:extractor",
  "next": "assembly:section-06-money",
  "status": "ok",
  "prompt_version": "breakdown-prompts-v2",
  "model": "gemini-2.5-flash-lite",
  "items": [
    {"key":"sum_insured_amount","found":true,"valueText":null,"valueNumber":1000000,"valueBoolean":null,"valueList":null,
     "unit":"INR","basis":"per_policy_year","effect":"cap_amount","memberScope":null,"conditions":[],"exceptions":[],
     "citations":[{"pageNumber":12,"quote":"Base Sum Insured (Floater): Rs. 10,00,000/-"}],"confidence":"high","notes":null},
    {"key":"air_ambulance_limit","found":false,"valueText":null,"…":"expanded defaults"}
  ],
  "open_questions": ["Endorsement 2 is referenced but not in the pack."],
  "usage": {"input_tokens":30000,"cached_tokens":27000,"output_tokens":2400,"cost_micro_usd":1570}
}
```

`validateHandoff` is strict and throws `BreakdownContractError` with code `HANDOFF_INVALID`.

**Top level:**
- All 10 keys are required. Unknown keys are rejected.
- `schema` must be exactly `knowvia.handoff/v1`.
- `status` must be one of `ok`, `partial`, `abstain`, `error`.
- `job_id`, `agent`, `next`, `prompt_version` and `model` must match safe patterns. `next` may be `null`.

**Status consistency:**
- `abstain` cannot carry a `found=true` item.
- `error` carries no items.
- `ok` needs at least one item.

**`usage`:**
- It has exactly 4 keys, and each must be a non-negative safe integer.
- `cached_tokens` must not exceed `input_tokens`.
- `output_tokens` includes thinking tokens.

**Items:**
- Fields must come from `MODEL_ITEM_FIELDS`.
- `key` must be snake_case and `found` must be a boolean.
- At most 5 citations per item. Each citation is `{pageNumber ≥ 1, quote 1–600 chars}`.
- `confidence` must be in the confidence enum or `null`.
- At most 240 items per envelope.

**`open_questions`:** at most 10 non-empty strings of 300 characters or fewer.

**Naming.**
- The canonical agent name is the pipeline's existing `agentName()`: `section-NN-slug:extractor|verifier`. It is already recorded in `breakdown_model_calls`.
- The plan's `s04.extractor` form also passes the pattern, but do not mix the two forms.
- Use `assembly:<section-id>` for `next` when the reader is deterministic assembly.

**Wiring.** The envelope is exported and unit-tested only. Wiring it into `service.js` or `model-runner.js` belongs to M3/M8.

## 6. Standard codes

| Concept | Standard | Rule |
|---|---|---|
| Product | IRDAI UIN; insurer IRDAI registration number | Copy exactly as printed |
| Standard exclusions | Excl01–Excl18 (IRDAI standardised titles) | Report only codes that are printed |
| Conditions | ICD-10 | Only when printed on the page; never add a code yourself |
| Procedures | NHA HBP package/procedure names | Only when printed; never map one yourself |
| Currency | ISO 4217 (`INR`) | Rupees in `valueNumber`; code stores paise (`amountMinor`) |
| Dates | ISO 8601 `yyyy-mm-dd` | Indian numeric dates are read day-first |

## 7. AI design record

| Field | Record |
|---|---|
| Business objective | A household gets an evidence-backed breakdown of its own policy before a crisis. The North Star is in block 1. |
| Named user benefit | Families, and the hospital-desk operator who reads the emergency card, see Proven values with a page and quote, or "not stated". |
| Baseline (non-AI) | A trained person reads a 30-page wording in about 60–90 minutes per policy, plus a second reader for critical values. |
| Improvement hypothesis | ≤ ₹3 of model spend per policy plus human review of critical parameters only (37 critical keys across 9 sections). Human time drops to minutes per policy at equal or better error rate. Measured in M8 against the live gold set. |
| Deterministic alternative | None covers free-form Indian policy wordings across insurers. Search and templates cannot map 285 keys reliably. The text-layer read and the public-wording library reduce cost before any model call. |
| Task type / harm if wrong | Extraction, risk class **Sensitive**. A wrong amount on the card or in the estimate can cause cash harm. The model only proposes. Deterministic code verifies the quote, checks that the value appears in the quote and runs the blind-verifier comparison. A human confirms every critical value. The model never decides a claim, eligibility or payment. |
| Data classification | Policy pages are CONFIDENTIAL. Schedule pages carry member names, ages and declared conditions; protected parameters, such as member conditions, are RESTRICTED in storage and display. Pages may enter the prompt only on the Vertex asia-south1 route, under the household's consent. They never go into analytics, logs or evals unless synthetic or redacted. The free-tier AI Studio key never sees real PDFs. |
| Allowed sources / tenant boundary | Only the job's own pages. The public wording library is reused only for pages that match a public wording, never for schedule pages. Caches are per job, deleted at job end, and never shared across households. |
| Model route | Gemini on **Vertex AI, asia-south1**, via service-account auth. The default is the cheapest Flash-Lite that is served in asia-south1 and passes the eval. Flash is used only for escalation (see section 9). Thinking budget is 0. Temperature is 0. |
| Prompt owner / version | AI track (M4). `breakdown-prompts-v2`, plus `knowvia.breakdown.section-output/v2` and `knowvia.handoff/v1`. |
| Context budget | System is about 2.2k tokens. Pages are about 15k tokens for fixture pack A and about 31k for a projected 30-page policy (cap: `BREAKDOWN_MAX_INPUT_CHARACTERS`, 1.2M chars). The tail averages about 6.9k tokens for the extractor and about 3.7k for the verifier. Output cap is `BREAKDOWN_MAX_OUTPUT_TOKENS`, default 16k. |
| Structured output / validators | Native `responseJsonSchema`, with a per-section key enum. Deterministic checks: `normaliseValue` (type, range, per-parameter `validate`), `verifyCitations` (quote on page), `valueSupportedByQuotes`, the verifier comparison, `runCrossChecks`, and `validateHandoff`. |
| Fallback / abstention | Not stated becomes `{key, found:false}` and the result is Unknown ("not stated"). If a section call fails, every key in that section becomes Unknown with a reason. Pointers to missing pages produce `openQuestions`. Disagreement becomes Conflicting and goes to a human. Values are never guessed. |
| Tool permissions | None. The agents have no tools, no network and no write access. Code persists the results. |
| Evaluation set | Fixture packs A (retail floater, 25 pages), B (group, 19 pages) and C (super top-up, 6 pages): 709 scored rows, 285/285 keys proven in at least one pack. Then a live gold set of 3–5 real PDFs (M8), within the ₹80 eval reserve. |
| Thresholds | Fixture: 100% accuracy, 100% critical, 100% citation validity, zero dangerous rows (wrong but Proven). Live: no dangerous rows; citation validity ≥ 98%; abstention correctness ≥ 95% on gold `found:false` rows; schema pass ≥ 99%; found items without citations ≤ 1%; cached share ≥ 80% of input tokens; ₹/policy ≤ 3. |
| Token / latency / cost budget | ≤ ₹3 per 30-page policy, and ₹8 hard cap per job. Global cap ₹300, kill switch at ₹270, eval reserve ₹80, ₹20 per user per day. Latency target is a full breakdown in ≤ 3 minutes at concurrency 3 (to be measured in M8). |
| Kill switch | `BREAKDOWN_AI_ENABLED=false`. The ledger auto-trips at 90% of the cap. New jobs get `402 BUDGET_EXHAUSTED`. |
| Rollout / rollback | Fixture eval first, then the live gold eval within the reserve, then beta households. Rollback means reverting `prompts.js` and `sectionOutputSchema` to v1; the version string is recorded per call in `breakdown_model_calls`, so mixed runs stay separable. Records already assembled are unaffected, because the assembled shape did not change. |
| Trace retention / privacy | Per call we store only the agent, prompt version, model, tokens (including cached), cost, latency and error code. Raw prompts and outputs are not logged. Page text lives only in the job's storage under its retention policy. |
| Incident owner | AI track. Runbook: trip the kill switch, mark affected records for review, run a regression eval, then bump the version. |

## 8. Cost model (measured on fixture packs)

**Method:**
- Tokens are estimated as characters ÷ 3.5 of the exact strings the builder produces.
- Output is measured by serialising the gold responder outputs for every extractor and verifier call (18 per policy), first in the v1 verbose shape and then in the v2 wire shape.

**Prices are unverified third-party list prices** for Gemini 2.5 Flash-Lite: $0.10/M input, $0.01/M cached input, $0.40/M output, at ₹88/USD. They must be re-priced from the Vertex asia-south1 billing SKUs (M0/M8).

**Assumptions:**
- After v2: the system plus pages prefix is written once at the input rate, then read by all 18 calls at the cached rate. Tails and output are paid at full rate.
- Before (v1): nothing is cached and the output is verbose.
- The 30-page projection uses 3,500 chars per page (fixture pages average about 2k) and reuses pack A's output sizes. Pack A is unusually dense, with 276 of 336 items found, so real policies will produce less output.

| Policy | Calls | System tok | Pages tok/job | Tail tok/call (avg) | Output tok v1 → v2 | v1 input tok | v1 ₹/policy | **v2 ₹/policy** |
|---|---|---|---|---|---|---|---|---|
| Fixture pack A (25 pp) | 18 | 2,183 | 14,939 | 5,313 | 45,644 → 33,199 | 357,815 | ₹4.76 | **₹2.43** |
| Fixture pack B (19 pp) | 18 | 2,183 | 10,839 | 5,313 | 43,605 → 30,020 | 284,025 | ₹4.03 | **₹2.22** |
| Fixture pack C (6 pp) | 18 | 2,183 | 1,329 | 5,313 | 11,169 → 4,890 | 112,835 | ₹1.39 | **₹1.10** |
| Projected 30 pp | 18 | 2,183 | 30,688 | 5,313 | 45,644 → 33,199 | 641,300 | ₹7.25 | **₹2.82** |

**Projected 30-page v2 breakdown:**

| Item | Cost |
|---|---|
| Prefix write | 32.9k × $0.10/M = $0.0033 |
| Cached reads | 18 × 32.9k × $0.01/M = $0.0059 |
| Tails | 95.6k × $0.10/M = $0.0096 |
| Output | 33.2k × $0.40/M = $0.0133 |
| **Total** | **$0.0320 ≈ ₹2.82** |

Not yet included:
- **Explicit-cache storage**, unverified at about $1.00 per M tokens per hour. A 33k-token cache held about 3 minutes adds about ₹0.15. Deleting the cache at job end keeps this small.
- **Flash escalations.** A whole-pack Flash call is about ₹0.85 each, which is why section 9 bounds them.

**Headroom:** about ₹0.03. At ₹2.8–3.0 per policy, ₹220 of non-reserve budget covers about 75 policies.

The v1 "before" column above is the real HEAD builder. The test file's "uncached+verbose" line is the v2 text with no caching, so it isolates the layout effect. `node --test tests/policy-breakdown-prompts.test.mjs` prints the figures as `[cost]` lines.

**Levers, in order, if the live number exceeds ₹3:**
1. Verifier gating (item 6 in section 9).
2. Trim the section expertise where it duplicates blocks 4–5. The section tests pin some phrases, so update those tests with the trim.
3. Cap the output tokens per extractor call.
4. Reuse public-wording pages from the library.

## 9. Change list for the M3 owner (`model-runner.js`, `run-sections.js`)

Evidence (installed versions):
- `@ai-sdk/google` 4.0.71: `node_modules/@ai-sdk/google/dist/index.js`
- `ai` 7.0.102: `node_modules/ai/dist/index.d.ts`

`@ai-sdk/google-vertex` is **not installed**; it is absent from both `node_modules` and `package-lock.json`. Every Vertex-specific claim below is therefore **unverified** and needs a CERT record before install.

**1. Explicit `cachedContent` per job.**
- `@ai-sdk/google` accepts `providerOptions.google.cachedContent` (`index.js:930-936`) and forwards it as `cachedContent` in the request body (`index.js:1877`).
- **The provider cannot create caches**: grep finds no create or delete API. M3 needs a small adapter that calls the REST API, roughly as below (shape unverified):
  - Create: `POST https://asia-south1-aiplatform.googleapis.com/v1/projects/{P}/locations/asia-south1/cachedContents`, body `{model:"projects/{P}/locations/asia-south1/publishers/google/models/{M}", systemInstruction:{parts:[{text: system}]}, contents:[{role:"user", parts:[{text: pagesBlock}]}], ttl:"300s"}`.
  - Delete: `DELETE` the returned name in a `finally` when the job ends.
- On cached calls, send **only `tail`** as `prompt` and **do not pass `system`**. Per Google's caching docs, a request that sets `system_instruction`, `tools` or `tool_config` together with `cachedContent` is rejected. Verify this in the M8 smoke.
- Check whether `@ai-sdk/google-vertex` reads `providerOptions.google` or `providerOptions.vertex`. Unverified.
- Caches are model-bound, so a Flash escalation cannot use the Flash-Lite cache.
- Check the minimum cacheable size for the chosen model and surface. Docs cite roughly 1,024–4,096 tokens; unverified. Fixture pack C's prefix is about 3.5k tokens. If the prefix is below the minimum, use the warm-call fallback.

**2. Warm-call fallback (implicit caching).**
- If cache creation fails or is unavailable, run the first extractor alone, then fan out the other 17 calls.
- Use the same `system` and the same `prompt` prefix; the builder guarantees byte identity.
- Implicit hits are not guaranteed, so record `cachedContentTokenCount` per call.

**3. Thinking budget 0.**
- Pass `providerOptions.google.thinkingConfig.thinkingBudget = 0` (option `index.js:925-929`), or `reasoning: 'none'`, which maps to `{thinkingBudget: 0}` for Gemini 2.5 (`index.js:2601-2607`).
- Gemini 3-family models map `none` to the minimum `thinkingLevel` instead (`index.js:2566-2567`).
- Thinking tokens are billed as output: `convertGoogleUsage` adds `thoughtsTokenCount` to `outputTokens.total` (`index.js:315,323-327`).

**4. Read cached tokens into usage and price them.**
- `convertGoogleUsage` maps `cachedContentTokenCount` to `inputTokens.cacheRead` and computes `noCache = prompt - cached` (`index.js:314-320`).
- `ai` surfaces these as `usage.inputTokenDetails.cacheReadTokens` and `noCacheTokens` (`ai/dist/index.d.ts:328-340`), and reasoning as `outputTokenDetails.reasoningTokens`.
- `model-runner.js:129-131` prices every input token at the full rate today. Change it as follows:
  - Add `BREAKDOWN_CACHED_INPUT_USD_PER_MILLION`.
  - Compute cost as `noCache × input + cacheRead × cached + output × output`.
  - Return `usage.cachedTokens`.
  - Keep the worst-case reservation at the full rate (`model-runner.js:109`).
- Then wrap each call's output with `wrapHandoff(...)` and persist `cached_tokens` to `breakdown_model_calls`.

**5. Use the additive builder fields.**
- `run-sections.js:17,31` already call `buildSectionPrompt` and `buildVerifierPrompt`. Pass `pagesBlock` and `tail` through to `runner.run` alongside `system` and `prompt`.
- Build `pagesBlock` once per job, not once per section.
- Call `normaliseSectionOutput(result.output)` before assembly, so `openQuestions` are captured and items are uniform. Assembly already tolerates compact items.

**6. Verifier gating.**
- Today the verifier always runs in parallel with the extractor (`run-sections.js:32-39`).
- Option A (cheapest, adds latency):
  - Run the extractor first.
  - Then verify only the critical keys where the extractor's candidate passes the deterministic checks (`normaliseValue`, `verifyCitations` and `valueSupportedByQuotes`), or where the extractor found nothing. The extractor-absent case still surfaces misses.
  - Skip keys whose candidate already fails. `applyVerifier` cannot rescue those, because only Proven targets change state (`assemble-section.js` `applyVerifier`).
  - Pass a narrowed `parameters` to `buildVerifierPrompt`.
- Keep the verifier blind: never pass extractor output into the prompt.

**7. Flash escalation cascade.**
- **Trigger:** a critical key ends Conflicting with reason `verifier_disagrees`, `verifier_found_no_value` or `extractor_found_nothing_but_verifier_found_a_value`.
- **Call:** one call per job, not per key. Use Flash with thinking 0 and a fresh blind prompt (`buildVerifierPrompt` with only the disputed keys).
- **Context:** to keep cost bounded, send only the union of pages cited by both readers, plus ±1 neighbouring page. Use the whole pack only if that union is empty.
- **Budget:** reserve at the Flash rates. Cap at 1 escalation call per job.
- **Result:** the escalation output is a third vote recorded on `verification`. It must not flip the evidence state without a central-agent decision on the assembly semantics. Human confirmation still applies to every critical value.

**8. Schema stays native.** Keep `Output.object({ schema: jsonSchema(schema) })`. It is sent as `responseJsonSchema` (`index.js:1857-1860`), outside the cached prefix. Do not switch to prompt-injected schemas.

## 10. Versioning and gates

Any edit to a block, the vocabulary, the parameter rendering, the section expertise text, the schema or the model requires all of the following:
1. Bump `BREAKDOWN_PROMPT_VERSION`, and the schema name if the shape changed.
2. `node --test tests/policy-breakdown-*.test.mjs`
3. `npm run eval:breakdown`: packs A, B and C at 100%, with citation validity 100%.
4. `npm run check:architecture`
5. Before a live rollout, the live gold eval within the reserve.

**The fixture eval does not test prompt quality.** The gold responder ignores `system` and `prompt`, so a 100% fixture score proves only that the schema and assembly are intact. Prompt quality is measured only by the live gold set.

## 11. Open questions

- Re-price Flash-Lite and Flash, including cache storage, from Vertex asia-south1 SKUs. Confirm that both models are served in asia-south1.
- Confirm the `cachedContent` and `system_instruction` exclusivity, and the minimum cache size, in the M8 smoke.
- Measure the real share of found versus not-found items on the live gold set. The fixture packs are deliberately dense.
- Decide whether a Flash tiebreak may promote a critical value; this is an assembly-semantics decision for the central agent.
- Decide whether to trim duplicated "HARD RULES" from the section expertise. That saves about 300–500 tail tokens per call, but means updating the section phrase tests.
