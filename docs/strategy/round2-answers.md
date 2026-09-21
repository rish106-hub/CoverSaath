# Knowvia: Round 2 answers

Submission draft, revised for clarity and feasibility on 21 September 2026.

These answers are based on eight consented interviews across six households, conducted between 5 and 8
September 2026. The sample is directional, not representative. All respondents were privately insured and
none used a state scheme. The design also incorporates Shilpa Arora's public feedback on an earlier
architecture. Proposed rail integrations are product designs, not built or contracted integrations.

## 1. What is the outcome your agent is accountable for? One sentence.

**For each health-insurance decision, Knowvia must tell the family what cover applies, what could limit
payment, what cash they may need, and what to do next, while showing the source for each fact and naming the
owner of anything still unknown.**

## 2. What is the level of autonomy your agent has?

**L3: Knowvia acts independently inside limits approved by the household.**

The most consequential action it takes without asking again is sending a factual question to an already
approved insurer, TPA, employer or hospital, then tracking the reply and updating the case record. It can
only do this when a named adult has already approved the institution, purpose and information being shared.

Inside those limits, Knowvia can:

- Read policy wordings, schedules, endorsements, employer booklets and hospital estimates.
- Reconstruct available cover for each person. Eligibility alone is not treated as enrolment.
- Find missing, conflicting or time-sensitive information.
- Apply policy clauses to the person's event and estimate likely cash exposure.
- Contact an approved family member or institution with a narrow factual question.
- Track replies, deadlines, policy versions and unresolved questions.
- Check its own output for missing sources, conflicting evidence and unsupported conclusions.

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

This boundary comes from the research. Mrs. Ghosh allowed full emergency access in advance but did not want
her son to see the reason behind a condition in her declaration [T8 00:02:16; T8 00:03:06]. A household
cannot be treated as one permission boundary. Access must be granted per person, per information class and
per viewer.

Knowvia is not L4 because insurers, TPAs, hospitals and licensed advisers control decisions the agent cannot
make or verify by itself.

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
1. EVENT + PERMISSION
   A person, purpose and access boundary are named.
             ↓
2. SOURCE PACK
   Knowvia requests the exact schedule, wording, employer booklet,
   endorsement, estimate or medical document needed for the case.
             ↓
3. PARALLEL READING
   Separate workers check enrolment, benefits, exclusions, hospital,
   estimate lines, cash exposure and evidence.
             ↓
4. CASE APPLICATION
   The policy rules are applied to this person, event, hospital and bill.
             ↓
5. DECISION BRIEF
   The family sees one route, cash scenarios, next actions and source pages.
             ↓
6. INSTITUTIONAL CONFIRMATION
   Time-sensitive facts are checked with the responsible insurer, TPA,
   employer or hospital desk when authority exists.
             ↓
7. HUMAN APPROVAL + ACTION
   The household approves sharing, declarations, payment or filing.
             ↓
8. TRACKING + RECONCILIATION
   Knowvia tracks issuance, pre-authorisation, claim status and the final outcome.
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

These states came from real failures. Seven of 19 collected documents contained a schedule field that did
not match the family's own account. One sister's date of birth was recorded six years wrong. Nikhil's
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
| Pre-authorisation is delayed or denied | Show deposit and reimbursement scenarios; do not call it a final claim rejection |
| Premium paid but policy not issued | Keep the purchase unresolved until issuance, reversal or dispute resolution |
| User asks to hide medical history | Refuse to coach concealment and require an accurate declaration |
| User asks for medical advice | Route to the treating clinician |

The output is complete only when each material question is answered from a source, explicitly marked
Unknown, or assigned to a named person or institution with a deadline.

## 4. On each rail, what exists and what must be built?

| Rail | What exists today | How Knowvia uses it | What Knowvia must build | Hard boundary |
|---|---|---|---|---|
| **Gnani: voice** | Multilingual voice agents, knowledge bases, dynamic pre-call variables, external actions, logs and analytics | Optional voice intake, voice interaction with the main agent, and approved read-back for a family member | A permission-aware layer that records who supplied each fact, reads material facts back, writes approved facts into the same case record and escalates uncertainty | Gnani does not analyse policy wording and never sits in the emergency route |
| **Pine Labs: payments** | Hosted checkout, payment links, payment status, refunds and reconciliation; public documentation also describes card pre-authorisation and UPI Reserve Pay | Final premium payment only, after the household approves renewal or a selected personal policy | A transaction record joining recommendation, quote, declaration, approval, payment, insurer issuance and endorsement | Payment success is not policy issuance; Pine Labs is not used for hospital deposits or claim decisions |
| **Delhivery: logistics and maps** | Address validation, standardisation, geocoding, routing, shipment creation and tracking | Validate the address and route to an already confirmed hospital insurance desk; ship originals only when an institution actually requires them | A verified desk directory and, for original documents, consent, chain of custody, exact-recipient proof and return or destruction status | Proximity and address accuracy do not prove network or cashless eligibility |

### Gnani in practice

Voice is useful because the person operating the case and the person holding the information can be
different. The user can choose voice for themselves or another adult can provide information with that
person's permission. Gnani turns speech into a structured draft. A voice-sourced health fact stays
**Reported** until it is read back and approved or supported by a document.

The documented ceilings shape the design. An agent supports a maximum of three languages, which this
research already used: English, Hindi and Bengali. The FAQ limit is 100. Agent Chaining is bot to bot, not a
documented bot-to-human warm transfer. There is no documented multi-party call or mid-call event stream.
Therefore emergency access bypasses Gnani and reaches the human operator directly.

### Pine Labs in practice

Pine Labs appears only after the product has reconstructed existing cover and a human has approved one of
two actions: renew an existing policy or buy a selected personal policy. We considered using a payment hold
for a hospital deposit and rejected it. No hold-expiry window is documented, hospital merchant eligibility
is unverified, and placing a payment instrument before treatment conflicts with "admit first".

### Delhivery in practice

Delhivery is useful but not central. Knowvia will not invent a parcel workflow to make the rail look more
important. Its Maps capability reduces wrong-address and wrong-desk friction after the hospital and desk
have been confirmed through an insurance source.

Documentation reviewed: [Gnani Agent Builder](https://docs.gnani.ai/introduction),
[Gnani Platform API](https://docs.gnani.ai/Platform/platform-introduction),
[Pine Labs hosted checkout](https://www.pinelabs.com/docs/online-payments/hosted-checkout/integration-steps),
[Delhivery B2C APIs](https://one.delhivery.com/developer-portal/documents/b2c/) and
[Delhivery Maps](https://www.delhivery.com/maps/reference). The Gnani console and live rail calls have not
yet been tested.

## 5. Does the agent need a fourth rail?

**Yes. Knowvia needs an Insurance Confirmation Rail, and Medi Assist is the Indian company best placed to
build it.**

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
pointed out that a ₹10 lakh sum insured can still contain a ₹2 lakh immunotherapy cap, corporate-policy
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
facts. The conflict begins when a product recommends whether to retain, replace or buy cover.

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

`Why` expands the clauses and calculation. This follows Meghna's instruction: "An app told me" would not
settle an argument with her relative-agent, but "it says here, page fourteen" could [T4 00:06:06].

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

Sourav lost seven hours between 2 a.m. and 9 a.m. while trying to identify his brother's employer cover. He
said one button is the maximum acceptable interface and two screens are already too many [T5 00:04:22]. He
expected the person answering to know the policy context already [T5 00:04:36].

Pressing `Emergency access` therefore calls a human support operator directly. The operator receives a
permissioned, read-only Emergency Case Brief containing the e-card, policy and TPA details, named member,
hospital, dated network status or a visible unknown, relevant caps, likely immediate cash, documents and
current escalation status.

The operator helps with insurance coordination, not clinical advice. The first rule is **admit first,
optimise later**.

This route cannot launch until Knowvia has an operator rota, escalation rules, backup routing and measured
time-to-human. Until then the product must state that the service is unavailable and provide the prepared
brief and direct routes to the hospital insurance desk, TPA, insurer or HR.

### Household control

One adult operates the case by default, but any covered adult can open their own case, correct a fact,
provide a document or use voice. A family member can enter another adult's information only within that
adult's permission.

Permissions are per person, per viewer and per information class:

- **Cover:** whether cover exists, sum insured and enrolment.
- **Operational:** policy number, member ID, TPA route, network status and desk contact.
- **Protected:** medical declarations, conditions, claim reasons and underwriting details.

Mrs. Ghosh's rule was "the number yes, the reason no" [T8 00:02:52]. Her son could see that cover existed
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

Meghna's case shows the difference. She was about to spend ₹9,400 a year on a top-up that left a ₹2 lakh
gap. The useful answer was not a different product for her. It was to stop that purchase and examine her
parents' weaker cover first [T4 00:01:34; T4 00:05:37].

Knowvia's defence is therefore not policy comparison or claim assistance. It is a persistent household
record, source-level proof, visible unknowns and the discipline to recommend no transaction. If Policybazaar
builds that same record and protects non-transactional recommendations from conversion pressure, most of
Knowvia's current differentiation disappears.
