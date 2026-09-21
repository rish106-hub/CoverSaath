# Knowvia working notes

## Gnani's correct role

Gnani is not the policy analyst, claims engine or family-interrogation bot. Knowvia's evidence workers do the insurance reasoning. Gnani is used where speaking is faster, easier or more accessible than typing.

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

Gnani transcribes the request. The main Knowvia agent turns it into a case, assigns specialist workers and returns a structured answer. Gnani can then read that answer aloud, but it does not perform the policy reasoning itself.

### Use 3: accessible text-to-speech for senior citizens

A senior family member is not restricted to listening. The operator model is the **default, not a ceiling**:
Ram runs the case so his parents do not have to, but if his father or mother wants to open the case, add a
document, answer a question, correct a fact or act on their own policy, they can. Nothing is locked to Ram.

What we do not do is hand a senior full agency by default and then expect them to operate an insurance
workflow. S. Ghosh, 58, holds the family policy and cannot get past the insurer login [T3]. Defaulting him
into the driver's seat would fail him. Defaulting him out of it, permanently, would also fail him.

If Ram is unavailable, or simply if a parent wants to, they open an approved household view and listen in
their preferred language.

The content is a simplified, pre-generated summary:

- Active policy and member ID
- Hospital or TPA contact route
- What to carry
- What is known about the current event
- What Ram has already done
- Immediate next action

Gnani translates and reads this summary in the requested language. It should not improvise medical, legal or policy conclusions beyond the evidence-backed Knowvia output.

From that view, a senior can request the same actions any operator can: ask a question, supply a document,
correct a recorded fact, or start a case on their own policy. Their own records are theirs. What they cannot
do is see another adult's protected fields without that adult's permission, which is the same rule that
applies to Ram.

## Permission

Permission is per-field and per-viewer, never a household switch. The full model — the three visibility
classes, grants, expiry, revocation, the pre-authorised emergency override and the worker constraints — is
specified under section C of [`building/insurance.md`](../building/insurance.md). Every rule in this file is
subject to it, including Gnani's three uses: a voice agent may not read a protected field aloud to a viewer
who does not hold that class.

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

## WhatsApp and Delhivery boundaries

WhatsApp is the main working surface for document forwarding, deadline nudges, written next actions and
institutional replies. It is not a source of truth. Every item received through WhatsApp enters the same
permissioned case record and retains its evidence state, source and date.

Delhivery is a supporting Maps rail, not a core insurance workflow. After a hospital insurance desk has been
confirmed through an insurer, TPA or hospital source, Knowvia may use address validation, geocoding and routing
to reduce wrong-address and wrong-desk friction. It does not infer network status from proximity. Original
document shipping is not part of the first build. It is considered only when an institution specifically
requires an original and the product can record consent, recipient proof, return or destruction status.

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

**Direct call to a human support operator. Gnani has no role in this path at all.**

Pressing `Emergency access` dials a trained support human. That human receives the permissioned Emergency
Case Brief: e-card, policy number, cover map, dated network evidence, cash scenario, hospital contact path
and current pre-authorisation state. They are a support operator who already has the file open, not a
clinician: they do not advise on treatment.

The brief is assembled from bounded worker outputs: document identity supplies the correct policy and
e-card; person and enrolment supplies the named member; benefit and cash-exposure supplies limits and the
immediate cash scenario; hospital access supplies the dated network and desk route; claims-process supplies
pre-authorisation and escalation state; evidence supplies the source date and visible uncertainty. A field is
never silently refreshed during the call. It remains Proven, Dynamic, Unknown or Conflicting, with its source
date, until an approved institution returns a new answer.

This route cannot be offered as emergency access until an on-call rota, backup routing and escalation rules
have been tested. A pilot measures answered-call rate and time-to-human first. Office-hours support must be
labelled as office-hours support, not emergency support.

No voice agent, no IVR, no bot triage, no read-back, no transcription step. Sourav's specification is one
button and a person who does not ask him anything [T5 00:04:22, 00:04:36]. A voice agent in that path is a
screen with a voice.

Talking to the AI is a **separate product path**, available any time the user chooses it, including during a
hospital stay for a non-urgent question. It is never on the emergency route and never a step before the call
connects. Do not make the family wait for an analysis before admission.

### Claim dispute or pre-authorisation delay

Show the stated reason, the policy clause, the missing evidence, current deadline and the permitted escalation route. Do not label a delayed pre-authorisation as a final claim rejection.
