# Coversaath: start here

Updated 20 September 2026. This file is the working contract for Claude, Codex, Cursor and Grok.
It supersedes every earlier direction in this repository.

**The name is Coversaath.** Public descriptor: *Understand your insurance before you need it.*
Product line: *Know what you have. Know what could go wrong. Know what to do next.*
Knowvia was an intermediate working name and has been retired. Do not reintroduce it.

## Source of truth

The Google Doc **"Coversaath Evidence Pack | Buying the Insurance"** is the source of truth for the
Round 2 position. Where any file in this repository disagrees with that doc, the doc wins and the file
is wrong.

Order of authority:

1. The evidence pack Google Doc (transcripts, method, Tab 11 answers).
2. `docs/evidence/coversaath-interview-transcripts.md` — the tracked mirror of the transcripts and method.
3. `round2_answers.md` — the eight Round 2 answers, expanded from Tab 11 with rail detail.
4. Everything in `research/` and `answers.md` — historical working material, superseded where it conflicts.

## Who edits what, 20 September 2026

- **Claude** makes the main file edits in this repository.
- **Codex** leads direction and review. Codex should not commit file edits in this window. Commit `c2f4b9e`
  (20 September, 12:30) was Codex.
- Do not create new concept files. Add sections to the files that already exist.

## The one confident claim

A family should not buy another health policy until it knows what protection already exists and whether
someone else can operate it during an emergency.

**North Star.** No family should have to understand its health insurance for the first time during a
medical crisis.

**USP.** Coversaath creates a living, source-backed understanding of a household's insurance, then turns
it into the next clear action across purchase, renewal, hospitalisation and claims. It does four things
together: explains what the household has; separates confirmed facts from assumptions; identifies what
could create problems; coordinates the people and institutions needed to resolve them.

It does not predict whether a claim will pass. It produces a claim-readiness assessment showing supporting
evidence, risk signals and unanswered questions.

## Evidence status, corrected

This section replaces every earlier statement in this repository that the evidence is thin, that no parent
has been interviewed, or that the research rests on student conversations.

**Eight consented interviews were conducted between 5 and 8 September 2026.** They are transcribed in
`docs/evidence/coversaath-interview-transcripts.md`. Every Round 2 answer must cite them.

| # | Respondent | Why the transcript matters |
|---|---|---|
| T1 | Arnab G., 26, product analyst, Gurgaon | Lost ₹80,000 to a ₹1,200 room-rent decision [T1 00:06:15] |
| T2 | "Vikas", 34, hospital insurance-desk executive, Delhi NCR | Six years at the desk plus two at a TPA. Declined payment; interviewed in the hospital cafeteria |
| T3 | S. Ghosh, 58, retired, Kolkata | Login and document friction for the generation that actually holds the policies |
| T4 | Meghna R., 29, Bengaluru | Discovered a ₹2 lakh deductible dead zone live on the call [T4 00:01:43]. "It says here, page fourteen" [T4 00:06:06] |
| T5 | Sourav D., 31, Kolkata | Seven lost hours, 2 a.m. to 9 a.m. One button maximum. "The rest they should already know" [T5 00:04:36] |
| T6 | Nikhil T., 33, Pune | 17-day portability window missed. "Nothing happens, that's the thing" [T6 00:01:39] |
| T7 | Faizan A., 27, Mumbai | "Everyone gives me the counterfactual. I want the next step." [T7 00:05:41] |
| T8 | Mrs. R. Ghosh, 55, Kolkata | Conducted entirely in Bengali. She requested the session. "The number yes, the reason no" [T4/T8 00:02:52] |

Hard numbers that belong in the answers: **7 of 19 collected documents had a schedule field that did not
match the family's own account of it.** One sister's date of birth was recorded six years wrong.

**Binding conduct rule.** Mrs. Ghosh asked that the contents of her session not reach her son. That was
agreed and has been honoured. Any derived document, demo or submission must preserve that redaction.

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

**WhatsApp is the main working interface, and it is not one of the three rails.** Say this plainly rather
than pretending a rail covers it. WhatsApp is where the household already is; Gnani is how the product
reaches the people WhatsApp cannot. They are complements, and the answer must explain what each one does
that the other cannot. See `round2_answers.md` answer 6.

**Do not call any single rail "the only load-bearing rail".** The load-bearing thing is the permissioned,
source-linked cover record. The rails are how it reaches people, money and places.

## Fourth rail

An **Insurance Confirmation Rail**, built by **Medi Assist**. Policy explanations, hospital information,
insurer emails, TPA replies and pre-authorisation updates live in different systems. Coversaath can organise
them; it cannot make them authoritative. The rail returns dated, case-specific status: active policy and
member status, latest endorsement, confirmed TPA, hospital network status, required documents,
pre-authorisation status, claim status, pending institutional action, responsible team and escalation route.

It confirms status. It does not guarantee approval.

Inside that rail, the hardest unsolved piece is **delegated household authority**: proof that a named adult
authorised a named person or agent to do a named thing, for a limited purpose and time, revocably. Setu's
Account Aggregator consent objects are the closest existing pattern and are worth citing as prior art. They
do not cover health records or family delegation today.

## Working contract

- Build the household health insurance understanding, buying and support service described in
  `research/01-product.md`, as corrected by this file.
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
- No external publication, submission, outreach, insurance purchase or financial transaction is authorised.

## Competition facts

The Ken Case Competition 2026, "The Great Rewiring". Opening #14, "Buying the insurance". Product Strategy
track. Round 2 is eight design questions, due **Friday 25 September 2026, 11:59 p.m. IST**. Finale 10 October.

Three grading mechanics that decide this round:

1. Answers are graded relative to other teams in the same opening. Opening #14 is 3.92% of submissions.
2. Answers are graded against The Ken's internal frontier-AI baseline. Anything a model could have written
   without this research scores nothing.
3. AI chat logs are collected to rank human versus machine contribution.

Mechanics 2 and 3 are why the eight transcripts are the whole advantage. A frontier model cannot invent
Vikas at a hospital desk or Mrs. Ghosh in Bengali. Cite them by respondent and timestamp.

## Recovery

The previous workspace was moved intact to `/Users/Rishav/Developer/KEN-archive-20260906-nUfpQT/` on
06 September 2026. No historical file was permanently erased. The local folder tracks `main` at
`https://github.com/rish106-hub/CoverSaath.git`. The local MVP uses synthetic data only; see README.md.
