# Coversaath working case: Ram's planned expense

## Why this case exists

This is a working example, not a statement about Google's actual employee benefits or any insurer's actual terms. It shows how Coversaath should behave once a household uploads the relevant policy documents, enrolment records, endorsements and hospital estimate.

The household operator is **Ram**, 27, a Google engineer. He has a pregnant wife, a mother with kidney issues, and both parents are above 60. Ram is the user of the product. His family are people whose policies, benefits and care events may appear in the case.

The question is not, "Will every claim pass?" It is:

> Given this family, these documents and this hospital event, what cover applies, what will likely be paid by the household, what must be done now, and what should Ram buy or renew next?

## Product position

Coversaath is a **policy-deciphering and household decision system**. It reads the policies, maps them to each covered person and specific care event, and recommends the best available action.

It does not predict claim approval. It does not make a medical decision. It does not hide uncertainty. But it should give a clear conclusion when the underlying documents answer the question.

## Ram's source pack

Before analysis, the main agent asks Ram for the smallest useful source pack:

1. Group medical policy wording and benefit schedule from Google.
2. Certificate, e-card or employee enrolment schedule showing who is actually enrolled.
3. Dependent endorsement, if spouse or parents were added later.
4. Ram's, his wife's and each parent's individual-policy schedules, if they exist.
5. Renewal notices and any portability or continuity correspondence.
6. Hospital name, city and a written cost estimate for the relevant planned event.
7. Previous claim or pre-authorisation correspondence, if it affects the event.

The system should never invent a benefit. A clause in the master policy proves the rule. The enrolment schedule proves that a named person receives that rule. A dated network result proves the hospital's current network status. A hospital estimate proves the current cost input.

## What Ram sees first

The first screen is not five policy PDFs. It is a household matrix.

| Person | Policies found | Immediate issue | Evidence status |
|---|---|---|---|
| Ram | Group cover; any personal cover | Job-linked continuity | Document-backed where uploaded |
| Wife | Group dependent cover; any personal cover | Pregnancy and delivery | Needs policy-rule mapping |
| Mother | Group dependent cover; individual cover if supplied | Kidney-care expense | Needs treatment-to-policy mapping |
| Father | Group dependent cover; individual cover if supplied | Senior-age renewal and co-pay | Needs renewal review |

Each row opens a short verdict: **covered facts**, **cost exposure**, **conditions that matter**, **next action** and **source pages**.

## Example planned-expense journey: delivery

### 1. Ram starts an event

Ram selects `Plan an expense` and enters:

- Person: wife
- Event: planned delivery
- Expected month
- Hospital and city
- Hospital estimate
- Proposed room type
- Any known clinical variation that changes billing, such as a doctor-indicated C-section

The intake does not diagnose or decide treatment. It translates the hospital plan into insurance questions.

### 2. Workers run in parallel

| Worker | Exact task | Allowed output |
|---|---|---|
| Person and enrolment worker | Match Ram's wife to the group-policy enrolment and endorsements | Enrolled / not evidenced / conflicting, with source |
| Maternity-rule worker | Extract maternity definition, waiting period, cap, delivery wording, newborn wording and exclusions | Clause table with page references |
| Hospital-network worker | Check hospital and branch against the latest official insurer or TPA network source | Networked / not networked / dated result unavailable |
| Estimate worker | Split estimate into package, room, tests, doctor fees, medicines, consumables and deposit | Cost table, not a claim promise |
| Benefit-application worker | Apply extracted rules to each estimate line | Likely payable, capped, excluded-looking, or needs institutional confirmation |
| Cash-exposure worker | Calculate scenarios after caps, co-pay, deductible, room rule and non-medical items | Conservative low / expected / high household cash scenarios |
| Evidence worker | Preserve page, clause, date, document version and calculation inputs | Audit trail |

### 3. Main-agent answer

The main agent returns one concise recommendation in this format:

> **Recommended route:** use the group policy as the first route at the selected hospital, subject to the listed enrolment and maternity conditions. Keep ₹[scenario range] available because [named cap / co-pay / uncovered charge / unresolved pre-authorisation] can remain payable by the household. Submit pre-authorisation through [named hospital desk] by [deadline].

Under `Why`, Ram can inspect every clause, estimate line and calculation. The default view is short. The evidence layer is one tap away.

### 4. What is concrete versus dynamic

| Coversaath can state directly from the supplied record | Coversaath must label as dynamic or unconfirmed |
|---|---|
| Eligibility definition, waiting period, maternity cap, room rule, co-pay, deductible, exclusions and document requirements | Current cashless network status if the source is stale or missing |
| Whether wife is named in an uploaded enrolment schedule | Whether a hospital has accepted pre-authorisation for this exact admission |
| Which estimate lines exceed a stated cap | Final clinical coding, final bill and insurer decision |
| Cash scenarios calculated from declared inputs | Whether a hospital changes its package or deposit demand |

The system does not use "needs confirmation" as a lazy answer. It uses it only for a fact that changes in real time or is absent from the source pack.

## Example planned-expense journey: mother's kidney-related treatment

Ram starts a second event for his mother. He uploads the treatment estimate and her existing policy records. Coversaath does not call his mother to run a generic health interview. Ram is the case operator.

The agents identify:

1. Whether she is enrolled under Ram's group plan and any individual plan.
2. Which policy is active on the planned date.
3. The policy's treatment-related benefit wording, pre-existing-disease clause, waiting period, co-pay, sub-limits and exclusions.
4. Networked hospitals suitable for the selected treatment, using official data where available.
5. The primary and secondary insurance route, if more than one active policy is relevant.
6. The household cash range if cashless is delayed, if a co-pay applies, or if a cost is outside the benefit.
7. The exact documents and pre-authorisation owner.

The main-agent output is a ranked plan, for example:

> **Recommended route:** approach Policy A first for Hospital X because its documented cost-sharing terms are lower for this event and the hospital is in the dated network list. Keep Policy B as the second record. Do not treat either as a claim guarantee. The remaining uncertainty is the institution's case-specific pre-authorisation decision.

## The age-26 continuity event

This is a separate, high-value trigger.

Someone may be covered under a parent's group or family policy while they meet the dependent definition. At 26, employment, marriage, policy renewal, or the plan's exact dependent-age rule may remove that cover. Coversaath must identify this early.

### Continuity worker logic

1. Read the policy's definition of child, dependent, student, age limit and marital-status condition.
2. Read the enrolment date, renewal date and any termination or aging-out rule.
3. Compare the person's date of birth and current status with the rule.
4. Calculate the last date of evidenced coverage. Do not assume it is the birthday without a clause saying so.
5. Raise a deadline case at 120, 90, 60 and 30 days where dates are known.
6. Compare replacement options against the loss of continuity, waiting-period consequences, declared conditions and affordability.
7. Recommend one of: retain current cover; renew before lapse; port where permitted; buy a new personal policy; seek HR or insurer clarification; or no action required.

The primary output is:

> "You are evidenced as covered until [date / policy-renewal event]. Start a personal-policy decision by [date] because a lapse could leave future cover subject to a new policy's waiting periods and underwriting rules."

## Renewal under pressure

When a renewal is approaching, Coversaath runs a renewal case rather than merely showing a reminder.

| Check | Why it matters | Agent action |
|---|---|---|
| Renewal due date and grace period | A missed date can alter continuity | Extract exact dates and create deadline |
| Premium movement | Higher price may be a signal, not proof | Compare old and new schedule |
| Benefit changes | A renewal can change a meaningful protection | Diff policy versions clause by clause |
| New exclusions or changed co-pay | May create a worse position | Highlight wording changes and household impact |
| Claims during the year | May affect decision context | Show record, never infer a penalty without evidence |
| Portability window | Can be time-bound | Identify exact documented deadline |
| Family changes | Dependents may no longer fit the plan | Re-run eligibility map |

The result is not "renew because renewal is good." It is a decision:

> **Renew / renew and add cover / port / seek clarification / do not allow lapse while comparing alternatives.**

## Pressure situation: admission at 2 a.m.

Ram presses `Emergency access`.

The app does not make him perform a policy analysis. It gives the smallest usable record:

1. Policy number, e-card and insurer or TPA number.
2. The person covered and the hospital selected.
3. Dated network status, or a visible "not verified" label.
4. Relevant caps, co-pay and room rule.
5. Likely immediate cash scenario.
6. Hospital-insurance-desk script and required documents.
7. Pre-authorisation and escalation status.

The first instruction remains: **admit first, optimise later.** No insurance workflow may delay urgent care.

## What Ram's parents experience

The normal design is that Ram operates the case. His parents do not need to type, navigate policy clauses or answer a medical questionnaire.

If a parent wants to use Coversaath directly, the product can provide an accessible read-only view. That is an option, not a required workflow. The parent sees a short approved summary: what cover is active, what to carry, whom to call and what Ram has already prepared.

