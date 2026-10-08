# Latest iteration: live official sources and extraction root fixes (2026-10-08)

- **Branch:** `claude/web-enrichment` (worktree `../CoverSaath-claude-enrich`), committed on top of `origin/claude/product-beta` 2384943 (Codex), whose tree equals this branch's old snapshot base.
- **Plan / CERT:** `docs/exec-plans/active/policy-web-enrichment-intake.md`, **Amendment 1**. The user authorised live retrieval of public insurer and IRDAI pages, coverage of all insurers, AI-assisted navigation to the exact policy PDF, and insurer-reported claim ratios that refresh automatically.
- **Class:** S2 (external data acquisition, sensitive AI extraction).

## Objective

Fix the extraction gaps found on the real policy from the root:
- A schedule-only upload left 173 of 316 keys `not_found_in_source_pack`.
- Several values were lost or misleading.

Add live official sources:
- policy wording by exact UIN, for all insurers
- claim settlement data
- the cashless network

## Built

### Extraction fixes
- **Table quotes:** `verification/citations.js` now has `table_aligned` matching for HTML tables, header over value or one row. The prompt rule is R2a.
- **More matching rules:**
  - `compact` matches line-break and punctuation noise around numbers. Every number token must still exist on the page.
  - `ellipsis_segments` handles spans joined with "...". Each span must be long, on the same page, and in order.
  - `adjacent_page` corrects a cite that is one page off when the text is repeated.
- **Validation:**
  - Enum label forms are normalised: "India only" becomes `india_only`.
  - Road ambulance is capped at the sub-limit maximum.
  - `non_payable_items_rule` is now cited only from the refusing clause.
  - `document_set` means the documents the text refers to.
  - New keys: `documents_present_in_pack` and `additional_sum_insured_amount` (Secure Benefit). There are now 316 parameters.
- **Waiting periods:** when the basis is `policy_first_inception` and no first inception date is found, the check counts from `policy_start_date` and returns `attention`, never `not_met`.
- **Budget:** a provider 4xx settles at $0. A double settle on an empty output, which had loosened the cap, is fixed.
- **Prompt:** version v3. R12 says how to use official wording pages.

### Official wording (`references/official/`)
- **Order of attempts:** exact UIN on the uploaded pages → `registry.js` (operator-reviewed) → `irdai-product-repository.js` (IRDAI Health Insurance Products, all insurers, filings only up to June 2022) → `wording-navigator.js` + `insurer-directory.js` + `insurer-site-sources.js`.
- **The navigator:**
  - The directory has 32 insurers; 19 have server-rendered wording pages.
  - It uses a deterministic link chooser. `createGeminiLinkChooser` is available but not wired.
- **Acceptance:** a PDF is accepted only when it prints the exact UIN as its own.
- **Fetching:** all fetches go through `live-adapter.js`:
  - `fetch` for registry entries and `fetchDiscovered` for discovery sources (`discovery.js`)
  - SSRF lookup guard, redirect re-validation, MIME, size, encoding and PDF-magic checks
  - kill switch `OFFICIAL_SOURCE_FETCH_ENABLED`
- **Service wiring (`service.js`):**
  - The wording is attached after OCR (step 1b, recorded in `ocr.metrics.officialWording`).
  - Its text comes from the PDF text layer via `pdfjs-dist` 6.4.299 (new dependency, Apache-2.0).
  - It is cached by content SHA.
  - Pages are labelled `official_wording` and cited as `official:<id>`.
- **Precedence:** assembly ranks the household's own pages first. A differing wording value goes to `officialWordingDiffers`. `SCHEDULE_ONLY_KEYS` are never Proven from wording alone.

### Insurer statistics and cashless network
- **Claims data:** `references/insurer-reported-disclosures.js` and `insurer-claims-sources.js` hold insurer-published claims data:
  - HDFC ERGO HTML
  - Form NL-37 PDFs from Go Digit, Bajaj General, Tata AIG and IFFCO-Tokio
- **Claims-data checks:** each is reconciled or rejected, refreshed once `freshnessDays` (7) have passed since the last successful fetch, keeps the last good file, and is labelled "insurer-reported, retrieved <date>".
- **Section 10:** the latest period wins. Renamed insurers are aliased.
- **Network counts:** `references/network-counts.js` + `official/network-locators.js` read the HDFC ERGO locator API and give `network_hospitals_in_city`. The value is Dynamic, carries a "confirm before admission" note, and is fetched once a day per (insurer, city).

## Verification

- **Checks:**
  - `npm run check`: architecture (171 files), 456/456 tests, build.
  - `npm run test:e2e`: API 9/9 and browser 24/24, run before the final citation changes.
  - `npm run eval:breakdown`: packs A/B/C 100%, 0 dangerous; found-path 287/287.
- **Live official sources:**
  - HDFC wording: same SHA as the saved copy, 69 pages.
  - Navigator: exact-UIN wording found for Tata AIG, Bajaj, Go Digit, IndusInd and Acko in 1.6–4.4 s each.
  - IRDAI repository: found a Star product.
  - Claims data: all 5 refreshes reconciled. HDFC ERGO retail health CSR was 98.31% for Apr–Jun 2026.
  - Locator: Pune 635, Bengaluru 436.
- **Live re-run on the real policy (stored OCR + attached wording):**
  - Model: Gemini 3.5 flash-lite (`thinkingLevel` minimal). Cost $0.84, about ₹70.
  - Proven went from 94 to **155** (56 schedule + 99 wording), plus 8 member-scoped keys whose variants are Proven.
  - Spot checks match the wording: initial wait 30 days, pre-existing disease 36 months, specified diseases 24 months, pre/post 60/180 days, restore 100%, SI ₹15L plus Secure Benefit ₹15L.
  - Artefacts are in `.local/replay/run3/` (gitignored; contains personal data).

## Risks and next

1. **Lost keys:** 15 keys Proven in the schedule-only run were not returned with the larger context (for example air ambulance, the non-payable rule, consumables add-on). Consider a schedule-first pass or a gap-fill call for keys missing after wording.
2. **The HDFC add-on (`HDFHLIA…`)** has not been found. Add-on wordings are listed by name, not UIN. Pass the add-on product name to the navigator, or register the add-on in the registry.
3. **Unreachable sites:** 13 insurer sites are blocked (403 or TLS) or render their links in JavaScript. They rely on the IRDAI repository (to 2022) or need a registry entry.
4. **Upkeep:** NL-37 PDF links change each quarter for Bajaj, Tata AIG and IFFCO and need updating. Only HDFC ERGO has a locator.
5. **Before production:** terms/robots review per host, an operational owner for the registry and directory, and a snapshot retention policy.
6. **Still not done:** the cashless check for a specific hospital (`findHospital`) is not exposed in the API, and the Gemini link chooser is not wired.

# Latest iteration: product beta, M0 + live run (2026-10-07)

- **Branch:** `claude/product-beta`, cut from local `main` (095b1d9). The policy breakdown backend was committed in 095b1d9. Local `main` is one commit ahead of origin.
- **Plan:** `docs/exec-plans/active/knowvia-product-beta-plan.md`
- **CERT:** `docs/exec-plans/active/knowvia-product-beta-intake.md` (READY for the fake-backed tracks; live and cloud work is BLOCKED on user inputs)

## Objective

Make the real flow work end to end: upload, Sarvam OCR, the 12-section breakdown, review, ready, then the emergency card, estimates and procedure checks.

The build must have these properties:
- stateless and durable
- consent-tracked
- tested under load
- deployable on GCP asia-south1
- within a ₹300 Gemini budget

It also adds a private insight layer. That layer turns redacted, aggregated customer signals into business scenarios.

## Done in M0

- Removed 26 Finder duplicate files (`* 2.*`) and 9 empty `* 2` directories. Each file was verified byte-identical with `cmp` before deletion.
- Created the branch, the CERT intake and the in-repo copy of the plan.
- **Gate:** `npm run check` passes: architecture, 287/287 tests, and the build.

## Parallel tracks: done and integrated

- **M1a (data):** SQLite → Postgres port (`pg`, PGlite for tests/dev); `migrations-pg/001_baseline.sql`; all repositories async.
- **UI:** journey controller on the real breakdown endpoints, tested against fakes.
- **QA:** fake Sarvam and Gemini servers; API journey E2E; Playwright smoke.
- **AI:** prompt contract v2 (12 blocks, cache-friendly), `knowvia.handoff/v1` envelope.

## Integration gate (central)

- `npm run check`: architecture, 313/313 tests, build.
- `npm run test:e2e`: API 9/9, Playwright 3/3.
- `npm run eval:breakdown`: packs A/B/C 100%, citation validity 100%, no wrong-but-Proven.

## First live run (2026-10-07)

Keys in `.env` (gitignored): `GEMINI_API_KEY` (AI Studio), `SARVAM_API_KEY`. Both smoke-tested. One real 20-page insurer policy (schedule + CIS) run end to end; artefacts and scorecard in `.local/live-run/` (gitignored, contains personal data — never commit).

Fixed in code (uncommitted):
- `contracts.js`: Gemini 3.x rejects a top-level `maxItems` in the response schema (HTTP 400). Removed; the keys×3 cap now lives in `assembly/assemble-section.js`.
- `verification/citations.js`: Sarvam returns tables as HTML; models quote them as `cell | cell`. The matcher now treats named table tags and `|` as whitespace. Proven 58 → 90 on the live replay; 0 wrong numbers on a full hand check.
- `agents/model-runner.js`: `BREAKDOWN_THINKING_LEVEL` (Gemini 3.x needs `thinkingLevel`, not `thinkingBudget`).
- `gemini-2.5-*` is closed to new users; live model is `gemini-3.5-flash-lite`.

Findings, highest risk first:
1. **Estimate ignores unresolved eligibility.** With sum insured Proven, `estimate.js` shows "insurer pays all, you pay ₹0" as the headline while waiting-period checks are still unknown. Must include insurer ₹0 whenever any waiting-period check is unknown or not met. Blocks shipping the matcher fix.
2. Waiting-period checks ignore Proven `member_cover_start_dates`/`policy_start_date` when the schedule says renewal "No".
3. No condition → specified-disease (Excl02) mapping; no hint when the list lives in a wording that is not uploaded. `document_set` claims a wording the PDF does not contain.
4. Models stitch a table header and a cell from different rows into one quote (`insured_members`, `first_inception_date` stay Unknown) — add a table-quoting rule to the prompt.
5. Schema gaps: Secure Benefit; `geographic_scope` enum rejects "India only"; road ambulance "up to SI".
6. `member_specific_conditions` deadlock: Unknown + member variants cannot be confirmed or marked absent, so readiness never passes.
7. Genuine insurer PDFs carry JavaScript and EmbeddedFiles and are quarantined at upload. Decision needed: sanitise server-side or reject.
8. Budget guard settles failed calls at worst case; worst-case × concurrency trips a $0.50 job budget at $0.14 real spend.
9. `breakdown_model_calls` lacks cached-token and finish-reason columns, so the ₹3/policy target is unproven (456k input tokens over 18 calls).
10. Missing APIs: procedure category for kidney stones, hospital/network lookup, free-text question.

## Next

1. Fix findings 1, 2 and 4, then re-run the live case (fresh DB: ≈ ₹10 Sarvam).
2. M1b, M2, M3 (spend ledger fixes finding 8 and 9), as planned.

## Earlier plan (kept for reference)

These four tracks ran in parallel, each on its own files:
- **M1a:** port the SQLite code to Postgres one-to-one (`pg`, with PGlite for tests).
- **UI:** wire the UI to the real breakdown endpoints, tested against fakes.
- **QA:** fake Sarvam and Gemini servers, plus a Playwright happy path.
- **AI:** prompt contract v2 and the `knowvia.handoff/v1` envelope.

After those tracks merge, the sequence continues:
1. M1b: schema split.
2. M2: stateless server.
3. M3: jobs, storage and spend caps.
4. M5: auth.
5. M6: tracking and insights.
6. M7: load, soak and chaos tests.
7. M8: GCP staging and a live smoke test.
8. M9: review.

## Blocked on user

- **M6:** run the PostHog wizard.
- **M8:** provide the following:
  - a GCP project with billing and the Vertex AI API enabled
  - the Sarvam key and its monthly cap
  - 3–5 gold-set PDFs

## Policy web enrichment and procedure safety (2026-10-07)

- **Class/CERT:** S2. The bounded fake-backed slice is READY under `docs/exec-plans/active/policy-web-enrichment-intake.md`; live retrieval and cashless confirmation remain blocked on the recorded security, legal, freshness and operations gates.
- **Delivery model:** central integration plus independent safety/backend, UI, official-source/provenance and security-review agents. GPT-5.6 Sol was the recorded fallback because the prescribed Luna/Terra models were unavailable.
- **Dependencies:** `npm ci` and `npm ls --depth=0` passed against the existing lockfile. No new application dependency was added.

Built and integrated:

- Eligibility now owns the estimate headline. A known coverage blocker yields insurer ₹0 and the applicable household exposure. Any unresolved coverage-critical fact yields `coverage_not_established`, keeps the primary insurer scenario at ₹0, and exposes arithmetic only as a labelled `if eligible` secondary scenario. Operational cashless uncertainty no longer masquerades as reimbursement ineligibility.
- Waiting-period checks use the applicable member/policy cover start, preserve `not found in source pack` as unresolved, distinguish cashless true/false/unknown, and never let a person's reported negative answer clear a contractual wait.
- Procedure intake now collects the patient, treatment/admission timing and type, prior diagnosis/treatment/advice/symptoms, proposal declaration, continuity/portability/break, exact hospital identity, pre-authorisation, prior floater use and other-policy contribution. `not_sure` and `prefer_not_to_answer` remain explicit `Reported` evidence.
- New official-source contracts resolve only an exact legal insurer + UIN + product/version/effective-date match. Requests are bound to an operator-reviewed registry; self-supplied URLs/hosts and free-text/private queries cannot authorize retrieval. Provenance binds the registry record, canonical identity, final URL, successful attempt, content hash and citation. The current adapter is fake-only and performs no network call.
- All 314 parameters receive additive response-only terminal metadata without rewriting stored evidence: unknown critical facts become `RequiredNow`; unknown non-critical facts become `RequiredForLaterJourney`; absence never implies `NotApplicable` or `Unavailable`.
- Independent review's material findings were closed: optimistic unresolved payouts, reported-answer authority, provenance mismatch, persisted relevance injection, registry authority, cashless tri-state handling and incomplete verdict disclosure.
- The browser analytics regression was traced to two test-harness compatibility issues: Playwright is intentionally bot-filtered by PostHog, and PostHog 1.438.2 emits gzip bodies without the legacy marker expected by the fake server. The harness now emulates a real-user browser for this consent test and detects gzip by magic bytes; production bot filtering and server-side consent enforcement remain enabled.

Official-source hierarchy for the future live connector:

1. Issued schedule, endorsements, renewal and portability evidence.
2. Exact-UIN wording from the insurer, cross-checked against IRDAI's Health Insurance Products directory.
3. Dated insurer/TPA cashless locator and exclusion list; live status remains `Dynamic` and needs branch-level confirmation.
4. IRDAI Handbook/annual reports and insurer public-disclosure forms for aggregate statistics. Store raw paid, repudiated, closed and pending counts and methodology; never reduce them to one ambiguous “claim settlement ratio” or use them for an individual claim decision.
5. Bima Bharosa and Insurance Ombudsman reports for complaints context. `data.gov.in` is supplementary, not controlling.

Final evidence:

- `npm run check`: architecture passed for 158 source files; 352/352 tests passed; production build passed.
- `npm run eval:breakdown`: packs A/B/C scored 100%, critical 100%, citations 100%, dangerous wrong-but-Proven values 0; 285/285 extraction keys have a Proven fixture path; provider spend $0.
- `npm run test:e2e`: API 9/9 and browser 24/24 across 360 px, 768 px and desktop.
- `git diff --check`: passed before final documentation update; rerun in the final verification.

Still blocked/not shipped:

- No production scraper, unrestricted browsing agent or live network adapter. A live adapter still needs per-redirect DNS/private/reserved-IP enforcement, allowlisted structured URL generation, terms/rate-limit review, snapshot retention policy, an operations owner, a kill switch and monitored smoke tests.
- Genuine active-content insurer PDFs are still quarantined; server-side sanitisation versus rejection remains a separate security decision.
- Failed model calls are still budgeted at their worst-case reservation, and cached-token/finish-reason accounting remains incomplete.
- The personal HDFC policy was not uploaded or re-run in this milestone; `.local/` remains gitignored and no family data was added to repository files.
