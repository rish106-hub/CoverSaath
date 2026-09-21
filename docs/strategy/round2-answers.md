# Knowvia: Round 2 answers

Updated 20 September 2026. These are the eight Round 2 answers for The Ken Case Competition, opening #14,
"Buying the insurance", Product Strategy track.

The **"Coversaath Evidence Pack" Google Doc** is the source of truth for the position. This file expands its
Tab 11 answers with rail detail and evidence citations. `answers.md` and `research/` hold earlier working
material and are superseded wherever they conflict.

Evidence citations use respondent and timestamp from
[docs/evidence/coversaath-interview-transcripts.md](../evidence/coversaath-interview-transcripts.md).

No submission has been made. Integrations below are proposed uses based on public documentation. No
partnership, production connection or vendor-platform test is claimed.

## Revision log

| Version | Change | Reason |
|---|---|---|
| 0.1 | Rebuilt all eight answers around the North Star and USP. | Disclosure history, claim correspondence, admission briefs and the household record are capabilities inside the product, not the product itself. |
| 0.2 | Changed autonomy from L4 to L3. | Insurers, TPAs, hospitals and licensed advisers still control important outcomes. |
| 0.3 | Replaced a broad outcome promise with a testable decision brief. | "The household understands" was too soft to judge. |
| 0.4 | Retired the mandatory readiness drill and the separate physical card. | Sourav will not complete a flow at 2 a.m. [T5 00:04:22]. Nobody signs up for a product that tests them. |
| 0.5 | Reframed around per-person cover interaction and the admission-morning cash question. | Arnab lost ₹80,000 to a ₹1,200 room-rent decision [T1 00:06:15]. |
| 0.6 | Standardised the public name as **Knowvia**. Retired Coversaath to an internal codename. | The earlier drafts mixed both names. |
| 0.7 | Fourth rail returned to **Medi Assist / Insurance Confirmation Rail**. Delegated household authority folded in as the hard part to build inside it. | Matches the evidence pack. A confirmation rail is the thing respondents actually lacked; authority is a component of it, not a separate ask. |
| 0.8 | Named **WhatsApp as the main working interface** and Gnani voice as the reach rail, with an explicit comparison of what each does that the other cannot. | The research shows two different populations: the person who signs up, and the people who hold the documents. |
| 0.9 | Wired all eight transcripts into the answers and removed every statement that human evidence is the weakest area. | Eight consented interviews were conducted 5 to 8 September 2026. Earlier files said none existed. |
| 1.0 | Reconciled the answers to the build spec in `working/` and `building/`. Four working modes became **two entry routes**. Evidence labels became **Proven / Calculated / Reported / Dynamic / Unknown / Conflicting**. Pine Labs narrowed to the payment step and the hospital-deposit hold was **withdrawn**. Emergency access became a **call to a live expert**, not a screen. | The answers must describe the product actually being built, not a parallel one. |
| 1.1 | Rewrote the opening and accountable outcome in plain language. | The product is deep. The explanation should not sound like a compliance memo. |

## Current position

Health insurance is sold as one number. It is used as a stack of rules: who is actually enrolled, which
version applies, what room is chosen, whether a waiting period is over, which hospital is in network, and
who answers the phone when something goes wrong. Families usually discover that stack when they are already
under pressure.

**North Star.** No family should have to understand its health insurance for the first time during a
medical crisis.

**What Knowvia does.** It turns policies, schedules, renewals, hospital estimates and insurer messages into
one live answer for each person: **what cover do we have, what could stop it, what might we have to pay,
and what do we do next?**

That answer stays useful from a planned expense to a renewal, a job change, a new policy purchase or a
claim problem. The product does not make a family read another dashboard. It reads the documents, applies
the rules to the right person and event, shows the evidence when asked, and keeps the next action moving.

Knowvia does not promise a claim will be approved. It tells the household what supports the claim, what may
create trouble, what is still unknown, and who needs to answer next.

### What the research established

Eight consented interviews, 5 to 8 September 2026, transcribed in full. Respondents were 26, 27, 29, 31,
33, 34, 55 and 58. Two parents. One hospital insurance-desk executive with six years at the desk and two at
a TPA, interviewed in person, who declined payment.

The number that anchors the product: **7 of 19 collected documents had a schedule field that did not match
the family's own account of it.** One sister's date of birth was six years wrong on a live policy schedule.

The interviews gave us three non-negotiable product rules:

- Arnab's family lost ₹80,000 after choosing a room ₹1,200 above the policy cap. The screen must show the
  family's number, not a definition of room-rent limits [T1 00:06:15].
- Meghna found a ₹2 lakh gap between her base policy and top-up. Policies must be checked together, not one
  at a time [T4 00:01:43].
- Nikhil missed a portability window for his mother's cover. A deadline is part of the answer, not a later
  reminder [T6 00:01:16].

The proposed system follows the same logic. Separate workers read the person, policy terms, hospital and
money question in parallel. A rules layer checks the conditions. The main agent turns their work into one
answer with a source, owner and deadline. A human takes over for emergencies, regulated advice and hard
institutional disputes. This is how the product gets more useful with technology without pretending that AI
can approve a claim.

Shilpa Arora's detailed feedback on the **earlier** architecture is recorded in Question 5. The current
design changes because of that feedback: it reads treatment-specific caps, retrieves corporate cover before
admission, and records which institution owns each live answer.

Directional, not a prevalence study. Respondents came through friends, family and their acquaintances.
Every one of them is privately insured; nobody is on a state scheme. Stated wherever these findings appear.

The reported opening share is 3.92%, the third-lowest share of submissions. That is a competition signal,
not customer evidence.

## 1. What is the outcome your agent is accountable for?

> **For every health-insurance decision, Knowvia is accountable for giving the family one clear answer:
> what cover applies to this person and event, what could block it, what they may need to pay, and what
> they should do next.**

A case is complete only when every important question has one of three endings: it is answered from a
source, clearly marked unknown, or owned by a named person or institution with a deadline. No important
question gets buried inside a long policy summary.

The answer is always personal. Knowvia does not add every sum insured and call it family protection. It
checks who is enrolled, which policy version applies, how the base policy and top-up work together, what
the room rule or co-pay changes, and what money might be needed before an insurer or TPA responds.

**Why this outcome matters.** The problem is not that families cannot find definitions online. The problem
is that they cannot connect a clause to their own person, hospital, timing and bill.

**Room-rent sub-limit and proportionate deduction.** Arnab's father's policy carried a ₹10 lakh sum insured
and a room-rent cap of one percent per day — ₹10,000. The family took a single AC room at ₹11,200. Because
the room breached the cap, the insurer applied a **proportionate deduction across the entire bill**: the
surgeon's fee, the OT charges, everything, scaled by the same ratio. "A twelve-hundred rupee mistake, an
eighty-thousand rupee loss" [T1 00:06:15]. A shared room at ₹7,000 was available and nobody mentioned it.
When the hospital desk told him "proportionate deduction lagega", he understood, in his words, "not one
word" [T1 00:05:43]. That is not a customer who needed a cheaper policy. It is a customer who needed one
number, on one morning.

He then searched for it, and produced the clearest statement of the problem in the entire study:

> "On the internet you get the definition. You don't get your number." [T1 00:09:44]

**Deductible interaction and the dead zone.** Meghna was three months into buying a 20L top-up with a 10L
deductible sitting on an 8L base. Between ₹8 lakh and ₹10 lakh, neither policy pays. A **₹2 lakh dead zone**,
inside a product she was about to spend ₹9,400 a year on, discovered live on the call [T4 00:01:43].

**Accrued waiting-period credit on portability.** Nikhil's mother was covered from day one for hypertension
and pre-diabetes under his employer's group policy, because group cover typically does not apply
pre-existing-disease waiting periods. At employer exit he had **seventeen days** to port that cover to a
retail policy with the same insurer and **carry the accrued waiting-period credit** — four years of it. He
did not know the right existed. The retail quote he got instead: ₹54,000 a year for ₹5 lakh, with a
three-year waiting period on the two conditions most likely to occur. He did not buy it, and says that was
the rational call, "which is the worst part" [T6 00:02:43]. Had he ported: roughly ₹28,000–32,000 a year
with credit carried. His mother has been uninsured since, at 62. His own estimate of the cost of not knowing
one thing: **₹2–8 lakh** [T6 00:03:47].

His summary of why a definition was not enough: "I knew the words. I did not understand the consequence.
Those are different things" [T6 00:01:16].

None of these is solved by a generic policy explainer. The family needed a direct answer for their own case
before the moment became expensive. That is the job Knowvia owns.

Knowvia is not accountable for claim approval. It cannot bind an insurer, decide underwriting, select
treatment, guarantee cashless approval or promise settlement. In an emergency, it does not delay care. It
gets the available record in front of a human support operator and keeps the insurance work moving after
admission.

**What this is worth, from the same respondent.** Asked what would have happened if someone had said,
"your room-rent cap is ₹10,000, do not take the single AC room", Arnab said, "I'd pay for that. Genuinely."
[T1 00:15:31]. This is not proof that people will pay for Knowvia in a calm month. Arnab also said he might
not sign up when nothing is wrong [T1 00:16:03]. It is proof that the valuable unit is a clear answer at the
right moment, not another insurance dashboard.

**The output rule, taken verbatim from a respondent.** Faizan: "Everyone gives me the counterfactual. I want
the next step." [T7 00:05:41]. Every screen will be tempted to explain what the household should have done.
None of them is allowed to stop there.

## 2. What level of autonomy does your agent have?

> **L3: acts independently within household-approved limits.**

After the named adults set the purpose, permissions and communication limits, Knowvia can act without
asking again inside those limits. It can:

- Read policies, schedules, endorsements and benefit documents.
- Reconstruct the household's available cover, per person.
- Identify missing or conflicting information.
- Contact an already approved family member.
- Prepare and send factual questions to insurers, TPAs, HR teams and hospitals.
- Track replies, deadlines and documents.
- Compare replies with policy wording and earlier correspondence.
- Update the household's insurance record and prepare the next decision brief.
- Check citations, source versions, conflicts and unanswered material questions before release.

It must ask before:

- A new person sees protected information.
- A new institution is contacted outside the agreed purpose.
- Sending a medical declaration or proposal answer.
- Accepting a licensed recommendation.
- Paying a premium.
- Filing a claim.
- Accepting a settlement.
- Any borrowing or investment action.

**Autonomy drops in an emergency, deliberately.** When `Emergency access` is pressed, the agent stops acting
and becomes a retrieval layer: it assembles a read-only Emergency Case Brief for a live expert and displays
evidence. It does not decide treatment, judge whether admission should wait, promise approval, or instruct a
hospital. The one moment the product matters most is the one moment it is least autonomous, and that is the
correct trade.

**It is not L4** because insurers, TPAs, hospitals and licensed advisers still control the outcomes that
matter. An adviser cannot bind an insurer. Family relationship never creates authority over another adult's
records.

**The evidence constrains autonomy in a specific direction.** Mrs. Ghosh will let a stranger on an emergency
line see everything, because she tells her doctor — but she will not let her own son see the reason behind
a condition on her declaration [T5/T8 00:03:06]. She granted an emergency override in advance, for herself,
knowingly [T8 00:02:16]. An agent that treats "the family" as one permission boundary fails her. Autonomy is
bounded per field and per viewer, not per household.
## 3. What states does your agent go through?

### The two entry routes

A case starts one of two ways. There is no generic dashboard and no home screen full of policy PDFs.

| Entry route | What the user is saying | What Knowvia returns |
|---|---|---|
| **`Plan an expense`** | "I already have cover. Help me plan this pregnancy, treatment, parent-care concern, claim issue or renewal." | Event-specific cover map, cash scenario, next action, and a renewal decision if one is due |
| **`Find and buy personal health cover`** | "I need personal cover, because my existing cover is ending, is inadequate, or does not exist." | Current-cover reconstruction first, then comparison, one ranked recommendation, and an optional purchase route |

**Renewal is not a third mode.** It is a time-sensitive case inside `Plan an expense` when a policy already
exists, or inside `Find and buy personal health cover` when expiring protection must be replaced. Treating
renewal as its own tab is what produces a reminder instead of a decision.

### The state pipeline

```text
EVENT + PERMISSION          A real trigger, and who may see what
        |
SOURCE PACK                 The smallest useful set of documents, requested by name
        |
WORKERS RUN IN PARALLEL     Person, policy and event workers, each with one job
        |
RULE APPLICATION            Extracted clauses applied to the actual estimate lines
        |
RECOMMENDATION + EVIDENCE   One route, a cash scenario, named next actions
        |
INSTITUTIONAL CONFIRMATION  Dated answers from insurer, TPA, HR or hospital desk
        |
ACTION                      Approved declarations, documents, payment
        |
TRACKING + RECONCILIATION   Issuance, pre-auth, claim status; then record what happened
```

The workers are not one model doing everything. For a planned delivery, seven run in parallel: a **person
and enrolment worker** (is this person actually enrolled, or merely eligible under the master policy); a
**benefit-rule worker** (extract the definition, waiting period, cap and exclusions, with page references);
a **hospital-network worker** (dated official source only, never a search snippet); an **estimate worker**
(split the hospital estimate into package, room, tests, fees, medicines, consumables, deposit); a
**benefit-application worker** (apply rules to each estimate line); a **cash-exposure worker** (low,
expected and high household cash scenarios after the room-rent sub-limit, ICU and treatment-specific
sub-limits, co-pay, deductible, and any restoration or recharge benefit that may or may not have been
triggered); and an **evidence worker** (preserve page, clause, date, document version and calculation inputs).

Separating them is what makes a wrong answer traceable to one step instead of to a paragraph.

### Every output carries one of six states

| State | Meaning |
|---|---|
| **Proven** | An exact source supports it, with page and clause |
| **Calculated** | Derived by a shown formula from proven inputs |
| **Reported** | Supplied by a person, not verified against a document |
| **Dynamic** | Can change, and needs a dated institutional source |
| **Unknown** | Source absent or unreadable |
| **Conflicting** | Two sources disagree; both are preserved |

No worker gives an unsupported final answer. Every extracted field retains its source document, version,
page, clause, extraction confidence, effective date, and whether a human has corrected it.

**Unknown never means absent**, and "needs confirmation" is not a lazy default — it is used only for a fact
that changes in real time or is genuinely missing from the source pack.

This six-state discipline is not a design preference. It survived contact with real documents: **7 of 19
collected schedules disagreed with the family's own account.** One sister's date of birth was six years
wrong. A system that cannot hold "the document and the person disagree" as a first-class state will print
a confident wrong answer.

### 2 states earn their place from the evidence

**Dynamic** exists because Nikhil had a 17-day portability window and received no notification when his
cover lapsed — "nothing happens, that's the thing" [T6 00:01:39]. His mother is uninsured at 62 nine months
later. Network status, enrolment status and eligibility dates are not facts you extract once.

**Conflicting** exists because of the 7-of-19 finding, and because Meghna's 8L base sat under a 10L
deductible producing a ₹2 lakh dead zone she discovered live on the call [T4 00:01:43].

### The continuity trigger

Losing dependent eligibility or employer cover is a separate, high-value case. The continuity worker reads
the exact dependent definition and renewal condition — **it does not assume an age-26 rule** — calculates
the last date of evidenced coverage, and raises deadline cases at 120, 90, 60 and 30 days where dates are
known. It outputs one of: retain, renew before lapse, port where permitted, buy new personal cover, seek HR
or insurer clarification, or no action required.

**The mechanism it exists to protect is accrued waiting-period credit.** Group cover typically does not
apply pre-existing-disease waiting periods; retail cover does, usually two to four years. Porting from group
to retail with the same insurer carries the accrued credit across. Missing the window does not merely cost a
premium — it resets the clock on exactly the conditions a household is insuring against. Nikhil had
seventeen days and no notification of any kind: "nothing happens, that's the thing" [T6 00:01:39].

So the continuity worker does not emit a reminder. It emits a decision with the credit at stake shown as a
number, because the warning is not the value. Nikhil's own instruction: it has to be "already sitting there,
correct and up to date, so that on the bad day it's a two-minute read and not a three-week research
project" [T6 00:05:20].

Two related mechanisms sit in the same worker and are checked on every renewal, because they are the other
two ways continuity silently degrades: the **grace period** (cover can lapse and be revived on different
terms) and **no-claim or cumulative bonus** accrual, which can be reduced or reset by a claim. Both are
policy-diff outputs, not price outputs.

### Unhappy flow

| Situation | Agent response |
|---|---|
| Treatment is an emergency | **Admit first, optimise later.** Route immediately to a live expert. No insurance workflow may delay urgent care |
| Permission is missing | Stop. Request permission from the relevant adult. Hide that adult's data and halt dependent tasks |
| Policy document is missing | Do not infer that cover is absent. Contact the approved holder and mark the policy unknown |
| Documents conflict | Preserve both versions, dates and source pages. Request institutional clarification |
| Family memory conflicts with policy wording | Treat the document as evidence and memory as **Reported**. Surface the conflict; do not silently pick one |
| Voice transcript is uncertain | Do not convert uncertain speech into a health declaration. Read back, confirm, switch language or channel |
| A person is eligible but not enrolled | Do not report them as covered. Eligibility under a master policy is not enrolment |
| Insurer or TPA does not reply | Follow up, record attempts, show the approaching deadline, escalate through a permitted route |
| Hospital network status is unclear | Mark **Dynamic**. Do not describe the hospital as cashless |
| Pre-authorisation is delayed | Show deposit and reimbursement scenarios |
| Pre-authorisation is denied | Escalate. Do not call it a final claim rejection |
| Premium is paid but policy is not issued | Keep the purchase unresolved. Reconcile until issued, reversed or disputed |
| A claim appears weak or excluded | Do not invent an approval probability or coach concealment. Say "the wording says X and this case is missing Y", never "your claim will fail" |
| The user asks to omit health history | Refuse. Only the user can approve a declaration, and it must be accurate |
| The existing adviser already solves the job | Avoid duplicate onboarding. Work alongside with permission, or close the case |
| User asks for medical advice | Route to the treating doctor |
| A serious source or privacy error is found | Block release and outbound action. Notify the owner, revoke affected access, correct the record, require review |

## 4. What does it use and build on each rail?

### Gnani: voice

**What exists.** Multilingual speech, configurable voice agents, knowledge bases, dynamic pre-call
variables, external actions, conversation logs and analytics.

**How Knowvia uses it — three uses, and no more.** Gnani is **not** the policy analyst, the claims engine or
a family-interrogation bot. The evidence workers do the insurance reasoning. Gnani is used where speaking is faster, easier or more accessible than typing:

1. **Optional voice intake per covered person.** At onboarding the operator picks `Add myself`, `Add wife`,
   `Add parent` or `Add child`, and chooses text or voice. Voice collects known past conditions or
   hospitalisations, rough timing and recurrence, current treatment, previous policy or claim history, and
   whether each detail is certain, estimated or unknown.
2. **Voice conversation with the main agent.** Someone can say "my wife is pregnant, my mother has kidney
   issues, my employer cover exists, should I buy another policy now" and get a structured case back. Gnani
   transcribes and reads the answer aloud. It does not do the reasoning.
3. **Accessible read-back for a senior family member.** A parent opens an approved household view and hears
   a pre-generated summary in their language: active policy and member ID, hospital or TPA contact route,
   what to carry, what is known about the current event, what has already been done, the next action.

**Why voice at all.** The person who runs the case and the person who holds the documents are usually
different people. S. Ghosh, 58, holds the family policy and cannot get past the insurer login [T3]. Mrs.
Ghosh gave nineteen minutes in Bengali on a phone call she asked for [T8]. Neither of them is going to type.

**What Knowvia must build.** A permission-aware conversation layer recording who supplied each fact, what
document supports it, who may see it, whether it was confirmed or disputed, and which unanswered question
must escalate. Gnani converts speech to a **structured draft** and reads every material detail back.
**Uncertain speech is never silently converted into a health declaration.** A voice-sourced fact is
**Reported** until the speaker approves it or a document supports it.

**Documented ceilings we design inside, and one we are already hitting.** Maximum three languages per agent
— this research already used English, Hindi and Bengali, so the cap binds on day one and "their preferred
language" is a promise we cannot make open-endedly. Maximum 100 FAQ entries. Agent Chaining is bot to bot;
there is **no documented bot-to-human warm transfer**, which directly complicates the emergency expert
handoff in answer 6. No multi-party or conference call. Post-call webhook only, with no mid-call event
stream, so no supervising system can intervene live.

**It must never** treat spoken recall as proof of coverage, improvise a policy conclusion beyond the
evidence-backed output, or share one adult's medical information with another without permission.

### Pine Labs: payments

**What exists.** Payment links, hosted checkout, payment status, refunds and reconciliation. The public
documentation at `api.pluralpay.in` additionally describes card pre-authorisation with hold-and-capture,
UPI Reserve Pay block-and-debit, split settlement and agent-native payment flows.

**How Knowvia uses it — the final step only.** Pine Labs is invoked **only after a human approves** one of
exactly two outcomes: renewing an existing policy, or purchasing a selected new personal policy. It is the payment rail.

**It is not** the discovery engine, the policy reader, the underwriting engine, or an emergency-payment
system. **It does not reserve a hospital deposit.** We considered the pre-authorisation hold for exactly
that — an authorised, released hospital deposit is a genuinely attractive use of the rail — and we are not
claiming it, for three reasons: no hold-expiry window is documented; whether a hospital can be an eligible
merchant accepting such a hold is unverified; and putting a payment instrument into an emergency flow
conflicts with "admit first, optimise later". A payment hold is not insurance pre-authorisation, and it is
not a right to use another adult's money.

Saying no to the most impressive-looking capability on the rail is the honest answer here.

**What Knowvia must build.** A transaction record connecting recommendation → quote and policy version →
medical declarations → household approval → premium payment → insurer issuance → endorsements → final
policy record. The payment worker records the chosen policy and payment status. It cannot recommend a
product, alter a declaration, make a claim decision or handle an emergency deposit.

Payment stays separate from recommendation, and the interface must keep offering `do not buy now`,
`renew while comparing` and `seek clarification first` when those are the safer actions.

**Honest gap.** **eNACH and NACH are not named in Pine Labs documentation. We do not claim them.**

**It must never** present payment success as proof that the policy has been issued or that a future claim
will be covered.

### Delhivery: logistics and maps

**What exists.** Shipment creation, pickup and tracking. Delhivery Maps provides Indian address geocoding, standardisation, validation, verification, routing and distance tools.

**How Knowvia uses it.** Only after a hospital or insurance office has been institutionally confirmed:
validate the address, and help the family reach the right insurance desk rather than the main reception.
Physical delivery only if original documents are genuinely required, in which case add a consent token,
tamper-evident chain of custody, exact-recipient proof and a return or destruction status.

**It must never** select the nearest hospital and assume it supports cashless treatment under this policy.
Address validation does not verify identity or insurance eligibility.

**Delhivery is useful but not load-bearing**, and we would rather say so than invent a parcel workflow to
feature the rail.

### What is load-bearing

Not a rail. The **permissioned, source-linked cover record** is load-bearing; the rails are how it reaches
people, money and places. Gnani is the **access** rail, Pine Labs the **settlement** rail, Delhivery the
**last-mile** rail.

Documentation checked 20 September 2026: [Gnani Agent Builder](https://docs.gnani.ai/introduction),
[Gnani Platform API](https://docs.gnani.ai/Platform/platform-introduction),
[Pine Labs hosted checkout](https://www.pinelabs.com/docs/online-payments/hosted-checkout/integration-steps),
[Delhivery B2C APIs](https://one.delhivery.com/developer-portal/documents/b2c/),
[Delhivery Maps](https://www.delhivery.com/maps/reference). The Gnani console has not been tested for this
submission; console-only behaviour remains unverified.

## 5. Does the agent need a fourth rail?

> **Yes. An Insurance Confirmation Rail, and Medi Assist is the company best placed to build it.**

The need for this rail is not a hunch. It falls out of the build. Every output in this system carries one of
six states, and one of them is **Dynamic** — "can change, and needs a dated institutional source". Dynamic
is not an answer. It is the name we gave to the answers we cannot get.

Today, policy status, hospital network status, TPA identity, endorsement history and pre-authorisation
updates live in different systems, none of which returns a dated, case-specific answer to a third party.
Knowvia can organise them. It cannot make them authoritative. So the product is forced to label the most
decision-relevant facts as Dynamic and ask the household to go find out.

**What changed after field feedback.** Shilpa Arora, Co-Founder and COO of Insurance Samadhan, replied to
our earlier architecture post with three reasons a generic coverage summary fails. A ₹10 lakh sum insured
can still contain a ₹2 lakh cap for immunotherapy. Corporate-policy benefits may be hidden from the employee
until hospitalisation sends them to HR. And the hospital TPA desk, TPA and insurer each process different
information. Her conclusion was: **"The process is breaking at many ends. ... It’s a complex problem but
can be solved."** [Public comment on the earlier architecture](https://www.linkedin.com/posts/rishav-dewan_%F0%9D%97%9B%F0%9D%97%B2%F0%9D%97%AE%F0%9D%97%B9%F0%9D%98%81%F0%9D%97%B5-%F0%9D%97%B6%F0%9D%97%BB%F0%9D%98%80%F0%9D%98%82%F0%9D%97%BF%F0%9D%97%AE%F0%9D%97%BB%F0%9D%97%B0%F0%9D%97%B2-%F0%9D%97%B6%F0%9D%98%80-%F0%9D%97%BB%F0%9D%97%BC-activity-7505177397751697408-25Lz)

That feedback is why the **new architecture** has three rules. First, it exposes treatment-specific inner
caps, not only the headline sum insured. Second, it asks for the employer booklet and proof of enrolment
before a hospital event, not after HR becomes the bottleneck. Third, it records whether the hospital desk,
TPA or insurer owns the next answer. The Confirmation Rail is the technical way to retrieve those live,
dated answers instead of leaving the household to reconstruct them under pressure.

The rail should return, dated and case-specific:

- Active policy and member status — and specifically **enrolment**, not eligibility.
- Latest endorsement.
- Confirmed TPA.
- Hospital network status.
- Required documents.
- Pre-authorisation status.
- Claim status.
- Pending institutional action, responsible team and escalation route.

**Why Medi Assist.** It already sits between insurers, hospitals and policyholders and runs
claims-administration workflows. It is the only kind of party that could return a *dated* answer instead of
an inference.

**What the evidence says.** Every expensive failure in this study is a confirmation failure, not an
information failure. Nikhil's 17-day window closed with no notification [T6 00:01:39]. Sourav lost seven
hours at 2 a.m. because an employer reception wanted an employee ID he did not have [T5 00:03:08]. Vikas,
from the hospital desk, is explicit that he cannot file a claim off a third-party sheet, though he would use
one to convince a family [T2 00:03:38]. A rail that returns status changes all three. A better summary
changes none of them.

**The hard part inside this rail is delegated authority.** It must answer not only "what is the status" but
"is this person allowed to ask". That means a signed, revocable authority record: the principal; the
delegated person or agent; the permitted action; the exact records, institution, purpose and expiry; live
revocation; an audit trail; and a denial state when authority is absent, expired, disputed or broader than
the task.

Setu's Account Aggregator documentation is the closest existing Indian pattern — purpose-specific consent
objects, approval or rejection, expiry and status. Worth citing as prior art. It does **not** establish a
health-data, family-delegation or third-party action API.

**This rail confirms status. It does not guarantee approval.** It must not turn a family relationship, a
payment token or a delivery address into authority, and it must not expose a claim-approval probability. A
claim score without an insurer-validated model creates false confidence.

Without this rail, Knowvia falls back to per-institution consent, customer documents and manual follow-up,
and the decision-critical facts stay marked Dynamic.

## 6. How will a human interact with the agent?

### The first screen is a household matrix, not a dashboard

The product does not open as a generic insurance dashboard, and it does not open as five policy PDFs.

| Person | Policies found | Immediate issue | Evidence status |
|---|---|---|---|

Each row opens a short verdict: covered facts, cost exposure, conditions that matter, next action, and
source pages. That structure comes straight from the research — every respondent overstated their coverage
and understated their exposure, and Arnab could not confirm his own sister was on the family policy
[T1 00:01:34].

From there the user picks one of the two entry routes in answer 3. There is no third option.

### Concise answer first, proof on demand

The first response is a decision, not a wall of text. Four layers, each one tap deeper:

| Layer | What the user gets |
|---|---|
| **Decision** | One recommended route and the next three actions |
| **Financial** | Low, expected and high household cash scenarios, and why they differ |
| **Evidence** | Clause, page, policy version, source date and the calculation |
| **Research** | Official network data, product comparison, complaint patterns and public discussion, ranked by reliability |

A planned-delivery answer reads: *"Use the group policy as the first route at this hospital, subject to the
listed enrolment and maternity conditions. Keep ₹[range] available because [named cap] can remain payable.
Submit pre-authorisation through [named desk] by [date]."* Then **`Why`** expands every clause, estimate
line and calculation.

The evidence hierarchy behind that: policy schedule and official wording first; then dated insurer, TPA,
hospital or employer confirmation; then hospital estimate and treatment documentation; then regulatory
disclosures; and last, public complaint trends and forum discussion. Reddit and claim-settlement ratios can
reveal experience patterns. They cannot prove this claim will be accepted. They stay in the research layer,
never above policy and event evidence.

This layering is Meghna's requirement made structural. She could not win an argument with a relative-agent
using "an app told me", but could using "it says here, page fourteen" [T4 00:06:06]. The decision has to be
short and the citation has to be reachable.

### Emergency access is a call to a person, not a chat and not a bot

The user presses **`Emergency access`**. It dials a **human support operator**. Directly.

**No voice agent sits in this path.** No IVR, no bot triage, no read-back, no transcription step, no Gnani.
This is the one place in the product where we deliberately use none of our own automation, because every
layer we add is a layer between a frightened person and a human who can help.

The operator receives a permissioned, read-only **Emergency Case Brief**: policy number, e-card and insurer
or TPA number; person covered and hospital selected; dated network status or a visible "not verified" label;
relevant caps, co-pay and room rule; the likely immediate cash scenario; the hospital-insurance-desk script
and required documents; pre-authorisation and escalation status.

They are a support operator who already has the file open. **Not a clinician** — they handle insurance and
coordination, and they do not advise on treatment. The AI's role collapses to retrieving, structuring and
displaying evidence for that person. It does not decide treatment, tell anyone to delay admission, decide
whether a claim will pass, or instruct a hospital.

This is Sourav's specification, not ours. One button is the maximum and two screens is already too many
[T5 00:04:22]. The person who answers must not ask him anything — "I'll only say my brother's accident, I'm
at [hospital] — the rest they should already know" [T5 00:04:36]. A voice agent on that route is a screen
with a voice. It fails the same test.

**Talking to the AI is a separate path**, available whenever the user chooses it, including from a hospital
bed for a non-urgent question. It is never placed in front of the call, and choosing it is never required to
reach a person. Two products, one button each.

**First instruction, always: admit first, optimise later.**

### WhatsApp and Gnani, working together

Neither one wins. They fail in different places, and the household needs both.

| | WhatsApp does this better | Gnani voice does this better |
|---|---|---|
| **Who it reaches** | The adult who runs the case | The parent or relative who holds the documents and will not type |
| **Language** | Written, re-readable, any script | Spoken, code-switched as people actually talk. Capped at three languages per agent |
| **Citations** | A source line stays on screen and can be shown to a relative [T4 00:06:06] | Cannot hold a source still; must read back and confirm |
| **Documents** | Upload, forward a renewal PDF, attach a schedule | Cannot carry a document, only describe one |
| **Nudges with a deadline** | Native. The 120/90/60/30-day continuity warnings land here | Intrusive for a routine reminder |
| **At 2 a.m.** | Still requires opening an app. "I will not open an app" [T5 00:04:22] | One call, no screens |
| **Someone who cannot use a smartphone well** | Fails | Works. S. Ghosh cannot get past the insurer login [T3] |
| **Audit trail** | Native. Every message is the record | Needs a transcript, a read-back and explicit confirmation before a fact is trusted |

**The design rule: WhatsApp carries the case. Voice carries the people the case depends on. The app carries
the evidence.**

Concretely: the renewal deadline arrives on WhatsApp; the mother's condition history is collected by voice
because she will not type it; the clause-level proof lives in the app behind `Why`; and the emergency is a
phone call to a person. Neither channel becomes a second uncontrolled record — both write into the same case.

WhatsApp is **not one of The Ken's three rails**, and we would rather say that plainly than pretend a rail
covers it. It is the surface the household already lives in. Gnani is how the product reaches past it.

### Who operates, and who can see

One household member operates the case by default. The product does not cold-call a mother to run a generic
health interview — the operator brings her policies and her event into the case.

**The operator model is a default, not a ceiling.** We do not hand a senior family member full agency
automatically and leave them to run an insurance workflow alone; S. Ghosh, 58, holds the family policy and
cannot get past the insurer login [T3], and defaulting him into the driver's seat would fail him. But
nothing is locked. If he or his wife wants to open the case, ask a question, supply a document, correct a
recorded fact or start a case on their own policy, they can — in their own language, by voice if they prefer.
Defaulting someone out of their own insurance permanently fails them just as badly.

Mrs. Ghosh is the proof that this has to be a choice rather than a setting we pick for her. She asked for her
session herself [T8]. She was not waiting to be given access.

**Permissions are per-field and per-viewer, with a member-approved emergency override.** Every stored fact
carries one of three visibility classes — **cover** (a policy exists, its sum insured, who is enrolled, the
funding route), **operational** (policy number, member ID, TPA route, network status, desk contact) and
**protected** (medical declarations, disclosed conditions, claim reasons, underwriting loadings). Each viewer
is granted classes individually, per member, with a purpose, an expiry, live revocation and an audit trail
the principal can read.

Withheld and unknown are deliberately different states. Rendering a withheld field as "unknown" would leak a
fact and misinform the viewer in the same stroke.

Mrs. Ghosh's rule is "the number yes, the reason no" [T4/T8 00:02:52] — her son may see that cover exists and how much,
because that keeps him calm, but not the declaration explaining why a condition is listed. And she has no
objection to a stranger on the emergency line seeing everything, because she tells her doctor; it is telling
her own son that is hard [T5/T8 00:03:06]. She granted a full emergency override in advance, for a moment
when she could not speak [T8 00:02:16].

A single household on/off switch fails her. So does a per-person switch. This is the one place where the
build spec and the evidence must not be allowed to drift apart: "one operator plus a read-only parent view"
is the common case, not the permission model.

A licensed human appears as a marked gate, not a permanent concierge. They receive disputed facts and their
sources, record their reasoning, and return the case to the household.

## 7. What is the name of the agent?

> **Knowvia**

Primary descriptor: **Understand your insurance before you need it.**

Product line: **Know what you have. Know what could go wrong. Know what to do next.**

The name carries the actual promise: know what cover exists, know what remains uncertain, know what to do
next. Coversaath was the internal codename during research and is retired. Name, trademark, domain and
company clearance remain unverified.

## 8. Which Indian company has the best chance of creating an agent like this?

> **Policybazaar.**

Policybazaar already operates across insurance comparison, purchase, renewal, policy servicing and claim
assistance. It has the widest existing position from which to build a similar agent: shoppers, licensed
distribution, insurer relationships, payment flows and post-purchase support. Its own claim-assistance page
states that the insurer makes the final settlement or rejection decision, so the boundary is already
acknowledged.

There is one important distinction. **Policybazaar is the strongest distribution competitor; Medi Assist is
the strongest operational entrant.** Medi Assist already sits in the claims and hospital workflow through
TPA relationships, network hospitals, policyholder servicing, pre-authorisation and claim tracking. It is
therefore the natural builder of the missing **Insurance Confirmation Rail** described in Question 5. That
rail could make a Medi Assist-built agent materially stronger at answering live questions about enrolment,
TPA ownership, network status, required documents and claim state.

This does not make Medi Assist a complete Knowvia competitor today. Its access is strongest for policies and
claims it administers, while Knowvia is designed to reconstruct the household's complete cover position,
including policies held across employers, insurers and TPAs. Medi Assist also has an operational incentive to
serve the policies in its network, not necessarily to tell a household to retain, replace or buy nothing.
That is why Policybazaar remains the answer to this question, while Medi Assist is the most important rail
partner and the most credible adjacent entrant.

**The gap is not access or technology.** The difficult part is building an agent that treats these as
equally valid outcomes: buy, renew, retain the existing cover, defer the decision, and "we cannot confirm
this yet". A conversion-led business may find that last one hard to prioritise, because it is the only
output that produces no transaction. This is an external inference about incentives, not knowledge of
Policybazaar's internal plans.

Knowvia's differentiation must therefore be the **persistent household record and its discipline around
unknowns**, not comparison, policy explanation or claim assistance. Meghna's outcome is the test: the right
answer for her was to spend nothing and redirect the money to her parents [T4 00:05:37]. If Policybazaar
builds the same pre-sale household record with credible conflict controls, most of the remaining
differentiation disappears.

## Where this submission is strong and weak

| Area | Current view |
|---|---|
| Strongest | Eight consented interviews with named respondents, including a hospital insurance-desk executive and two parents, wired into specific design decisions. The permission model, the reconstruction-first sequence and the handling of unknowns all come from a transcript, not from a whiteboard |
| Also strong | State design, institutional boundaries, and the willingness to publish what the evidence does not establish |
| Genuinely weak | No tested rail call. No licensed partner. Economics untested. Willingness to pay in a calm month is unresolved and the research says so plainly [T1 00:16:03] |
| Sampling limit | Eight respondents through friends, family and acquaintances. All privately insured. None on a state scheme. Directional, not prevalence |
| Exists locally | Synthetic workflow, deterministic rules, source-linked evidence model, consent and safety gates, persistence, fail-closed provider boundaries |
| Does not exist | Real policy ingestion, a real Gnani call, a Pine Labs transaction, institutional integration, a licensed partner agreement, or a real purchase or claim case |

## Before submission

1. Test Gnani in at least two relevant language modes and document where insurance terminology, consent,
   context or handoff fails. The three-language cap and the missing warm transfer are the two things to
   probe first.
2. Test the Pine Labs authorised-payment lifecycle in its test environment. Do not claim a hospital deposit
   hold works until a hospital merchant and the operating terms are verified.
3. Test Vikas's output format at two more hospital desks, ideally one government and one small nursing home,
   before fixing the Admission Readiness Brief format [T2 00:03:38].
4. Stand up the human support rota behind `Emergency access` and measure time-to-human. The number that
   matters is how long Sourav waits, not how good the brief looks.
5. Confirm the 3.92% figure and preserve its organiser source.
6. Obtain qualified review of the licensed recommendation, data handling, delegated authority and commission
   model.
7. Keep the demonstration to one planned-care event after cover reconstruction. Present buying and renewal
   as cases inside the two entry routes, not as separate products.
8. Preserve the T8 redaction in every derived document, demo and submission.
