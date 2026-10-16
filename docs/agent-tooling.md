# Agent tooling

Agent tooling is separate from application dependencies. Nothing here belongs in `package.json`.

## Repository map

Approved tool: **repomap**.

- Preferred: the repomap MCP server (`map`, `impact`, `search`, `context`, `trace`, `db`).
- CLI fallback, when approved: `npx -y @sylphx/repomap map . --json` and `npx -y @sylphx/repomap impact --changed`.
- The built-in RepoMap stays authoritative. `pdavis68/RepoMapper` may be used only as a pinned, isolated, read-only cross-check for high-risk phases. It is not a CI or application dependency.

## Models

Model roles from the 2026-10 production plan of action:

| Role | Model | Effort |
|---|---|---|
| Central integration owner | Opus 5.5 | High |
| CERT and repository graph | Haiku 5.5 | Medium |
| PostgreSQL/data, runtime/DAG, adapters, frontend, Azure/ops, QA | Sonnet 5.5 | High |
| AI, privacy, insurance logic, security review, final review | Opus 5.5 | High |

The model assignment in each phase section of the plan wins over the summary table. Opus 5.5 XHigh is reserved for a critical final S2 review with written justification. If Haiku or Sonnet is unavailable, use Opus 5.5 High and record the fallback.

## Work isolation

- One sub-agent, one `claude/p<phase>-<scope>` branch, one git worktree.
- Worktrees branch from a commit. Checkpoint uncommitted work before dispatch.
- No direct pushes to `main`. One independent human approval before merge.
- The central owner owns shared contracts, package files, lockfiles, module exports, workflow definitions and iteration documents.
- Review agents are read-only. Fixes go back to the original owner.

## Local tools

Record presence and version in the intake. Do not install a CLI without recording need, version, smoke test and rollback in the task's exec plan.

| Tool | Use | Required from |
|---|---|---|
| Node.js (>= 22.16) and npm | runtime, tests, build | Phase 0 |
| gh | pull requests, repository settings | Phase 1 |
| Docker | local PostgreSQL | Phase 1 |
| psql | PostgreSQL checks | Phase 1 |
| Azure CLI and Bicep | infrastructure | Phase 2 (dev environment) or Phase 6 |

## Task states and review format

- Hand off risky work with one state: `READY`, `BLOCKED` or `NOT_APPLICABLE`.
- Review findings: ID, severity (P0–P3), evidence (`file:line`), affected area, fix, verification, disposition.
- Phase gate: no P0/P1, no privacy, security, migration, permission or deployment P2, and one independent human approval.

## Optional per-machine tools

Install once per machine, never per task, and never as application dependencies. Pin to a tag or commit before use.

| Tool | Install (verify the pin first) | Check |
|---|---|---|
| Caveman (Codex) | `npx -y github:JuliusBrussee/caveman#v4.0.1 -- --only codex` | `$caveman status` |
| GStack (Codex) | clone `garrytan/gstack` at a pinned commit, then `./setup --host codex` | `npx skills ls -g -a codex --json` |
| taste-skill (UI work only) | `npx skills add https://github.com/Leonxlnx/taste-skill --skill design-taste-frontend` at a pinned ref | `npx skills ls -g -a codex --json` |

A specialist agent gets one named skill, one owned scope and one handoff.
