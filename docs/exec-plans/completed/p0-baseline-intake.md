# Phase 0 baseline intake and handoff

Branch: `claude/p0-integration`. Base: `135acc9` on `main`. Plan of action: the 2026-10 production POA (Phases 0–6).

## CERT state

```text
TASK CLASS = S2
CERT = READY (code gate green)
PHASE 0 GATE = PENDING third independent review
```

## Objective

Close the unfinished evidence-completion work and establish a clean, verified baseline before PostgreSQL, Azure or real customer data.

## Map findings

- RepoMap (MCP): 141 code files, 30 test files at start; 832 symbols; 1,092 call edges.
- `impact --changed` on the starting WIP: HIGH risk, 13 direct callers, 6 modules, 13 test files.
- Migrated schema after Phase 0: 42 tables + 2 views, 86 foreign keys, 48 explicit indexes, 54 triggers. The POA's 84 FKs / 64 indexes came from a static count; use migrated counts in Phase 1.

## Corrections to the POA

| Item | Correction |
|---|---|
| P0-B metric | The failing test expects 22 tasks completed and 5 model calls, not 22 model executions. 17 tasks are deterministic. |
| Model table | Phase-section assignments win over the summary table. Claude models override the GPT table in CLAUDE.md (recorded in `docs/agent-tooling.md`). |
| Worktrees | Worktrees need a commit base, so WIP was checkpointed first (`3b90fe5`). |
| Phase 2 vs 6 | Phase 2 needs Blob, Defender, Event Grid and Entra before Phase 6 provisions them. A minimal dev Azure environment (or local fakes) must move into Phase 1/2. |
| Phase 2 corpus | The 500-page real-policy corpus needs legal/privacy approval, which the POA only schedules in Phase 5/6. Move that approval to a Phase 1 exit item. |
| P1-C governance | A second maintainer must be named before Phase 1, or the ruleset deadlocks. |
| P3 | Keep 100% registry representation; add an insurer-site terms review; no CAPTCHA bypass. |
| P6 | Add "rollback within 15 minutes" to P6-B metrics. |

## Agent assignments (as run)

| Agent | Model / effort | Owned scope | Result |
|---|---|---|---|
| Central owner | Opus 5.5 high | branches, merges, docs, shared contracts | — |
| P0-A CERT/graph | Haiku 5.5 medium | read-only | Report; BLOCKED until ownership and failing test resolved |
| P0-B runtime | Sonnet 5.5 high | source-input, persistent-service, live runtime, task registry, decomposition, contracts | VERIFIED (4 rounds) |
| P0-C privacy | Opus 5.5 high | privacy gate, schemas, port, consent repository, create-server | VERIFIED (4 rounds) |
| Data | Sonnet 5.5 high | migration 005, parameter repository and records | VERIFIED |
| Round-3 integration | Sonnet 5.5 high | run creation wiring, OCR, revocation audit | VERIFIED |
| P0-D QA | Sonnet 5.5 high | verification only | VERIFIED |
| Independent review | Opus 5.5 high, read-only | — | Review 1 FAIL (4 P1), review 2 FAIL (2 P1, 1 P2), review 3 pending |

## Verification commands

```bash
npm ci
npm run check:architecture
npm test
npm run build
git diff --check 135acc9 HEAD
```

## Rollback

`main` is untouched. Discard by deleting `claude/p0-*` branches. Every merge on the integration branch is a `--no-ff` merge and can be reverted on its own. Migration 005 was never released; a local database that applied an earlier draft of it must be recreated (`npm run db:init`).

## Open decisions for the owner

1. Purge `docs/evidence/` from public git history (destructive force-push), or make the repository private.
2. `README.md` and `research/03-architecture.md` still link to the now-ignored `docs/evidence/`.
3. Name the second maintainer, the Azure region/data-residency owner, the identity tenant owner and the legal/privacy approver before Phase 1/2.
