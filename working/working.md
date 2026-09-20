# Coversaath working notes

## Gnani's correct role

Gnani is not the policy analyst, claims engine or family-interrogation bot. Coversaath's evidence workers do the insurance reasoning. Gnani is used where speaking is faster, easier or more accessible than typing.

### Use 1: optional voice intake for each covered person

At onboarding, Ram can select `Add myself`, `Add wife`, `Add parent` or `Add child` and choose either text or voice.

If he selects voice, Gnani collects only structured, insurance-relevant history in plain language:

- Known past conditions or hospitalisations
- Rough timing and recurrence
- Current treatment or medication, if relevant to an insurance declaration
- Previous policy or claim history, if known
- Whether a detail is certain, estimated or unknown

Gnani converts speech to a structured draft. It reads each material detail back. Ram must correct and approve it before it becomes a declaration or is sent to an insurer. Uncertain speech is never silently converted into a health declaration.

This is optional. Ram can type, upload a document or skip a field and return later.

### Use 2: voice conversation with the main agent

Ram may say:

> "My wife is pregnant, my mother has kidney issues, my employer cover exists, and I need to know whether I should buy another policy now."

Gnani transcribes the request. The main Coversaath agent turns it into a case, assigns specialist workers and returns a structured answer. Gnani can then read that answer aloud, but it does not perform the policy reasoning itself.

### Use 3: accessible text-to-speech for senior citizens

If Ram is unavailable, his father or mother may open an approved household view and listen in their preferred language.

The content is a simplified, pre-generated summary:

- Active policy and member ID
- Hospital or TPA contact route
- What to carry
- What is known about the current event
- What Ram has already done
- Immediate next action

Gnani translates and reads this summary in the requested language. It should not improvise medical, legal or policy conclusions beyond the evidence-backed Coversaath output.

## Product rule: concise answer first, proof on demand

The first response must be a decision, not a wall of text.

| Layer | What Ram receives |
|---|---|
| Decision layer | One recommended route and the next three actions |
| Financial layer | Estimated household cash scenarios and why they differ |
| Evidence layer | Clause, page, policy version, source date and calculation |
| Research layer | Official network data, product comparison, complaint patterns and public discussion, clearly ranked by reliability |

Ram should be able to ask, "Why do you recommend this?" and inspect the reasoning. He should not be forced to read it before getting the decision.

## The two entry routes and Pine Labs boundary

| Start route | User intent | Result |
|---|---|---|
| **Plan an expense** | "I already have insurance. Help me plan this pregnancy, treatment, claim issue or renewal." | Event-specific cover map, cash scenario, next action and, if needed, a renewal decision |
| **Find and buy personal health cover** | "I need personal cover because existing cover ends, is inadequate, or does not exist." | Current-cover reconstruction, comparison, one ranked recommendation and an optional purchase route |

Pine Labs is used only after the user approves a renewal or a selected personal policy. It is the payment rail. It does not decide what to buy, make an insurance recommendation, process a claim, reserve an emergency hospital deposit or replace insurer approval.

## Evidence hierarchy

1. Policy schedule, certificate, endorsement and official wording.
2. Dated insurer, TPA, hospital or employer confirmation.
3. Hospital estimate and treatment documentation.
4. Official regulatory disclosures and product documents.
5. Public complaint trends, reviews and Reddit discussions.

Reddit, reviews and claim-settlement ratios can reveal experience patterns. They cannot prove that Ram's claim will be accepted or that a product is suitable by themselves. They sit in the research layer, never above the policy and event evidence.

## Main-agent operating contract

The main agent receives the user's question, creates a case, delegates evidence tasks, detects disagreements and returns a recommendation.

It must:

- State the household, event, policies and source version used.
- Give a ranked recommendation, not merely a list of options.
- Explain material cash exposure.
- Separate proven policy rules from current operational facts.
- Show exactly what is unresolved and who can resolve it.
- Preserve a full evidence record for review.

It must never:

- Promise claim approval.
- Convert voice uncertainty into an insurance declaration.
- Hide an exclusion, sub-limit, co-pay, waiting period or conflict.
- Sell a product merely because it pays distribution commission.
- Treat a public comment or claim-settlement ratio as stronger than policy wording.

## Pressure-mode design rules

### Planned admission

Give a detailed Admission Readiness Brief: policy route, hospital network status, expected out-of-pocket scenarios, documents, owner, deadline and escalation path.

### Renewal due soon

Diff old and new policy terms. Highlight changes in price, coverage, exclusions, co-pay, waiting periods and dependent eligibility. Give a decision before the deadline.

### Coverage ending at age 26 or another eligibility trigger

Read the exact dependent definition. Identify the evidenced last day of cover. Set a transition decision date early enough to avoid an accidental lapse.

### Hospital admission now

Default to an immediate call to a live healthcare expert. Give that expert the permissioned Emergency Case Brief: e-card, policy number, cover map, dated network evidence, cash scenario, hospital contact path and current pre-authorisation state. AI chat is optional and secondary. Do not make the family wait for an analysis before admission.

### Claim dispute or pre-authorisation delay

Show the stated reason, the policy clause, the missing evidence, current deadline and the permitted escalation route. Do not label a delayed pre-authorisation as a final claim rejection.
