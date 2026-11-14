# Squad B brief: FSS real data (paste-ready)

You are Squad B. Squad A (another Claude session) builds the CoverSaath backend at the same time. Lane contract: `CoverSaath/docs/exec-plans/active/two-squads-2026-11-14.md`. Read it first and append to its hand-off log when you finish a slice or change the FSS contract.

## Where

- Repo: `/Users/rishavdewan/Developer/Product experiments/insurance-data-api` (GitHub private `rish106-hub/insurance-data-api`, default branch `master`).
- Worktrees: `insurance-data-api.worktrees/sqb-<slice>`, branches `sqb/<slice>`. Never touch `sqa/*`, `archive/*`, or CoverSaath files outside `src/integrations/insurance-data/` and `scripts/live-run/fss-stub.mjs`.
- Read `insurance-data-api/AGENTS.md`, `README.md`, `docs/` first.

## Goal by 2026-11-15

FSS serves real data for every Indian insurer and product, keyed by UIN, through the routes CoverSaath's client calls (`CoverSaath/src/integrations/insurance-data/client.js`, schemas in `schemas.js`): `GET /v1/insurers`, `/v1/insurers/resolve` -> `{status: 'resolved'|'ambiguous'|'unmatched', insurer}`, `/v1/products`, `/v1/products/search`, `/v1/products/by-uin/{uin}/export`, `/v1/network-hospitals/export`, `/v1/versions/{id}/facts`.

## Slices, in order (small PRs, merge each to `master` as soon as checks pass)

1. **B1 one service**: create `sqb/unify` off `master`; merge `feat/parser-core`, `feat/parser-integration`, `feat/structure-layer`, `feat/real-ingest-slice`, `fix/ida-review-findings`, `feat/export-v2`, `feat/export-by-uin`, `feat/network-hospitals` (skip `feat/parser-bakeoff` unless needed). Resolve conflicts, get typecheck, lint and tests green, one API build serving every route above. Merge to `master`.
2. **B5 rule**: ADR "real public insurer data": public documents only, raw files outside git (object storage or a gitignored data dir, sha256 + source URL + fetch date per file), one rights-register entry per source, **FOR LEGAL REVIEW**. Update the FSS AGENTS.md synthetic-only rule to match.
3. **B2 insurers**: every IRDAI-registered insurer (life, general, standalone health; IRDAI website lists them) with registration number, legal and brand names, aliases, type. Importer plus migration, idempotent.
4. **B3 products**: health products by UIN from IRDAI product lists and insurer websites: UIN, name, insurer, line, status, version. Health first (all health and general insurers' health products), life later.
5. **B4 wordings**: for each product, fetch the public policy wording / CIS / prospectus PDF, store outside git, extract pages and clauses, map facts (room rent, co-pay, waiting periods incl. PED and initial, sub-limits, exclusions, sum insured options, restoration, deductibles) with page number and exact quote; review state `extracted_unverified`. Start with the top 10 health insurers by market share, then widen.

## Rules

- Polite crawling: honour robots.txt, rate limit, identify as a generic client, no logins, no CAPTCHAs.
- No personal data. Never read or print `.env*`. zsh: never name a variable `path`.
- Commit messages end `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Reviews (CodeRabbit, CodeQL, cubic) are deferred to Tuesday: do not stop to fix review comments; keep CI green.
- Subagents: Haiku for grunt work (crawling lists, mechanical merges), Sonnet for scoped builds, Opus only for open-ended problems.
- If you need a CoverSaath change outside your lane, write it in the lane file's hand-off log instead of editing.
- When your usage limit nears its end, append state + next step to the hand-off log and push.
