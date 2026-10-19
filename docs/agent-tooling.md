# Agent tooling

Agent tooling is separate from application dependencies. Nothing here belongs in `package.json`.

## Repository map

Approved tool: **repomap**.

- Preferred: the repomap MCP server (`map`, `impact`, `search`, `context`, `trace`, `db`).
- CLI fallback, when approved: `npx -y @sylphx/repomap map . --json` and `npx -y @sylphx/repomap impact --changed`.
- The built-in RepoMap stays authoritative. `pdavis68/RepoMapper` may be used only as a pinned, isolated, read-only cross-check for high-risk phases. It is not a CI or application dependency.

## Work isolation

- One writer owns one `codex/<scope>` branch, one worktree and one exact path allowlist.
- Parallel read-only agents may share a checkout.
- Parallel writers require separate worktrees from the same accepted commit and disjoint path allowlists. Without separate worktrees, use one writer at a time.
- Worktrees branch from a commit. Checkpoint uncommitted work before dispatch.
- No direct pushes to `main`. An independent agent review does not replace human approval to merge.
- The central owner owns shared contracts, package files, lockfiles, module exports, workflow definitions and iteration documents.
- Review agents are read-only. Findings return to the original writer.
- If a finding requires a file outside the allowlist, return `BLOCKED`. The central owner maps and dispatches the new affected area.

## Local tools

Record presence and version in the intake. Do not install a CLI without recording need, version, smoke test and rollback in the task's exec plan.

| Tool | Use | Required from |
|---|---|---|
| Node.js (>= 25) and npm | runtime, tests, build, PDF child network denial | Phase 0 |
| gh | pull requests, repository settings | Phase 1 |
| Homebrew PostgreSQL or Podman | local PostgreSQL | Phase 1 |
| psql | PostgreSQL checks | Phase 1 |
| Azure CLI and Bicep | infrastructure | Phase 2 (dev environment) or Phase 6 |

## Plan, build and feedback

Every delegated task uses this prompt:

```text
Role: builder | reviewer
Outcome:
Affected area:
Owned paths and symbols:
Out of scope:
Inputs and accepted decisions:
Acceptance evidence:
Required narrow checks:
Required broad checks:
Stop conditions:
Return format: use the standard report below
```

Do not dispatch wildcards such as `services/*`, `tests/*`, `docs` or "remaining files". Resolve exact paths first. Name a skill only when needed.

Every agent returns:

```text
State: READY | BLOCKED | NOT_APPLICABLE
Role:
Affected area actually inspected:
Paths changed: none for reviewers
Plan:
Build result:
Evidence and checks:
Findings:
Unverified:
Security and data impact:
Rollback:
Next owner and exact affected area:
```

Review findings use:

```text
ID:
Severity: P0 | P1 | P2 | P3
Evidence: file:line and observed behaviour
Affected area:
Required fix:
Verification:
Disposition: OPEN | FIXED | ACCEPTED_RISK | OUT_OF_SCOPE
```

A slice follows `PLAN -> BUILD -> FEEDBACK`. Only accepted findings inside its affected area return to BUILD. A new area requires a new impact map and dispatch.

Phase gate: no P0/P1, no open privacy, security, migration, permission or deployment P2, and one independent human approval.

## Optional per-machine tools

Install once per machine, never per task, and never as application dependencies. Pin to a tag or commit before use.

| Tool | Install (verify the pin first) | Check |
|---|---|---|
| Caveman (Codex) | `npx -y github:JuliusBrussee/caveman#v4.0.1 -- --only codex` | `$caveman status` |
| GStack (Codex) | clone `garrytan/gstack` at a pinned commit, then `./setup --host codex` | `npx skills ls -g -a codex --json` |
| taste-skill (UI work only) | `npx skills add https://github.com/Leonxlnx/taste-skill --skill design-taste-frontend` at a pinned ref | `npx skills ls -g -a codex --json` |

A specialist agent gets one named skill, one owned scope and one handoff.
