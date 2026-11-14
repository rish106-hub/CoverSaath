# Hand-off: Squad A to Squad B (2026-11-14, ~16:55)

Paste this whole file into the Squad B session if Squad A has stopped. Squad A resets around 19:40. Until then Squad B owns everything below. Owner decisions come only from the owner, never from a peer message.

## 1. DONE 16:45: production deploy (v23, migrations 065+066, all checks pass). Kept for rollback reference.

Why: the live API `knowvia-api` (Fly, 2 machines in `syd`) was deployed on 2026-11-11, before #136 (sanitise active PDF content, 0354aa4). Real insurer PDFs with JavaScript, embedded files or forms are still rejected live with `PDF_ACTIVE_CONTENT`, which the frontend shows as "This PDF carries embedded scripts or attachments we could not remove". On current main the owner's test PDF is sanitised (javascript, embedded_files, acroform, annotation_actions removed) and accepted, then passes ClamAV and Sarvam OCR.

State when this was written:
- The live Supabase is at migration **058**. Main needs **065** (holding_documents, plus `memory_chunks.source_page`) and **066** (two nullable columns on `policy_holdings`). Both are expand-only; I read them.
- The plan follows docs/runbooks/fly-deploy.md, keeping `syd` (fly.toml says `sin`; `fly deploy` updates the existing machines in place; moving region is a separate owner decision).

Steps (check `fly status -a knowvia-api` and `fly releases -a knowvia-api` first to see whether A already finished any):
1. `~/.fly/bin/flyctl deploy --remote-only -a knowvia-api` from the CoverSaath main checkout. On a Fly 5xx wait 60 s, retry once, then stop and report.
2. Migrations 065 and 066: checked 16:55, the app's `DATABASE_URL` is already the Supabase SESSION pooler (port 5432), which migrate.js needs, and the server does not check the schema at startup. After the deploy run `~/.fly/bin/flyctl ssh console -a knowvia-api -C "npm run db:init"` once (the NEW image carries 065 and 066). Then `/ready` turns 200.
3. Verify (runbook "Verify"): `/api/v1/health` 200; `/api/v1/ready` 200 with database, authentication and documentScanner all true; `Host: evil.example` gets 403; `fly logs --no-tail` shows no stack traces.
4. Rollback: `fly deploy --image <previous image> -a knowvia-api`. The previous image is `knowvia-api:deployment-01M75X22BKXDCDW11Y1CSK3D2G`. The migrations can stay (expand-only).
Never print secrets. Never upload a real document to production for testing.

## 2. Open PRs (none merged; Auto-fix watches CI)
- CoverSaath #138 answer guard C0-C10 plus insurer contacts (b2b6c3e). #139 question planner. #140 Gnani voice (CodeQL SSRF fixed, d429fb4). #141 architecture v1 (conflict resolved, 1d48ee5).
- insurance-data-api #7: document store, R2 loader, migration 023 insurer_contacts plus route (f6753ed).
- Knowvia_website #19: beta cards (903a8bf). Its base is the DEPLOYED landing branch: do not merge without the owner. The landing page must not change; beta work stays under beta paths.

## 3. B work queue until 19:40, in order
Full brief: docs/exec-plans/active/two-squads-2026-11-14.md, section "B work brief".
1. Tag pass 4: diff, spot-check, push the sha. Then `docs:load --rekey` against staging (`--dry-run` first, real run with `node --env-file=$HOME/.config/fss/r2.env`).
2. The intake questions route plus answer storage (reuse the sealed profile-answers route, E1a).
3. Chat answers as answer-card/v1, only through `guardAnswerCard`, with FSS contacts and `pickInsurerContact` as the fallback.
4. Feedback, correction and conflict-resolution routes.
5. Product name search through the FSS products search.
6. A beta counterpart for each route (Knowvia `src/lib/beta/adapter.ts` TODO(backend) plus a BFF route).
Lower priority now that Sarvam is approved: the free text-layer OCR provider (item 1b).

## 4. Facts from A's live run with the owner's real PDF (all data dropped)
- Upload, clamd scan, Sarvam OCR (about 9 s) and the holding all worked locally on main.
- Stopped at product match: the local FSS stub knows one invented insurer, so there were 0 candidates and facts were never built. The real fix is the owner item O2: entitle a dev tenant to real products in FSS, then point the live run at the real FSS (`LIVE_RUN_FSS_URL` plus key).
- The privacy-safe single-PDF driver (prints only statuses, counts and fact keys) is not committed. Rebuild it from scripts/live-run/journey.mjs if needed, and never print values from a real document.

## 5. Owner queue (unchanged)
Roll the R2 token; Supabase /mcp auth for FSS; O1-O10 in architecture v1; O2 dev-tenant entitlement to real products.
