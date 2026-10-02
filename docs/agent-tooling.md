# Agent tooling

Approved tools for coding agents. These are not application dependencies.

| Tool | Version | Use | How | Notes |
|---|---|---|---|---|
| repomap (`@sylphx/repomap`) | 1.5.0 | Repository map and change impact (MAP gate) | `npx -y @sylphx/repomap@1.5.0 map . --json > .local/repomap/map.json`; `npx -y @sylphx/repomap@1.5.0 impact <file>`; `... impact --changed` | MIT, no install scripts or dependencies. **Do not run `setup`**: it edits global Claude Code, Codex, Cursor and VS Code configuration. Output stays in ignored `.local/`. |

Removal: nothing is installed in the repository; delete `.local/repomap/`.
