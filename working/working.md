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

## Product surfaces, acquisition and Delhivery boundaries

Knowvia's web or app workspace is where the household sees its matrix, evidence, calculations, permissions
and decision brief. It is the D2C product, not the HRMS or an insurer's support screen.

WhatsApp is an optional companion for document forwarding, deadline nudges, written next actions and
institutional replies. It is not a source of truth and not the only place the product lives. Every item
received through WhatsApp enters the same permissioned case record and retains its evidence state, source
and date.

Two proposed integrations make the D2C workspace easier to discover and set up:

| Entry point | When it is useful | What it could provide | What it must not become |
|---|---|---|---|
| Employer HRMS | Joining, benefit enrolment, family addition or employer-cover change | A link to Knowvia, an employee-authorised group-policy booklet or schedule, and a prompt to check enrolment | The assumed emergency destination or the source of truth when it conflicts with the policy schedule |
| Insurance platform or adviser, beginning with a proposed Ditto integration | After personal-policy purchase, renewal or an existing support interaction | A trust-led invitation to add the issued policy and build the household record; later, a link to the same permissioned case brief | A white-labelled partner tool, a claimed commercial partnership, or a replacement for the platform's own support service |

This is an acquisition hypothesis, not research proof: in a health event, people are more likely to recall a
health or insurance brand, hospital, TPA or adviser than an employer system. Knowvia therefore uses HRMS for
setup and cover discovery, while insurance platforms can provide a more relevant health-insurance moment of
entry. The household's work remains in Knowvia. The hypothesis needs activation and repeat-use testing.

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

## EOD implementation plan and release gate

This plan turns the product specification into a demonstrable local release. It does not turn a
synthetic prototype, a configured key or an unverified partner credential into a claim of live insurer,
TPA, hospital, voice, payment or emergency-service operation.

### Delivery target

By the end of this build, Knowvia must provide one coherent, synthetic, consent-scoped household journey:

```text
Create household -> record member and permission -> create one of two cases
-> add a source-backed synthetic pack -> run bounded analysis -> review and release
-> show Decision / Financial / Evidence / Research -> take an approved next action
```

The supported case triggers are planned expense, renewal or continuity, and emergency. Renewal remains a
time-sensitive case inside the two entry routes, not a third product mode. An emergency must surface the
admit-first human route before any analysis or chat action.

### Repository ownership map

| Area | Owns | Must not own |
|---|---|---|
| `src/ui/` | Accessible household matrix, case intake, four answer layers, permission-aware rendering and explicit prototype status | Policy, payment or institutional decisions |
| `src/server/` and `src/shared/http/` | HTTP composition, request validation, local security and versioned route dispatch | Business rules or provider-specific logic |
| `src/backend/` | SQLite migrations, repositories, consent, case lifecycle, task persistence and immutable audit events | UI state or provider clients |
| `src/agents/` and `src/modules/` | Typed source-pack analysis, coverage graph, worker contracts and deterministic classification | External actions, money authority or hidden inference |
| `src/orchestration/` and `src/models/` | Bounded DAG execution, model packet construction, reservations, retry and release gates | A fallback that silently turns live mode into fixtures |
| `src/integrations/` | Narrow fail-closed adapters for document, voice, payment, email and future confirmation rails | Policy interpretation or unauthorised side effects |
| `tests/` and `tests/evals/` | Module-level contracts, route journeys, migration safety and adversarial safety evidence | Assertions that synthetic runs prove production effectiveness |

### Data and JSON contracts

Every API and worker boundary must use explicit, versioned JSON-shaped data rather than UI-derived
assumptions. The canonical records are:

- `household`, `adult`, `member`, `policy`, `document`, `source_fact` and `evidence_citation`;
- `permission_grant` with principal, viewer, member, visibility class, purpose, expiry, revocation and
  pre-authorised emergency override;
- `case` with route, trigger, selected member, event, state, evidence digest and revision;
- `worker_output` with role, schema version, one of the six evidence states, citations, confidence,
  effective date, calculation inputs and human-correction marker;
- `institutional_status` with institutional owner, source date, case scope and a Dynamic or Proven state;
- `recommendation` with decision, reasons, cash scenarios, owners, deadlines, unknowns and explicit
  permission blind spots; and
- `approval`, `payment_attempt`, `outbox_item` and `audit_event`, each idempotent and append-only where
  history matters.

No document, model response or user-provided text is executable instruction. Unknown, conflicting,
withheld and false remain distinct values throughout persistence, worker outputs and rendering.

### Required implementation sequence

1. **Foundation and naming.** Install the lockfile dependencies; remove retired-name references from new
   product-facing copy, identifiers and runtime defaults where migration-safe; preserve only explicitly
   historical filenames, remote URL and evidence artefacts. Make the versioned API the canonical route and
   label or remove the memory-only demo seam once equivalent persisted journeys exist.
2. **Household and permission journey.** Complete the persisted household matrix, per-member records and
   per-field/per-viewer grant lifecycle. Enforce revocation, brief invalidation and emergency override in
   repositories, services, API and UI together.
3. **Source-pack and analysis journey.** Implement synthetic source-pack capture with document authority,
   version, page and clause metadata; route it through the A–K decomposition workers. Add contract schemas
   and test fixtures for every worker input and output.
4. **Decision and evidence experience.** Render the four answer layers with proof on demand, source links,
   visible Dynamic/Unknown/Conflicting states, cash-scenario inputs and an owner/deadline for every next
   action. The household matrix replaces a dashboard or chat-first surface.
5. **Pressure paths.** Implement planned expense, renewal/continuity and emergency paths against the same
   case model. Emergency access is a clearly labelled local demonstration until an independently operated
   rota, backup routing, escalation policy and measured service levels exist.
6. **Controlled model assistance.** Gemini is opt-in per run, budget-reserved, schema-validated and
   source-gated. Live analysis requires authorised, protected OCR pages and never falls back to fixture
   input. Fixture mode remains explicit. Record provider invocation metrics and
   redacted errors, but never persist keys or raw sensitive prompts in logs.
7. **Connector boundaries.** Keep Sarvam, Gnani, Pine Labs, email and the proposed Confirmation Rail
   disabled by default and fail closed. A connector becomes usable only after its exact contract,
   authentication, idempotency, webhook verification, reconciliation and explicit human approval gate are
   implemented and tested. Payment is limited to approved renewal or selected personal-cover purchase; it
   never handles an emergency deposit.
8. **Release engineering.** Add configuration validation, health/readiness reporting, migration and restart
   tests, request-size and rate limits, safe structured logs, dependency audit, accessibility and responsive
   UI checks, architecture checks, full tests and a production asset build. Deployment, secrets manager,
   identity provider, encryption-key rotation, backup/restore and 24/7 staffing remain external launch
   prerequisites unless separately implemented and verified.

### Acceptance gates

The local release is ready only when all of these are demonstrated:

- a fresh database migrates and survives restart without cross-household access;
- protected fields require a live matching grant and disappear from future reads immediately after
  revocation;
- every released recommendation is source-linked, evidence-state-labelled and fails closed on missing or
  conflicting controlling evidence;
- no path converts a model output, voice draft or synthetic reply into a declaration, institutional
  confirmation, claim prediction, payment authorisation or policy issuance;
- the emergency route presents admit-first human support without putting an AI or voice step in front;
- live-model configuration is observable and unconfigured or failed calls do not become fixture results;
- all architecture, unit, integration, safety-evaluation and production-build checks pass from a clean
  install; and
- product-facing copy uses Knowvia and accurately labels all simulated, proposed and unverified capability.

### Implemented agent and OCR contracts, 1 October 2026

The canonical coverage workflow is `coverage-analysis` version 4. It executes 22 roles: profile, group,
personal, coverage graph, ten A-J policy-decomposition workers, deterministic decision, the K household
action worker, evidence review, privacy review, safety review, question drafting, bounded primary synthesis
and deterministic release. Every role has versioned input and output
schema IDs. Every output is wrapped in `knowvia-agent-contract-v1` with producer authority, run and case
provenance, input digest, source references, one of the six evidence states and a validated payload. A task
can read only declared dependency envelopes. Invalid identity, dependency, schema, authority or payload
blocks the handoff.

Model assistance is allowed only for profile extraction, group-cover extraction, personal-cover extraction,
question drafting and evidence synthesis. Deterministic code owns consent, source authorization, graph
construction, classification, policy arithmetic, evidence/privacy/safety review, state transitions, external
action authorization and release. Model output never authorises a purchase, payment, declaration, provider
message or claim conclusion.

The OCR boundary is `knowvia.ocr.v1`. It requires an active protected document, current document-processing
consent and a clean scan before starting. Each normalized page retains document ID, immutable source version,
content hash, one-based page number, text digest, extraction state, optional provider confidence and a stable
locator. OCR results remain unverified evidence and require human review. Fixture OCR makes zero provider
calls and proves only lifecycle and schema behavior. Live Sarvam execution remains disabled until an official
endpoint and payload contract, credentials and an injected verified transport are available. Raw provider
responses are not persisted.

Live analysis consumes only successful `knowvia.ocr.v1` pages belonging to the case and backed by an active,
clean, encrypted document. Missing source pages block the run before any model call. Fixture and live inputs
remain separate.

### Explicit release boundary

Passing these gates establishes a production-oriented, locally demonstrable software release. It does not
establish legal compliance, licensed insurance distribution, real-document handling approval, production
data protection, live rail certification, insurer authority, emergency staffing or a deployed service. Each
needs its own owner, evidence and go-live approval.
