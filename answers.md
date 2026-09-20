# Knowvia: submission answers and defence

> **SUPERSEDED — historical working material, 20 September 2026.**
> This file predates the eight consented interviews (5 to 8 September 2026) and the build spec in
> `working/` and `building/`. It still contains retired claims: the "15 college students" research, the
> five-minute readiness drill, the separate physical card, the 18-to-24 student ICP, and statements that
> no parent was interviewed or that evidence is the weakest area. **All of those are retired.**
> Read [AGENTS.md](AGENTS.md) for the current position and `round2_answers.md` for the live answers.
> Kept for provenance. Do not cite from this file.

Updated 20 September 2026. Drafts against the public [The Ken competition questions](https://the-ken.com/case-competition-2026/). Prompts are paraphrased. The private form has not been inspected. No submission has been made.

The source of truth for the current Round 2 eight-question form is
[round2_answers.md](round2_answers.md). Update that file first. The material below retains the earlier
competition answers and supporting defence notes.

**Round 2 status:** not ready to submit unchanged. The product design is specified, but the reported
student conversations, one real household drill, vendor-platform testing and the 3.92% opening share
still need attachable evidence or organiser confirmation. The older ten-question draft is retained below
as an archive and has separate unresolved member inputs.

**North Star:** no household should reach an insurance decision or hospital admission without knowing what cover it has, what remains uncertain, what money it may need and what it should do next.

**USP:** Knowvia reconstructs group and personal cover first, then carries the same household context through buying, renewal, hospitalisation and claim coordination. The Treasury, policy history, disclosure record and emergency handover are internal modules, not separate products.

## Round 2: the eight design questions

These answers respond to the Round 2 email received on 20 September 2026. They supersede the older
ten-question format for this round. The integrations below are proposed uses based on public
documentation. No partnership, production connection or platform test is claimed.

The reported opening share is 3.92%, the third-lowest share of submissions. Treat that as a competition
signal, not customer evidence. It may mean fewer teams to beat within the opening. It may also mean the
problem is difficult, unattractive or poorly understood. It does not prove demand for Knowvia.

### 1. What outcome is the agent accountable for?

> For each buying, renewal or planned-care case, Knowvia delivers a source-linked household decision brief where every material cover, cash and next-action question is confirmed, disputed, unknown or assigned to a named owner and deadline.

Completion is testable: no material question may disappear into a summary, and the household must be
able to identify the next action and owner from the brief. In an emergency, the brief is optional and
must never delay care. The outcome is not “a claim gets approved.” Knowvia cannot bind the insurer, predict an
underwriting decision, choose treatment or guarantee cashless approval. It is accountable for reducing
avoidable uncertainty and unfinished household work, while preserving the institution's authority.

### 2. What level of autonomy does the agent have?

> **L3, inside a permissioned case.**

After the named adults set the purpose, permissions and communication limits, the agent can act without
asking again inside those limits: read evidence, reconstruct cover, identify missing facts, contact an
authorised household member or institution, track responses, compare them with policy wording, revise the
case and produce the next decision brief. It checks citations, conflicts, stale documents and unanswered
material questions before release. A person handles anything outside the agreed limits.

L3 does not give the agent unlimited authority. It must ask before a new person sees data, before a new
institution is contacted outside the agreed scope, before a declaration is submitted, before a licensed
recommendation is accepted, before payment, cancellation, borrowing, investment sale or settlement
acceptance. A licensed expert owns regulated recommendations. The insurer, TPA, hospital and employer
retain their own decisions.

The most consequential action it may take without asking again is to send and chase a pre-approved,
case-specific factual question within an already consented channel. It cannot expand that question into a
new purpose or disclose another adult's record.

### 3. What states does the agent go through?

#### Core state machine

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

Every state contains four visible fields: current owner, evidence used, unresolved question and deadline.
An evidence item is marked confirmed, needs confirmation, missing, conflicting, or reported from memory.
Unknown never means absent.

#### Happy flow

1. **Triggered.** A renewal, new job, family change, planned admission or claim problem creates one case.
2. **Scoped.** The agent names the exact question, patient or buyer, deadline and existing helper. If no
   unresolved job exists, it closes rather than manufacturing work.
3. **Permissioned.** Each adult approves the purpose, records, viewers, channels and revocation rules.
   Patient, policyholder, payer, household operator and backup may be different people.
4. **Evidence collecting.** It requests only relevant policy schedules, wording, endorsements, employer
   benefit booklets, estimates and institution correspondence. Each file receives a version, source,
   owner and timestamp.
5. **Reconstructing.** It creates a household cover map across group and personal cover. It extracts
   members, sum insured, utilisation, room rules, co-pay, deductible, waiting periods, exclusions,
   condition or therapy limits, restoration and top-up dependencies. A headline sum insured is never
   shown as the payable amount.
6. **Assessing.** For buying or renewal, it identifies the uncovered need and viable route. For planned
   care, it creates cash-timing scenarios and the exact questions that remain. For a claim problem, it
   reconstructs what was declared, submitted, acknowledged, queried and decided.
7. **Awaiting gate.** The agent sends permitted questions to the named hospital desk, HR team, TPA,
   insurer or licensed partner. Material ambiguity and regulated recommendations go to a human. The case
   stays open until an answer, deadline or explicit unresolved status exists.
8. **Action ready.** It produces one primary brief: buy, renew, retain, switch, defer, prepare admission,
   supply a document, challenge a mismatch or escalate. Every statement shows source, confidence and
   owner.
9. **Action in progress.** The household approves the action. Payment, policy issuance, pre-authorisation,
   claim submission and settlement remain separate events.
10. **Reconciled.** The agent checks issued terms or institutional responses against the accepted route.
    A mismatch becomes a new owned question, not a silent success.
11. **Recorded.** The permissioned cover map, continuity history, correspondence and handover remain in
    the Household Health Treasury for the next renewal, job change, admission or claim issue.

#### Unhappy flow

| Failure or exception | Agent response | Exit or recovery |
|---|---|---|
| Emergency treatment is underway | Show the smallest available emergency card and say “Admit first. Optimise later.” | Administrative work resumes only when it will not delay care. |
| A named adult has not consented | Hide that adult's data and stop dependent tasks. | Ask that adult directly, narrow the scope or continue without the data and label the gap. |
| Policy or employer booklet is missing | Do not infer that cover is absent. | Request the document or an authorised institutional answer; otherwise mark unknown. |
| Two sources conflict | Preserve both versions, dates and source pages. | Apply the source hierarchy, ask the institution and route material ambiguity to a human. |
| Voice transcript is uncertain | Do not convert uncertain speech into a declaration. | Read back, ask for confirmation, switch language or channel, or send to human review. |
| Insurer, TPA, HR or hospital does not answer | Log attempts and the approaching deadline. | Escalate through the permitted route and issue a brief that states the unanswered question. |
| A rail or API fails | Keep the case and evidence state intact. | Fall back to a permissioned call, email, upload or manual payment route. |
| Payment succeeds but policy is not issued | Never mark the case complete. | Reconcile payment status with the licensed partner and insurer until issued, reversed or disputed. |
| A claim appears weak or excluded | Do not invent an approval probability or coach concealment. | Explain the relevant condition, missing evidence, response route and right owner; obtain formal confirmation. |
| The current adviser already solves the job | Avoid duplicate onboarding. | Work alongside them with permission or close the case. |
| A medical, underwriting or settlement decision is requested | Stop the model from deciding it. | Route to the doctor, insurer, TPA, licensed expert or household decision-maker. |
| Serious source or privacy error is found | Block release and outbound action. | Notify the owner, revoke affected access, correct the record and require review before resuming. |

### 4. What does the agent use and need on each rail?

| Rail | What exists and Knowvia would leverage | What Knowvia must build or validate | Fallback when it is unavailable |
|---|---|---|---|
| **Gnani, voice** | Agent Builder, knowledge bases, configurable voice agents, multilingual behaviour, dynamic pre-call variables, custom actions, call logs, transcripts, dispositions, analytics, audio access and post-call webhooks. Speech APIs also provide real-time, batch and REST STT/TTS for Indian languages. | Per-adult consent bound to each call and record; a household-role map; source-linked read-back; safe caller-to-parent-to-relative-to-human handoff; field-level redaction; insurance vocabulary evaluation; uncertainty handling; revocation, retention and audit rules; resumable follow-up without leaking another adult's facts. | A scoped human call or WhatsApp/email questionnaire. The transcript remains unconfirmed until the speaker approves the material facts. |
| **Pine Labs, payments and authorisation** | Hosted checkout, order creation, cards, UPI, netbanking and wallets, callbacks, payment status, webhooks, refunds and optional payment pre-authorisation/capture flows. | Bind the exact accepted policy quote, premium, commission disclosure, payer permission and case revision to an order; use idempotency and expiry; reconcile payment with the licensed partner; keep authorised, processed, refunded, policy issued and endorsement accepted as separate states. Payment pre-authorisation is not insurance authorisation, and Pine Labs cannot confirm insurance issuance. | Send the licensed partner's approved payment route and manually reconcile the receipt. No payment link appears before the recommendation and disclosure gates pass. |
| **Delhivery, logistics and maps** | Shipment creation, pickup and tracking APIs exist. Maps provides Indian address geocoding, standardisation, validation, verification, routing and distance tools. | **No core first-build role.** If a real case requires physical originals, build a consent token, tamper-evident chain of custody, sensitive-document handling, exact recipient proof and return/destruction status. Address validation may later reduce failed physical correspondence, but it does not verify identity or insurance eligibility. | Secure digital upload, authorised email or household-managed courier. If no physical original is required, do not create a shipment. |

The load-bearing rail is Gnani. Voice reaches the parent, relative or household operator who holds the
missing facts but may not install another app or type policy details. Pine Labs is narrow. Delhivery has
no honest core role today. Saying that is stronger than inventing one.

Documentation checked on 20 September 2026: [Gnani Agent Builder](https://docs.gnani.ai/introduction),
[Gnani Platform API](https://docs.gnani.ai/Platform/platform-introduction),
[Pine Labs hosted checkout](https://www.pinelabs.com/docs/online-payments/hosted-checkout/integration-steps),
[Delhivery B2C APIs](https://one.delhivery.com/developer-portal/documents/b2c/) and
[Delhivery Maps](https://www.delhivery.com/maps/reference). The Gnani console was not tested in this
draft, so console-only behaviour remains unverified.

### 5. Does the agent need a fourth rail?

> **Yes: a Health Insurance Evidence Rail, piloted by Medi Assist for cases it is authorised to administer.**

With the adult's permission, this rail would return source-stamped group membership, applicable benefit
booklet version, insurer and TPA identifiers, network status, pre-authorisation or claim status,
outstanding document queries, response timestamps and the institution that owns the next decision. It
would also accept a structured question and return a written, attributable response.

Medi Assist is the preferred pilot builder because it already sits between employers, members, hospitals and
insurers in health-benefit administration. That makes the company operationally close to the missing
answers. It does not make it neutral or universal. A later industry rail would need permission,
auditability and cross-TPA standards. Without it, Knowvia uses customer documents, official correspondence and manual
institutional follow-up, and labels the remaining unknowns.

Basis for the choice: [Medi Assist says it provides TPA services to insurers and administers employer
and retail health plans](https://www.mediassist.in/about/). This supports proximity to the workflow, not
access to a universal API or willingness to build the proposed rail.

This rail must not expose a secret “claim score.” It should expose evidence, status, reason codes and
ownership. A claims approval probability without an insurer-validated model would create false confidence.

### 6. How does a human interact with the agent?

The primary interface is an event-led mobile case, not a generic chat screen. The first question is:
**What is happening now?** The choices are buy or renew, job or family change, planned admission, claim
problem, or emergency access.

The case then has six fixed views:

1. **Today.** One sentence on the situation, the next action, its owner and deadline.
2. **Household cover map.** People on one axis and group or personal policies on the other. Each cell shows
   confirmed cover, unknowns, relevant limits and the source page. It never adds policies into one
   guaranteed cash number.
3. **Questions and answers.** One queue for household, hospital, HR, TPA, insurer and licensed partner.
   Every question has one owner, one written answer, attempts, deadline and escalation route.
4. **Money view.** Premium, known deductibles or co-pay, hospital deposit, possible upfront cash and
   unresolved exposure remain separate. Optional income, commitments, loans and emergency savings appear
   only when they answer an affordability question.
5. **Evidence drawer.** Original document, version, page citation, extracted fact, confidence and dispute
   history sit together. A user can correct a fact without deleting the earlier record.
6. **Permissions and people.** Each adult sees who may read, speak or act for what purpose and until when.
   They can revoke access or nominate a backup without granting blanket family authority.

Voice is a channel into the same case. Gnani can call the named knowledge holder in their preferred
language, read back material facts and write the confirmed answer into the queue. WhatsApp or email can
collect a document or deliver a brief, but neither becomes a second uncontrolled record.

The agent's outputs change with the event: a Buy/Renew/Retain/Switch/Defer decision, an Admission
Readiness Brief, a Claim Position Brief, an updated Household Health Card or an Optional Backup Handover.
A licensed human appears as a clearly marked gate, not a permanent concierge. They see the disputed
facts and sources, record their reasoning, and return the case to the household. In an emergency, the
interface collapses to policy identifiers, support contacts, named operator, authorised documents and
the instruction to admit first.

### 7. What is the name of the agent?

> **Knowvia**

The internal codename was Coversaath. Knowvia is the public name. It supports
the actual promise: know what cover exists, know what remains uncertain and know what to do next. Name,
trademark, domain and company clearance remain unverified.

### 8. Which Indian company has the best chance of creating the same agent?

> **Policybazaar.**

It is closest to the full loop because it already has insurance shoppers, licensed distribution,
insurer relationships, payment flows and post-purchase support. It could add household cover
reconstruction, permissioned operator mapping, institutional question tracking and continuity across
events faster than a new company can build distribution.

Its possible weakness is incentive, not capability. Knowvia treats retain, defer and no-purchase as
valid outcomes and refuses to recommend before reconstructing existing cover. A conversion-led business
may find that friction hard to prioritise. That is an external inference, not a claim about Policybazaar's
internal plans. If Policybazaar builds the same pre-sale household record with credible conflict controls,
the current differentiation is largely gone.

### Why this may stand out within a 3.92% opening

The originality is not “AI reads an insurance PDF.” Many teams and incumbents can do that. The stronger
sequence is: reconstruct group and personal cover, bind each fact to evidence and permission, identify
the real household operator, make institutions own unanswered questions, then carry the same record from
purchase into admission and claim coordination. The weakest part remains proof that households will
complete this work and that the economics can support the exceptions.

## 1. Members, personal connection and team edge

Limit: 50 words total, one line per member. Rishav's line is based on his reported family experience, not independently verified fieldwork. Tiya's line below explicitly marks missing input; replace it with her own approved words.

> Rishav Dewan: I helped my father buy health cover and spoke with 15 students about whether their families could use theirs in an emergency.
>
> Tiya: My personal connection and contribution still need to be documented before submission.

Do not infer Tiya's contribution from her parents or pressure her to share a difficult family relationship. Ask what work she actually did, what she understands firsthand and which contribution she wants to own.

## 2. One real customer insight and its design effect

Limit: 60 words. **Based on conversations reported by Rishav. Confirm the underlying evidence before submission.**

> Across 15 college students we spoke to, most could not name their family policy. More surprisingly, they expected relatives outside the immediate family to operate it in an emergency. So Knowvia tests that assumption: before recommending cover, a backup person must find the family's existing policy within five minutes.

Do not substitute an invented exact percentage. The observation is unverified delegation outside the immediate household. The design consequence is the five-minute readiness drill, which is a falsifiable test we can pass or fail, not a promise. The claim that parents caused disengagement is a hypothesis, not the finding. Record the exact numerator, question wording, raw answers, participant mix and publication consent before using evidence attachments.

## 3. Six-step agent flow

Limit: one sentence per step, at most 15 words each.

**Trigger**

> A renewal, new job, family change or planned admission starts a real insurance decision.

**Knows**

> It knows consented group and personal cover, household roles, policy history and unresolved facts.

**Does**

> It reconstructs cover, checks crisis-relevant limits, coordinates answers and prepares the next decision.

**Deals with**

> It coordinates with households, hospitals, HR, insurers, TPAs, licensed partners and authorised experts.

**Asks a human**

> People approve sharing, declarations, recommendations, purchases, commission, payment and settlement decisions.

**Done**

> The household has a clear decision, issued terms or a record of what remains unresolved.

Routing a question is not resolving it. A licensed adviser separately reviews the evidence behind every recommendation and is expected to recommend no purchase when existing cover is enough. The household, adviser and insurer have different decision authority. Retaining existing cover, deferral and rejection are recorded completions, not failures.

## 4. Payments, logistics and voice

Limit: one sentence per rail.

**Payments**

> We would use Pine Labs for user-approved premium payment and reconciliation; payment never means policy issuance.

**Logistics**

> Delhivery has no core role: policy evidence, consent and coordination should stay digital and permissioned.

**Voice**

> We would use Gnani for consented multilingual voice intake, read-back and missing-fact collection across household members.

Zerodha is the main partner, not one of these three rails. It is a later optional source for a user-selected affordability scenario, not a default feed or trading rail. Credit, investment and tax data are never needed for a basic coverage decision. These are proposed uses, not established partnerships.

## 5. One missing rail capability

Limit: 40 words. Proposed capability gap to validate, not a verified absence.

> Voice: per-adult consent that survives caller-to-parent-to-relative handoff, carrying source-backed facts and unresolved questions without leaking another adult's records.

Gnani already advertises contextual transfer to people. The novel test is whether adult-specific consent, provenance and disputed interpretations survive across calls and case owners. If the rail already supports this, acknowledge that and identify the actual remaining gap.

## 6. One customer asset

Limit: 30 words.

> Existing policies, employer benefit documents and optional affordability inputs, for a clear cover, cost and next-action view whether they buy or not.

This answers what the customer hands over, not the case file our product creates. Ask only for records relevant to the current buying question. A first-time buyer without an existing policy can supply their employer benefit document instead. The customer keeps authorised access whether or not they buy.

## 7. Adjacent use case

Limit: 30 words.

> Planned admission: reuse the cover map, policy history and permissions to prepare limits, cash questions and institutional follow-up.

This remains conditional planning, not clinical advice or guaranteed coverage. The broader product already anticipates this extension; the competition demonstration centres on completing a purchase.

## 8. One opening you would not delegate, even to flawless AI

Limit: one sentence. **Proposed personal answer; submit only if genuinely yours.**

> Managing my family's health, because I would delegate paperwork but not the responsibility of being present and deciding with them.

This distinguishes administrative assistance from human presence. The answer is not an assertion that AI cannot perform a task accurately under the question's premise.

## 9. An incumbent that could have built it, and why it has not

Limit: 60 words. The reason is explicitly an inference.

> Policybazaar has shoppers, policies and payments. Our agent creates a household-wide cover, affordability and operator record before recommending a sale. My guess: a conversion-led model may find a step that often ends in retain or do-not-buy harder to justify. This is an incentive hypothesis, not knowledge of its plans.

Source: [PB Care+](https://www.policybazaar.com/health-insurance/pb-care-plus/). No claim about undisclosed internal strategy. Explain the actual unresolved task before asserting a competitive gap.

## 10. Track

> Product Strategy.

This reflects the current team direction. Confirm before locking the form. Present the complete buying sequence, segments, exclusions, rail depth and a specific capability request. Do not describe mocked flows as a working Product Build submission.

## Likely follow-up questions

These are preparation questions, not a claim that the organisers will ask them.

### What are you building in plain language?

An agent that reconstructs a family's employer and personal cover, prepares a buying or renewal decision,
then helps the same household use that context during planned care or a claim problem. The Treasury and
policy history sit inside the agent; they are not the product headline.

### Isn't readiness a separate thing from buying?

No. The Treasury is the record created while buying properly. It starts with documents and an optional
continuity check, then adds an affordability plan and card when useful. A drill, policy ledger or finance
dashboard alone would each be a feature. None is the product.

### Who is the first user?

Someone with a live buying decision: a renewal notice, a job change or a family change. The knowledge holder may be a parent or outside relative. A student entering work is a second entry point that brings employer cover into the family map. The premium payer and the person who holds the knowledge are often different people.

### Why would a disengaged young adult act now?

Do not expect monthly insurance interest, and do not assume ignorance becomes action. Use a real transition such as placements, an offer letter or employer-benefit onboarding. Ask one uncomfortable but concrete question: if a parent were admitted tonight, could you find the cover? The pilot must show that this trigger produces a completed decision without repeated researcher chasing. If it does not, that is a real result.

### Who pays, and why not the employer?

Disclosed distribution commission on completed purchases through a licensed partner, plus renewal commission only when that partner services the renewal. The agent handles routine work. Human review is metered at purchase gates, exceptions or a customer request. Employer distribution stays a later channel, not the funder.

### Isn't commission exactly the conflict you criticise?

Yes, and pretending otherwise would be worse. So we build against it: the commission on a recommended product is disclosed in the case record at the time of recommendation and shown before approval; the adviser is permitted and expected to recommend no purchase; adviser pay and case review are not tied to a sale; readiness help and the handover are never gated on buying; retaining existing cover is a first-class recorded outcome; and the purchase, retain, defer and decline mix is reportable. These controls reduce the conflict. They do not remove it, and a commission-funded recommendation is not independent advice. We will not claim it is.

### Won't free human support be expensive?

Possibly enough to kill the model. Measure loaded handling time, repeat contacts and complex-case concentration. The critical number is not the commission rate. It is hours per case and the share of cases ending in no purchase, because those earn nothing and still cost adviser time. Our figures are illustrative sensitivity examples, not evidence in either direction. Do not solve this on paper by assuming AI eliminates most work.

### Why do you ask about income and loans?

Only after we know the cover gap or a planned-care question. Income, fixed commitments, loans, emergency
savings and current premiums can show whether a route is plausible for this household. They are voluntary.
They do not decide eligibility, prove cash is available or replace a financial planner.

### Why not connect every financial account?

The first build should not. Credit reports, full investment holdings and tax records create privacy scope
without helping a basic coverage decision. A household can add selected figures manually. A connector is
justified later only if repeated cases show that a missing source prevents a useful affordability answer.

### Why is consent part of the core product rather than a later step?

Because a buying case depends on records belonging to several adults, so permission is what the whole thing rests on. Each person is a subject with their own scoped, revocable consent. A young adult cannot consent for a parent, a spouse cannot consent for a spouse, and a translation is not consent. Permission checks run in tested code on every read, share and outbound request, never as a model judgement or an inference from family relationship. The correct legal and intermediary structure still needs qualified review before any real household is onboarded.

### Why isn't this just Ditto with AI?

It is, if all we do is explain policies and offer calls. Ditto already serves motivated buyers well. Knowvia differs in order: it will not recommend a policy until existing family and employer cover has been reconstructed from documents and a backup person has been tested. We have not proved that this order is enough differentiation, or that buyers value it enough to switch.

### Why not use Policybazaar or an LLM?

They are valid alternatives. Policybazaar can compare, sell and support claims. An LLM can explain a PDF immediately. Neither fact means a household has had its existing cover reconstructed, verified who can operate it, or preserved that record across employer and retail cover. Existing players can still add these steps.

### Why won't the existing broker do this?

They might, and we should not claim otherwise. First identify the exact question left unanswered after the existing route. Work alongside the adviser when useful. If they already deliver the same outcome with less effort, Knowvia adds no value to that case. Our comparison must measure duplicate calls and extra onboarding as costs, not hide them.

### Do you need people to come back monthly?

No, and we abandoned that idea. Monthly engagement is not a goal or a success metric. Success is a household finishing a real decision it can explain, and the same record being useful again at renewal, a job change or a treatment. Monthly active users would reward engagement the product does not need.

### What did the AI interviews actually contribute?

They exposed possible contradictions worth designing around: the payer may lack medical knowledge; a satisfied adviser user may reject another service; and emotional comfort may coexist with distrust of verbal assurances. Separate interviewers challenged the persona agents' initial answers. We preserve those exchanges and distinguish the interviewee's reaction, interviewer's judgment and our decision. These are simulation-derived design hypotheses, not measured customer findings.

### What did the 15 real conversations contribute?

They named the failure mode. Most students reportedly did not know the family policy and assumed an outside relative would help, without anyone checking. That is why cover reconstruction and operator verification now come before any recommendation. The exact count and raw evidence still need documentation, the reason for the gap is not proved, and knowing about a gap is not the same as acting on it.

### Did parents cause the problem?

Possibly, but we do not know. Parents may exclude children, children may disengage, parents may not understand, or a relative or agent may already own the work. Separate parent and student interviews and a policy-retrieval test must distinguish these explanations.

### Why not call the simulations customer interviews?

Because the respondents are models playing customers. They have not paid a premium, handled a real claim or accepted a real data-sharing trade-off. The exercise can test coherence and expose missing cases, but cannot show which behaviours occur or how often. We call them paired AI-simulated interviews and attach their actual logs, not fictional human fieldwork.

### Why do you need agents?

For reading changing documents, reconstructing cover across several sources, collecting missing facts, drafting targeted questions and tracking replies over time. Calculations, permission checks and commission disclosure need tested code, not prompts. A chatbot that gives one answer and forgets the case would not perform the proposed job.

### Why several agents rather than one?

Some document and evidence tasks can run independently. Separate roles can make errors easier to inspect. They are not automatically more accurate; correlated errors remain. Use multiple agents only where evaluation shows a benefit.

### Why keep a human if the AI is good?

The agent does routine reading, calls with consent, follow-up, planning and card updates. The licensed human
enters for a purchase recommendation, material ambiguity, exception or a customer request. Their minutes
per completed decision are measured. Neither person can bind the insurer.

### What can the AI do autonomously?

It can read and cite documents, reconstruct the cover map, request records with consent, run the drill,
calculate an affordability scenario, update the card, track deadlines and brief an adviser. A person must
approve sharing, financial inputs, declarations, purchase, cancellation, payment and settlement acceptance.

### Can the human guarantee the answer?

No. They can own their interpretation and actions, but not the insurer's underwriting or claim decision. The case must distinguish adviser assessment from institutional confirmation.

### What happens in an emergency?

Admit first. Optimise later. Provide accessible policy and support details; never make treatment wait for an AI analysis, document upload or expert callback. Do not pretend a support line replaces emergency medical services.

### What if there is no coverage?

Say so within the evidence available and help establish the remaining options. Do not turn hope into an eligibility promise. A service that exposes a shortfall has not necessarily made the expense affordable.

### How do you prevent incorrect reassurance?

Link important claims to sources, preserve unresolved status, require review for high-impact ambiguity and test negative cases. Block any recommendation made before cover has been reconstructed, and any approval without recorded commission disclosure. Show payment, issuance, authorisation and settlement separately. Track serious errors and stop the affected workflow.

### If you later sell through employers, can they see employee family records?

Not by default, and this is why the employer channel is deliberately last. Employment-based access would not justify unrestricted medical access. Adults need role-specific permissions, employer reporting must be limited and designed against reidentification, and the visibility rules must be written before selling into any employer.

### What happens at a job change?

Employer cover is updated on the same household record, which may expose a new gap and start a fresh buying case. The customer keeps personal access and export of their authorised records regardless of employment, and open cases have a defined transfer. Never imply employer insurance continues just because records remain accessible.

### Why use the sponsors?

Voice is load-bearing because it reaches the parent or relative who holds missing policy facts. Payments
complete approved premiums. Logistics has no core role because consent and policy flow should be digital.
Zerodha is a later optional source for a selected affordability scenario, not a trading rail.

### What is the moat?

There is no demonstrated moat today, and Ditto or Policybazaar can copy the order we propose. A Treasury
with verified operators, versioned policy facts, disclosure history, affordability decisions and actual
outcomes could compound into an advantage. It is an accumulating-record bet, not a network effect, and
may still be a feature of a platform rather than a company.

### How large is the market?

Not responsibly estimated yet. Build it bottom-up: households with a live trigger, those who complete a
cover map, those who use affordability planning when relevant, those who reach a decision, those who buy,
average commission and renewal retention. National healthcare expenditure does not establish revenue.

### What evidence do you have today?

Rishav reports 15 actual student conversations. Most lacked family-policy knowledge and expected outside
relatives to help. The exact count, raw answers, participant mix and consent are pending. We also have
public sources and eight fictional ICPs tested in five paired AI simulations. We have no completed
purchase, affordability-plan behaviour, measured demand or paid pilot. Ignorance is not demand.

### Where are the sub-agents' own opinions?

Each pair's independent audit is preserved beside its transcript in [the customer research file](research/02-customer-tests.md). It distinguishes the persona's conditional reaction, the interviewer's critique and the main agent's decision. The result is not a single rewritten consensus paragraph. Refusal cases and generation errors remain visible.

### What changed because the interviewers contradicted the personas?

The service must identify its unresolved task before collecting a broad record. It must collaborate with or defer to an existing adviser when that route works. A hypothetical treatment does not automatically need an active case. A cash answer can remain unresolved without forcing financial access. These are design changes to test, not discoveries about how common the problem is.

### What would make you stop?

Households will not supply their existing policy documents, the reconstruction step changes no decisions, existing support consistently does the same job, buyers distrust a commission-funded recommendation despite disclosure, serious errors cannot be contained, or hours per case exceed what the distribution income can carry. We should report that rather than add unrelated features to rescue the story.

### What should be built next?

One manual buying case end to end: reconstruct real cover, verify the operator, run a cold drill, name
the gap, collect voluntary income and loan inputs only if needed, produce the Household Health Card, then
buy, retain or defer. The staged implementation is in [the architecture](research/03-architecture.md).

## Final pre-submission check

- Confirm member names, roles, personal statements and track.
- Document the exact count, question wording, raw answers, participant mix and consent behind Answer 2.
- Confirm permission for every published quote, recording and personal detail.
- Keep simulations visibly fictional, including in screenshots and attachments.
- Check no answer or slide reintroduces employer-funded support as the payer.
- Check no answer or slide turns the Treasury into a generic wealth-management app or assumes financial data is compulsory.
- Check the commission disclosure and no-purchase path are visible in the demo, not only in the text.
- Recount limits in the actual form; its counter takes precedence over local counting.
- Check dates, upload rules and whether the organiser has changed the public instructions.
- Verify sponsor usage is proposed or working as stated, with no fake integration claims.
- Submit only through the user's explicit approval; this pack has not been submitted.
