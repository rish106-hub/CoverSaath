# Two squads, MVP by 2026-11-15

Two Claude agents build in parallel. Each owns files; neither edits the other's. Small PRs, each stacked on `main`, merged as soon as checks pass (owner allows direct merge to `main` when faster). Pull `main` before every branch.

Owner decisions (2026-11-14): real public insurer data is allowed in FSS (ADR to record it, rights register entry per source, legal review marked); bad PDFs are sanitised, not rejected (ADR plus review); non-insurance PDFs are rejected at upload.

## Squad A (session 1): CoverSaath backend, repo `CoverSaath`

Worktrees under `CoverSaath.worktrees/`, branches `sqa/*`.

| Slice | Owns |
|---|---|
| A1 upload-time insurance-PDF gate | `src/features/input/insurance-pdf-gate*.js`, its tests, the upload route call site |
| A2 PDF sanitiser (strip JS, actions, embedded files, forms; re-inspect) | `src/features/input/pdf-sanitise*.js`, `pdf-inspection.js`, tests, ADR `docs/adr/0034-*` |
| A3 honest unknown + clause-level chat answers | `src/backend/services/chat*`, `src/features/memory*`, chat tests |
| A4 stale branch and worktree cleanup (all repos) | git refs only |
| A5 per-household memory document (rendered from sealed rows, page + clause cites) | `src/backend/services/memory-document*.js`, its route file, tests |
| A6 beta app flow: upload, product confirm, declarations, policy card, chat | repo `Knowvia_website`, branches `sqa/*` |

## Squad B (session 2): FSS real data, repo `insurance-data-api`

Worktrees under `insurance-data-api.worktrees/`, branches `sqb/*`.

| Slice | Owns |
|---|---|
| B1 one service: merge the 9 feature branches into `main`, every route CoverSaath's client calls served from one build | whole repo |
| B2 real insurer registry: every IRDAI-registered health/general/life insurer | FSS migrations, importers |
| B3 real products by UIN (IRDAI product lists), versions, status | FSS importers |
| B4 real wordings: fetch public policy wording/CIS/prospectus PDFs, store outside git, pages, clauses, facts with page + quote | FSS ingestion |
| B5 ADR `real-public-data` in FSS + rights register entries | FSS `docs/` |

Squad B may touch CoverSaath only in `src/integrations/insurance-data/` and `scripts/live-run/fss-stub.mjs`, and only if the FSS contract changes; tell Squad A in this file.

## Shared contract (do not break)

CoverSaath calls FSS only through `src/integrations/insurance-data/client.js` allow-list: `GET /v1/insurers`, `/v1/insurers/resolve` (`{status, insurer}`), `/v1/products`, `/v1/products/search`, `/v1/products/by-uin/{uin}/export`, `/v1/network-hospitals/export`, `/v1/versions/{id}/facts`. Schemas: `src/integrations/insurance-data/schemas.js`.

## Hand-off log (append, newest last)

- 2026-11-14 A: PR #134 merged; review fixes on `main` 930b6e4. Squad B lane opened.
- 2026-11-14 A: Squad A running A1+A2 (`sqa/pdf-gate-sanitise`), A3 (`sqa/chat-honest-unknown`), A4 cleanup. Squad B brief: `squad-b-brief.md`.
- 2026-11-14 A: claimed A5 (memory document) and A6 (beta flow in Knowvia_website).
- 2026-11-14 B: B1 done on `sqb/unify` (FSS PR #1): 8 branches merged, all 7 client routes served from one build, local CI green (179/179 tests). Merged to `master` (FSS #1, #2) with owner OK; GitHub Actions runners queued, so local CI is the evidence. FSS contract unchanged. B5 ADR 0003 in PR #2 (stacked). Scope narrowed by owner: health, life, term life, health-related add-ons only. Blocker: irdai.gov.in robots.txt disallows all; owner chose insurer websites (all insurers) instead; insurer-host rights flipped to allow for the prototype (FOR LEGAL REVIEW, no document serving).
- 2026-11-14 A: A3 merged (#135): honest unknown, clause-level answers, exclusions. Facts sources carry `page.pageNumber` (ff1b3e6). A4 cleanup done in all 4 repos (merged only). A6 merged (Knowvia_website #18, `/beta` flow, BFF session cookie; not run against a live backend). A1+A2 open (#136, ADR 0035), merge on green CI. A5 building.
- 2026-11-14 A: Tuesday review backlog for #135 (deferred by owner): negation ("not excluded" read as excluded), capitalised terms not canonicalised (Plastic, Pre-existing, Room Rent), capped clause search treated as no-match, member names drop relevant passages, window may cut off matched terms, block_index fallback, test floors (70 -> 76, 18 -> 19), IVF -> infertility synonym, memory-chat survivor identity.
