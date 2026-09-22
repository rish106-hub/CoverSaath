# Knowvia: start here

Updated 21 September 2026. This file is the working contract for Claude, Codex, Cursor and Grok.
It supersedes every earlier direction in this repository.

**The name is Knowvia.** Public descriptor: *Understand your insurance before you need it.*
Product line: *Know what you have. Know what could go wrong. Know what to do next.*
Coversaath was the internal codename and is retired. Do not use it in any new copy, answer or file.
It survives only inside existing filenames, the Google Doc title and the git remote URL, which are real
artefacts and are left as they are.

## Repo layout

| Path | What it is | Status |
|---|---|---|
| `src/` | The app: `agents/`, `backend/` (database, repositories, services, state), `core/`, `evaluation/`, `integrations/` (email, gnani, pine-labs, sarvam), `models/`, `modules/` (ai-analysis, coverage-analysis, document-intake, insurance-rules), `orchestration/`, `server/`, `shared/`, `ui/` | Live code |
| `tests/` | One test file per code module above, plus `tests/evals/` | Live |
| `scripts/` | `dev.mjs`, `database.mjs`, `orchestration-demo.mjs`, `run-safety-evals.mjs`, `check-architecture.mjs` | Live |
| `working/`, `building/` | The build spec — how the product works, mechanics-level. Led by Codex. | **Authoritative**, rank 3 above |
| `docs/evidence/` | The tracked transcript mirror | **Authoritative**, rank 2 above |
| `docs/strategy/` | `round2-answers.md` (current submission draft) and `answers.md` (superseded) | Mixed, see ranks 5–6 |
| `docs/assets/`, `docs/comms/` | Images, diagrams, wordmarks, external-post drafts | Supporting |
| `research/` | Historical working material, six numbered files | Superseded where it conflicts |
| `.local/`, `dist/` | Runtime DB, build output | Gitignored, not part of the repo |

Root keeps only what tooling and agents expect to find there without a path: `AGENTS.md`, `CLAUDE.md`,
`README.md`, `LICENSE`, `package.json`, `vite.config.js`, `index.html`, `.env.example`.

## Source of truth

Competition rules and product evidence answer different questions. Do not use one as a substitute for the
other. The organiser's current Round 2 email or form decides what must be submitted. The competition website
and terms decide the general rules. The Google Doc **"Coversaath Evidence Pack | Buying the Insurance"**
(title kept as the real artefact name) is the source of truth for the research and current product position.

Order of authority:

1. The organiser's current Round 2 email or submission form, then the competition website and terms, for
   questions, format, deadlines, judging, consent and submission rules.
2. The evidence pack Google Doc for transcripts, research method and the product position.
3. `docs/evidence/coversaath-interview-transcripts.md` — the tracked mirror of the transcripts and method.
4. `working/working.md`, `working/planned-expense.md`, `building/insurance.md` — the **build spec**. These
   define how the product actually works. Written by Codex, 20 September. They win on product mechanics.
5. `working/answer-to-build-map.md` — traceability between the answers and the build spec, and the current
   gap list. Read it before editing either side, so the two do not drift apart again.
6. `docs/strategy/round2-answers.md` — the eight Round 2 answers. These must **describe** the build spec, not a parallel
   product. Reconciled to it on 20 September.
7. Everything in `research/` and `docs/strategy/answers.md` — historical working material, superseded where it conflicts.

Where the build spec and the evidence disagree, the evidence wins and the spec gets fixed. The one live case
of this is permissions: the spec says "one operator plus a read-only parent view", which is the common case,
not the permission model. Per-field and per-viewer stands, because Mrs. Ghosh's rule is evidence.

## Editing contract

- Claude, Codex, Cursor and Grok may edit the repository when the user asks them to.
- Read this file before editing. Preserve unrelated work and inspect the current diff before changing a file.
- Do not commit, push, publish, submit, contact anyone or make a transaction unless the user explicitly asks.
- `working/` and `building/` are the canonical build spec. Add sections to existing files instead of creating
  more concept files unless the user asks for a new file.

## The one confident claim

A family should not buy another health policy until it knows what protection already exists and whether
someone else can operate it during an emergency.

**North Star.** No family should have to understand its health insurance for the first time during a
medical crisis.

**USP.** Knowvia creates a living, source-backed understanding of a household's insurance, then turns
it into the next clear action across purchase, renewal, hospitalisation and claims. It does four things
together: explains what the household has; separates confirmed facts from assumptions; identifies what
could create problems; coordinates the people and institutions needed to resolve them.

It does not predict whether a claim will pass. It produces a claim-readiness assessment showing supporting
evidence, risk signals and unanswered questions.

## Evidence status, corrected

This section replaces every earlier statement in this repository that the evidence is thin, that no parent
has been interviewed, or that the research rests on student conversations.

**Eight consented interviews across six households were conducted between 5 and 8 September 2026.** The user
has confirmed that every respondent consented to being interviewed and to their opinions being used for this
case-competition work. The interviews are transcribed in
`docs/evidence/coversaath-interview-transcripts.md`. One household contributed the adult-child, policyholder
and covered-member perspectives that led to the per-field permission model.

Use interview evidence only where it actually supports an answer. Do not force an interview into every answer.
Keep the claim narrow: these interviews show observed problems and design inputs, not market prevalence.
Unless a respondent separately approved public identification, use the organiser's required anonymised format
in the submitted version. Do not publish raw recordings, full transcripts or contact details.

| # | Respondent | Why the transcript matters |
|---|---|---|
| T1 | Arnab G., 26, product analyst, Gurgaon | Lost ₹80,000 to a ₹1,200 room-rent decision [T1 00:06:15] |
| T2 | "Vikas", 34, hospital insurance-desk executive, Delhi NCR | Six years at the desk plus two at a TPA. Declined payment; interviewed in the hospital cafeteria |
| T3 | S. Ghosh, 58, retired, Kolkata | Login and document friction for the generation that actually holds the policies |
| T4 | Meghna R., 29, Bengaluru | Discovered a ₹2 lakh deductible dead zone live on the call [T4 00:01:34]. "It says here, page fourteen" [T4 00:06:06] |
| T5 | Sourav D., 31, Kolkata | Seven lost hours, 2 a.m. to 9 a.m. One button maximum. "The rest they should already know" [T5 00:04:36] |
| T6 | Nikhil T., 33, Pune | 17-day portability window missed. "Nothing happens, that's the thing" [T6 00:01:26] |
| T7 | Faizan A., 27, Mumbai | "Everyone gives me the counterfactual. I want the next step." [T7 00:05:41] |
| T8 | Mrs. R. Ghosh, 55, Kolkata | Conducted entirely in Bengali. She requested the session. "The number yes, the reason no" [T8 00:02:52] |

Hard numbers that belong in the answers: **7 of 19 collected documents had a schedule field that did not
match the family's own account of it.** One sister's date of birth was recorded six years wrong.

**Binding conduct rule.** Consent to use an interview for the competition does not cancel a narrower
confidentiality request. Mrs. Ghosh asked that the contents of her session not reach her son. Any internal
sharing, derived document, demo or submission must preserve that separation and use only the agreed,
anonymised insight.

### What the evidence does not establish

- Prevalence. Respondents came through friends, family and their acquaintances. Directional, not a study.
- Willingness to pay in a calm month. Arnab would pay ₹2–3k a year but would not sign up when nothing is
  wrong, "because when there's no problem you don't remember it" [T1 00:16:03].
- Portability in practice. No respondent has actually been through it.
- Government or state-scheme households. Every respondent is privately insured. Say so when presenting.
- How people react to an honest no. Untested, and "admit first" depends on it being survivable.

### Who the user is

Any adult in a household that holds health cover. Respondents were 26, 27, 29, 31, 33, 34, 55 and 58.

Do not describe the activation user as a student, a college second- or third-year, an 18-to-24-year-old or
a workforce entrant. That framing came from an earlier undocumented claim and is retired. Workforce entry
is one trigger among renewal, job change, family change and planned treatment. It is not the entry point.

### The 15-student claim is retired

Earlier files recorded "15 college students" as the firsthand research. That claim was never documented
with count, wording, raw answers or consent, and it has been superseded by the eight consented interviews.
Do not repeat it, cite it, or reconstruct a number from "approximately 90%".

### The five-minute readiness drill is retired

The mandatory drill, the pass/fail preparedness test and the separate physical card are all retired. The
evidence killed them: Sourav will not complete a flow at 2 a.m. [T5 00:04:22] and nobody signs up for a
product that tests them. Preparedness is an outcome of accumulated context, not a compulsory exercise.
Historical drill references in `research/` are marked as retired and must not be treated as live design.

### The AI-simulated personas are not evidence

`research/02-customer-tests.md` contains paired AI-simulated interviews run with GPT-5.6 Terra and Luna.
Call them paired AI-simulated interviews. Never human customer interviews, consented fieldwork or findings
from real people. They are working material. They must not appear in a submission as customer evidence and
must never be placed alongside the eight real transcripts as if they were the same kind of thing.

## Rail position

The Ken supplies three rails: Gnani (voice), Pine Labs (payments), Delhivery (logistics and maps).

- **Gnani, voice.** The access rail. It reaches the person who holds the document and the permission — the
  parent, the relative, the household operator — when that person will not upload or type. S. Ghosh and
  Mrs. Ghosh are the case. Known ceilings: maximum three languages per agent, maximum 100 FAQ entries,
  no documented bot-to-human warm transfer (Agent Chaining is bot to bot), no multi-party or conference
  call, post-call webhook only with no mid-call event stream. State these ceilings; do not design past them
  silently.
- **Pine Labs, payments and authorisation.** The differentiated event rail. Hosted checkout, payment status,
  refunds and reconciliation exist. Card pre-authorisation with hold-and-capture, UPI Reserve Pay and split
  settlement are documented at `api.pluralpay.in` and are the interesting depth. **eNACH and NACH are not
  named in Pine Labs documentation. Do not claim them.** No hold-expiry window is documented; that is a real
  and citable gap.
- **Delhivery, logistics and maps.** Useful but not load-bearing. Address validation, standardisation,
  geocoding and routing help the family reach a confirmed hospital insurance desk. Do not invent a parcel
  workflow to feature the rail.

**Pine Labs is the final payment step only.** It is invoked after a human approves one of exactly two
outcomes: renew an existing policy, or purchase a selected new personal policy. It is **not** the discovery
engine, policy reader, underwriting engine or emergency-payment system, and **it does not reserve a hospital
deposit**. The pre-authorisation hold was considered and withdrawn: no hold-expiry window is documented, no
hospital merchant eligibility is verified, and a payment instrument inside an emergency flow conflicts with
"admit first, optimise later".

**Knowvia's web or app workspace is the main product surface.** WhatsApp is an optional companion for
document forwarding, reminders, written updates and short questions. It is not one of the three rails and
not a second source of truth. Gnani is the optional voice access route for people who prefer speaking.

**Proposed acquisition and integration model.** Knowvia remains a D2C household product. Employer HRMS
and insurance platforms are proposed entry points, not replacements for Knowvia. HRMS is useful when a
person joins, changes benefits or needs to discover group cover. It is not assumed to be the place someone
remembers in a health event. A platform or adviser such as Ditto is a proposed trust-led entry point after
a personal-policy purchase, renewal or support interaction. It can introduce the household record and
surface it later; it is not a claimed partner or a proven integration. The household works in Knowvia.
This is a product hypothesis from the ICP discussion, not a conclusion established by the eight interviews.

**Rail dependency.** The product's core dependency is the proposed Insurance Confirmation Rail because it
turns scattered insurer, TPA and hospital responses into dated, case-specific status. Among the three supplied
rails, Gnani is the main access rail. Pine Labs is a final transaction rail and Delhivery is a supporting
location rail. Do not pretend that a supplied rail performs the confirmation function when it does not.

## The workflow, in one place

This is the product. Everything else serves it.

- **No dashboard.** The first screen is a **household matrix**: person, policies found, immediate issue,
  evidence status. Each row opens covered facts, cost exposure, conditions that matter, next action, source
  pages.
- **Two entry routes only.** `Plan an expense` and `Find and buy personal health cover`. **Renewal is not a
  third mode** — it is a time-sensitive case inside either one.
- **Three ways into the product.** Direct D2C sign-up is always available. HRMS can introduce the group-cover
  case at joining or benefit change. An insurance platform or adviser can introduce the personal-policy case
  after purchase, renewal or a support interaction. Those two integrations are proposed, not contracted.
- **Source pack requested by name** before analysis. Never invent a benefit. A clause proves the rule; the
  enrolment schedule proves a named person gets that rule; a dated network result proves network status; a
  hospital estimate proves the cost input.
- **Workers run in parallel**, each with one job and one allowed output type: person and enrolment,
  benefit-rule, hospital-network, estimate, benefit-application, cash-exposure, evidence.
- **Six output states, always one of:** Proven, Calculated, Reported, Dynamic, Unknown, Conflicting. Every
  field keeps source document, version, page, clause, confidence, effective date, and whether a human
  corrected it.
- **Decision first, proof on demand.** Four layers: Decision, Financial, Evidence, Research. `Why` expands
  every clause and calculation. Never force someone to read the reasoning to get the answer.
- **Evidence hierarchy:** official wording and schedules > dated institutional confirmation > hospital
  estimate > regulatory disclosure > public complaint trends. Reddit and settlement ratios stay in the
  research layer, never above policy evidence.
- **Continuity is a first-class trigger.** Read the exact dependent definition; do not assume an age-26 rule.
  Raise deadline cases at 120, 90, 60 and 30 days.
- **Renewal is a policy diff, not a price comparison.** Output: renew / renew and add cover / port / seek
  clarification / do not lapse while comparing.
- **Emergency access dials a human support operator. Directly.** No voice agent, no IVR, no bot triage, **no
  Gnani in this path at all.** The operator gets a permissioned read-only Emergency Case Brief and already
  has the file open. They handle insurance and coordination, not clinical advice. The AI only retrieves,
  structures and displays. Talking to the AI is a **separate path** the user may choose at any time; it is
  never in front of the call. Admit first, optimise later.
- **Do not make recall a false product promise.** In a health event, a household may first call its insurer,
  TPA, hospital desk or the adviser who sold the policy. Knowvia does not claim it will replace that habit.
  Its record makes whichever approved route the household takes more prepared, and a partner entry point can
  surface the same permissioned brief where the customer already seeks help.
- **Seniors: default out of the driver's seat, never locked out.** The operator model is a default, not a
  ceiling. A senior who wants to open the case, ask, supply a document, correct a fact or act on their own
  policy can do so, in their own language. What we do not do is hand full agency by default and expect them
  to run an insurance workflow alone.
- **Payment last.** Only after approval, and the interface must keep offering `do not buy now`,
  `renew while comparing` and `seek clarification first`.
- **Never** sum every sum insured into one "guaranteed family cover" number. Never report someone as covered
  because they are eligible — check they are enrolled. Never tell a user to omit health history. Never call a
  pre-authorisation delay a claim rejection.

## Fourth rail

An **Insurance Confirmation Rail**, built by **Medi Assist**. Policy explanations, hospital information,
insurer emails, TPA replies and pre-authorisation updates live in different systems. Knowvia can organise
them; it cannot make them authoritative. The rail returns dated, case-specific status: active policy and
member status, latest endorsement, confirmed TPA, hospital network status, required documents,
pre-authorisation status, claim status, pending institutional action, responsible team and escalation route.

It confirms status. It does not guarantee approval.

Inside that rail, the hardest unsolved piece is **delegated household authority**: proof that a named adult
authorised a named person or agent to do a named thing, for a limited purpose and time, revocably. Setu's
Account Aggregator consent objects are the closest existing pattern and are worth citing as prior art. They
do not cover health records or family delegation today.

## Working contract

- Build the service described in the workflow section above and specified in `working/working.md`,
  `working/planned-expense.md` and `building/insurance.md`. `research/01-product.md` is superseded
  historical material and must not be used as a build reference.
- Reconstruct existing cover before recommending anything. The refusal to recommend before reconstruction
  is an asset. Keep it.
- Treat a real event as the trigger: purchase, renewal, job change, family change or planned treatment.
- The agent does routine work: reads, checks, calls with permission, tracks, plans and prepares. A human
  enters for licensed advice, ambiguity, exception handling or reassurance. The household approves sharing,
  declarations, payment and any transaction.
- Consent and role-based permission are core mechanics, not later hardening. Permissions are **per-field
  and per-viewer**, with a member-approved emergency override. That is Mrs. Ghosh's rule, not a preference.
- The service is funded by disclosed distribution commission through a licensed partner. State the conflict
  openly. The adviser must be permitted and expected to recommend no purchase. Never call a
  commission-funded recommendation independent advice.
- Every output gives the next step. Faizan's rule: "Everyone gives me the counterfactual. I want the next
  step." A screen that only explains what the household should have done is not finished.
- **Admit first, optimise later.** In an emergency, administrative analysis never delays treatment.
- Monthly engagement is neither a goal nor a success metric. The record updates at a real event.
- Assume the proposed integrations work for product design. Do not describe them as built or contracted.
- Illustrative pricing, handling-time and economics figures are sensitivity examples only.
- Data protection and intermediary structure need qualified legal review. State the exposure. Do not assert
  a compliance conclusion in either direction.
- Keep source facts, user-reported experience, simulations, assumptions and proposals distinguishable.
- Use simple English. No em dashes, invented statistics, demographic stereotypes or guaranteed claims.
- Preserve disagreements between AI, adviser, customer and institution. An adviser cannot bind an insurer.
- Ignorance is not demand. Not knowing a policy does not establish that a household will act, share records
  or pay. Keep that distinction visible in every answer.
- Interview material may be used to prepare the competition submission within the consent boundaries above.
  No actual submission, public post, outreach, insurance purchase or financial transaction is authorised
  unless the user explicitly asks.

## Competition facts

The Ken Case Competition 2026, "The Great Rewiring". Opening **"Buying the insurance"**, Product Strategy
track. Do not attach an opening number because the number has changed across organiser pages. Round 2 is eight
design questions, due **Friday 25 September 2026, 11:59 p.m. IST** according to the organiser's Round 2 email.
Finale: 10 October, subject to the organiser's latest communication.

Three grading mechanics that decide this round:

1. Answers are graded relative to other teams in the same opening. The organiser's published Round 1 page
   showed "Buying the insurance" at 3.92% of submissions.
2. Answers are graded against The Ken's internal frontier-AI baseline. Anything a model could have written
   without this research scores nothing.
3. AI chat logs are collected to rank human versus machine contribution.

These three mechanics came from the organiser's Round 2 email. The interviews are one advantage, not the whole
submission. The answers also need rail-documentation evidence, a coherent state model, explicit product limits
and a feasible human operating model. Cite interviews by anonymised respondent label and timestamp where they
directly support a claim.

## Recovery

The previous workspace was moved intact to `/Users/Rishav/Developer/KEN-archive-20260906-nUfpQT/` on
06 September 2026. No historical file was permanently erased. The local folder tracks `main` at
`https://github.com/rish106-hub/CoverSaath.git`. The local MVP uses synthetic data only; see README.md.
