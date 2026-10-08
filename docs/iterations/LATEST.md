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
