# Backend-first repository layout

Date: 2026-10-20

## Outcome

Keep CoverSaath backend-only. Remove the active browser UI and historical visual material. Group business capabilities under `src/features/`, with document intake under `src/features/input/`.

## Scope

- Remove `src/ui/`, Vite, frontend entry points and UI-only tests.
- Run `npm run dev` as the API process only.
- Move `src/modules/` to `src/features/`.
- Move `src/features/document-intake/` to `src/features/input/`.
- Remove tracked design, marketing, strategy and research artifacts from the active tree.
- Keep contracts, migrations, backend tests, ADRs, architecture docs, runbooks, active plans, `working/` and `building/`.
- Keep legacy `knowvia` identifiers until a compatibility plan exists.

## Behaviour boundary

No API, database, consent, authorization, model authority, provider, retry or erasure behaviour changes.

## Proof

Run before and after:

```sh
npm run check
npm run eval:safety
git diff --check
```

The test count may fall only by the removed UI-only tests. PostgreSQL tests still require `TEST_DATABASE_URL`.

## Rollback

No commit, push, merge or deployment is part of this task. Restore the branch from its starting commit `9cad7d0` if the migration is rejected. Removed tracked files remain in Git history.
