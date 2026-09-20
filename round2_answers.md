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

## Current position

**North Star:** no household should reach an insurance decision or planned hospital admission without
knowing what cover it has, what remains uncertain, what money it may need and what it should do next.
During an emergency, the record should be immediately available but must never delay care.

**USP:** Knowvia reconstructs group and personal cover first, then carries the same household context
through buying, renewal, hospitalisation and claim coordination.

The Household Health Treasury, policy continuity record, disclosure history, correspondence tracker,
Admission Readiness Brief and backup handover are capabilities inside Knowvia. None is the product alone.

The reported opening share is 3.92%, the third-lowest share of submissions. This is a competition signal,
not customer evidence. It may mean fewer comparable submissions. It may also mean the opening is harder,
less attractive or poorly understood. It does not prove demand.

## 1. What is the outcome your agent is accountable for?

> For each buying, renewal or planned-care case, Knowvia delivers a source-linked household decision brief where every material cover, cash and next-action question is confirmed, disputed, unknown or assigned to a named owner and deadline.

Completion is testable:

- No material question disappears into a summary.
- Every important statement links to evidence or is labelled as reported from memory.
- The household can identify its next action, owner and deadline from the brief.
- Group cover, personal cover, available cash, loans and investments remain separate.
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
  -> RECONSTRUCTING
  -> ASSESSING
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
4. **Evidence collecting.** Knowvia requests only the policy schedules, wording, endorsements, employer
   benefit booklets, estimates and correspondence relevant to the case. Each source receives an owner,
   version and timestamp.
5. **Reconstructing.** It creates a household cover map across group and personal cover. It separately
   records membership, sum insured, utilisation, room rules, co-pay, deductible, waiting periods,
   exclusions, therapy or condition limits, restoration and top-up dependencies. A headline sum insured
   is never shown as the payable amount.
6. **Assessing.** For buying or renewal, it identifies the uncovered need and feasible routes. For planned
   care, it creates cash-timing scenarios and institutional questions. For a claim problem, it reconstructs
   what was declared, submitted, acknowledged, queried and decided.
7. **Awaiting gate.** Knowvia sends permitted questions to the named hospital desk, HR team, TPA, insurer
   or licensed partner. Material ambiguity and regulated recommendations go to a human. The case remains
   open until an answer, deadline or explicit unresolved status exists.
8. **Action ready.** It produces one primary brief: buy, renew, retain, switch, defer, prepare admission,
   supply a document, challenge a mismatch or escalate. Each statement shows source, status and owner.
9. **Action in progress.** The household approves the action. Payment, policy issuance, pre-authorisation,
   claim submission and settlement remain separate events.
10. **Reconciled.** Knowvia checks issued terms or institutional replies against the accepted route. A
    mismatch becomes a new owned question, not a silent success.
11. **Recorded.** The permissioned cover map, continuity history, correspondence and handover remain in
    the Household Health Treasury for the next renewal, job change, admission or claim issue.

### Unhappy flow

| Failure or exception | What Knowvia does | Exit or recovery |
|---|---|---|
| Emergency treatment is underway | Shows the smallest available emergency card and says “Admit first. Optimise later.” | Administrative work resumes only when it cannot delay care. |
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
| **Gnani, voice** | Agent Builder, knowledge bases, configurable voice agents, multilingual behaviour, dynamic pre-call variables, custom actions, call logs, transcripts, dispositions, analytics, audio access and post-call webhooks. Speech APIs provide real-time, batch and REST STT/TTS for Indian languages. | Bind per-adult consent to each call and record; household-role mapping; source-linked read-back; safe caller-to-parent-to-relative-to-human handoff; field-level redaction; insurance-vocabulary evaluation; uncertainty handling; revocation and retention rules; resumable follow-up without leaking another adult's facts. | A scoped human call or WhatsApp/email questionnaire. Material voice facts remain unconfirmed until the speaker approves them. |
| **Pine Labs, payments and authorisation** | Hosted checkout, order creation, cards, UPI, netbanking, wallets, callbacks, payment status, webhooks, refunds and optional payment pre-authorisation and capture. | Bind the accepted policy quote, premium, commission disclosure, payer permission and case revision to an order; add expiry and idempotency; reconcile payment with the licensed partner; keep authorised, processed, refunded, policy issued and endorsement accepted as separate states. Payment pre-authorisation is not insurance authorisation. | Use the licensed partner's approved payment route and reconcile the receipt manually. No link appears before the recommendation and disclosure gates. |
| **Delhivery, logistics and maps** | Shipment creation, pickup and tracking. Maps provides Indian address geocoding, standardisation, validation, verification, routing and distance tools. | **No core first-build role.** If a real case needs physical originals, build a consent token, tamper-evident chain of custody, sensitive-document handling, exact-recipient proof and return or destruction status. Address validation does not verify identity or insurance eligibility. | Secure digital upload, authorised email or a household-managed courier. If no physical original is required, do not create a shipment. |

The load-bearing rail is Gnani. Voice reaches the parent, relative or household operator who holds the
missing facts but may not install another app or type policy details. Pine Labs is narrow. Delhivery has
no honest core role today.

Documentation checked on 20 September 2026:

- [Gnani Agent Builder](https://docs.gnani.ai/introduction)
- [Gnani Platform API](https://docs.gnani.ai/Platform/platform-introduction)
- [Pine Labs hosted checkout](https://www.pinelabs.com/docs/online-payments/hosted-checkout/integration-steps)
- [Delhivery B2C APIs](https://one.delhivery.com/developer-portal/documents/b2c/)
- [Delhivery Maps](https://www.delhivery.com/maps/reference)

The Gnani console has not been tested for this submission. Console-only behaviour remains unverified.

## 5. Does the agent need a fourth rail?

> **Yes: a Health Insurance Evidence Rail, piloted by Medi Assist for cases it is authorised to administer.**

With the adult's permission, this rail would return:

- Group membership and the applicable benefit-booklet version.
- Insurer and TPA identifiers.
- Network status with source and timestamp.
- Pre-authorisation or claim status.
- Outstanding document or information queries.
- Response timestamps and reason codes.
- The institution that owns the next decision.
- A written, attributable answer to a structured question.

Medi Assist is the preferred pilot builder because it already operates between employers, members,
hospitals and insurers in health-benefit administration. This makes it operationally close to the missing
answers. It does not make Medi Assist neutral or universal. A later industry rail would require common
permission, audit and cross-TPA standards.

Without this rail, Knowvia uses customer documents, official correspondence and manual institutional
follow-up. Any missing answer remains unknown.

[Medi Assist says it provides TPA services to insurers and administers employer and retail health
plans](https://www.mediassist.in/about/). This supports its proximity to the workflow. It does not prove
that an open evidence API exists or that the company would build it.

This rail should expose evidence, status, ownership and reason codes. It should not expose a secret claim
score. A claim-approval probability without an insurer-validated decision model would create false
confidence.

## 6. How will a human interact with the agent?

The primary interface is an event-led mobile case, not a generic chat screen. The first question is:
**What is happening now?**

The choices are:

- Buy or renew.
- Job or family change.
- Planned admission.
- Claim problem.
- Emergency access.

The case has six fixed views:

1. **Today.** One sentence on the situation, next action, owner and deadline.
2. **Household cover map.** People on one axis and group or personal policies on the other. Each cell shows
   confirmed cover, unknowns, relevant limitations and source pages. Policies are never added into one
   guaranteed cash number.
3. **Questions and answers.** One queue for the household, hospital, HR, TPA, insurer and licensed partner.
   Each question has one owner, one written answer, attempts, deadline and escalation route.
4. **Money.** Premium, deductible, co-pay, hospital deposit, possible upfront cash and unresolved exposure
   remain separate. Optional income, commitments, loans and emergency savings appear only when needed for
   an affordability question.
5. **Evidence.** Original document, version, page citation, extracted fact, confidence and dispute history
   sit together. A correction does not erase the earlier record.
6. **Permissions and people.** Each adult sees who may read, speak or act, for what purpose and until when.
   They can revoke access or nominate a backup without granting blanket family authority.

Voice is another channel into the same case. Gnani can call the named knowledge holder in their preferred
language, read back material facts and write the confirmed answer into the question queue. WhatsApp and
email can collect a document or deliver a brief, but neither becomes a second uncontrolled record.

Outputs change with the event:

- Buy, Renew, Retain, Switch or Defer decision brief.
- Admission Readiness Brief.
- Claim Position Brief.
- Updated Household Health Card.
- Optional Backup Handover.

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
2. Run the five-minute retrieval and backup drill. Record the failure, not only the success.
3. Test Gnani in at least two relevant language modes and document where insurance terminology,
   consent, context or handoff fails.
4. Confirm the 3.92% figure and preserve its organiser source.
5. Obtain qualified review of the licensed recommendation, data handling and commission model.
6. Keep the first demonstration focused on buying or renewal after cover reconstruction. Present planned
   admission and claim support as continuity, not as three additional products.

