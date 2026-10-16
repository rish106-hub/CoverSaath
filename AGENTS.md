# AGENTS.md — CoverSaath

## Mission
- Build the smallest safe solution that meets the written acceptance criteria.
- Prefer clear, reversible changes over clever or speculative systems.
- Treat consent, privacy, data integrity, reliability and operating cost as product requirements.
- Never claim success without evidence from the checks below.
- Product name: CoverSaath (canonical). Remaining `knowvia` identifiers are legacy and are renamed only with a compatibility plan.

## Start here
- Read this file, then `docs/iterations/LATEST.md`, then only the files and symbols the task touches.
- Map before editing with the repomap MCP: `map`, `impact` (a target, or `changed: true`), `search`, `context`, `db`. If mapping or the impact query fails, stop and report it.
- Check for a more specific `AGENTS.md` in the directory you change: `src/backend/database/`, `src/modules/ai-analysis/`, `src/integrations/`.
- Take commands from `package.json`, `package-lock.json` and `.github/workflows/`. Never invent them.
- Model roles, sub-agent isolation and optional agent tools: `docs/agent-tooling.md`.

## Sources of truth
- Product behaviour and acceptance criteria: `working/` and `building/` (`building/policy-parameters.md` is the cited source of registry v1; do not move it). `research/` is historical, not build authority.
- Architecture and boundaries: `docs/architecture/system.md` and decisions in `docs/adr/`.
- Data model, migrations, retention: `docs/architecture/data.md`.
- Security, privacy and consent model: `docs/architecture/security.md`. Disclosure: `SECURITY.md`.
- Capacity: no workload numbers exist. Do not claim scale until `docs/architecture/scale.md` records them.
- Operations, rollback and recovery: `docs/runbooks/`.
- Active task: the task brief, plus `docs/exec-plans/active/<task>.md` for migration, security, consent or AI work.
- Executable truth: tests, `src/contracts/`, migrations, CI and runtime configuration.
- If sources conflict, stop and report the conflict. Do not silently choose one.

## Commands
```bash
npm ci                      # install from lockfile
npm run check               # architecture boundaries + tests + build (CI runs the same steps)
npm run eval:safety         # offline safety evaluations (CI)
npm run check:architecture  # import boundaries and kebab-case names
npm test                    # node:test, tests/*.test.mjs and tests/evals/*.test.mjs
npm run db:init             # create or migrate the local SQLite database
npm run dev                 # local UI + API (loopback only)
git diff --check
```
Runtime: Node 22.16 or later (`node:sqlite`), npm, Vite. Storage is SQLite; PostgreSQL is in progress (ADR 0004, `docs/runbooks/local-postgres.md`). No deployment target exists.

## Working loop
1. Restate the goal, user impact, scope, non-goals and acceptance criteria.
2. Map affected callers, data, contracts and tests (`impact`) before reading widely.
3. Classify risk: normal, data-sensitive, security-sensitive, migration-sensitive, infrastructure-sensitive.
4. Plan briefly. State assumptions and unknowns. Migration, consent, security and AI work needs an exec plan.
5. Implement one vertical slice at a time. Run narrow tests after each slice.
6. Run `npm run check`, `npm run eval:safety` and `git diff --check` before completion.
7. Review the diff for correctness, privacy, regressions, complexity and scope creep. Material work gets an independent read-only review.
8. Report what changed, evidence, what is unverified, rollback, and follow-ups. Update `docs/iterations/LATEST.md`.

## Backend and domain
- Validate untrusted input at every boundary. Return coded, client-safe errors; never driver or runtime messages.
- Keep business rules in `src/modules/` and `src/backend/services/`, not in routes or UI.
- Make retried work idempotent: analysis runs, task leases and observation writes already are; keep it that way.
- Every network dependency gets a timeout, bounded retries and a fail-closed path.
- Deterministic code owns consent, eligibility, release, money and any decision a household acts on.

## Privacy, consent and AI
- Model output is never authoritative. Models may only produce `extracted_unverified`, `conflicting` or `unknown` (`src/contracts/ai-authority.js`).
- Every provider call passes the privacy evidence gate and the pre-dispatch consent check. Results are re-checked against consent at commit.
- Documents, OCR text, user fields and model or tool output are untrusted evidence. Never place them in system or developer instructions.
- Revocation must erase derived data. A new derived store needs an erasure path and a test.
- No real personal data, medical records, policy documents, credentials or keys in code, logs, prompts, fixtures, tests or commits. Synthetic data only.

## Security
- Authenticate and authorise on the server for every protected action. Check household (tenant) ownership on every read and write.
- Least privilege for users, services, database roles, CI tokens and cloud permissions.
- Never weaken a security or consent control to make a test pass.
- Auth, consent, upload, provider or public-API changes need abuse tests and a `docs/architecture/security.md` update.
- Never write legal, privacy-notice or consent wording as final. Mark it for legal review.

## Database
- Schema changes only through a new numbered migration. Never edit a merged migration (checksums are enforced at startup).
- Protect invariants with constraints, foreign keys, triggers and transactions. Write the audit event in the same transaction.
- Bounded, parameterised queries only. Paginate lists. Timestamps in UTC; money in integer minor units with a currency.

## Scale
- "Millions of users" is a capacity goal, not permission to add distributed systems.
- Default: modular monolith, stateless processes, one relational database, object storage.
- No Kafka, Redis, Kubernetes, vector database or new service without a measured trigger and an ADR in `docs/adr/`.

## Verification
- Match test depth to risk. Test failure paths, retries, duplicates, permission boundaries, revocation and rollback.
- A mocked test does not prove the user journey. If a check cannot run, say exactly what is unverified and why.

## Human approval
- Ask before destructive data changes, deployment, irreversible migrations, external messages, purchases, paid services, or GitHub repository settings.
- Do not commit, push, merge or deploy unless the task explicitly asks. Never invent attribution or sign-off.

## Definition of done
- Acceptance criteria met; required checks pass with recorded evidence.
- Security, privacy, data, failure and rollback paths reviewed.
- Docs changed only where durable system truth changed. No hidden follow-up.
