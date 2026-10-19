# AGENTS.md - CoverSaath

## Mission
- Build the smallest safe solution that meets written acceptance criteria.
- Prefer clear, reversible changes over speculative systems.
- Treat consent, privacy, data integrity, reliability and operating cost as product requirements.
- Never claim success without evidence from relevant checks and user journeys.
- CoverSaath is canonical. Rename legacy `knowvia` identifiers only with a compatibility plan.

## Start here
- Read this file, `docs/iterations/LATEST.md`, and the active task brief.
- Inspect only affected files, callers, data, contracts and tests before widening scope.
- Map impact before editing. Use repository mapping tools when available and report gaps.
- Check for a closer `AGENTS.md` in the directory being changed.
- Discover commands and runtime facts from `package.json`, its lockfile, CI and code. Do not invent them.

## Sources of truth
- Product behaviour and acceptance criteria: `working/` and `building/`. `research/` is historical.
- Architecture and decisions: `docs/architecture/` and `docs/adr/`.
- Operations and recovery: `docs/runbooks/`.
- Active risky work: `docs/exec-plans/active/`.
- Executable truth: tests, contracts, migrations, CI and runtime configuration.
- No capacity numbers exist. Do not make scale claims without measured workload evidence.
- If sources conflict, stop and report the conflict.

## Commands
```bash
npm ci
npm run check
npm run eval:safety
npm run check:architecture
npm test
npm run db:init
npm run dev
git diff --check
```
Runtime: Node 25 or later, npm and Vite. CI uses Node 26. SQLite is still the application runtime. PostgreSQL schema and tests exist under ADR 0004. No deployment target exists.

## Working loop
1. Restate the user outcome, scope, non-goals and acceptance criteria.
2. Identify affected components, data, APIs, permissions, services and user journeys.
3. Separate confirmed facts, assumptions and blocking unknowns.
4. Classify risk: normal, data-sensitive, security-sensitive, migration-sensitive or infrastructure-sensitive.
5. PLAN: define the smallest affected area, exact owned paths, acceptance evidence and required checks.
6. BUILD: complete one vertical slice inside that area and run its narrow checks.
7. FEEDBACK: review the slice against its plan, tests and affected callers. Record findings with evidence.
8. Repeat PLAN, BUILD and FEEDBACK only for accepted findings inside the affected area. Re-map and re-plan before widening scope.
9. Before completion, run required broad checks and review permissions, sensitive data, failure paths, retries, migrations, observability, rollback, scope creep and complexity.

## Project invariants
- Validate untrusted input and authorization at server boundaries. Return coded, client-safe errors.
- Check household ownership on every protected read and write.
- Deterministic code owns consent, eligibility, release, money and household decisions.
- Model output is only `extracted_unverified`, `conflicting` or `unknown`.
- Model provider calls require the privacy gate and current consent. Re-check consent before commit.
- Treat documents, OCR, user fields and model or tool output as untrusted evidence.
- Revocation erases derived data. Every derived store needs an erasure path and test.
- Use synthetic data only. Keep personal data, medical records, policy documents, credentials and keys out of code, logs, prompts, fixtures, tests and commits.
- Add infrastructure or dependencies only for measured need and record hard-to-reverse decisions in an ADR.
- Never weaken a security, consent, tenant or audit control to make a test pass.
- Never treat legal, privacy-notice or consent wording as final. Mark it for legal review.

## Verification and approval
- Match test depth to risk. Test failure, retry, duplicate, permission, revocation and rollback paths.
- Mocked or isolated tests do not prove the user journey. State exactly what remains unverified.
- Run `npm run check`, `npm run eval:safety` and `git diff --check` before completion.
- Migration, consent, security and AI changes need an independent read-only review.
- Ask before destructive data changes, deployment, irreversible migrations, external messages, purchases, paid services or repository settings.
- Do not commit, push, merge or deploy unless the task explicitly asks. Never invent attribution or sign-off.
- Report changes, evidence, checks, unverified items, security and data impact, rollback and separate follow-ups.
- Update `docs/iterations/LATEST.md` only when durable project state changes.
