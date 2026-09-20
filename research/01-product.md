# Coversaath: product and decisions

Updated 20 September 2026. Brand system added 18 September 2026. Status: coherent concept with a
buying-led sequence, ready for a scoped prototype and behavioural testing. Fifteen student conversations
are user-reported. No paid pilot, partner agreement or working integration is claimed.

## 1. The product in one sentence

Coversaath is a household health-insurance understanding and decision agent. It reconstructs group and
personal cover, helps the household buy or renew appropriately, and carries the same context into planned
care, a claim problem and the next decision.

Working descriptor: **Know what you have. Buy what you need. Plan what it costs.**

**North Star:** no household should reach an insurance decision or hospital admission without knowing what
cover it has, what remains uncertain, what money it may need and what it should do next.

**USP:** Coversaath first reconstructs the household's complete insurance position across employer and
personal policies. It then carries that same context through buying, renewal, hospitalisation and claim
coordination.

The Household Health Treasury is the record and planning layer inside this agent. A disclosure history,
policy reconciliation record, email trail, admission brief and backup handover are modules inside
Coversaath. None is the product on its own. Coversaath is not a generic policy wallet, a claims processor
or a "disclosure-to-claim ledger" sold as a separate product.

Readiness is not a separate product placed before buying. It is the first half of buying properly.
Reconstructing cover, verifying the operator and running the drill are what make a recommendation
honest instead of a guess about a household nobody has examined. The same record then carries the
household through renewal, job changes, planned care and claims.

The Treasury is not a wallet and a policy's sum insured is not spendable cash. It keeps insurance,
available cash, loans and investments in separate buckets, with source and permission status. The first
build uses voluntary affordability inputs. It does not make a general investment plan.

## 2. Decisions settled by the user

- Coversaath operates through a licensed distribution partner for advice and purchase. Support and
  continuing assistance are funded by disclosed distribution commission through that partner.
- The adviser must be permitted and expected to recommend no purchase. Adviser pay and case review
  must not depend on a sale. Every recommendation records the commission position at the time it was made.
- Employer and HRMS distribution remains a later channel, not the funding assumption for this pitch.
- Consent and role-based permission are core product mechanics, not a later hardening step. Nothing is
  collected, shared or acted on without the named adult's recorded permission.
- Activation trigger: a real buying decision. Workforce entry, a renewal notice, a family change or a
  planned procedure all qualify. Workforce entry is one trigger, not the only one.
- Activation users: students and young adults aged 18 to 24 who will enter work within two years.
- Persistent users: household insurance operators and corporate employees aged 30 to 45.
- Employer benefit information is assumed accessible for the purpose of evaluating the product.
- Credit, investment and tax data are out of scope for this pitch and the first build. They may return
  only if a real funding question repeatedly needs them.
- Income, fixed commitments, loans and emergency savings are optional inputs after the coverage gap is
  known. They help price affordability, not determine insurance eligibility or replace financial advice.
- The service works across existing employer cover, personal health policies and genuinely relevant
  additional benefits. It does not assume every credit card supplies illness cover.
- Group cover is treated as a live membership and benefits record, not an individual policy purchase:
  enrolment, members, employer contribution, voluntary top-up, exit dependency, employer renewal and
  benefit-booklet version all remain separate facts.
- Each personal policy can keep a policy continuity record: proposal answers, evidence supplied,
  submission and acknowledgement receipts, insurer questions, underwriting changes, loading, waiting
  periods, exclusions, endorsements, payment, issuance and later correspondence. This is a supporting
  evidence module, not Coversaath's public identity.
- The agent completes routine document work, follow-up, coverage reconstruction and planning.
- A human enters at the licensed recommendation gate, on material ambiguity, on exception or when the
  customer asks for one. Human minutes per completed decision are measured and capped.
- The service is used around real decisions. Monthly engagement is neither a goal nor a success metric.
- A household's real operator may be a parent, sibling, adviser or relative outside the immediate family.

These are design assumptions and preferences. They do not prove vendor permissions, data completeness,
continuous staffing, clinical or underwriting authority, or commercial viability. The commission model
funds the service on paper. It has not been tested against real case volumes, adviser capacity or the
conflict controls described in section 6.

## 3. The customer job

For a purchase: "Help me finish choosing cover that I understand, once I know what my family already
has and who can actually use it."

For readiness inside that purchase: "Before you recommend anything, show me what we already hold and
whether anyone except the usual organiser could operate it."

For treatment: "Before admission, show which benefits may apply to this procedure, what is unconfirmed,
what cash I may need and who must answer each question."

For planning: "Show me what premium I can carry, what a medical event may require before settlement,
and which money should remain protected."

The first principle is: **do not recommend cover for a household nobody has examined.** The product
reduces dependence on one person's memory and on an unverified assumption that a relative will help.
It must work for people who are disengaged by default. It should not require them to become insurance experts.

### Entry rule after paired-agent challenge

Before opening a full case, name the unresolved question, the existing helper, the missing answer,
the institution that can answer it, and the work Coversaath will own. If the current adviser already
finishes the same task with less effort, do not manufacture another workflow. The service can work
alongside that adviser with permission. This is a design change from simulations, not proof that the
gap occurs in real households.

Buying remains the paid job. This entry rule limits each case, not the product. A disagreement log must
lead to a question, action or explicit unresolved decision. Recording a disagreement without helping
the household act is not itself value.

## 4. ICP and segment boundaries

There are two linked ICPs. The activation ICP exposes the family knowledge gap at a buying moment. The
persistent ICP owns later decisions. City and income alone do not make someone a good customer.

| Segment | First trigger | Why it may fit | Why it may fail |
|---|---|---|---|
| Employee with employer cover considering retail cover | Self-selected decision date, marriage, job transition | Needs to understand what another policy adds before paying for it | A trusted existing adviser may already resolve it |
| Retail buyer with employer cover at renewal | Renewal quote or changed member benefits | Can compare changed protection and cost against what is really held | May only want a payment reminder |
| College student or young adult entering work | Placement, offer letter or benefits onboarding | Brings employer cover into the family map and exposes an unverified operator | Parent or relative may refuse, and the young adult may ignore a non-urgent task |
| Parent or relative who currently handles family cover | Consent request during a live buying decision | Can transfer the minimum operational knowledge without teaching policy jargon | May not understand the policy or may resist sharing control |
| Household coordinator with planned admission | Hospital estimate and treatment date | Immediate route and cash-timing question | Hospital and existing broker may handle it well |
| Employee coordinating a parent's care elsewhere | Missing records or unclear enrolment | Roles, language and locations differ | Parent may not be covered under any relevant plan |

Exclude emergency treatment selection, investment trading and broad tax advice from the initial
decision engine. An emergency access path remains part of the support service.

Do not assume women always organise care, men always pay, migrant families are uniformly poor,
or corporate workers are comfortable with English medical terminology. Let adults control their records.

## 5. Complete customer journey

### The buying sequence

1. A real buying trigger occurs.
2. Coversaath reconstructs existing family and employer cover.
3. It identifies and verifies the actual insurance operator.
4. The family runs the five-minute readiness drill.
5. The system identifies the uncovered need.
6. The Treasury prices insurance routes and optional affordability scenarios.
7. The agent recommends a route or identifies that no purchase is justified.
8. A licensed human reviews purchase recommendations, exceptions or requested cases.
9. The customer approves and buys, then the issued policy is checked.
10. The Household Health Card and Treasury support renewal, job changes, planned care and claims.

Steps 2 to 4 are not a delay before buying. They are the difference between a recommendation based on
documents and one based on a form. A gap named at step 5 is only as good as the cover reconstructed at
step 2. Steps 7 and 8 are where the business earns its commission, and step 6 is what keeps that
commission from deciding the answer.

Any step can end the case. Existing cover may already be sufficient. The operator may refuse. The drill
may fail and stay failed. The household may defer or decline. Each ending is recorded with its reason
and next step.

### Trigger and discovery

A user arrives with a decision: a renewal notice, a new job, a family change or a procedure ahead.
The first screen confirms people, existing cover and the job to be done. Existing data pre-fills
relevant fields. Full financial account connection is neither offered nor needed for a coverage check.

Each adult can contribute privately. The payer, patient, operator and decision-maker can differ.
Where an employer channel is used later, the employee's manager receives no medical details.

### Reconstructing existing cover

The service collects the policy schedules, wording, endorsements, employer benefit documents and any
customer information sheets the household can supply. Each fact is linked to its source page and
version. Marketing summaries never override issued documents. What cannot be found is recorded as
unknown rather than assumed absent.

The reconstruction does not stop at sum insured. It separately records procedure, therapy and
condition-specific limits, room-rent rules, co-pay, waiting periods, exclusions, deductibles and
network status where the issued documents support them. An employer's group cover is marked
**unverified** until the employee supplies the benefit booklet or an authorised HR, TPA or insurer
response confirms the relevant term. A headline cover amount is never presented as the amount payable.

### Verifying the operator and running the drill

The service asks one concrete question: "If a parent were admitted tonight, who would you call?"
The user names the likely operator. The service does not assume that person actually knows. With
recorded permission, it contacts the parent or trusted relative by voice or WhatsApp, asks who holds
the documents, and records what remains unknown. Each adult controls their own records.

The output is a small emergency handover: current policy documents, insured members, insurer or TPA,
the real operator, one backup, authorised viewers, unknowns and the first administrative actions. A
five-minute backup check is available when a household wants to test the handover or when voice outreach
reveals a material operator gap. It is a supporting continuity feature, not Coversaath's headline or a
mandatory exam before every recommendation.

The backup check is a test, not a promise. Passing it does not mean the family has adequate insurance.
Failing it does not mean they must buy anything. Refusal, an unreachable relative, no policy found and a
failed check are all real, recorded outcomes.

### Identifying the uncovered need

Only after existing protection is reconstructed does the service name a gap. It captures priorities,
compares a small shortlist and explains consequential trade-offs using a household scenario. It reconciles
proposal answers with submitted evidence, labels whether a disclosure is only prepared, sent,
acknowledged, considered in underwriting or reflected in issued terms, and routes unknowns to the insurer
or licensed adviser. Where the honest answer is that current cover is enough, the service says so and
closes.

### Household Health Treasury and affordability plan

After the cover map is complete, the household may add monthly income, fixed commitments, loans,
emergency savings, current premiums and any user-selected accessible funds. The Treasury keeps each
number separate: income is not savings, a credit limit is not emergency cash, and investments are not
automatically available to sell.

It produces an affordability plan, not a loan or investment recommendation. The plan shows premium
ranges, current insurance commitments, a conservative emergency-cash view, possible upfront cash for a
specific planned-care scenario, and what remains unknown. It can say "cannot calculate" when the
household withholds inputs or no estimate exists.

The Household Health Card is the short output: current cover by person, renewal dates, named operators,
known gaps, recommended action, premium range, voluntary affordability context, emergency route and next
event. It never adds multiple policies into one guaranteed cash number.

### Agent recommendation, adviser gate and purchase

The agent produces a source-linked recommendation after reconstruction, the drill and the affordability
view. A licensed human reviews a recommendation that would lead to purchase, material ambiguity or a
customer-requested case. They can disagree, and their disagreement is recorded with reasons. A no-purchase
result can close without routine human time if it does not cross a regulated advice boundary. The final
operating boundary needs qualified legal review.

Before payment, the household confirms its choice, sees the disclosed commission on that product and
understands key limitations. A licensed distribution partner handles the purchase. Payment completion
does not count as policy issuance.

A decision can end in non-purchase, insurer rejection, deferral or choosing to retain existing cover.
Record the reason and next step. There is no conversion target, and no adviser incentive attached to
one outcome over another.

### Issuance check and updated handover

The issued schedule and endorsements are checked against what was agreed. An issued policy that differs
from the accepted offer stays an open issue. Coversaath reconciles the household's declared facts,
submitted evidence, insurer questions, underwriting response and issued contract. It flags a mismatch,
but only the institution can resolve it. The emergency handover is then updated with the new policy,
members, insurer or TPA route and authorised viewers. A short family guide records how to seek help. The
case persists for renewal and claims.

### Renewal

Import the quote and current policy. Compare actual changes in premium, members, coverage and
applicable benefit rules. Reuse confirmed facts but ask about material changes. The adviser reviews
trade-offs and may recommend renewing unchanged. The household approves renewal or another appropriate
route through the licensed partner. Do not cancel existing protection merely because a replacement
application has been started.

### Planned treatment

The user supplies the patient, doctor-recommended procedure, hospital, estimate and date. The engine
checks the exact policy version against the procedure or therapy, relevant sub-limits, room rules,
co-pay, waiting periods, exclusions, network status and available employer documents. It separates
possible final personal expense from cash needed before settlement. Formal insurer or TPA responses
update the plan.

It produces an **Admission Readiness Brief**: relevant policies, source-linked benefit conditions,
unresolved facts, required documents, cashless or pre-authorisation questions, a requested deposit,
possible cash scenarios, and the named owner and deadline for each institutional question. The brief
goes to the household, hospital insurance desk, HR or benefits administrator, TPA and insurer only
within recorded permission. It prepares the case. It does not file a claim autonomously, decide medical
care or represent that any institution has approved payment.

The primary view contains the recommended route, next action, estimated money and timing, a critical
uncertainty, and the named human owner. Detailed reasoning is optional; material uncertainty is not.
The service then tracks documents, institutional questions, pre-authorisation, revised estimates,
admission, discharge and final settlement. It records what was confirmed and what changed.

### Emergency

Admit first. Optimise later. Show an emergency access card and direct support contact immediately.
No AI conversation, financial onboarding or 15-minute consultation is a prerequisite for care.
The interface becomes deliberately simple. AI stays backstage to retrieve documents, assemble facts,
track requests and brief the human. The expert uses the case and gives their own interpretation.
Make the access card available to authorised family members.

### Claim problem, after the expense and after a job change

Reconcile bills and actual payments, record remaining cover, and pursue a specific unresolved item
within the service's agreed scope. For a disputed, delayed or rejected reimbursement, prepare a **Claim
Position Brief**: what the institution says, the exact clause it cites, the household evidence, the
submission and correspondence timeline, unresolved contradictions, and the next evidence-based question.
It helps a household preserve and understand its record. It does not claim a rejection is wrongful, submit
an appeal autonomously, promise settlement or speak with the authority of the insurer.

Do not invent savings from an estimated payout.

A job change updates employer cover on the same record and may expose a new gap. Provide personal
access or export of the household's authorised records at any time. Never imply employer insurance
continues just because the records remain accessible.

## 6. What the human contributes, and how the conflict is controlled

The agent owns routine reading, document chasing, source linking, affordability calculations, reminders,
follow-up and Household Health Card updates. The human handles licensed recommendation gates, material
ambiguity, exceptions and requested conversations. They can see source documents without first accepting
the model's interpretation. If they disagree, the case records both positions and the reason. An unresolved
contractual point goes to the institution with authority. Neither adviser confidence nor AI consensus
creates an insurer commitment.

Because the service is funded by distribution commission, the conflict is structural and must be managed
in the open rather than denied:

- Disclose the commission on every recommended product, at the time of recommendation, in the case record.
- Permit and expect a no-purchase recommendation, and record how often it happens.
- Do not tie adviser pay, review outcomes or case closure to a sale.
- Never make readiness help, the drill or continuing assistance conditional on buying.
- Keep a comparable no-purchase and retain-existing-cover path visible at every decision point.
- Publish the aggregate mix of purchase, retain, defer and decline outcomes for review.

These controls reduce the conflict. They do not remove it. A commission-funded adviser recommending a
purchase is not equivalent to independent advice, and the pack should not claim otherwise. Whether these
controls hold under real volume is untested.

The user can request a person at any step. The pilot needs a published operating schedule and backup
route. A round-the-clock promise requires actual staffed capacity before launch, not a phone icon.
Human expertise and empathy are proposed contributors to trust, not guarantees.

## 7. Product boundaries

- Do not recommend a purchase before existing cover has been reconstructed from documents.
- Do not collect, share or act on any record without the named adult's recorded permission.
- Do not aggregate unrelated insurance limits as cash or reimburse the same expense twice.
- Do not assume a newly bought policy or top-up pays for a treatment already planned.
- Do not infer absence of disease from missing records, or non-disclosure from an omitted schedule line.
- Do not treat ordinary email acknowledgements as binding confirmation of a future claim.
- Do not treat a sum insured, employer-plan summary or extracted policy clause as confirmed claim
  eligibility for a specific admission.
- Do not promise a claims API, automated claim filing, cashless approval or final settlement; the hospital,
  TPA and insurer retain separate authority.
- Do not optimise claims using premium GST, a generic NCB rule or insurer-wide ratings.
- Do not select treatment or liquidate investments automatically.
- Do not use income, loans, savings or investments to decide a medical or insurance outcome.
- Do not call a premium affordable simply because it fits one month's income.
- Do not claim comprehensive medical history, universal cashless access or zero hallucinations.
- Do not request relatives, parents or colleagues through uncomfortable personal relationships.
- Do not present a commission-funded recommendation as independent advice.

Policy mechanics and source caveats are in [04-market-and-sources.md](04-market-and-sources.md).

## 8. Roadmap and proof gates

| Phase | Deliverable | Continue only when |
|---|---|---|
| A | One manual buying case: cover map, operator verification, cold drill, gap and recorded decision | A household finishes a real decision it can explain, without repeated chasing |
| B | Consent and role-permission layer with revocation, scope limits and audit trail | Adults can grant, see and withdraw access, and the audit trail holds under test |
| C | Treasury v1: premium ranges, voluntary income, loans, commitments and Household Health Card | Users understand the numbers without treating them as guaranteed cash |
| D | Licensed purchase completion with commission disclosure, payment and issued-policy checks | Users finish real decisions without pressure, including recorded no-purchase outcomes |
| E | Renewal and job-change continuity on the same household record | Reused facts measurably cut repeat questions and effort |
| F | Admission Readiness Brief, planned-care cash scenario and actual-bill reconciliation | Institution replies change the brief without unsupported certainty |
| G | Employer or benefits-platform channel | It reduces acquisition effort without changing who the service works for |
| H | Relevant adjacent insurance products | Real cases justify each addition and the licensed route exists |

Phases A to D are the competition scope. Term-life, travel and ULIP modules are expansion possibilities,
not initial obligations, and they have distinct triggers and rules. Credit, investment and tax sources
remain later voluntary additions, not default planning inputs.

## 9. Brand system

Updated 18 September 2026. This direction is evidence-aware, not a claim that colour or typography
can create trust on their own. The evidence and competitor audit are in
[04-market-and-sources.md](04-market-and-sources.md#brand-evidence-review).

### Audience and emotional job

The product acquisition segments in section 4 remain unchanged. The brand must be usable across a
wider age span because the buyer, patient, payer, operator and parent may be different people.

| Brand audience | Situation | What the brand must do |
|---|---|---|
| Tech-comfortable adult, roughly 22 to 29 | First job, first retail policy or helping parents | Feel adult and serious without resembling a bank or a lecture |
| Household operator, roughly 30 to 45 | Renewal, family change, job change or planned care | Make evidence, responsibility and the next action easy to scan |
| Parent or senior decision-maker, roughly 46 to 60 | Sharing records, approving a purchase or supporting a claim | Stay legible, plain and respectful without looking childish |

These age bands are a design scope supplied for this brand exercise. They are not measured demand or
a replacement for the current ICP. The shared emotional job is:

> Turn scattered evidence and anxious responsibility into one calm next action, without pretending
> uncertainty has disappeared.

The desired shift is from overloaded, suspicious and dependent on one person's memory to oriented,
informed and able to act. Do not promise reassurance about coverage or claim outcomes. A clear unknown
is better than a comforting guess.

### Personality and voice

The personality is **calm, exact, adult and candid**. It is not cheerful wellness, clinical authority,
fear-led insurance advertising or playful fintech. The product should sound like a capable case worker
who shows the source, names the limit and says what happens next.

- Lead with status, evidence and the next action.
- Use sentence case, short verbs and ordinary insurance terms with a definition when needed.
- Say `unknown`, `unconfirmed` or `needs insurer response` instead of softening uncertainty.
- Never use death, illness or family guilt to force a purchase.
- Never let colour, a checkmark or a confident headline imply approval.

Core descriptor: **Know what you have. Buy what you need. Plan what it costs.**

### Colour system

This is a low-to-medium saturation system built for long reading and consequential decisions. Deep
Tide gives the product a stable field. Harbour carries ordinary actions. Signal Gold is a small cue
for attention and keyboard focus, not a dominant campaign colour. Brick is semantic danger only.

| Token | Hex | Role |
|---|---|---|
| Deep Tide, primary | `#163F42` | Header, wordmark field and high-emphasis surfaces |
| Harbour, secondary | `#176F69` | Primary buttons, links and progress |
| Signal Gold, accent | `#E0A02B` | Focus, a single decision cue and small brand details |
| Mist, canvas | `#F3F7F6` | Low-noise page background |
| Paper, surface | `#FFFFFF` | Reading and form surfaces |
| Ink, text | `#1A3034` | Main text and text on Signal Gold |
| Slate, muted text | `#5C7074` | Supporting text only |
| Fog, line | `#CFDCDA` | Dividers and control boundaries |
| Brick, danger | `#A74335` | Errors, emergency boundaries and destructive actions |

Verified contrast pairs include white on Deep Tide at 11.51:1, white on Harbour at 5.98:1, Ink on
Signal Gold at 6.09:1, Slate on white at 5.22:1 and white on Brick at 6.00:1. Normal text must meet
WCAG 2.2 AA at 4.5:1. Large text and essential control boundaries must meet their applicable 3:1
threshold. Colour never carries status alone. Pair it with a label, icon, pattern or border.

### Typography

Use **Source Sans 3** for the product interface and body copy. It is open source, restrained and has
the weights needed without switching families inside a case. Use 400 for body, 600 for controls and
labels, and 700 only for strong emphasis. The fallback stack is
`system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif`.

Use **Newsreader** only for large marketing or editorial headlines when a warmer voice is useful. Do
not use it for forms, coverage conditions, prices or dense case content. Use **Noto Sans Devanagari**
for Hindi and mixed-script content rather than leaving Devanagari to an accidental system fallback.

Product body text starts at 16px on mobile and 17 to 18px on desktop, with 1.5 to 1.6 line height.
Critical coverage, exclusion and consent text should be 17px on mobile and 18 to 19px on desktop.
Supporting metadata may use 14px, but never for essential conditions or price qualifiers. Test every
flow at 200% zoom, 320 CSS pixels, increased device font size and WCAG text-spacing overrides.

### Visual signature

The signature element is a quiet three-part **decision line**:

`KNOWN  |  UNKNOWN  |  NEXT`

It can appear as slim case-file tabs, a progress header or a banner motif. It expresses the real product:
preserve what the documents establish, keep uncertainty visible, then assign the next action. Avoid
shields, hospital crosses, smiling-family stock photos, heart-rate lines and generic AI gradients.

### LinkedIn banner concept

Use LinkedIn's recommended 1584 by 396 pixel canvas. Keep the left quarter clear for the profile photo
and responsive crop. On a Deep Tide background, place the decision line in small Source Sans 3 labels,
then one headline on the right:

> Insurance should feel clear before it becomes urgent.

Below it, use the core descriptor in smaller type. Add one narrow Signal Gold rule and the working
wordmark. No feature list, email address, badges or people photography. The banner should make one
claim and leave breathing room.

### Name recommendation

**PolicyKey is the final masterbrand recommendation. Coversaath remains the working product and
repository name until clearance and user testing are complete. Do not run a code-wide rename yet.**
“Policy” gives the category away immediately across Indian regions. “Key” frames the product as the
thing that helps a household unlock, understand and act on what its policy actually means. It follows
the strongest YC naming pattern for this product: a short, familiar word pair that earns meaning through
use, rather than an invented name that needs explanation. It is a creative recommendation, not a
cleared mark.

| Candidate | Why it fits | Main risk | Score |
|---|---|---|---:|
| **PolicyKey** | Direct insurance cue; “key” signals access, understanding and readiness; nine letters | More descriptive than distinctive; trademark and domain checks are still required | **24/25** |
| **CoverNest** | Household protection cue and easy pronunciation | Existing Indian insurance aggregator; reject | **14/25** |
| **CoverSure** | Clear cover and confidence cue | Existing Indian insurance-management platform; reject | **14/25** |
| **Insurly** | Immediate insurance category cue | Existing health-insurance app and generic suffix; reject | **14/25** |

The score covers household trust, recall and pronunciation, seriousness, expansion room and basic web
cleanliness, each out of five. It is a strategy score, not trademark clearance. Before adoption, check
Indian trademark classes, MCA company names, app stores, social handles, `.com` and `.in` domains,
phonetic conflicts, and pronunciation in the target languages. Test hearing, spelling and unaided
recall with users aged 22 to 60.

## 10. Decision history retained in brief

The user approved a broad Household Health Treasury direction with an agent-led buying journey.
The 07 September student conversations changed what comes first inside that service: existing cover,
the real operator and the readiness drill now precede any recommendation.

A later reordering made the sequence buying-led. Readiness was previously described as the entry point
with purchase following it. It is now the first half of a single buying journey, because the customer job
being paid for is completing a purchase they understand. This is a change of order and framing, not a
new product.

The payer question was settled in the same pass. Earlier drafts assumed an employer or service partner
funds free human support. That assumed a willingness to pay we had not tested. The service is now funded
by disclosed distribution commission through a licensed partner, with the conflict controls in section 6.
Employer distribution remains a later channel.

Consent remains a core mechanic. The Household Health Treasury was restored as the long-term layer.
Income, loans, commitments and emergency savings are optional planning inputs. Credit, investment and tax
data remain later, voluntary sources rather than default onboarding.

The earlier standalone Bill Rehearsal is a comparison method within purchase and renewal, not the brand
or the scope. Generic wallets, compulsory monthly engagement and retirement-only positioning are out.
Earlier categorical claims that pre-authorisation makes planning useless were too strong: actual
coordination and cash-timing value must be tested. This document supersedes all archived concepts.

Practitioner feedback received on 15 September added a claims-backwards lens. The product must detect
benefit-specific limits, such as a therapy cap inside a larger sum insured, and make corporate-policy
unknowns visible before admission. It does not change the primary opening or make Coversaath a claims
processor. The next proof is whether an Admission Readiness Brief produces a clearer written answer
from the hospital desk, TPA, insurer or employer than the household's current route.
