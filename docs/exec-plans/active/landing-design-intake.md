# Intake: Knowvia landing and onboarding design brief

CERT = READY for CP1 to CP4. Task class: S1. No application code changes.

The full intake (objective, decisions, scope, non-goals, non-negotiables, acceptance criteria, metrics,
capability matrix, risks and rollback) is kept with the design work, at the user's request:
[docs/design/00-requirements-and-framework.md](../../design/00-requirements-and-framework.md).

Graph findings: `repomap map . --json` returned 161 files and 963 call edges. The only product surface this
brief touches is the UI module (`src/ui/app.js`, `src/ui/styles.css`, `src/ui/components/household-workspace.js`),
and only as a read-only reference for tokens and the household-matrix handover. `repomap impact --changed`
reports no code change.
