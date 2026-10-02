# Latest iteration — policy breakdown backend (2026-10-02)

Branch `claude/policy-backend` (uncommitted). Plans: docs/exec-plans/active/policy-breakdown-backend-intake.md and
docs/exec-plans/active/policy-criteria-completeness.md. API for the frontend: docs/api/policy-breakdown-api.md.
Where every parameter is checked: docs/policy-criteria-matrix.md (`node scripts/criteria-matrix.mjs`).

## Built
- 12 section definitions (314 parameters, 39 critical); pipeline upload → Sarvam OCR → 9 extraction agents +
  blind verifiers → citation and value-in-quote checks → sections 10–12 analysers → cross-checks → review → ready.
- Criteria round (this iteration):
  - Planned-procedure checklist (`consumers/procedure-check.js`, `POST /procedure-checks`, also inside
    `/estimates`).
  - Estimate covers every money criterion, including top-ups (never paying the base policy's share).
  - Policy status and overview (`GET /policy-status`).
  - Emergency card shows policy status and paid-first deadlines.
  - Dated reference files for sections 10–12 (`BREAKDOWN_REFERENCE_DIR`).
  - Household city (migration 006, `PATCH /households/{id}/city`).
  - Sum-insured adequacy method.
  - Synthetic packs B (group) and C (super top-up).
- 16 policy endpoints.

## Verification
- `npm run check`: architecture pass, 287/287 tests, build pass.
- Criteria matrix 314/314 parameters checked. Found-path coverage 285/285 extraction parameters Proven in at least
  one pack. Fixture eval: packs A/B/C 100% (296/306/107 rows), citation validity 100%.
- Independent review (criteria round) fixed, each with a regression test:
  - H1: group- or honorific-scoped member values.
  - H2: top-up with an unusable threshold.
  - H3: age co-pay judged on the admission date.
  - M1: no-member worst case.
  - M2/M3: disease sub-limit parsing.
  - M4: inferred waits are not blockers.
  - M5: one shared name normaliser.
  - M6: revoked records excluded from analysis.
  - L1: birth-date-derived values masked for viewers without access.
  - L3: partial domiciliary cap.
  - L4: restoration raises the high bound only.
  - L5: member basis without a member.
  - L6: non-object bodies return 400.
- Accepted: L2. The PED co-pay is only disclosed when the person has not said whether the condition is
  pre-existing.

## Open / next
1. Live smoke test needs GEMINI_API_KEY, LLM_MODEL (+ rates) and SARVAM_API_KEY in .env.local. Confirm the Sarvam
   per-page metadata shape and set SARVAM_DOWNLOAD_HOST_SUFFIXES.
2. Build .local/eval with public wordings + user PDFs and hand-marked gold.json; run `npm run eval:breakdown:live`.
3. Reviewed reference files (insurer disclosures, procedure costs, verified regulatory floor) for
   BREAKDOWN_REFERENCE_DIR. Real antivirus scanner. "Ask the policy" chat (phase 2). Then the frontend.
4. Nothing committed yet.
