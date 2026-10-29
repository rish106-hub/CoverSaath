# AI.md - 60-second start for AI agents

Read this, then [AGENTS.md](AGENTS.md) (the binding rules), then [docs/iterations/LATEST.md](docs/iterations/LATEST.md) (current state), then your task brief. If sources conflict, stop and report it.

## What this is

CoverSaath: a consent-first health-insurance evidence backend. Node 25+ ES modules, one process, one PostgreSQL database (Supabase in hosting). No frontend. **Prototype, synthetic data only.**

Core rule: **deterministic code decides** consent, eligibility, money, release. Model output is only `extracted_unverified`, `conflicting` or `unknown`.

## Run it

```sh
npm ci
cp .env.example .env.local     # set DATABASE_URL, KNOWVIA_BOOTSTRAP_TOKEN (32+ chars), DOCUMENT_ENCRYPTION_KEY_BASE64
npm run db:init                # migrate
npm run dev                    # http://127.0.0.1:8787  (container/Fly listens on 8080)
```

Tests need PostgreSQL 17 in `TEST_DATABASE_URL` (see [local-postgres runbook](docs/runbooks/local-postgres.md)). Add `REQUIRE_POSTGRES=1` or they skip silently.

| Command | Use |
| --- | --- |
| `npm run check` | architecture + all tests + entry-point check. Run before claiming done. |
| `npm run eval:safety` | safety evals. Required before completion. |
| `npm run check:architecture` | import and naming boundaries only (fast). |
| `node --test tests/<file>.test.mjs` | one test file. |
| `git diff --check` | whitespace. Required before completion. |
| `gitleaks git .` | secret scan of full history. |

## Where things are

| Need | Path |
| --- | --- |
| HTTP routes (all of `/api/v1`) | `src/server/routes/v1-backend-routes.js` |
| Auth, host/origin guard, rate limit | `src/shared/http/security.js`, `src/server/config.js` |
| Services and repositories | `src/backend/services/`, `src/backend/repositories/` |
| Migrations (append-only) | `src/backend/database/postgres/migrations/` |
| Contracts and error codes | `src/contracts/` |
| Upload, scan, OCR | `src/features/input/` |
| Evidence, retrieval, structuring | `src/features/policy-evidence/`, `src/features/policy-structuring/` |
| Deterministic rules and household reasoning | `src/features/insurance-rules/`, `src/features/household-reasoning/` |
| Model calls, privacy gate, budget | `src/features/ai-analysis/` |
| Provider adapters | `src/integrations/` (import via `src/integrations/index.js` only) |
| Decisions | `docs/adr/` (0011 = Supabase + Fly) |
| Deploy and recovery | `docs/runbooks/fly-deploy.md` |
| Product behaviour sources | `working/`, `building/` |

Check `AGENTS.md` in the directory you edit; `src/backend/` and `src/integrations/` have their own.

## Invariants (never trade these for a green test)

1. Check household ownership on every protected read and write.
2. Provider calls need the privacy gate and current exact consent, re-checked before commit.
3. Revocation erases derived data. Every new derived store needs an erasure path and a test.
4. Validate input and authorization at the server boundary; return coded, client-safe errors.
5. Synthetic data only. No personal data, policies, keys or tokens in code, logs, prompts, fixtures, tests or commits.
6. Consent, privacy and legal wording is never final. Mark it for legal review.
7. Add infrastructure or dependencies only for measured need; record hard-to-reverse choices in an ADR.

## How to work

- Restate outcome, scope, non-goals and acceptance criteria. Make the smallest safe, reversible change.
- Map impact first (callers, data, contracts, tests). Do not widen scope without re-planning.
- Match test depth to risk: failure, retry, duplicate, permission, revocation, rollback.
- Migration, consent, security and AI changes need an independent read-only review.
- **Ask before** destructive data changes, deployment, history rewrites, repository settings, purchases or paid services. **Do not commit, push, merge or deploy** unless asked.
- Report: changes, evidence, checks run, what is still unverified, security and data impact, rollback.

## Gotchas

- Names: public name is CoverSaath; `knowvia` identifiers (env vars, DB values, Fly app `knowvia-api`) stay until a compatibility plan exists.
- The API answers 403 to any `Host` other than loopback or a `PUBLIC_HOSTS` entry, and to any browser `Origin` except the dev one. There is no CORS. A UI must call it server-side (BFF), never from the browser.
- Auth is a bearer token from `POST /api/v1/households` (needs the bootstrap token). No login, OTP or member-invite routes exist.
- No route lists cases or consent grants, serves PDF bytes, or returns OCR text.
- Provider features (`SARVAM_OCR_ENABLED`, `POLICY_EVIDENCE_ENABLED`, `POLICY_STRUCTURING_ENABLED`) are off unless exactly `true`. Live calls cost money; tests use local stubs, and live tests (`test:sarvam-live`) are opt-in.
- `src/ui` is rejected by `check:architecture`. A frontend needs an accepted task and an ADR first. Website and BFF code live in separate sibling repos (`Knowvia_website*`).
- Rate limit, model budget and the evidence-claim guard are per process: one machine only.
- A privacy-scan timing test (200 ms bound) can fail under a loaded full run; rerun in isolation before blaming your change.
- `.gitignore` deliberately hides some private plans under `docs/`. Do not force-add them.
- ADR numbering skips 0007.

## Do not

Invent commands, claim success without checks, weaken a security, consent, tenant or audit control, read or print `.env*`, `.local/`, or anything gitignored, or put secrets in a commit.
