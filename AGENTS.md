# Knowvia: start here

Knowvia is the approved public brand and tagline: **Know your cover. Before you need it.**
Coversaath remains the internal repository and legacy code name. Do not expose the legacy name in
new user-facing copy unless the context is explicitly about the codebase.

Updated 07 September 2026. This is the only active product direction.

Read [the viability audit](research/06-viability-audit.md) first: it checks the idea against the live
competition page and says what to change. Then [the product](research/01-product.md),
[customer simulations](research/02-customer-tests.md), [architecture](research/03-architecture.md),
[market and sources](research/04-market-and-sources.md),
[competition audit](research/05-competition-audit.md), then [answers](answers.md).

## The one confident claim

A family should not buy another health policy until it knows what protection already exists and
whether someone else can operate it during an emergency.

## Approved direction, 07 September 2026

An idea-viability audit was run against the live competition page and is recorded in
[research/06-viability-audit.md](research/06-viability-audit.md). Every agent must read it before
answering questions about fit, direction or the ten answers.

The user approved the broader Household Health Treasury direction on 07 September. Coversaath remains
the buying agent and entry point. The Treasury is the long-term household record and planning layer it
creates. The competition pitch still leads with buying insurance, cover reconstruction and the drill.

Audit conclusions all agents should treat as the shared current view:

- The opening, the insight, the five-minute drill, the refusal to recommend before reconstruction, the
  conflict controls, the stop rules and the Product Strategy track are the assets. Keep them.
- The agent, not the adviser, must do document reading, follow-up, tracking, cover reconstruction and
  household planning. Human review is metered and used for licensed recommendation gates, exceptions or
  a customer-requested conversation.
- Voice is the only load-bearing rail. Payments is thin. Logistics has no real role.
- Evidence is the weakest and most fixable area: no parent or knowledge holder has been interviewed, the
  student conversations are undocumented, no workaround has been photographed, and no drill has ever
  been run with a real household.
- The broader Treasury must not become a generic financial-planning app. It begins with health cover,
  voluntary affordability inputs and a clear Household Health Card.

## Working contract for Claude, Cursor, Codex and Grok

- Build the household health insurance buying, planning and support service described in 01-product.md.
- The paid job is helping a household buy the right cover and understand the premium and medical-spend
  consequences. Reconstructing existing cover, verifying the real operator and running the five-minute
  readiness drill are the first half of buying properly, not a separate product placed before it.
- Never present readiness, the drill or the handover as the product on its own. The product is the
  purchase and continuity system built around them.
- Treat a real buying decision as the trigger: renewal notice, workforce entry, family change or planned
  procedure. Workforce entry is one trigger, not the only one.
- The service is funded by disclosed distribution commission through a licensed partner. Employer and
  HRMS distribution is a later channel, not the funding assumption. Do not reintroduce employer-funded
  free support as the payer.
- State the commission conflict openly and keep the controls in 01-product.md section 6. The adviser must
  be permitted and expected to recommend no purchase. Never call a commission-funded recommendation
  independent advice.
- Consent and role-based permission are core mechanics, not a later hardening step. Nothing is collected,
  shared or acted on without the named adult's recorded permission.
- Monthly engagement is neither a goal nor a success metric. The Treasury updates at a renewal, job
  change, family change, planned treatment or a user-requested review.
- Household Health Treasury is now the approved long-term product layer. It contains cover, household
  roles, renewal and disclosure history, voluntary affordability inputs, planned-care cash scenarios and
  the Household Health Card. It is not a general wealth-management product.
- Income, fixed commitments, loans and emergency savings are optional affordability inputs. Credit
  reports, investment holdings and tax records are optional later sources, never default onboarding and
  never needed to explain a policy.
- Assume the proposed integrations work for product design. Do not describe them as built or contracted.
- A human expert is available on exception, at the regulated recommendation gate or when requested.
  The agent does routine reconstruction, chasing and planning. Human minutes per completed decision are
  measured and capped. Costs, adviser capacity and whether the conflict controls hold remain hypotheses.
- Eight current personas were tested in five two-agent pairs: a persona agent and a separate sceptical
  interviewer using GPT-5.6 Terra and Luna. Preserve their questions, responses, contradiction probes
  and independent audits in 02-customer-tests.md. Call them paired AI-simulated interviews, never
  human customer interviews, consented fieldwork or findings from eight real people.
- The earlier eight single-agent scripts, run across five cities, were superseded by this paired rerun.
  Model agreement is not market validation. All agents knew the concept; record priming and generation
  inconsistencies honestly, including reused names and locations.
- Rishav reports speaking with 15 college students in their second or third year. Most could not name
  their family policy and expected relatives to help in an emergency. The exact numerator, raw answers,
  question wording, participant mix and publication consent are not yet documented in this pack.
- This is real user-reported experience, but not independently verified evidence. Do not turn
  "approximately 90%" into an invented count. Do not call it consented fieldwork. Do not say parents
  caused disengagement until paired parent and child interviews test that explanation.
- Ignorance is not demand. Not knowing a policy does not establish that a household will act, share
  records or pay. Keep that distinction visible in every answer.
- Illustrative pricing, handling-time and economics figures are sensitivity examples only. Do not
  present them as evidence that the model works or that it fails.
- Data protection and intermediary structure need qualified legal review. State the exposure; do not
  assert a compliance conclusion in either direction.
- Keep source facts, user-reported experience, simulations, assumptions and proposals distinguishable.
- Use simple English. No em dashes, invented statistics, demographic stereotypes or guaranteed claims.
- Preserve disagreements between AI, adviser, customer and institution. An adviser cannot bind an insurer.
- AI does routine work: reads, checks, calls with permission, tracks, plans and prepares. A human enters
  for licensed advice, ambiguity, exception handling or reassurance. The household approves sharing,
  declarations, borrowing, investment sale and transactions.
- Keep the eight Markdown files consistent. Add sections to them instead of creating more concept files.
- No external publication, submission, outreach, insurance purchase or financial transaction is authorised.

## Using this pack

Local coding tools: open this directory and instruct the tool to read AGENTS.md first.
Chat-only tools: attach all eight Markdown files, or start with 01-product.md and answers.md.
Files do not automatically synchronise to a cloud chat. Upload or connect the folder explicitly.

Paste-ready handoff: "Read AGENTS.md and its seven linked files. Summarise the buying agent, Household
Health Treasury, the voluntary affordability planner, Household Health Card, funding and conflict
controls, consent model, human responsibility and evidence gaps. Do not turn fictional personas into
customer evidence or revive employer-funded support as the payer."

## Recovery

The previous workspace was moved intact to
`/Users/Rishav/Developer/KEN-archive-20260906-nUfpQT/` on 06 September 2026.
It is outside this project's active context. No historical file was permanently erased.
The new pack supersedes The Bill Rehearsal as a standalone product and all older scopes.
The local folder tracks `main` at `https://github.com/rish106-hub/CoverSaath.git`.
Project work has not been committed or pushed. The local MVP uses synthetic data only;
see README.md for implemented features and unbuilt production safeguards.
