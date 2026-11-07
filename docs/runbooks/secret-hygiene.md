# Runbook: secret hygiene and history purge plan (S1)

Prepared 2026-11-06 by a read-only inspection of the main checkout. No history was rewritten, nothing was rotated, and no secret value is recorded here (only key names and lengths).

## Findings

| Item | Result |
|---|---|
| `.claude/launch.json` | Untracked. The `api-journey` configuration passes literal values on its command line: `KNOWVIA_BOOTSTRAP_TOKEN` (48 characters), the document encryption key variable (44 characters, the size of a base64 32-byte key) and absolute local paths. Gitleaks flags two `generic-api-key` lines (17 and 18) in the working copy. The `dev` configuration holds no values. |
| `.mcp.json` | Untracked. One server, the hosted Supabase MCP (`https://mcp.supabase.com/mcp`) with `project_ref` and `features` query parameters, no headers and no environment. No credential. The project ref is an identifier already named in ADR 0011. |
| History | Neither path was ever committed on any ref: `git log --all` for both is empty, there are no stashes, and `gitleaks git .` over all 528 commits reports 0 findings (config `.gitleaks.toml`, allowlists synthetic fixtures only). So there is nothing to purge from history today. |
| Exposure risk | In the main checkout (branch `chore/repo-hygiene`) the uncommitted `.gitignore` change **removes** the lines that ignore `.claude/launch.json`, `.claude/settings.local.json`, `.claude/worktrees/`, `.mcp.json`, `.vscode/`, `.idea/`, `*.log` and the migration test-scratch directory, and a line was mangled to `pdocs/exec-plans/active/handoff-codex.md`. With that diff, `git status` lists `.claude/launch.json` and `.mcp.json` as untracked and a `git add -A` would stage the token-bearing file. `main` still has the ignore lines (this worktree inherits them). |
| Separate exposure | The Supabase `postgres` password was pasted into chat twice (ADR 0011 D9). That is outside git and is handled by `docs/runbooks/db-roles.md`. |

## Do now (no history rewrite needed)

1. In the main checkout, restore the dropped `.gitignore` lines (keep the owner's new `.gstack/`, `.vercel` and `.env*` entries) and fix the `pdocs/` typo, then confirm `git check-ignore -v .claude/launch.json .mcp.json` prints both. This is the one change that prevents a leak.
2. Remove literal values from `.claude/launch.json`: start the journey server with `node --env-file=.env.local src/server/server.js` (as `npm run dev` does) so the file carries no secrets.
3. Decide whether the bootstrap token and the document encryption key in that file are the same as the Fly-staged ones. If they are, rotate: new `KNOWVIA_BOOTSTRAP_TOKEN` with `fly secrets set`. Rotating `DOCUMENT_ENCRYPTION_KEY_BASE64` is not a simple swap (stored document bytes are sealed with it, ADR 0013): with synthetic data only, either re-create the data or re-encrypt before switching. If they are distinct local-only values, no rotation is needed.
4. Keep `gitleaks git .` (and `gitleaks dir .` for the working tree) in the pre-merge checks. No CI workflow runs gitleaks today (`.github` has no reference); adding one is a follow-up, not done here.

## Purge plan (only if a secret is ever found in history)

This is a plan, not an instruction to run. A history rewrite needs explicit owner approval (AGENTS.md).

1. **Rotate first.** Treat any committed secret as public: rotate or revoke it at the provider, then purge. Purging does not make a leaked secret safe.
2. Work on a fresh mirror clone, never the working checkout: `git clone --mirror <remote> purge.git && cd purge.git`.
3. Install `git-filter-repo`. Remove a whole file from all history: `git filter-repo --path .claude/launch.json --invert-paths`. For a value inside files that must stay, use `--replace-text` with an expressions file kept outside the repo (the file itself holds the secret, so shred it afterwards).
4. Verify on the rewritten mirror: `gitleaks git . --redact` returns 0 findings, `git log --all -- <path>` is empty, and `git rev-list --all --count` is the expected number.
5. Owner approval, then force-push all refs: `git push --force --mirror`. Branch protection must allow it temporarily; restore it after.
6. Ask GitHub Support to drop cached views and dangling objects (pull-request refs `refs/pull/*` and forks keep the old objects otherwise), and tell every collaborator to re-clone. Old clones, worktrees under `.worktrees`, and stashes still hold the old objects; delete them.
7. Record the event (date, what, rotated) in `docs/iterations/LATEST.md`.
