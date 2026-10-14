# CERT procedure

CERT is the mandatory pre-build gate defined in the root `CLAUDE.md` (sections "CERT — mandatory pre-build gate" and "Appendix A"). This file is the short operational checklist. If the two disagree, `CLAUDE.md` wins.

## Order

```text
MAP → INTAKE/CERT → CLASSIFY → PLAN → DESIGN → IMPLEMENT
→ VERIFY → INDEPENDENT REVIEW → FINAL VERIFY → HANDOFF
```

## C — Clarify

Record in `docs/exec-plans/active/<task>-intake.md`: objective, user, problem, scope, non-goals, acceptance criteria, constraints, risks, open questions.

## E — Examine

```bash
pwd
git status --short --branch
git log -5 --oneline
rg --files -g '!*node_modules*' -g '!*.env*' | head -200
node --version; npm --version
```

Then the repository map (see `docs/agent-tooling.md`):

- `map` for modules and central files.
- `impact` with `changed: true` for the current diff.
- `search` / `context` for the task area.

If the map or the impact query fails, `CERT = BLOCKED`.

Never print secret values. Record environment variables by name only.

## R — Resolve

- Classify: S0, S1 or S2 (see `CLAUDE.md`).
- For every package, skill, MCP server, CLI or service: need → existing alternative → risk review → install → version check → smoke test → record.
- Application dependencies only through `npm` and `package-lock.json`.
- Record file ownership per agent. No two agents edit the same file.

## T — Test and hand off

Verification for this repository:

```bash
npm ci
npm run check:architecture
npm test
npm run build
git diff --check
```

Run every test that `impact` recommends for the changed files.

Hand off with exactly one state:

```text
CERT = READY | BLOCKED | NOT_APPLICABLE
```

Update `docs/iterations/LATEST.md` after meaningful work.
