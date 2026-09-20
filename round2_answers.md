# Knowvia: Round 2 answers

Updated 20 September 2026. This is the source of truth for The Ken Round 2 eight-question submission.
All agents should edit this file when the Round 2 answers change. `answers.md` retains the earlier
competition material and defence notes.

No submission has been made. The integrations below are proposed uses based on public documentation.
No partnership, production connection or vendor-platform test is claimed.

## Revision log

| Version | Change | Reason |
|---|---|---|
| 0.1 | Rebuilt all eight answers around the final North Star and USP. | Disclosure history, claim correspondence, admission briefs and the Treasury are capabilities inside Knowvia, not the product itself. |
| 0.2 | Changed autonomy from L4 to L3. | The agent acts independently only inside limits already set by people. Its most consequential unsupervised action is bounded institutional follow-up. |
| 0.3 | Replaced a broad outcome promise with a testable decision brief. | “The household understands” was too soft to judge. The new outcome has a completion condition. |
| 0.4 | Narrowed the Medi Assist fourth rail to cases it is authorised to administer. | Medi Assist is not a neutral or universal source across every insurer and TPA. |
| 0.5 | Standardised the public name as Knowvia and retained Coversaath only as the internal project name. | The earlier draft mixed both names. |
| 0.6 | Reframed the design around per-person cover interaction and the admission-morning cash question. Replaced the mandatory readiness drill and separate physical card. | The product should quietly hold usable context. It should not make a household pass a preparedness test or mistake a static card for live support. |

## Current position

**North Star:** no household should make an insurance decision or reach a planned hospital admission
without knowing, for the specific person and expense, what cover may apply, what remains uncertain,
what money may be needed and what to do next. During an emergency, the authorised context should be
available to a human but must never delay care.

**USP:** Knowvia is a household health-cover interaction engine. It reconstructs group and personal
cover per person, then works out how those protections may interact for a particular purchase, renewal
or hospital expense. It does not add headline sums insured into a false total.

The Household Health Treasury, policy continuity record, disclosure history, correspondence tracker,
Admission Readiness Brief and backup handover are capabilities inside Knowvia. None is the product alone.

The reported opening share is 3.92%, the third-lowest share of submissions. This is a competition signal,
not customer evidence. It may mean fewer comparable submissions. It may also mean the opening is harder,
less attractive or poorly understood. It does not prove demand.

The five-source, ₹30 lakh-to-₹8 lakh scenario is an **illustrative working case**, not proof of a typical
household or a claims result. It may be used to make the interaction logic concrete only when each policy
term, bill assumption and institutional fact is labelled and source-checked.

## 1. What is the outcome your agent is accountable for?

> For each buying, renewal or planned-care case, Knowvia delivers a person-specific, source-linked route: what existing cover may apply, what does not yet apply, what must be confirmed, and what cash may be needed by the relevant deadline.

Completion is testable:

- No material question disappears into a summary.
- Every important statement links to evidence or is labelled as reported from memory.
- The household can identify its next action, owner and deadline from the brief.
- Group cover, personal cover, available cash, loans and investments remain separate.
- A shared floater, deductible, waiting period, room rule, co-pay, top-up and fixed-benefit payment are
  modelled as conditions, not added into one reassuring number.
- In an emergency, administrative analysis never delays treatment.

The accountable outcome is not claim approval. Knowvia cannot bind an insurer, decide underwriting,
select treatment, guarantee cashless approval or promise settlement. It is accountable for reducing
avoidable uncertainty and unfinished household work while preserving institutional authority.

## 2. What level of autonomy does your agent have?

> **L3, inside a permissioned case.**

After the named adults set the purpose, permissions and communication limits, Knowvia can act without
asking again inside those limits. It can:

- Read and classify relevant evidence.
- Reconstruct group and personal cover.
- Identify missing or conflicting facts.
- Contact an already authorised household member or institution.
- Send and chase a pre-approved factual question.
- Track responses and deadlines.
- Compare replies with policy wording and earlier correspondence.
- Revise the case and prepare the next decision brief.
- Check citations, source versions, conflicts and unanswered material questions before release.

A person handles anything outside the agreed limits. Knowvia must ask before:

- A new person sees protected information.
- A new institution is contacted outside the agreed purpose.
- A declaration or proposal answer is submitted.
- A licensed recommendation is accepted.
- A payment, cancellation, borrowing, investment sale or settlement decision occurs.

A licensed expert owns regulated recommendations. The insurer, TPA, hospital and employer retain their
own decisions. Family relationship never creates authority over another adult's records.

## 3. What states does your agent go through?

### Core state machine

```text
TRIGGERED
  -> SCOPED
  -> PERMISSIONED
  -> EVIDENCE COLLECTING
  -> PER-PERSON COVER MAP
  -> EVENT ROUTE MODELLED
  -> AWAITING INSTITUTION / HUMAN GATE
  -> ACTION READY
  -> ACTION IN PROGRESS
  -> RECONCILED
  -> RECORDED FOR THE NEXT EVENT
```

Every state shows four fields: current owner, evidence used, unresolved question and deadline. Evidence
is marked confirmed, needs confirmation, missing, conflicting, or reported from memory. Unknown never
means absent.

### Happy flow

1. **Triggered.** A renewal, new job, family change, planned admission or claim problem creates one case.
2. **Scoped.** Knowvia names the exact question, patient or buyer, deadline, institution and current helper.
   If no unresolved job exists, it closes instead of manufacturing work.
3. **Permissioned.** Each adult approves the purpose, records, viewers, communication channels and expiry.
   Patient, policyholder, payer, household operator and backup may be different people.
4. **Evidence collecting.** Knowvia asks for only the evidence needed for this case: policy schedules,
   wording, endorsements, employer benefit booklets, hospital estimate and correspondence. It turns a
   vague request into a small task, for example: "forward the current renewal PDF from this email thread."
   Each source receives an owner, version and timestamp.
5. **Per-person cover map.** It maps who is actually insured under each group and personal policy. It
   separately records shared utilisation, room and ICU rules, co-pay, deductible, waiting-period dates,
   exclusions, condition limits, restoration and top-up dependencies. A headline sum insured is never
   presented as payable cash.
6. **Event route modelled.** For buy or renew, it identifies the real gap, duplication and facts that
   could change the answer. "Wait and find out X" is a valid output. For planned care, it models this
   patient, procedure, hospital, date and estimate: likely first route, network and pre-authorisation
   questions, documents, constraints and conservative admission-morning cash scenarios. It never calls
   a scenario an approval.
7. **Awaiting gate.** Knowvia sends permitted questions to the named hospital desk, HR team, TPA, insurer
   or licensed partner. Material ambiguity and regulated recommendations go to a human. The case remains
   open until an answer, deadline or explicit unresolved status exists.
8. **Action ready.** It produces one primary brief: buy, renew, retain, switch, defer, prepare admission,
   supply a document, challenge a mismatch or escalate. Each statement shows source, status and owner.
9. **Action in progress.** The household approves the action. Payment, policy issuance, pre-authorisation,
   claim submission and settlement remain separate events.
10. **Reconciled.** Knowvia checks issued terms or institutional replies against the accepted route. A
    mismatch becomes a new owned question, not a silent success.
11. **Recorded.** The permissioned cover map, continuity history, correspondence and event route remain
    available for the next renewal, job change, admission or claim issue. Preparedness is an outcome of
    accumulated context, not a compulsory drill.

### Unhappy flow

| Failure or exception | What Knowvia does | Exit or recovery |
|---|---|---|
| Emergency treatment is underway | Connects the authorised human to the smallest safe live case view and says “Admit first. Optimise later.” | Administrative work resumes only when it cannot delay care. |
| A named adult has not consented | Hides that adult's data and stops dependent tasks. | Ask that adult, narrow the scope, or continue with the gap labelled. |
| Policy or employer booklet is missing | Does not infer that cover is absent. | Request the document or an authorised institutional answer. Otherwise mark unknown. |
| Two sources conflict | Preserves both versions, dates and source pages. | Apply source hierarchy, ask the institution and route material ambiguity to a human. |
| Voice transcript is uncertain | Does not convert uncertain speech into a declaration. | Read back, ask for confirmation, switch language or channel, or request human review. |
| Insurer, TPA, HR or hospital does not answer | Logs attempts, ownership and the approaching deadline. | Escalate through a permitted route and issue a brief that shows the unanswered question. |
| A rail or API fails | Preserves the case and evidence state. | Fall back to a permissioned call, email, upload or manual payment route. |
| Payment succeeds but policy is not issued | Does not mark the case complete. | Reconcile with the licensed partner and insurer until issued, reversed or disputed. |
| A claim appears weak or excluded | Does not invent an approval probability or coach concealment. | Explain the condition, missing evidence, response route and responsible institution. |
| The current adviser already solves the job | Avoids duplicate onboarding. | Work alongside the adviser with permission or close the case. |
| A medical, underwriting or settlement decision is requested | Stops the model from deciding it. | Route to the doctor, insurer, TPA, licensed expert or household decision-maker. |
| A serious source or privacy error is found | Blocks release and outbound action. | Notify the owner, revoke affected access, correct the record and require review. |

## 4. What exists and what must be built on each rail?

| Rail | What exists and Knowvia would use | What Knowvia must build or validate | Fallback |
|---|---|---|---|
| **Gnani, voice** | Agent Builder provides voice-agent configuration, knowledge bases, dynamic pre-call variables, custom actions, call logs and integrations. Its Agent Chains documentation includes a transfer event and transfer-number configuration. | Bind each call to an adult's purpose-limited permission; pass only permitted context into a human transfer; read back material facts; redact at field level; evaluate insurance terms in relevant languages; retain revocation and audit records; and prevent one relative's call from exposing another adult's details. A transfer event alone does not carry safe household authority or source-linked context. | A scoped human call or WhatsApp/email questionnaire. Material voice facts remain unconfirmed until the speaker approves them. |
| **Pine Labs, payments and authorisation** | Hosted Checkout supports order creation, payment callbacks, verified status, refunds and a card-payment pre-authorisation flow. An `AUTHORIZED` card payment can be captured or cancelled. The public documentation also lists UPI Reserve Pay, split settlement and agentic-commerce products, whose case-specific operating terms require validation. | For a policy premium, bind the accepted quote, commission disclosure, payer permission and case revision to an order. For planned care, validate whether the hospital is an eligible merchant and whether it can accept an authorised hold. Build payer-to-patient authority, amount ceiling, expiry, release condition, cancellation deadline, idempotency and reconciliation. A payment hold is not insurance pre-authorisation or a right to use another adult's money. | Use the licensed partner's approved payment route or the hospital's own payment route. Reconcile the receipt manually. No link appears before recommendation and disclosure gates. |
| **Delhivery, logistics and maps** | Shipment creation, pickup and tracking. Maps provides Indian address geocoding, standardisation, validation, verification, routing and distance tools. | **No core first-build role.** If a real case needs physical originals, build a consent token, tamper-evident chain of custody, sensitive-document handling, exact-recipient proof and return or destruction status. Address validation does not verify identity or insurance eligibility. | Secure digital upload, authorised email or a household-managed courier. If no physical original is required, do not create a shipment. |

Gnani is the access rail for the household member who holds a missing fact. Pine Labs is the differentiated
event rail: after the household and hospital agree the route, it may support an authorised premium payment
or time-bound deposit hold. The cover-interaction and evidence layer remains the product's load-bearing
logic. Delhivery has no honest core role today.

Documentation checked on 20 September 2026:

- [Gnani Agent Builder](https://docs.gnani.ai/introduction)
- [Gnani Platform API](https://docs.gnani.ai/Platform/platform-introduction)
- [Pine Labs hosted checkout](https://www.pinelabs.com/docs/online-payments/hosted-checkout/integration-steps)
- [Delhivery B2C APIs](https://one.delhivery.com/developer-portal/documents/b2c/)
- [Delhivery Maps](https://www.delhivery.com/maps/reference)

The Gnani console has not been tested for this submission. Console-only behaviour remains unverified.

## 5. Does the agent need a fourth rail?

> **Yes: a Household Authority Rail, with Setu as the best Indian company to build the first version.**

The missing thing across voice, payment and logistics is not another channel. It is proof that a named
adult has authorised a named person or agent to do a named thing for a limited purpose and time. The rail
would create a signed, revocable authority record containing:

- The principal, delegated person or agent, and confirmed identity.
- The permitted action: read, ask, share, pay, hold funds or receive a response.
- The exact records, institution, purpose, amount limit and expiry.
- A live revocation and an audit trail that a rail or human can verify before acting.
- A denial state when authority is absent, expired, disputed or broader than the intended task.

Setu is the best fit because its Account Aggregator documentation already uses purpose-specific consent
objects, approval or rejection, expiry and status for financial-data sharing. That is a useful operational
starting point, not proof that it can manage health records or household delegation today. The new rail
would need a cross-domain authority standard, institution adoption and legal review before it could be
relied upon.

Without this rail, Knowvia uses per-institution consent, customer documents and manual follow-up. Any
missing answer or authority remains unknown or unavailable. A Medi Assist-style evidence connection would
still be valuable, but only inside cases it is authorised to administer. It does not solve cross-rail
household authority.

[Setu's AA documentation describes consent requests and status within the financial-information
ecosystem](https://docs.setu.co/data/account-aggregator/overview). It does not establish a health-data,
family-delegation or third-party action API.

This rail must not turn a family relationship, a payment token or a delivery address into authority. Nor
should it expose a secret claim score. A claim-approval probability without an insurer-validated model
would create false confidence.

## 6. How will a human interact with the agent?

The primary interface is an event-led mobile case, not a generic chat screen or a policy dashboard. The
first question is: **What is happening now?**

The choices are:

- Buy or renew.
- Job or family change.
- Planned admission.
- Claim problem.
- Emergency access.

The case has four working modes:

1. **Per-person view.** People sit on one axis and group or personal policies on the other. Each cell shows
   confirmed cover, unknowns, relevant limitations and source pages. Policies are never added into one
   guaranteed cash number.
2. **Plan an expense.** Patient, procedure, hospital, date and estimate lead to a route: policies that may
   apply, network and pre-authorisation questions, documents, constraints and a conservative cash-needed
   scenario for admission morning.
3. **Buy or renew.** The agent first checks the household's existing map. It can recommend buy, retain,
   switch, defer or "find out X first", with the regulated recommendation gate marked.
4. **Emergency access.** An authorised human opens the same live context, with policy identifiers, support
   contacts, known limits, unknowns and the next administrative task. It is not a static physical card.

Across every mode, the case also keeps:

1. **Today.** One sentence on the situation, next action, owner and deadline.
2. **Questions and answers.** One queue for the household, hospital, HR, TPA, insurer and licensed partner.
   Each question has one owner, one written answer, attempts, deadline and escalation route.
3. **Money.** Premium, deductible, co-pay, hospital deposit, possible upfront cash and unresolved exposure
   remain separate. Optional income, commitments, loans and emergency savings appear only when needed for
   an affordability question.
4. **Evidence.** Original document, version, page citation, extracted fact, confidence and dispute history
   sit together. A correction does not erase the earlier record.
5. **Permissions and people.** Each adult sees who may read, speak or act, for what purpose and until when.
   They can revoke access or nominate a backup without granting blanket family authority.

Voice is another channel into the same case. Gnani can call the named knowledge holder in their preferred
language, read back material facts and write the confirmed answer into the question queue. WhatsApp and
email can collect a document or deliver a brief, but neither becomes a second uncontrolled record.

Outputs change with the event:

- Buy, Renew, Retain, Switch or Defer decision brief.
- Admission Readiness Brief.
- Claim Position Brief.
- Updated per-person cover map.
- Authorised emergency context for the human who answers.

A licensed human appears as a marked gate, not a permanent concierge. They receive disputed facts and
their sources, record their reasoning and return the case to the household. In an emergency, the interface
collapses to policy identifiers, support contacts, named operator, authorised documents and the instruction
to admit first.

## 7. What is the name of the agent?

> **Knowvia**

Coversaath is the internal project name. Knowvia is the current working public name. It supports the
actual promise: know what cover exists, know what remains uncertain and know what to do next.

Name, trademark, domain and company clearance remain unverified.

## 8. Which Indian company has the best chance of creating an agent like this?

> **Policybazaar.**

Policybazaar is closest to the complete loop because it already has insurance shoppers, licensed
distribution, insurer relationships, payment flows and post-purchase support. It could add household
cover reconstruction, permissioned operator mapping, institutional question tracking and continuity
across events faster than a new company can build distribution.

Its possible weakness is incentive, not capability. Knowvia treats retain, defer and no-purchase as
valid outcomes and refuses to recommend before reconstructing existing cover. A conversion-led business
may find that friction hard to prioritise. This is an external inference, not knowledge of Policybazaar's
internal plans.

If Policybazaar builds the same pre-sale household record with credible conflict controls, most current
differentiation disappears.

## Current adversarial assessment

The separate adversarial review returned **REVISE**, with an overall answer score of **7.3/10**.

| Area | Current view |
|---|---|
| Strongest | State design, permission model, reconstruction-first sequence, unknown handling and institutional boundaries. |
| Weakest | Human evidence, tested rail use, licence structure, economics and willingness to complete multi-person consent. |
| Exists locally | Synthetic workflow, deterministic rules, source-linked evidence model, consent and safety gates, persistence, fixture orchestration and fail-closed provider boundaries. |
| Does not exist | Real household workflow, real policy ingestion, real Gnani call, Pine Labs transaction, institutional integration, licensed partner agreement, real purchase or claim case, or demonstrated moat. |
| Main way another team wins | One real household, one real policy, one documented failure and one tested Gnani call can beat a much larger paper architecture. |

## Before submission

1. Run one real household case with redacted documents and recorded permission.
2. Run one planned-care rehearsal with a real patient, hospital estimate and redacted policy evidence. Record
   which question, document or authority stops the route.
3. Test Gnani in at least two relevant language modes and document where insurance terminology,
   consent, context or handoff fails.
4. Test the Pine Labs authorised-payment lifecycle in its test environment. Do not claim that a hospital
   deposit hold works until a hospital merchant and the operating terms are verified.
5. Confirm the 3.92% figure and preserve its organiser source.
6. Obtain qualified review of the licensed recommendation, data handling, delegated authority and
   commission model.
7. Keep the first demonstration focused on one planned-care event after cover reconstruction. Present
   buying, renewal and claim support as connected modes, not three unrelated products.
