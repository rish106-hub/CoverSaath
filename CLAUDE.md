# CLAUDE.md

**Read [AGENTS.md](AGENTS.md) first and in full. It is the working contract for this repository.**

Short version, so nothing drifts:

- The product is **Knowvia**. Coversaath is the retired internal codename. Do not use it in new copy.
- The **Google Doc "Coversaath Evidence Pack | Buying the Insurance"** is the source of truth. Where a file
  here disagrees with it, the file is wrong.
- The evidence is **eight consented interviews, 5 to 8 September 2026**, transcribed in
  [docs/evidence/coversaath-interview-transcripts.md](docs/evidence/coversaath-interview-transcripts.md).
  Cite them by respondent and timestamp. Every Round 2 answer must.
- **Retired and not to be revived:** the "15 college students" claim, the five-minute readiness drill, the
  separate physical card, the 18-to-24 student ICP, and any statement that no parent has been interviewed
  or that the evidence is the weakest area.
- `research/02-customer-tests.md` is **AI-simulated**, not customer evidence. Never place it beside the real
  transcripts as the same kind of thing.
- **The build spec is [working/working.md](working/working.md),
  [working/planned-expense.md](working/planned-expense.md) and
  [building/insurance.md](building/insurance.md).** These define how the product works and win on mechanics.
  Two entry routes only (`Plan an expense`, `Find and buy personal health cover`) — renewal is not a third
  mode. Six output states: Proven / Calculated / Reported / Dynamic / Unknown / Conflicting. Emergency access
  dials a human support operator directly — no voice agent, no Gnani in that path; AI chat is a separate
  path, never in front of the call. Pine Labs is the final payment step only and does **not** reserve a
  hospital deposit.
- [working/answer-to-build-map.md](working/answer-to-build-map.md) traces each answer to the build component
  behind it and lists the current gaps. Check it before editing either side.
- The Round 2 answers live in [round2-answers.md](docs/strategy/round2-answers.md) and must describe that build spec, not a
  parallel product. `docs/strategy/answers.md` and `research/` are historical working material, superseded where they
  conflict.
- **No rail is "the only load-bearing rail."** The load-bearing thing is the permissioned, source-linked
  cover record. WhatsApp is the main working channel and is not one of The Ken's three rails. Say so plainly.
- Permissions are **per-field and per-viewer** with a member-approved emergency override. The build spec's
  "one operator plus read-only parent view" is the common case, not the permission model. Mrs. Ghosh's rule
  is evidence and outranks it.
- Mrs. Ghosh (T8) asked that her session contents not reach her son. Honour that in every derived document.
- No external publication, submission, outreach, purchase or financial transaction is authorised.

Editing right now: **Claude makes the file edits. Codex leads direction and does not commit in this window.**
