# Knowvia: Round 2 answers

Master submission draft, revised for the organiser FAQ on 22 September 2026. Paste only the eight
numbered responses into the form. The appendix is supporting material for a judge, presentation or later
Product Strategy stage. No Round 2 field-level word limit has been supplied in the organiser email yet.

These answers are based on eight consented interviews across six households, conducted between 5 and 8
September 2026. The sample is directional, not representative. All respondents were privately insured and
none used a state scheme. We went looking for policy-understanding gaps. We did not expect seven of 19
collected documents to disagree with the household's own account, or a family to require different emergency
access for an operator and a son. Those findings changed the design. It also incorporates Shilpa Arora's
public feedback on an earlier architecture. Proposed rail integrations are product designs, not built or
contracted integrations.

## 1. What is the outcome your agent is accountable for? One sentence.

**For every health-insurance event, Knowvia is accountable for getting the family to the next insurance
action, or to a named human or institutional handoff with the exact blocker, evidence, owner and deadline.**

## 2. What is the level of autonomy your agent has?

**L4: Knowvia plans, carries out and checks a multi-step insurance case inside standing household limits,
then comes back when a person or institution must decide.**

This is the level of the agent we are designing, not only what can be assembled from the three rails today.
After a named adult sets a standing permission, Knowvia can run a case plan without returning for each
routine step: collect the named documents, read them, find contradictions, ask approved factual questions,
chase the responsible party, check every output against its sources and keep going until the next action is
complete or it is genuinely blocked. The most consequential thing it does without asking again is send a
narrow factual request through an already approved channel and update the case record from the reply.

Standing permission names the institution, purpose, information class, expiry and escalation route. It
allows a question to be sent. It does not oblige an insurer, TPA, employer or hospital to answer a third
party, and it never turns Knowvia into the decision-maker.

Inside those limits, Knowvia can:

- Read policy wordings, schedules, endorsements, employer booklets and hospital estimates.
- Reconstruct available cover for each person. Eligibility alone is not treated as enrolment.
- Find missing, conflicting or time-sensitive information.
- Apply policy clauses to the person's event and estimate likely cash exposure.
- Contact an approved family member or use an approved institutional channel with a narrow factual question.
- Track replies, deadlines, policy versions and unresolved questions.
- Check its own output for missing sources, conflicting evidence and unsupported conclusions.
- Re-plan when a reply changes the route, then close the case only when the action is completed or the
  remaining blocker has a named owner and deadline.

It must ask before:

- Sharing protected information with a new person or institution.
- Sending a medical declaration or proposal answer.
- Accepting a licensed recommendation.
- Paying a premium.
- Filing a claim or accepting a settlement.
- Taking any borrowing or investment action.

Autonomy deliberately falls during an emergency. Pressing `Emergency access` calls a human support
operator directly. The AI only retrieves and displays a permissioned Emergency Case Brief. It does not
triage the patient, recommend treatment, delay admission, promise cashless approval or decide whether a
claim will pass.

This boundary comes from the research. T8 (55, Kolkata) allowed full emergency access in advance but did not
want her son to see the reason behind a condition in her declaration [T8 00:02:16; T8 00:03:06]. A household
cannot be treated as one permission boundary. Access must be granted per person, per information class and
per viewer.

L4 does not mean Knowvia can override an insurer, give clinical advice or spend the household's money. It
means it owns the operational sequence around those decisions and reports back when the sequence reaches a
decision it cannot take.

**What is missing to make this real:** today, Knowvia can work from household documents and approved manual
follow-up. The proposed Insurance Confirmation Rail would let an authorised request receive structured,
case-specific institutional status. Until then, a non-response remains **Dynamic** or **Unknown**, not a
hidden failure or an invented answer. That is the specific gap between an L4 design and an L4 service in
production.

## 3. What states does your agent go through? Share the happy and unhappy flow.

### Entry

The user starts with one of two real decisions:

| Entry route | User need | Output |
|---|---|---|
| **Plan an expense** | Plan a pregnancy, procedure, parent-care need, renewal or existing claim issue | Cover route, cash scenarios, documents and next actions |
| **Find and buy personal health cover** | Replace missing, ending or inadequate protection | Existing-cover reconstruction, comparison, one ranked recommendation and optional purchase |

Renewal is not a third route. It appears inside either route when protection is nearing expiry or must be
replaced.

### Happy flow

```text
1. CASE OPEN
   EVENT + PERMISSION
   A person, purpose and access boundary are named.
             ↓
2. EVIDENCE INTAKE
   SOURCE PACK
   Knowvia requests the exact schedule, wording, employer booklet,
   endorsement, estimate or medical document needed for the case.
             ↓
3. CASE ANALYSIS
   PARALLEL READING
   Bounded specialist checks assess enrolment, benefits, exclusions,
   hospital, estimate lines, cash exposure and evidence.
             ↓
4. DECISION READY
   CASE APPLICATION
   The policy rules are applied to this person, event, hospital and bill.
             ↓
5. PLAN ISSUED
   DECISION BRIEF
   The family sees one route, cash scenarios, next actions and source pages.
             ↓
6. WAITING ON INSTITUTION
   INSTITUTIONAL CONFIRMATION
   Time-sensitive facts are checked with the responsible insurer, TPA,
   employer or hospital desk when authority exists.
             ↓
7. WAITING ON HOUSEHOLD
   HUMAN APPROVAL + ACTION
   The household approves sharing, declarations, payment or filing.
             ↓
8. TRACKING
   TRACKING + RECONCILIATION
   Knowvia tracks issuance, pre-authorisation, claim status and the final outcome.
             ↓
9. RESOLVED OR BLOCKED
   CLOSE OR RETURN STUCK
   It closes with proof of completion, or returns the exact blocker, owner and deadline.
```

Every material fact carries one evidence state:

| State | Meaning |
|---|---|
| **Proven** | Supported by an exact source, page and clause |
| **Calculated** | Derived from shown inputs and a visible formula |
| **Reported** | Supplied by a person but not yet verified |
| **Dynamic** | Can change and needs a dated institutional answer |
| **Unknown** | The required source is missing or unreadable |
| **Conflicting** | Two sources disagree and both remain visible |

These are bounded checks, not seven human teams or seven irreversible actions. They create one case record,
and the user sees a decision brief only after the evidence check identifies what is proven, calculated,
dynamic, unknown or conflicting.

These states came from real failures. Seven of 19 collected documents contained a schedule field that did
not match the family's own account. One sister's date of birth was recorded six years wrong. T6 (33, Pune)'s
employer cover ended without a notification: "Nothing happened. That's the thing" [T6 00:01:26]. The
system therefore cannot turn missing, old or disputed information into a confident answer.

### Unhappy flow

| Failure | What Knowvia does |
|---|---|
| Medical emergency | **Admit first.** Call the human operator and move insurance work behind treatment |
| Permission missing | Stop the affected task and ask the relevant adult |
| Policy missing | Mark it Unknown and ask the approved holder for the named document |
| Sources conflict | Preserve both, block the affected conclusion and seek clarification |
| Person is eligible but not enrolled | Do not report them as covered |
| Hospital network status is old or unclear | Mark it Dynamic and do not promise cashless treatment |
| Institution does not reply | Record attempts, show the deadline and escalate through an approved route |
| Institution replies with an answer that conflicts with the document | Keep both sources visible, block the affected conclusion and assign the contradiction to the institution that owns it |
| Institution says it cannot speak to Knowvia | Give the household a one-tap approval or direct-contact route. Do not impersonate the household or fabricate authority |
| Employer HRMS data and the employee booklet differ | Treat HRMS as a source, not truth. Request the current booklet, schedule or HR confirmation and mark the field Conflicting |
| Voice transcript is unclear or a material fact was not read back | Keep it Reported, do not turn it into a declaration and ask for correction by voice, text or document |
| Gnani call is unanswered, fails or times out | Do not retry silently. Send the written next action through WhatsApp or the app and preserve the incomplete voice task |
| Rail endpoint is unavailable, unauthorised or rate-limited | Preserve the case, expose the failed check as Dynamic or Unknown, retry only within a visible policy and offer the manual route |
| Pre-authorisation is delayed or denied | Show deposit and reimbursement scenarios; do not call it a final claim rejection |
| Premium paid but policy not issued | Keep the purchase unresolved until issuance, reversal or dispute resolution |
| Payment callback is missing, invalid or inconsistent with the order record | Verify the callback signature, poll the order status, and keep payment unconfirmed until the two agree |
| Payment fails or the user abandons checkout | Leave the recommendation intact, mark payment incomplete and never substitute another policy or payment method without approval |
| Hospital address or route is uncertain | Show the address-confidence result and direct contact, not a false claim that the hospital is the right insurance desk |
| User asks to hide medical history | Refuse to coach concealment and require an accurate declaration |
| User asks for medical advice | Route to the treating clinician |

The output is complete only when each material question is answered from a source, explicitly marked
Unknown, or assigned to a named person or institution with a deadline.

## 4. On each rail, what exists and what must be built?

WhatsApp is Knowvia's main working surface for documents, reminders and written next actions. It is not a
competition rail and it is not an alternate source of truth. It writes into the same permissioned case record
as the app and voice. An employer HRMS is a possible **source** of group-cover data, not an acquisition
channel and not a requirement. If it is unavailable or disagrees with the policy schedule, Knowvia asks for
the booklet, schedule or HR confirmation and marks the result Conflicting.

| Rail | Exact existing call and what it returns | How Knowvia uses the return | What Knowvia must build | Hard boundary |
|---|---|---|---|---|
| **Gnani: voice** | For sandbox validation, `POST /v1/agents/{botId}/trigger_call` returns a `clientReferenceId`. `POST /v1/conversations/logs` finds the `conversationId`; `GET /v1/conversations/{conversationId}/stats` returns `callStatus`, turn-by-turn `utteranceAnalytics`, detected language, a disposition and latency. Gnani also supports a custom on-call HTTP action. | After an optional intake call, Knowvia takes only the transcript, speaker, language and call outcome into a voice draft. It reads material facts back for approval before those facts affect a case. | A permission-aware `voice-draft` action and case-record writer: it must accept only allowed fields, attach speaker and consent, ask for read-back, and return `accepted`, `needs-correction` or `blocked`. | The Gnani result is a transcript, not a verified health fact. Gnani does not analyse policy wording and never sits in the emergency route. |
| **Pine Labs: payments** | `POST /api/auth/v1/token` returns an access token. `POST /api/checkout/v1/orders` creates an order and returns a checkout URL. The callback returns `order_id`, `status` and `signature`; `GET /api/pay/v1/orders/{order_id}` returns the current order and payment status. | After human approval, Knowvia creates one premium order, opens the returned checkout URL, verifies the signed callback, then polls the order until payment is `PROCESSED`, `FAILED`, `CANCELLED` or another documented state. | A transaction record joining recommendation, insurer quote, declaration approval, Pine order, verified payment, policy issuance and endorsement. The missing link is insurer issuance confirmation, not payment collection. | Payment success is not policy issuance. Pine Labs is not used for hospital deposits, underwriting, claims or claim decisions. |
| **Delhivery: logistics and maps** | `POST /validate` returns address quality, granularity and a corrected address. `POST /geocode` returns latitude, longitude and `error_radius`. `POST /route` returns driving distance, duration and route. | Only after Knowvia has already confirmed the hospital and its insurance desk from an insurance source, it validates the desk address and gives the family a route and ETA. | A verified desk directory that joins the insurer or TPA's dated desk confirmation to one address and contact. For any later original-document shipment: consent, chain of custody, exact-recipient proof and return or destruction status. | Address quality, distance and route do not prove hospital network status or cashless eligibility. |

### Gnani in practice

Voice is useful because the person operating the case and the person holding the information can be
different. The user can choose voice for themselves or another adult can provide information with that
person's permission. Gnani turns speech into a structured draft. A voice-sourced health fact stays
**Reported** until it is read back and approved or supported by a document.

The documented ceilings shape the design. An agent supports a maximum of three languages, which this
research already used: English, Hindi and Bengali. The FAQ limit is 100. Agent Chaining is bot to bot, not a
documented bot-to-human warm transfer. There is no documented multi-party call or mid-call event stream.
Knowvia therefore does not make a decision during a call that needs live supervision: Gnani captures a draft,
the call ends, and the main case record checks, labels and routes it. Emergency access bypasses Gnani and
reaches the human operator directly. We will use the Gnani sandbox to test this exact intake, read-back and
failed-call flow before presenting the rail as validated. It is not yet a tested production integration.

### Pine Labs in practice

Pine Labs appears only after the product has reconstructed existing cover and a human has approved one of
two actions: renew an existing policy or buy a selected personal policy. We considered using a payment hold
for a hospital deposit and rejected it. No hold-expiry window is documented, hospital merchant eligibility
is unverified, and placing a payment instrument before treatment conflicts with "admit first".

### Delhivery in practice

Delhivery is useful but not central. Knowvia will not invent a parcel workflow to make the rail look more
important. The first build uses Maps for address and route quality after the hospital and desk have been
confirmed through an insurance source. Original-document shipment remains an optional later workflow, only
when an institution specifically requires it and chain of custody can be proved.

Documentation reviewed: [Gnani Agent Builder](https://docs.gnani.ai/introduction),
[Gnani Platform API](https://docs.gnani.ai/Platform/platform-introduction),
[Gnani conversation statistics](https://docs.gnani.ai/Platform/Get_Conversation_Stats),
[Pine Labs hosted checkout](https://www.pinelabs.com/docs/online-payments/hosted-checkout/integration-steps),
[Pine Labs order lookup](https://www.pinelabs.com/docs/online-payments/api/orders/get-order-by-id) and
[Delhivery Maps](https://www.delhivery.com/maps/reference). The Gnani sandbox test is the one remaining
rail-validation task. No live payment, logistics or production call is needed for this round.

## 5. Does the agent need a fourth rail?

**Yes. Knowvia needs an Insurance Confirmation Rail, and Medi Assist is the Indian company best placed to
build it.**

This is Knowvia's load-bearing rail: without an authoritative status route, the product can prepare a case
but cannot responsibly convert changing institutional facts into confirmation.

Knowvia can read a policy document, but it cannot make a changing institutional fact authoritative. Member
status, latest endorsement, TPA ownership, hospital network status, document receipt, pre-authorisation and
claim progress live in different systems. The current product must mark these facts **Dynamic** and ask the
family to confirm them manually.

The fourth rail would return a dated, case-specific response containing:

- Active policy and named-member status.
- Latest endorsement and confirmed TPA.
- Current hospital network status.
- Required documents and whether they were received.
- Pre-authorisation or claim status.
- Pending action, responsible institution and escalation route.

It would confirm status. It would not guarantee approval.

This need was sharpened by feedback on our earlier architecture. Shilpa Arora, COO of Insurance Samadhan,
pointed out to us that a ₹10 lakh sum insured can still contain a ₹2 lakh immunotherapy cap, corporate-policy
coverage may remain undisclosed until an employee reaches HR during hospitalisation, and three different
entities process information: the hospital TPA desk, the TPA and the insurer. Her conclusion was that the
process breaks at several points, but can be solved. [Public comment on the earlier
architecture](https://www.linkedin.com/posts/rishav-dewan_%F0%9D%97%9B%F0%9D%97%B2%F0%9D%97%AE%F0%9D%97%B9%F0%9D%98%81%F0%9D%97%B5-%F0%9D%97%B6%F0%9D%97%BB%F0%9D%98%80%F0%9D%98%82%F0%9D%97%BF%F0%9D%97%AE%F0%9D%97%BB%F0%9D%97%B0%F0%9D%97%B2-%F0%9D%97%B6%F0%9D%98%80-%F0%9D%97%BB%F0%9D%97%BC-activity-7505177397751697408-25Lz)

The current architecture changed because of that feedback. It now:

1. Extracts treatment-specific inner caps instead of showing only the headline sum insured.
2. Requests the employer booklet and proof of enrolment before hospitalisation.
3. Records whether the hospital desk, TPA or insurer owns the next answer.

Medi Assist is a credible builder because it already operates between insurers, hospitals and
policyholders through [network-hospital, hospitalisation, pre-authorisation and claim-tracking
workflows](https://mediassist.in/products-tech/). The rail's hardest requirement is delegated
authority: proof that a named adult authorised a named person or agent to ask a specific institution for a
specific answer, for a limited purpose and period, with revocation and an audit trail. Setu's Account
[Aggregator consent objects](https://docs.setu.co/data/account-aggregator/consent-object) are useful prior
art for purpose, approval, expiry and status, but they do not currently create a health-data or
family-delegation rail.

Medi Assist building this rail would not make its recommendation layer neutral. The rail returns dated
facts. The conflict begins when a product recommends whether to retain, replace or buy cover. This is why
Medi Assist can be the right builder for a status rail while Policybazaar can still be the stronger answer to
Question 8, which asks who could build the whole agent.

Without the rail, Knowvia still works through customer documents, narrow consent and manual follow-up, but
decision-critical facts remain visibly Dynamic.

## 6. How will a human interact with the agent?

### First screen: the household matrix

Knowvia opens with people, not policy PDFs.

| Person | Policies found | Immediate issue | Evidence status | Next action |
|---|---|---|---|---|

Selecting a person shows:

1. What is confirmed.
2. What could create a problem.
3. What cash may be needed.
4. What to do next.
5. The source pages behind the answer.

The household then chooses `Plan an expense` or `Find and buy personal health cover`.

### Decision first, proof on demand

Every answer has four layers:

| Layer | What the user sees |
|---|---|
| **Decision** | One recommended route and the next three actions |
| **Financial** | Low, expected and high cash scenarios |
| **Evidence** | Policy version, page, clause, source date and calculation |
| **Research** | Official network information, comparison data, complaint patterns and public discussion, ranked by reliability |

For a planned delivery, the first answer might read:

> Use the group policy as the first route at this hospital, subject to the listed enrolment and maternity
> conditions. Keep ₹[range] available because [named cap] may remain payable. Submit pre-authorisation
> through [named desk] by [date].

`Why` expands the clauses and calculation. This follows T4's instruction: "An app told me" would not settle
an argument with her relative-agent, but "it says here, page fourteen" could [T4 00:06:06].

### Channels

| Channel | Role |
|---|---|
| **App** | Household matrix, evidence, calculations and permission controls |
| **WhatsApp** | Document forwarding, deadline nudges, written next actions and institutional replies |
| **Gnani voice** | Optional intake and read-back for someone who prefers speaking |
| **Emergency access** | One button that calls a human support operator directly; neither WhatsApp nor Gnani sits in front of it |

WhatsApp is the main working surface, but it is not one of The Ken's rails. Gnani reaches people who prefer
or need voice. Both write into the same case record, so neither becomes an uncontrolled second record.

### Emergency interaction

T5 (31, Kolkata) lost seven hours between 2 a.m. and 9 a.m. while trying to identify his brother's employer
cover. He said one button is the maximum acceptable interface and two screens are already too many [T5
00:04:22]. He expected the person answering to know the policy context already [T5 00:04:36].

Pressing `Emergency access` therefore calls a human support operator directly. The operator receives a
permissioned, read-only Emergency Case Brief containing the e-card, policy and TPA details, named member,
hospital, dated network status or a visible unknown, relevant caps, likely immediate cash, documents and
current escalation status.

The operator helps with insurance coordination, not clinical advice. The first rule is **admit first,
optimise later**.

This route cannot launch until Knowvia has an operator rota, escalation rules, backup routing and measured
time-to-human. An office-hours route is not emergency access. Until the service can prove real on-call
coverage, it must state that human support is unavailable and provide the prepared brief and direct routes to
the hospital insurance desk, TPA, insurer or HR. A pilot measures answered-call rate and time-to-human before
it promises this route to households.

### Household control

One adult operates the case by default, but any covered adult can open their own case, correct a fact,
provide a document or use voice. A family member can enter another adult's information only within that
adult's permission.

Permissions are per person, per viewer and per information class:

- **Cover:** whether cover exists, sum insured and enrolment.
- **Operational:** policy number, member ID, TPA route, network status and desk contact.
- **Protected:** medical declarations, conditions, claim reasons and underwriting details.

T8's rule was "the number yes, the reason no" [T8 00:02:52]. Her son could see that cover existed
and where money would come from, but not the medical reason behind a declaration. She separately approved
full emergency access for a moment when she might be unable to speak [T8 00:02:16]. That is why a single
household permission switch is not enough.

## 7. What is the name of the agent?

**Knowvia**

Descriptor: **Understand your insurance before you need it.**

Product line: **Know what you have. Know what could go wrong. Know what to do next.**

The name reflects the product's job: convert scattered insurance documents and institutional replies into
a source-backed understanding and a clear next action.

## 8. Which Indian company has the best chance of creating an agent just like yours?

**Policybazaar.**

It has the strongest starting position because it already supports [insurance comparison, purchase,
renewal and claim assistance](https://www.policybazaar.com/health-insurance/health-insurance-india/). It has
customers, insurer relationships and payment flows. Those assets make it easier for Policybazaar to build
an agent spanning the full insurance lifecycle than for a new company to assemble the same access.

Medi Assist is the strongest operational entrant, but not the best complete answer to this question. Its
documented product already includes network-hospital search, hospitalisation requests, reimbursement
submission and real-time claim tracking, which is why it is our choice for the Insurance Confirmation Rail.
It does not automatically have a household-wide view across every employer, insurer and TPA.

Policybazaar's challenge is not technology. It is incentive design. Knowvia treats all of these as valid
outcomes: buy, renew, retain existing cover, add cover, port, wait for clarification, or buy nothing. A
conversion-led business may find the last two outcomes harder to prioritise. This is an inference about the
business model, not a claim about Policybazaar's internal plans.

T4's case shows the difference. She was about to spend ₹9,400 a year on a top-up that left a ₹2 lakh
gap. The useful answer was not a different product for her. It was to stop that purchase and examine her
parents' weaker cover first [T4 00:01:34; T4 00:05:37].

Knowvia's defence is therefore not policy comparison or claim assistance. It is a persistent household
record, source-level proof, visible unknowns and the discipline to recommend no transaction. If Policybazaar
builds that same record and protects non-transactional recommendations from conversion pressure, most of
Knowvia's current differentiation disappears.

---

## Product Strategy appendix: segment map and the wall

This is not a ninth form answer. It is the material behind the eight answers and the two Product Strategy
deliverables the competition describes: a segment map and the wall we hit.

### Segment map

| Segment | Trigger | Job they need done | What Knowvia does first | Evidence and limit |
|---|---|---|---|---|
| **Household operator with a planned expense** | Pregnancy, procedure, parent-care estimate or hospital choice | Know which existing cover applies and how much cash to keep ready | `Plan an expense`: reconstruct cover, apply clauses to the estimate, show low, expected and high cash scenarios | Primary starting segment. T2 (hospital-insurance-desk employee, Delhi NCR) saw families arrive without cash clarity [T2 00:03:42]. This is not a claim-approval promise. |
| **Employee with opaque group cover** | Joining a job, HR benefit change, hospitalisation or family addition | Find out whether a named person is actually enrolled and what the employer policy includes | Request the exact employer booklet, schedule and enrolment proof before relying on the headline sum insured | Shilpa Arora highlighted corporate coverage that is undisclosed until hospitalisation. One small interview set cannot prove prevalence. |
| **Adult child managing parents' cover** | Parent's planned care, renewal, hospitalisation or document retrieval | Compare parent-specific protection with the care event without treating the household as one policy | Create one row per person and restrict views by permission class | One household's T1, T3 and T8 interviews showed that operator, policyholder and covered member can need different access. It is a design input, not a claim about all Indian families. |
| **Household approaching a coverage break** | Job exit, dependent-age limit, renewal, portability or lapse risk | Preserve continuity before a quiet gap becomes expensive | Read the exact policy definition, show the evidenced deadline and compare renew, port, replace or wait | T6's missed window is one directional case [T6 00:01:26]. Knowvia does not assume a universal age or portability rule. |
| **Retail-policy shopper without a current event** | Wants a new policy because an ad, agent or relative suggested one | Decide whether to buy at all, after existing cover is reconstructed | `Find and buy personal health cover`: map current cover before comparison and allow `do not buy now` | T4's top-up gap made stopping a purchase the better immediate action [T4 00:01:34; T4 00:05:37]. This is not the first activation segment because calm-month willingness to act is unproven. |

**Initial wedge:** the household operator with a live planned expense. The problem has an estimate, a date,
a hospital and a reason to collect documents now. The same cover record then supports group-cover checks,
renewal and continuity events.

### The wall we hit, and why

**The wall is authoritative, case-specific insurance status.** A policy PDF can prove wording. An enrolment
schedule can prove membership at a point in time. Neither can prove today's network status, latest
endorsement, document receipt, pre-authorisation state or who at the hospital desk, TPA or insurer owns the
next answer. Those facts are spread across institutions and change after the document is issued.

Knowvia can be useful before that wall. It can reconstruct documents, calculate scenarios, mark uncertainty,
prepare a precise question and coordinate approved follow-up. It must not turn that preparation into a false
confirmation. That is why the proposed Insurance Confirmation Rail is the product's load-bearing dependency.

There is a second operating wall: a direct human emergency route is only real with tested on-call staffing,
backup routing and measured response times. We will not represent it as live until that operating system
exists. Both walls are explicit because hiding them would make the product look feasible on paper and unsafe
in a hospital.
