# Latest iteration

## Backend-first repository layout (2026-10-20)

Completed plan: [backend-first-layout.md](../exec-plans/completed/backend-first-layout.md).

### State

- Branch: `codex/backend-first-layout`, based on `9cad7d0`.
- No commit, push, merge or deployment was performed.
- The active application is backend-only. `src/ui/`, `index.html`, Vite configuration and UI-only tests were removed.
- `npm run dev` now starts only `src/server/server.js` on `127.0.0.1:8787`.
- `npm run build` validates the backend entry point. It produces no browser bundle.
- Business capabilities moved from `src/modules/` to `src/features/`.
- Document intake moved to `src/features/input/`.
- Source filenames remain lowercase kebab-case. Architectural categories remain in directory names.

### Repository cleanup

- Removed tracked design prototypes, generated Figma tooling, marketing images, communication drafts and historical research from the active tree.
- Removed the obsolete landing-design execution plan.
- Kept product source material in `working/` and `building/`.
- Moved the two still-referenced product answer documents from `docs/strategy/` into `working/`.
- Kept ADRs, architecture docs, runbooks, migrations, contracts, tests and active backend plans.
- Moved untracked design exports and the Figma zip to `/Users/rishavdewan/Developer/Product experiments/CoverSaath-archive-2026-10-20/`.
- Removed generated `dist/`.
- Did not touch `.local/`, `.claude/worktrees/`, environment files, `node_modules/` or Git history.

### Behaviour boundary

No API, database, consent, authorization, model authority, provider, retry or erasure behaviour changed. Legacy `knowvia` identifiers remain until a compatibility plan covers stored data and callers.

### Evidence

- Pre-change `npm run check`: pass. 685 tests, 634 pass, 51 PostgreSQL or live-service skips, 0 fail. Vite build passed.
- Pre-change `npm run eval:safety`: pass, 23 of 23 offline cases, 0 network calls.
- Post-change `npm test` with loopback permission: pass. 666 tests, 615 pass, 51 skips, 0 fail. The 19 removed tests covered only the deleted UI.
- Post-change `npm run check:architecture`: pass for 131 source files.
- Post-change `npm run build`: pass. Backend entry-point syntax validated.
- The first sandboxed post-change test run failed only with `listen EPERM` on loopback sockets. The same suite passed with loopback permission.

### Production state

Production readiness remains **FAIL**.

Open work includes:

- PostgreSQL runtime migration and recovery proof.
- Production identity and secret management.
- Deployment target, observability, backup and restore rehearsal.
- Live provider validation, OCR accuracy evidence and cost checks.
- Retention policy and legal review of consent wording.
- A future UI, only after backend contracts and production boundaries are accepted.
