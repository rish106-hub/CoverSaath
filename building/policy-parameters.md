# Health-policy parameters: the coverage checklist

This is the parameter catalogue behind [insurance.md](insurance.md). `insurance.md` defines the workers and the
A–K decomposition. This file lists material parameters a worker must check, derived from first principles. It is
organised into sections a household would recognise.

How to read the tables:

- **Spec** column: `●` means the parameter is already named in `insurance.md` A–K; `○` means it needs an explicit
  build-spec and runtime implementation decision. A named parameter is not automatically calculable.
- **Basis** column: the unit the value is counted in (per claim, per year, per eye, % of sum insured). Two policies
  with the same number but a different basis are different policies.
- Regulatory requirements are **Dynamic**. This catalogue does not set a regulatory number or legal conclusion.
  A current official source and qualified legal review are required before any worker relies on one.
- Every parameter's value is shown with its evidence state: Proven, Calculated, Reported, Dynamic, Unknown or
  Conflicting. A value withheld by permission shows as **Not permitted**, never as Unknown.

---

## 0. First principles

A health policy pays a claim only when **every gate passes**. It then pays the bill **minus every reducer**,
up to the **money available**. Every clause in any policy is one of these three things.

```text
GATES (yes / no)                REDUCERS (how much less)          MONEY AVAILABLE (ceiling)
1 Is this person covered?       non-payable items                 sum insured
2 Is the policy alive?          room-rent cap + proportionate     + cumulative / no-claim bonus
3 Has the waiting clock run?      deduction                       + restoration
4 Is this treatment a benefit?  ICU cap                           + top-up / super top-up
5 Is it excluded?               procedure / disease sub-limits    + other policies
6 Was disclosure clean?         reasonable & customary charges    - already used this year
7 Is the hospital eligible?     package rate                      - already used by floater members
8 Was the process followed?     deductible
                                co-pay (age, zone, network, PED)
```

Every clause, however worded, is stored in one shape so it can be calculated, not just labelled:

```text
IF    scope      member · policy year · event · treatment · bill line · hospital · zone · date
AND   condition  age · wait served · network · room chosen · disclosure · document present
THEN  effect     pay | pay % | cap at amount | cap per day | deduct | exclude | wait until | require | void
PER   basis      claim | illness | person | policy year | lifetime | day | eye / joint / limb
```

**The order of reducers is itself a parameter.** Some policies apply the co-pay before the deductible, some
after. Some apply the sub-limit before the co-pay. The worker records the order the wording states. If the
wording is silent, the order is Unknown and the cash range shows both orders.

---

## 1. Document and authority — *what exactly is the contract?* (A)

| Parameter | What to check | Spec |
|---|---|---|
| Insurer, TPA, group administrator | Who decides, who administers, who services | ● |
| Policy, certificate, member and e-card numbers | Identity of contract and of each member's enrolment | ● |
| Policy type | Individual, floater, group, top-up, super top-up, critical illness, fixed benefit, government scheme | ● |
| Document set | Wording, schedule, certificate, endorsements, renewal notice | ● |
| Customer Information Sheet (CIS) | Mandated one-page summary; easiest to extract; not the contract — disagreement is Conflicting | ○ |
| Product UIN and version | Identifies the filed product; enables comparison and withdrawal detection | ○ |
| Document precedence | Which document wins when schedule, wording and endorsement disagree | ○ |
| Add-ons and riders | Each one separately: premium, term, own waiting period, own exclusions | ○ |
| Intermediary of record | Agent, broker, bank, aggregator or employer HR — who must service it | ○ |
| Source quality and date | Original PDF, portal export, screenshot, forward, verbal | ● |

## 2. People — *who is covered, as of the event date?* (C)

| Parameter | What to check | Spec |
|---|---|---|
| Named insured members | Each household member matched to a named certificate, not inferred from a definition | ● |
| Relationship definitions | Spouse, child, parent, in-law, dependent — exact wording | ● |
| Member effective date | The date each member joined; drives that member's waiting clocks | ● |
| Entry age and maximum renewal age | Per member type | ○ |
| Age-out rules | Dependent child age, student, marital or employment condition | ● |
| Sum-insured allocation | Individual, floater, corporate family pool, per-parent cap | ● |
| Floater exhaustion exposure | One member's claim reduces what is left for everyone else | ○ |
| Underwriting outcome per member | Standard, loading (% and reason), member-specific exclusion, condition-specific wait — **Protected** | ○ |
| Pre-policy medical check-up | Done or waived; waived shifts risk onto the declaration | ○ |
| Proposal-form declarations | Exact answers per member — the basis of any non-disclosure dispute — **Protected** | ○ |
| Residency and occupation | NRI / OCI, long stays abroad, hazardous occupation loadings or exclusions | ○ |
| Newborn, adoption, marriage | Day-one newborn cover, mid-term addition, pro-rata premium | ● |
| Nominee and payout bank account | Needed for reimbursement and fixed-benefit payout | ● (partly) |

## 3. Time — *is the cover alive and has every clock run?* (B, F)

| Parameter | What to check | Basis | Spec |
|---|---|---|---|
| Policy period | Start, end, renewal date | dates | ● |
| Grace period and lapse | Days to renew; whether claims in the grace period are paid; revival terms | days | ● |
| Initial waiting period | Exact days from member start and any accident exception | days from member start | ● |
| PED waiting period | Months before declared pre-existing conditions are covered | months, per member | ● |
| Specified-disease / procedure waits | Named list (hernia, cataract, joints, etc.) and months for each | months, per condition | ● |
| Maternity waiting period | Months before delivery is covered | months | ● |
| Waits on a sum-insured increase | The increased portion serves fresh waits; available cover differs by condition | per tranche of SI | ○ |
| Waiting-period buy-down | Add-on that shortens PED or specified waits | months reduced | ○ |
| Continuity credit | Credit carried from a ported, migrated or group policy, up to the previous SI | months, per member | ● |
| **Moratorium date** | Current rule, continuity requirement and applicable exception, confirmed against a current official source | date, per member | ○ (keyword only) |
| Free-look period | Contractual or regulatory cancel-and-refund window, confirmed against a current official source | days | ○ |
| Relapse window | A recurrence within N days counts as one illness | days | ○ |

## 4. Treatment — *is this event an affirmative benefit?* (E)

| Parameter | What to check | Spec |
|---|---|---|
| In-patient hospitalisation | Minimum admission hours; surgery, medicines, diagnostics, fees | ● |
| Definition of "hospital" | Beds, 24-hour nursing, OT, registration — a small nursing home can fail this | ○ |
| Medical necessity / active treatment | Admission only for tests or evaluation is usually excluded | ○ |
| Day-care procedures | Listed or open-ended | ● |
| Pre- and post-hospitalisation | Days before and after (e.g. 30 / 60, 60 / 180); whether linked to an admitted claim | ● |
| Accident versus illness | Accident skips waits; needs FIR / MLC | ○ |
| Maternity and newborn | Normal and C-section caps, number of deliveries, complications, newborn from day one | ● |
| Pre-existing and chronic care | Disease-specific wording linked to disclosure | ● |
| Modern treatments | Each named method (robotic surgery, immunotherapy, oral chemotherapy, stem-cell, etc.) with its own cap | ● (as a bucket) |
| High-cost care | Dialysis, cancer, cardiac, transplant | ● |
| Organ donor | Harvesting only, or donor's pre- and post-operative care too | ○ |
| Bariatric surgery | BMI and comorbidity conditions | ○ |
| Mental health | Parity under the Mental Healthcare Act 2017 | ● |
| Rehabilitation, home care, domiciliary | Minimum days; "cannot be moved / no bed" conditions; hospital-at-home approval | ● |
| AYUSH | Covered only in a recognised AYUSH hospital; caps | ● |
| Dental and vision | Usually only after an accident; OPD add-on | ● |
| OPD, teleconsultation, diagnostics | Annual OPD wallet, consultations, pharmacy | ● |
| Health check-up and wellness | Annual or after a claim-free year; wellness points turning into discounts | ○ |
| Vaccination | Including post-bite rabies | ○ |
| Second medical opinion | For named critical illnesses | ○ |
| Critical illness and fixed benefit | Trigger definition, survival period, lump sum, interaction with indemnity | ● |
| Hospital daily cash | Per-day amount, day deductible, maximum days | ○ |
| Geography | India only; planned or emergency treatment abroad; currency and exchange rate | ○ |

## 5. Exclusions and disclosure — *what is carved out, and what can unwind cover?* (F)

| Parameter | What to check | Spec |
|---|---|---|
| Standard exclusions with codes | Map each to its regulator code so policies compare | ○ (listed, uncoded) |
| Permanent exclusions | Generic plus condition-specific ones the insured accepted at underwriting | ● (generic only) |
| Lifestyle, hazardous, self-harm, substance | Exact wording | ● |
| Cosmetic, experimental, fertility, gender-affirming | Exact wording; mandated inclusions to check against | ● |
| Disclosure at renewal | Whether new conditions must be declared at renewal | ○ |
| Misrepresentation and fraud | Consequence (claim denial, cancellation) and whether the moratorium protects | ● |

## 6. Money — *the bill-to-payout waterfall* (D)

This is the section that decides what the household pays. Parameters are listed in the order a bill flows
through them. The policy wording can change that order.

### 6.1 Ceiling: money available

| Parameter | What to check | Basis | Spec |
|---|---|---|---|
| Sum insured | Individual, floater, corporate pool, per-parent cap | per year | ● |
| Amount already used | Claims this policy year, for this member and all floater members | per year | ● |
| Corporate buffer | HR-approved discretionary pool — **Dynamic**, never guaranteed | per event | ○ |
| Cumulative / no-claim bonus | % added per claim-free year, cap, how much is lost after a claim, whether it survives porting or an SI change | % of SI per year | ● (partly) |
| Guaranteed / loyalty bonus | Added regardless of claims | % per year | ○ |
| Inflation protection | SI rising with an index | % per year | ○ |
| Restoration / recharge | Trigger (full or partial exhaustion), same illness or person allowed, same claim allowed, how often, floater or per member | per year | ● (partly) |
| Top-up / super top-up | Deductible per claim (top-up) or aggregate per year (super top-up); whether the base payout counts toward it | per claim / per year | ● |

### 6.2 Reducers: line by line on the bill

| Parameter | What to check | Basis | Spec |
|---|---|---|---|
| **Non-payable items** | Regulator's list of non-payable or subsumed items (gloves, admission kits, documentation…); consumables add-on reverses part | per bill line | ● (partly) |
| **Room rent limit** | Fixed ₹ per day, % of SI per day, room category ("single private AC"), or no cap | per day | ● |
| **Proportionate deduction** | Associated charges scaled by eligible ÷ actual room rent; not applied to ICU, pharmacy and consumables, implants and devices, diagnostics, or hospitals without room-wise pricing | ratio | ● (named, no formula) |
| **ICU charge limit** | Separate ₹ or % per day; ICCU, HDU and step-down treated how | per day | ● |
| Procedure and disease sub-limits | Cataract, joint replacement, hernia, hysterectomy, stones, ENT, modern treatments, etc. — with basis | per eye / joint / claim / year | ● (basis missing) |
| Surgery bill components | Surgeon, anaesthetist, OT, implants, medicines, diagnostics, blood, oxygen, physiotherapy, nursing, doctor visits — which are capped, linked to room rent, or uncapped | per line | ○ |
| Reasonable and customary charges | The insurer pays only what it deems customary for the area — major silent short-payment | per line | ○ |
| Package rates / PPN | A negotiated package caps the bill below its line items | per procedure | ○ |
| Ambulance and travel | Road ambulance per trip, air ambulance, donor travel, attendant travel and lodging, conveyance for chemotherapy or dialysis | per trip / per year | ● (partly) |
| Attendant / companion allowance | Daily amount | per day | ○ |
| Deductible | Mandatory or voluntary; per claim, person, year or aggregate | per basis | ● |
| Co-pay — general | % or ₹ | per claim | ● |
| Co-pay — age | Starts at a stated age | per claim | ● |
| Co-pay — zone | Treated in a costlier zone than the one priced | per claim | ○ |
| Co-pay — non-network hospital | Treated outside the network | per claim | ○ |
| Co-pay — PED or named disease | Applies only to listed conditions | per claim | ○ |

### 6.3 Combining policies

| Parameter | What to check | Spec |
|---|---|---|
| Claim order | The insured chooses which policy pays first; the balance goes to the next | ● (partly) |
| Contribution clause | Whether insurers split the bill between them | ○ |
| Deductible layering | Whether the base policy's payout satisfies the super top-up deductible | ○ |

## 7. Where — *which hospital, which process?* (G)

| Parameter | What to check | Spec |
|---|---|---|
| Network status | Dated official source, specific branch — a city listing is not branch proof | ● |
| Preferred / excluded hospitals | Preferred-provider list; de-empanelled or blacklisted hospitals whose claims are refused | ○ |
| Cashless at non-network hospitals | "Cashless everywhere" notice period: planned versus emergency | ○ |
| Pre-authorisation | Form, owner, planned versus emergency timeline, enhancement requests | ● |
| Authorisation turnaround | Contractual or regulatory response expectation and breach consequence, confirmed against a current official source | ○ |
| Room category chosen | Its effect through 6.2 | ● |
| Deposit and estimate | Deposit demanded, estimate lines, revisions | ● |
| Distance to suitable network hospital | By specialty, from the household's home — matters when buying | ○ |

## 8. Process — *what must be done, by when, by whom?* (H)

| Parameter | What to check | Spec |
|---|---|---|
| Intimation deadline | Planned and emergency | ● |
| Reimbursement submission deadline | Days after discharge | ● |
| Documents per event type | Discharge summary, bills, reports, prescriptions, FIR / MLC | ● |
| KYC at claim | CKYC or e-KYC requirement | ○ |
| Who collects records | The insurer or TPA should obtain hospital records directly | ○ |
| Status by authority | Hospital desk, TPA and insurer kept as separate statuses | ● |
| Rejection rules | Claims review committee, specific reason citing a clause | ○ |
| Settlement turnaround and interest | Days to settle; interest owed on delay | ○ |
| Partial settlement breakdown | Line-by-line deduction mapped back to section 6 clauses so it can be contested | ○ |
| Grievance ladder with clocks | Insurer grievance officer → Bima Bharosa → Insurance Ombudsman (time and value limits) → consumer forum | ● (partly) |

## 9. Keeping it — *what does continuing cost and what can change?* (B, I)

| Parameter | What to check | Spec |
|---|---|---|
| Renewal version diff | Clause-level changes, not only price | ● |
| Premium now | Base, loadings, add-ons, discounts, tax | ● |
| Next age-band crossing | Renewal at which a member's premium jumps | ○ |
| Premium revision rules | No loading for an individual's own claims; product-wide revisions need approval | ○ |
| Payment mode | Annual, multi-year discount, instalments; consequence of a missed instalment | ○ |
| Lifelong renewability | Stated grounds for refusing renewal | ○ |
| Portability | Deadline before renewal; what carries over (waits up to previous SI, bonus); re-underwriting | ● (partly) |
| Group-to-individual conversion | Option and window on leaving the employer; credit for group years | ● (partly) |
| Product withdrawal | Notice, migration offer, credit preserved | ○ |
| Cancellation | Insured's refund basis (pro-rata or short-period); insurer's grounds | ○ |
| Tax | Section 80D limits, qualifying payment mode (not cash); GST status of the premium | ○ |

## 10. Insurer quality — *will they actually pay, and how fast?* (J)

Each metric with its source and the year it refers to:

| Parameter | Spec |
|---|---|
| Claim settlement ratio by count **and** by amount | ● (single ratio) |
| Incurred claim ratio | ○ |
| Repudiation ratio | ○ |
| Complaints per 10,000 claims | ○ |
| Average settlement turnaround | ○ |
| Solvency ratio | ○ |
| In-house claims or TPA | ○ |
| Network density in the household's city | ○ |
| Public complaint patterns | ● |

## 11. Household portfolio — *is the household as a whole protected?* (K)

| Parameter | What to check | Spec |
|---|---|---|
| Who has no evidenced cover | Any member without a named certificate | ● |
| Adequacy | Available cover versus the city cost of the household's likely events — needs a procedure-cost dataset | ○ |
| Employer dependence | Share of cover lost if the earner's job ends | ○ |
| Floater concentration | One high-risk member sharing a pool | ○ |
| Layering fit | Super top-up deductible matches base SI; gaps and overlaps | ○ |
| Premium path | Projected premium over 10–20 years versus stated affordability | ○ |
| Inflation erosion | Real value of today's SI in 5 and 10 years | ○ |
| Next cover-ending event | Age-out, job change, renewal, lapse | ● |
| Recommendation | Use / renew / retain / buy / top-up / port / clarify / no purchase now | ● |

## 12. Regulatory and legal review — *where a current rule may affect the wording*

A separate legal-review check can compare extracted wording with a current, cited regulatory source. It must retain
the source date and jurisdiction, identify the exact rule being compared, and route disagreements to a qualified
reviewer. It does not silently rewrite policy terms or declare a product compliant. Areas that commonly need this
check include waiting periods, continuity, cancellation and renewal terms, cashless service expectations,
proportionate deductions and mandated inclusions.

---

## Current implementation boundary

The A–K decomposition uses exact structured field names, not free-text substring matching. Permission-restricted
facts must be excluded before analysis; access status is separate from the six evidence states and must not be
rendered as Unknown. The live policy-arithmetic path is intentionally bounded: each clause needs the rule shape
above, plus source provenance, before it can contribute to a calculation. Until then it remains a source-backed
observation or an explicit evidence gap, not a payout conclusion.
