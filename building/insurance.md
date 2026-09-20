# How Knowvia breaks down a health-insurance policy

## Purpose

This is the internal build specification for policy interpretation. The goal is not a generic policy summary. The goal is to answer a real household question with evidence:

> For this person, this policy, this hospital event and this date, what is the best available insurance route and what may the household pay itself?

Every extracted field retains: source document, version, page, clause, extraction confidence, effective date, and whether a human has corrected it.

## Worker system

```text
DOCUMENTS + USER EVENT + HOUSEHOLD FACTS
                    |
                    v
              INTAKE AND SOURCE WORKER
                    |
      +-------------+-------------+
      |             |             |
      v             v             v
POLICY WORKERS   PERSON WORKERS   EVENT WORKERS
      |             |             |
      +-------------+-------------+
                    |
                    v
          RULE APPLICATION AND CALCULATION
                    |
                    v
       RECOMMENDATION, EVIDENCE AND REVIEW
```

### Non-negotiable worker rule

No worker gives an unsupported final answer. Each output is one of:

- **Proven**: exact source supports it.
- **Calculated**: shown formula using proven inputs.
- **Reported**: user-provided and not document-verified.
- **Dynamic**: can change and needs a dated institutional source.
- **Unknown**: source absent or unreadable.
- **Conflicting**: two sources disagree; preserve both.

## Policy decomposition tree

```text
HEALTH POLICY
|
|-- A. Document identity and authority
|-- B. Policy lifecycle and continuity
|-- C. People, eligibility and enrolment
|-- D. Coverage structure and financial limits
|-- E. Medical benefits and treatment rules
|-- F. Exclusions, waiting periods and disclosures
|-- G. Hospital access and cashless process
|-- H. Claim, pre-authorisation and reimbursement process
|-- I. Renewal, portability and change control
|-- J. Service quality and external research
|-- K. Household recommendation and action plan
```

## A. Document identity and authority

### Fields

- Insurer, TPA, employer or group-policy administrator
- Policy number, certificate number, member ID and e-card ID
- Policy type: individual, family floater, group medical cover, top-up, super top-up, critical illness, fixed-benefit or other
- Master policy wording, benefit schedule, certificate, endorsements and renewal version
- Effective date, expiry date, renewal date and grace period
- Document issue date and document version
- Source quality: original PDF, insurer portal export, screenshot, forwarded message or user statement

### Worker interpretation

The document-identity worker first decides whether it has the policy rule, the person-specific enrolment evidence, or both. A master policy can contain every clause but still not prove that Ram's wife or parents are enrolled. An e-card can prove membership but often not every rule. The worker joins them and highlights any gap.

## B. Policy lifecycle and continuity

### Brackets

1. Start, end and renewal dates
2. Grace period
3. Lapse and revival conditions
4. Waiting-period credit and continuity credit
5. Portability eligibility and deadline
6. Migration options
7. Employer exit, job change and retirement effect
8. Dependent aging-out or status-change effect
9. Premium, loading and renewal variation

### Worker interpretation

The continuity worker creates a timeline. It identifies the next point at which coverage could stop or materially worsen. It does not assume an age-26 rule. It reads the exact dependent definition and policy renewal condition.

## C. People, eligibility and enrolment

### Brackets

1. Policyholder, employee and insured members
2. Relationship definitions: spouse, child, parent, parent-in-law and dependent
3. Age thresholds and child eligibility
4. Marital-status, employment or student-status conditions
5. Date each dependent was added
6. Sum insured allocation: individual, floater, family pool or corporate pool
7. Birth, adoption, marriage, newborn and family-change rules
8. KYC, nominee, contact and permission records

### Worker interpretation

The person worker maps each named household member to a named certificate or enrolment record. It never assumes a dependent is covered because the master-policy definition permits them. It checks that they were actually enrolled.

### Permission model

Permission is not a policy field. It is a separate record that governs every other field in this document,
and it is **per-field and per-viewer**. A household is not a permission boundary and neither is a person.

Each stored fact carries a visibility class:

1. **Cover facts** — that a policy exists, its sum insured, who is enrolled, the funding route.
2. **Operational facts** — policy number, member ID, TPA route, network status, hospital desk contact.
3. **Protected facts** — medical declarations, disclosed conditions, claim reasons, underwriting loadings.

Each viewer holds a grant per class, per member, not a single household switch:

| Field | Meaning |
|---|---|
| Principal | The adult the data is about. Always holds full access to their own record |
| Viewer | The person or agent being granted access |
| Classes granted | Cover / operational / protected, individually |
| Purpose | The named case or standing reason |
| Expiry | A date, a case closure, or standing until revoked |
| Revocation | Live, unilateral by the principal, with immediate effect |
| Emergency override | Whether the principal has pre-authorised full access to a support operator during an active emergency |
| Audit | Every read of a protected field is recorded and visible to the principal |

**The evidenced rule this implements.** A member may permit family to see the cover amount and the funding
route while withholding the reason a condition is listed — "the number yes, the reason no" [T4/T8 00:02:52].
The same member may simultaneously permit a **stranger** on an emergency line to see everything, because
that is closer to telling a doctor than to telling a son [T5/T8 00:03:06]. A single household on/off switch
cannot express this. Neither can a per-person switch. The grant must be per class and per viewer.

The emergency override is granted **in advance, by the principal, knowingly**, for a moment when they may not
be able to speak [T8 00:02:16]. It is not inferred from a relationship, a payment method or a device.

### Worker constraints on permission

- No worker may read a protected field without a live grant covering that class, that viewer and that
  purpose. Absence of a grant produces a denial state, not a silent omission.
- **Unknown and not-permitted are different states and must never be collapsed.** Rendering a withheld field
  as "unknown" leaks a fact to the viewer and misinforms them at the same time.
- A grant is never created as a side effect of another action. Adding a dependent, taking a payment or
  receiving a document does not grant visibility.
- Family relationship creates no authority. The operator running a case holds no implicit right to another
  adult's protected class.
- Revocation is immediate and retroactive for future reads. Already-generated briefs containing revoked
  fields must be invalidated, not left in a cache.
- A senior family member, or any member, may exercise every one of these rights over their own record
  directly. The operator model is a default, not a restriction on the principal.

## D. Coverage structure and financial limits

### Brackets

1. Sum insured
   - Individual limit
   - Family floater limit
   - Shared corporate pool, if applicable
   - Remaining balance after claims, if evidenced
2. Deductible
   - Per claim, per person, per policy year or aggregate
   - Whether it interacts with base cover, top-up or super top-up
3. Co-pay
   - Percentage or fixed amount
   - Age, hospital, city, treatment or product-specific trigger
4. Sub-limits
   - Room rent
   - ICU
   - Maternity
   - Cataract
   - Ambulance
   - AYUSH
   - Home care
   - Consumables, implants or treatment-specific categories
5. Restoration or recharge benefit
   - Trigger
   - Amount restored
   - Same illness or same person restriction
   - Frequency and timing
6. No-claim bonus or cumulative bonus
   - Accrual, cap and reduction condition
7. Day-care and outpatient structure

### Worker interpretation

The financial-rules worker does not add every policy's sum insured into a single "guaranteed family cover" number. It creates an event-specific availability calculation. It shows the sequence in which policies may be relevant and what each cap, deductible or co-pay does to the hospital estimate.

## E. Medical benefits and treatment rules

### Brackets

1. In-patient hospitalisation
   - Minimum admission duration, if any
   - Room and ICU coverage
   - Surgery, medicines, diagnostics and professional fees
2. Day-care procedures
3. Pre-hospitalisation and post-hospitalisation expenses
4. Emergency ambulance and air ambulance
5. Maternity
   - Normal delivery and C-section
   - Waiting period
   - Delivery cap
   - Number of deliveries
   - Newborn cover and effective date
   - Complication wording
6. Chronic and pre-existing-condition treatment
   - Disease-specific wording
   - Waiting period
   - Disclosure linkage
7. Dialysis, organ-related treatment, cancer, cardiac care and other high-cost categories
8. Mental health, rehabilitation, home care and domiciliary treatment
9. AYUSH, dental, vision and outpatient benefits
10. Critical illness and fixed-benefit riders
    - Trigger definition
    - Survival period
    - Payout amount
    - Interaction with indemnity cover

### Worker interpretation

The benefit worker maps the planned treatment or claim event against the exact benefit definition. It separates: eligible-looking treatment, capped benefit, exclusion-looking item, unsupported fact and dynamic institutional decision.

## F. Exclusions, waiting periods and disclosures

### Brackets

1. Permanent exclusions
2. Initial waiting period
3. Pre-existing-disease waiting period
4. Specified-disease or procedure waiting period
5. Maternity waiting period
6. Lifestyle, self-harm, substance-related or hazardous-activity exclusions where policy wording contains them
7. Cosmetic, experimental, fertility and non-medical exclusions
8. Non-medical consumables and administrative charges
9. Disclosure obligations at purchase, renewal and claim
10. Misrepresentation, non-disclosure and fraud clauses

### Worker interpretation

The exclusions worker highlights terms that could change the household's exposure. It does not tell a user to hide or rewrite health history. If voice intake yields uncertainty, it creates a draft for Ram to correct. Only the user can approve a declaration.

## G. Hospital access and cashless process

### Brackets

1. Network hospital and branch
2. TPA and insurer contact route
3. Cashless eligibility process
4. Pre-authorisation form and owner
5. Emergency versus planned-admission timeline
6. Hospital insurance-desk availability
7. Room-category choice and effect
8. Deposit, payment-card and reimbursement scenario
9. Treatment estimate and revision history

### Worker interpretation

The hospital worker must use a dated official network source, not a search-result snippet or an old user comment. Network listing is useful evidence, but the worker must not call a planned admission cashless until the relevant process supports that conclusion. The cash worker calculates possible household payment from the estimate and policy rules. It does not promise the final settlement amount.

## H. Claim, pre-authorisation and reimbursement process

### Brackets

1. Intimation deadline
2. Pre-authorisation requirement
3. Required documents by event type
4. FIR, MLC, discharge summary, prescriptions, diagnostic reports, invoices and payment receipts where applicable
5. Claim-form and bank-detail requirements
6. Reimbursement submission deadline
7. Query, denial, partial-settlement and grievance process
8. Ombudsman or escalation route, where applicable
9. Claim history and correspondence

### Worker interpretation

The claims-process worker makes a case-specific checklist. It should say, "The policy wording says X and this case is missing Y," not "your claim will fail." A pre-authorisation delay is not a final claim denial. A final claim decision belongs to the insurer and must be represented as such.

### Emergency handoff rule

For an active emergency, the system places a direct call to a human support operator. **No voice agent sits in
this path.** The workers produce a read-only Emergency Case Brief for that operator. No AI worker may make
treatment decisions, decide whether admission should wait, promise approval, or autonomously direct hospital
action. The support operator handles insurance and coordination, not clinical advice.

Conversing with the AI is a separate product path the user may choose at any time. It cannot replace the
operator handoff and must never be interposed before it.

## I. Renewal, portability and change control

### Brackets

1. Current versus renewal policy version
2. Clause-level changes
3. Premium changes
4. Added, removed or aged-out members
5. New declarations or changed health facts
6. Portability or migration decision
7. Employer-cover loss and continuity replacement
8. Required action owner and deadline

### Worker interpretation

The renewal worker performs a policy diff, not just a price comparison. It tells Ram whether a renewal is preserving continuity, worsening a material condition, creating a time-sensitive portability decision, or leaving a household member without evidenced cover.

## J. Service quality and external research

### Inputs

- Official insurer and TPA service documents
- Official hospital network and grievance records
- Regulatory disclosures
- Product brochures and policy wording
- Public complaint patterns, reviews and Reddit discussions
- Claim-settlement disclosures, where comparable and current

### Worker interpretation

This worker produces a research appendix, not the core policy conclusion. Claim-settlement ratios are broad and may not apply to Ram's event. Reddit and reviews can indicate friction or repeated complaints but can be biased, stale or fabricated. The recommendation engine gives higher weight to policy fit, eligibility, continuity, cost exposure, hospital access and evidence quality.

## K. Household recommendation and action plan

### Recommendation inputs

1. Who is covered now.
2. Which benefits apply to the named event.
3. What the household may pay under conservative scenarios.
4. Which policy has the best event-specific fit.
5. What coverage ends or changes soon.
6. Whether a new product would solve the present risk or merely start new waiting periods.
7. Premium affordability, if Ram provides it voluntarily.
8. Which facts in this case are withheld by permission rather than missing, so the recommendation states its
   own blind spots honestly instead of reasoning over a gap it cannot see.

### Recommendation output

The recommendation worker must produce:

```text
PRIMARY RECOMMENDATION
Use / renew / retain / buy / top-up / port / seek clarification / no purchase now

WHY
Three to five evidence-backed reasons, each linked to a source.

HOUSEHOLD CASH SCENARIO
Low, expected and high scenario, with stated inputs.

NEXT ACTIONS
Named owner, action and deadline.

UNRESOLVED FACTS
Only facts that cannot be proven from the source pack or that change in real time.
```

## Payment boundary: renewal and new personal cover

Pine Labs is invoked only after a human has approved one of two outcomes:

1. **Renew an existing policy.** The renewal worker has shown the policy-version diff, premium, deadline and any material coverage change.
2. **Purchase a new personal health policy.** The comparison and recommendation workers have shown the chosen product, final premium, waiting periods, exclusions and declarations for approval.

The payment worker records the chosen policy and payment status. It cannot recommend a product, alter a declaration, make a claim decision or handle an emergency deposit.

## Example: Ram's household

For a planned delivery, the agents map the wife to the group enrolment, extract maternity rules, check the selected hospital, split the estimate and calculate a household cash range. The main agent recommends the best policy route and gives Ram a specific pre-authorisation action.

For the mother's planned kidney-related treatment, the agents compare active policies, identify the relevant treatment terms, check hospital access, calculate co-pay and cap exposure, and recommend the primary route. The output remains conditional only where a real-time institution must make the decision.

For an adult child approaching an eligibility age, the continuity worker reads the actual dependent definition, establishes the evidenced coverage end date, and starts a replacement-policy decision before an accidental lapse.
