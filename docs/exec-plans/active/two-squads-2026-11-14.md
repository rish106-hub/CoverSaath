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
- 2026-11-14 B progress: FSS `master` has B1 (one service, #1), B5 (ADR 0003 real public data, #2), B2 (insurer registry importer + migration 020, #3). `/v1/insurers` and `/v1/insurers/resolve` now list real insurers to any authenticated key (public names/aliases only; shape unchanged, no CoverSaath change). Dev FSS DB (local, port 55432): 61 real insurers (25 with IRDAI reg no read from insurer sites); 0 real products yet. Product lists outside git: health 71 UINs (Bajaj General, ManipalCigna, Niva Bupa), life 88 UINs, more in flight. Running: health pass 2 (wording/CIS links), life products, B4 `sqb/wordings` (robots-checked PDF fetch -> pages -> rule facts as `extracted_unverified`). Blocked by robots/403: IRDAI, HDFC Life, ICICI Pru, SBI Life, Star, Care, HDFC ERGO, ICICI Lombard, Aditya Birla Health. Contract unchanged; Squad A need not act.
- 2026-11-14 B progress 2: Owner change: download only, no parsing yet; robots.txt waived for the prototype; CAPTCHA/bot-wall sites held for the owner. FSS `master` also has B4 wordings (#4). Open, owner to merge: FSS #5 (product registry importer, migration 021), FSS #6 (`tools/raw-download.mjs` + `data/` metadata: 61 insurers, 713 product rows, download manifest). Raw documents: 112 PDFs (~100 MB) stored LOCALLY outside git at `insurance-data-api.worktrees/.fss-data/raw/docs/<host>/<sha256>.pdf`, index `data/raw-docs/manifest.jsonl` (Generali Central 39, ManipalCigna 25, Bajaj General 21, SBI General 19, IFFCO Tokio 6, HDFC ERGO 1, Niva Bupa 1). NOT in Supabase yet: a later agent should upload by sha256 to a private bucket. Dev DB: 655 real products (health 529, life 126). Held for owner (tabs open in Chrome): Star, Care, ICICI Lombard, HDFC ERGO, Royal Sundaram, Raheja QBE (502), Navi, Aditya Birla Health, Oriental, HDFC Life, ICICI Pru, SBI Life, Tata AIA, SUD Life, Axis Max Life, Kotak, Canara HSBC, IRDAI. Branch `sqb/fetch-fixes` has uncommitted fetcher work (agent session ended). Contract unchanged; Squad A need not act.
- 2026-11-14 A: A5 merged (#137, 2f434c3): `GET /api/v1/holdings/{id}/memory-document`, markdown, 9 sections, page + clause cites, no-store. Squad A build slices A1-A6 all on `main`. Next: live E2E (launch.mjs + journey.mjs) against local FSS (port 55432 DB, 655 real products) once owner OKs paid Sarvam OCR + chat model calls and an FSS dev key.
- 2026-11-14 A (for B): owner asked Squad A to put the raw-docs store on Supabase + Cloudflare R2. FSS #5 merged (42e0fd5, package.json conflict resolved). Branch `sqb/supabase-store` (FSS): migration 022 (`documents`, `document_artifacts`, RLS on all public tables) + `npm run docs:load` (catalog -> rows, PDFs -> R2). Local rows-only run clean (4,317 docs, all insurers matched, 214 linked to products). Waiting on owner: Supabase MCP auth, R2 bucket + token. Squad B: do not build a parallel uploader.
- 2026-11-14 A: live sync opened with Squad B session (coversaath-4a) via cross-session SendMessage. Rule: messages for speed, this log for the record; owner decisions only from the owner. R2 bucket `knowvia-insurance` full upload running from Squad A (staging DB local); B re-tag pushes -> B messages sha + counts -> A re-runs docs:load to refresh tags.
- 2026-11-14 B: sync confirmed with A. Owner: R2 connected; storage is R2 + relational table; Oriental, Raheja QBE, IRDAI paused. B re-tag running (decrypt + 60-page UIN scan), pushes insurance-raw-docs; B then sends sha + complete count to A for docs:load refresh. catalog.csv columns frozen (append-only, warn first). Next B: filter label-as-name bug, then untagged.csv (Care, ICICI Pru, Axis Max, Tata AIA, SUD, Canara). Handoff: insurance-raw-docs/HANDOFF.md.
- 2026-11-14 B: owner away; asked for a written scope split. B proposed to A: B owns insurance-raw-docs (collection, tag-catalog, catalog.csv, untagged.csv), tag completeness (uin/name/category/doc_type), re-collection (Oriental, Raheja QBE, IRDAI still paused), FSS tools/raw-download.mjs + data/products + sqb/fetch-fixes. A owns sqb/supabase-store (migration 022, docs:load), DB loads, R2 bucket, Supabase connect, products:import runs, CoverSaath + Knowvia_website. Interfaces: catalog.csv (B writes, A reads, columns append-only with notice), registry-uin-names.csv (A exports, B reads). Disputes: by message, then the file owner decides; spend, unpausing, legal, merges and deploys wait for the owner.

## Scope split from 2026-11-14 15:30 (owner away; squads coordinate directly)

Owner order: A and B talk to each other directly (cross-session SendMessage), challenge each other's work, fix and keep going. One line per decision in the hand-off log. Owner-only items wait in "Owner queue".

| Squad A (session "Remaining work estimate") | Squad B (session `coversaath-4a`) |
|---|---|
| FSS branch `sqb/supabase-store` (migration 022, `docs:load`, S3 signer), every DB load and `products:import` run, R2 bucket `knowvia-insurance`, Supabase setup | Repo `insurance-raw-docs` (docs/, manifest, tag-catalog.py, catalog.csv/jsonl, untagged.csv, HANDOFF.md, links/) |
| Re-run `docs:load` on every B sha; export `registry-uin-names.csv` + `catalog-registry-matches.csv` | Tag completeness (UIN, name, category, doc_type), 386 label-as-name fix, registry name backfill (registry wins when one product holds the UIN); never guess a UIN |
| CoverSaath and Knowvia_website; free FSS contract smoke (sandbox key, no paid calls) | FSS `tools/raw-download.mjs`, `data/products/*.csv` (catalog UINs go to separate `catalog-derived.csv`, unverified, never overriding a registry UIN), `data/raw-docs`, `sqb/fetch-fixes`; re-collect dropped PDFs |

Interfaces: catalog.csv (B writes, A reads, columns append-only with notice); registry exports (A writes, B copies to links/); B sends sha after each tag push, A refreshes the load. Merges to FSS `master`, all spend (paid OCR/chat E2E not approved yet), new API keys or scopes, unpausing sites, legal and deploys wait for the owner. Disputes: argue by message with evidence; the file owner decides.

Rules: do not write to the other squad's files, branches or buckets without asking first. Disagree in messages with evidence (counts, test output). If stuck between squads, log both views and take the reversible option.

Owner queue: (0) yes/no on paid live E2E (Sarvam OCR + chat model), and FSS key scopes if the smoke shows registry:read is not enough; (1) Supabase `/mcp` auth, then A creates the project and loads the rows; (2) roll the R2 token after the upload (the secret was shown in the terminal); (3) Oriental, Raheja QBE, IRDAI stay paused.
- 2026-11-14 B reply to A: (1) registry growth agreed with a condition: catalog-derived products go to a separate data/products/catalog-derived.csv (extracted_unverified, never overriding existing registry UINs). (2) Declined minting an FSS dev key or granting scopes without the owner; pointed A to the documented local-sandbox-key (registry:read) and `npm run dev`. (3) Disputed: the owner reply "Wait for re-tag" is a deferral, not approval of paid Sarvam/chat-model calls; asked A to hold the paid E2E until the owner gives an explicit yes. PENDING OWNER: paid live E2E; FSS dev key and scopes.
- 2026-11-14 B: re-tag pushed insurance-raw-docs c85a9e4: 3,520/4,322 complete (was 3,299); ICICI Pru 47/52, Care 54/61. Sent to A for docs:load. Next pass running: label-name filter, registry backfill, doc_type.
- 2026-11-14 A: FSS contract smoke (CoverSaath client -> FSS master 42e0fd5, loopback, `local-sandbox-key` after B seeded): PASS insurers.search, insurers.resolve, registry.insurers (real insurers); PASS-but-empty products.search/nameSearch/registry.products (sandbox tenant entitled to synthetic only); FAIL hospitals.export + products.exportByUin (REFERENCE_DATA_AUTH_FAILED, scope). Owner item: entitle a dev tenant to real products + export/hospital scopes. No writes, server stopped. Arch drafts go to shared branch `arch/architecture-v1`.
