# CodeQL alert remediation

## Outcome

Close every open CodeQL alert on `main` without weakening runtime, privacy, consent, tenant, or database controls.

## Scope

- Provider smoke scripts: stop loading secrets from files and sending file-derived values over HTTP.
- Evaluation code: replace dynamic object writes with `Map` plus explicit object conversion.
- PostgreSQL migration tooling: restrict migration loading to fixed production and test roots, reject links, and execute only validated migration files.
- CodeQL configuration: remove the checked-in advanced workflow only if GitHub default setup remains active.

## Non-goals

- No API, consent, model authority, schema, migration, provider, or deployment change.
- No alert dismissal without a concrete false-positive justification.
- No commit, push, pull request, merge, deployment, or repository-setting change without separate authorization.

## Acceptance evidence

1. All affected narrow tests pass.
2. `npm run check`, `npm run eval:safety`, and `git diff --check` pass.
3. An independent read-only review finds no unresolved security blocker.
4. A fresh GitHub CodeQL scan reports no open alert on the branch. This needs a push or pull request and remains unverified until authorized.

## Rollback

Revert the files changed by this branch. There is no database or external-state rollback.
