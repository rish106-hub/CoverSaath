# S2 build plan: branded GatedText (ADR 0017)

Audience: a Sonnet build agent working in its own worktree. Read `AI.md`, `AGENTS.md`, `src/features/ai-analysis/AGENTS.md` and ADR 0017 first. Synthetic data only. Do not read `.env*` or `.local/`. Do not commit, push or deploy unless the task brief says so.

Risk class: **security-sensitive and AI**. An independent read-only review is required before merge (AGENTS.md).

Every work package (WP) ends green on these commands:

```sh
REQUIRE_POSTGRES=1 node --test tests/<files touched>.test.mjs
npm run check:architecture
```

The final WP runs `npm run check`, `npm run eval:safety` and `git diff --check`.

## WP1. GatedText primitives (Phase 1)

**Owned paths:** `src/features/ai-analysis/privacy-evidence-gate.js`, `src/features/ai-analysis/index.js`, and the new `tests/gated-text-brand.test.mjs`.

**Build:** `gateText`, `isGatedText`, the module-private `GATED` symbol and the `GATED_TEXT` `WeakSet`, as specified in ADR 0017 D1.

**Tests (`tests/gated-text-brand.test.mjs`):**

1. `gateText('Sum insured: 500000', { knownIdentifiers: [] })` returns a frozen object. Its `text` equals the storage gate's `text`, `gateVersion === PRIVACY_EVIDENCE_GATE_VERSION`, and `isGatedText` is true.
2. `Object.keys(g)` does not include the symbol, `JSON.stringify(g)` has no brand, and `structuredClone(g)` gives `isGatedText === false`.
3. Forgeries are false: a hand-built literal; a literal with the symbol copied through `Object.getOwnPropertySymbols(g)`; `{ ...g }`; `Object.create(g)`; `new Proxy(g, {})`; an object with a getter `text`.
4. Writing `g.text = 'x'` or `g.gateVersion = 'v0'` throws in strict mode, and `isGatedText(g)` stays true.
5. Truncation fails closed: input that would truncate at `maxBytes` throws `EVIDENCE_SOURCE_LIMIT` and returns nothing.
6. Refusal: input with a private key throws `RESTRICTED_EVIDENCE`.
7. A missing `knownIdentifiers` throws `PRIVACY_GATE_MALFORMED` (parity with `privacy-evidence-gate.js:1580`).
8. Raw input carrying placeholder syntax without `regate: true` throws `RESTRICTED_EVIDENCE`. With `regate: true` it is accepted.
9. Counts: `placeholderCount` equals the number of `<KIND_n>` tokens in `text`. `reasonCodeCount` is an integer of 0 or more, and the reason-code strings are **not** properties of the object.
10. `index.js` exports `gateText` and `isGatedText` and does **not** export `isSealedModelInput`.

**Acceptance:** all 10 tests pass, and the existing `tests/privacy-*.test.mjs` pass unchanged.

## WP2. Seal and allow-list (Phase 1)

**Owned paths:** `privacy-evidence-gate.js`, `src/features/ai-analysis/structuring-contract.js` (shared kind constants, ADR 0017 D2 notes), and the new `tests/model-input-seal.test.mjs`.

**Build:** `MODEL_INPUT_FIELDS`, `sealModelInput`, `isSealedModelInput`, `sealedInputCounts` and `MODEL_INPUT_MAX_BYTES`. Then make `sanitizeEvidenceForModel` return a sealed `input` (seal it internally through the same table).

**Tests (`tests/model-input-seal.test.mjs`). For every task in `AI_TASKS`, using `BRAND_PROBES` from `tests/support/privacy-corpus.mjs`:**

1. A valid draft seals. The result is deeply frozen, `isSealedModelInput(result, task)` is true, and `isSealedModelInput(result, otherTask)` is false.
2. Every `gated` slot, filled with a raw string, throws `MODEL_INPUT_NOT_ALLOWED`. The message names the path (for example `payload.chunks[0].text`) and does **not** contain the value. Assert that the value is absent from `error.message` and from `JSON.stringify(error)`.
3. An extra key, a missing key, a symbol key, an accessor property, a Proxy, a class instance, a cycle, a `__proto__` key, an out-of-range int, an unknown enum value, a bad id regex, an over-long array, and a draft over `MODEL_INPUT_MAX_BYTES` each throw `MODEL_INPUT_NOT_ALLOWED`.
4. TOCTOU: mutating the draft (and the `GatedText`'s source chunk object) after sealing does not change the sealed output.
5. `static` slots: a registry label that the gate would change (for example `Contact Meera Testcase`) throws.
6. `sanitizeEvidenceForModel(...)` returns an `input` for which `isSealedModelInput(input, task)` is true. Existing tests that read `input.sources[...]` still pass, because reading a frozen object is allowed.
7. `sealedInputCounts(sealed)` returns exactly `{ gateVersion, gatedSlots, placeholders, reasonCodes, gatedBytes }`, all numbers except `gateVersion`. None of the strings in it match a placeholder or reason-code pattern.

**Acceptance:** tests 1 to 7 pass for all 9 tasks.

## WP3. Gateway enforcement (Phase 1 warn, then Phase 2 enforce)

**Owned paths:** `src/features/ai-analysis/model-gateway.js`, `src/server/create-server.js` (lines 123-130 only), and `tests/model-gateway-brand.test.mjs`.

**Build:** the D3 check before `budget.reserve`, and the D5 counts on `onEvent`. Warn mode is a constructor option `brand: 'warn' | 'enforce'` that defaults to `'enforce'`. Warn mode is used only by the Phase 1 commit and is removed in WP5.

**Tests:**

1. In both `fixture` and `live` mode, an unsealed `input` throws `ungated_model_input`. Then: `budget.reserve` was **not** called (spy), `liveRunner` and the fixture were not called, and one `onEvent` fired with `outcome: 'ungated_model_input'` and `dispatched: false`.
2. A sealed input for task A passed to `execute({ task: B })` throws `ungated_model_input`.
3. A sealed input dispatches. The runner's `request.input` is a plain, unfrozen, unbranded clone (`Object.isFrozen === false`, no symbols), and is deep-equal to the sealed object.
4. A live `ok` event carries the five D5 fields. `create-server`'s `onProviderEvent` passes them through `sanitizePayload` (`app-event-repository.js:24`) unchanged. Assert this with a stub `recordEvent`.
5. No D5 field contains a digest (64 hex characters), a reason code (`/^[A-Z_]{6,}$/`) or a placeholder.

## WP4. Builders produce sealed inputs (Phase 2)

**Owned paths:** `src/features/policy-structuring/index.js` (`gateChunks`), `extractor.js`, `reconciler.js`, `src/features/policy-evidence/investigate.js`, `src/features/ai-analysis/structuring-runtime.js`, and the tests that use them.

**Build:**

- `gateChunks` and `gateClauses` use `gateText` and add `gated` and `gatedTitle`.
- The question becomes a `GatedText`.
- `toWire`, the extract, reconcile, investigate and sweep drafts use `GatedText` slots.
- Reconcile and sweep re-gate the model-derived strings with `regate: true`.
- `call({ task, input })` replaces `call({ task, payload })`.

**Tests:**

1. `gateChunks` invariant: for every sent chunk, `chunk.text === chunk.gated.text` and `isGatedText(chunk.gated)`. A refused title gives `gatedTitle === null`, and the raw title appears nowhere in the sealed payload.
2. Extract: a fake `call` receives `input` with `isSealedModelInput(input, 'policy_structuring_extract')`. Its `payload.chunks[i].text` equals the gated text.
3. Reconcile: a model reading `value` that contains a synthetic phone (`98765 43210`) reaches the payload as `<PHONE_n>`. A value the gate refuses (one containing a private key) is dropped and counted as `privacy_gate_refused`.
4. Investigate fallback regression (T1): make `search()` return a stored, ungated clause that is not in `sent`. The sealed payload must not contain its text, and the seal throws if a builder bug injects it. Test this through a deliberately broken `toWire` stub.
5. Sweep: `findings[].subject` and `findings[].quote` are re-gated. A finding whose subject carries a known name becomes `<NAME_n>`.
6. End to end through the real `createStructuringModelCallFactory` with a stub `loadModel`/`createAgent` (as the existing tests do): an unsealed call is refused before `consentCheck` is called and before any reservation.
7. The moved tests pass: the files listed in ADR 0017 "Tests that call the gateway...".

## WP5. Enforce and architecture rules (Phase 2)

**Owned paths:** `model-gateway.js` (remove warn mode), `scripts/check-architecture.mjs`, and `tests/check-architecture.test.mjs`.

**Build:** remove the `brand: 'warn'` option, and add the D7 rules.

**Tests:** for each new rule, add a fixture tree under the existing `--root` mechanism (`check-architecture.mjs:5`) that violates it, and assert that the violation message appears. Covered rules:

- `createModelGateway(` outside the two runtimes;
- `@ai-sdk/` imported outside ai-analysis;
- `isSealedModelInput` imported outside `model-gateway.js`;
- `export { GATED_TEXT }`.

## WP6. Corpus, fuzz and second detector (Phase 1; can run in parallel with WP2 to WP5)

**Owned paths:** the files in `docs/architecture/privacy-gate-golden-corpus.md` section 2, plus `src/evaluation/safety-evaluator.js` (add a brand probe) and its eval test.

**Build:** exactly as the corpus spec says: 336 rows, the category counts in section 7, and `KNOWN_GAP_CEILING = 49`.

**Rule:** write `tests/support/second-detector.mjs` **before** opening `privacy-evidence-gate.js`, and do not copy its regexes.

**Tests:**

- P1 to P8 from the corpus spec.
- Meta-tests: row schema, unique ids, per-category counts equal section 7, Aadhaar rows are Verhoeff-invalid, emails use only `example.test` or `example.invalid`, and no row's `input` matches the existing `RESTRICTED_PATTERNS` unless `expect === 'refuse'`.
- The safety evaluator gains a probe: `gateway.execute` with an unsealed input must refuse. `npm run eval:safety` reports it.

**Acceptance:**

- The corpus test, fuzz test and second-detector test pass.
- The known-gap count printed by the test is ≤ 49.
- Runtime is within the P8 time limits.

## WP7. Purpose registry (independent)

**Owned paths:** `src/contracts/data-purpose-registry.js` and `tests/data-purpose-registry.test.mjs`.

**Build and tests:** rules R1 to R11 in `docs/architecture/dpdp-purpose-registry.md`. Report every erasure gap. Do not invent erasure functions.

## WP8 (optional, owner decision Q1). Gate v10: ABHA

**Owned paths:** `privacy-evidence-gate.js` and the corpus.

**Build:**

- Add ABHA labels (`abha(?:\s+(?:no\.?|number|id))?`, `health\s+id`, `आभा`) to the government-id label rules.
- Add the 14-digit shapes (`2,4,4,4` and `14`) to an `isAbhaNumber` check in the unlabelled digit-run rule, with a new placeholder kind `HEALTH_ID` and reason code `DIRECT_IDENTIFIER_HEALTH_ID`.
- Bump the version to `knowvia-privacy-evidence-v10`.

**Tests:**

- Promote the `GAP-ABHA-14` rows to enforced and lower the ceiling to 37.
- Every `PRS` row still passes. In particular, check that a 14-digit premium receipt number or policy number labelled `Policy No` still gets its existing `IDENTIFIER` placeholder.
- Rerun `npm run eval:safety` and all `tests/privacy-gate-*.test.mjs`.

## Final checks and report

Run:

```sh
npm run check
npm run eval:safety
git diff --check
```

The report must cover:

- changed files;
- the new error codes (`ungated_model_input`, `MODEL_INPUT_NOT_ALLOWED`), and whether they are added to `src/contracts/error-codes.js`. They are server defects and must never surface detail to clients;
- the final known-gap count;
- the fuzz summary (counts only);
- the erasure gaps found;
- what remains unverified: live Gemini calls are not exercised; `test:sarvam-live` was not run;
- rollback: one revert per WP.

An independent read-only review of WP1 to WP5 is required before merge.
