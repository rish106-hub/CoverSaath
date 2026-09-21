# Answer-to-build map

Updated 21 September 2026. Traceability between the eight Round 2 answers in
[`docs/strategy/round2-answers.md`](../docs/strategy/round2-answers.md) and the build spec in
[`working.md`](working.md), [`planned-expense.md`](planned-expense.md) and
[`insurance.md`](../building/insurance.md).

Two artefacts, two jobs. **The build spec is the machine.** The A–K decomposition tree, the workers and the
six output states are how a policy actually gets read. **The eight answers are the pitch.** They are judged
on evidence, creativity, clarity, feasibility and thoroughness.

This file exists because those two drifted apart. The answers now expose only the mechanics needed to answer
each question clearly. Omitted build depth remains available in the build spec and should not be restored to
the submission unless it resolves a judge-facing gap.

---

## 1. Objective to build component, answer by answer

### Q1 — What outcome is the agent accountable for?

**Objective:** a completion condition a judge can test.

| Claim in the answer | What actually delivers it | Evidence |
|---|---|---|
| "What cover applies" | Person worker (C) joined to the benefit-application worker | 7 of 19 schedules mismatched |
| "What could limit payment" | Financial-rules, treatment and exclusions workers (D–F) | Meghna's ₹2L dead zone [T4 00:01:34] |
| "What cash they may need" | Cash-exposure worker, low/expected/high scenarios | Vikas: families arrive empty-handed [T2 00:03:42] |
| "What to do next" | Household recommendation and unresolved-facts output | Faizan: "I want the next step" [T7 00:05:41] |
| "Source for each fact" | Evidence worker and field-level provenance rule | Meghna: "page fourteen" [T4 00:06:06] |
| "Owner of anything still unknown" | Named owner and deadline in the unresolved-facts block | Institutional handoff failures across T2, T5 and T6 |

**Status: fully backed.** Every clause in Q1 has a named worker behind it.

### Q2 — Autonomy

**Objective:** a defensible level with real limits.

| Claim | Build component | Note |
|---|---|---|
| L3 inside approved limits | Main-agent operating contract, `working.md` | The "must / must never" lists are the autonomy boundary |
| Send an institutional question only inside existing authority | Permission model in C and main-agent outbound-action boundary | The fourth rail is not silently assumed |
| Must ask before a declaration | Exclusions worker (F): "Only the user can approve a declaration" | Also enforced at voice intake |
| Autonomy **drops** in an emergency | Emergency handoff rule (H) | AI becomes retrieval only |

**Status: backed, and Q2's strongest line — autonomy dropping at peak stakes — comes from the build spec,
not from the pitch.**

### Q3 — States

**Objective:** a real state machine, including failure.

| Claim | Build component |
|---|---|
| Two entry routes, renewal not a third | `working.md` entry-route table; `planned-expense.md` |
| Workers in parallel | Worker system diagram, `insurance.md` |
| Six output states | Non-negotiable worker rule |
| Unhappy flow | Distributed across B, F, G, H worker interpretations |

**Status: fully backed.** Q3 is the closest of the eight to the machine.

### Q4 — Rails

**Objective:** depth on each rail, with honest non-use permitted.

| Rail | Build component | Status |
|---|---|---|
| Gnani | `working.md` Uses 1–3, plus the read-back rule | Backed. The three-language cap is a real ceiling, stated |
| Pine Labs | Payment boundary section (`insurance.md`), payment worker | Backed, and narrowed. The hospital-deposit hold is withdrawn |
| Delhivery | Hospital worker (G) plus `working.md` WhatsApp and Delhivery boundaries | Supporting only. Maps validates the route to an already confirmed desk; it does not establish insurance eligibility or network status |

**Delhivery boundary.** The build spec now names the narrow Maps use. Original-document shipping remains out
of the first build because neither demand nor a defensible chain-of-custody workflow has been evidenced.

### Q5 — Fourth rail

**Objective:** identify a missing primitive, name a builder.

| Claim | Build component |
|---|---|
| The gap is confirmation, not information | The **Dynamic** state — "can change, needs a dated institutional source" |
| Enrolment, not eligibility | Person worker (C) |
| Network status cannot be asserted | Hospital worker (G): "must use a dated official network source" |
| Pre-auth status, claim status | Claims-process worker (H) |
| Modern-therapy inner cap and split institutional ownership | Financial-rules worker (D), treatment worker (E) and claims-process worker (H): each answer stays tied to the hospital desk, TPA or insurer that owns it |

**Status: this is the tightest derivation in the submission.** Q5 is not an idea bolted on; it is the name of
the state the machine is forced to emit when no rail can answer. Dynamic is the rail-shaped hole.

**Iteration evidence.** Shilpa Arora's public feedback on the earlier architecture named the missing
requirements: immunotherapy can have a low inner cap inside a high sum insured; corporate cover can be
invisible until hospitalisation; and hospital desk, TPA and insurer answers must not be merged. The new
build spec implements those requirements. The Fourth Rail makes their live confirmation possible.

### Q6 — Human interaction

**Objective:** a real interface, not a chat box.

| Claim | Build component |
|---|---|
| Household matrix first, no dashboard | `planned-expense.md` opening screen |
| Four answer layers, `Why` on demand | `working.md` concise-answer-first rule |
| Evidence hierarchy, Reddit stays in the research layer | `working.md` evidence hierarchy + worker J |
| `Emergency access` → human operator, no voice agent | Emergency handoff rule (H) |
| Seniors: default out, never locked out | `working.md` Use 3 |
| Per-field, per-viewer permissions | Permission model under C in `insurance.md` |
| Emergency operator is a launch gate | Open operational dependency stated in Q6 and section 4 below |

### Q7 — Name

Knowvia. No build dependency.

### Q8 — Policybazaar

**Objective:** a real incumbent and a real reason they would struggle.

| Claim | Build component |
|---|---|
| "Buy / renew / retain / defer / cannot confirm are equally valid" | Recommendation output contract: `Use / renew / retain / buy / top-up / port / seek clarification / no purchase now` |
| Differentiation is the persistent record and unknown-discipline | The six states and the field-level provenance requirement |

**Status: backed.** Q8's argument is that a conversion-led business will not ship a button that says "no
purchase now". Our build spec has that button in its output contract.

---

## 2. Reverse map — which A–K brackets the answers actually use

| Bracket | Used in the answers? | Where |
|---|---|---|
| A. Document identity and authority | Partly | Q3 source pack; the rule-versus-enrolment split |
| B. Policy lifecycle and continuity | **Yes, heavily** | Q3 continuity trigger, Q5 |
| C. People, eligibility and enrolment | **Yes, heavily** | Q1, Q3, Q5 — enrolment vs eligibility is a recurring line |
| D. Coverage structure and financial limits | **Partly — the big miss** | Deductible and co-pay appear; room rent, sub-limits, restoration and no-claim bonus do not |
| E. Medical benefits and treatment rules | Barely | Maternity via the worked example only |
| F. Exclusions, waiting periods and disclosures | Partly | Waiting periods named, not decomposed |
| G. Hospital access and cashless process | Yes | Q3 unhappy flow, Q5, Q6 emergency brief |
| H. Claim, pre-auth and reimbursement | Yes | Q3, Q5, Q6 |
| I. Renewal, portability and change control | Partly | Renewal-is-a-diff appears; migration and revival do not |
| J. Service quality and external research | Yes | Q6 evidence hierarchy |
| K. Household recommendation and action plan | **Yes, fully** | Q1, Q6, Q8 |

---

## 3. Build depth deliberately kept out of the submission

The build spec remains deeper than the form answers. That is intentional. The following mechanisms remain
implemented in the design but are not expanded in the eight answers unless the portal provides room or a
judge asks:

- Full room-rent and proportionate-deduction calculation.
- Grace period, lapse, revival and migration mechanics.
- No-claim or cumulative bonus changes.
- Restoration and recharge rules.
- Day-care, AYUSH and grievance decomposition.
- The full A–K policy tree and every worker output field.

The submission keeps treatment-specific caps, deductible interaction, waiting-period continuity, enrolment,
cash exposure and institutional ownership because those directly establish the outcome, state flow, fourth
rail and interface. Restoring every insurance mechanism would increase thoroughness on paper while reducing
clarity, which is the current scoring constraint.

---

## 4. The reverse gap: what the answers claim that the machine does not yet do

**1. Per-field, per-viewer permissions. — RESOLVED, 20 September.** The build spec now carries a full
permission model under section C of `insurance.md`: three visibility classes (cover, operational, protected),
per-viewer and per-member grants with purpose, expiry, live revocation and an audit trail, a pre-authorised
emergency override, and six worker constraints. The load-bearing one: **unknown and not-permitted are
different states and must never be collapsed**, because rendering a withheld field as "unknown" leaks a fact
and misinforms the viewer at the same time. Q6 now names the three classes so both sides match.

**2. The Emergency Case Brief assembly path. — RESOLVED, 21 September.** `working.md` and
`insurance.md` now name the six bounded worker outputs that populate the brief. They also require source
dates and visible Dynamic, Unknown or Conflicting labels. No field is silently refreshed while the operator
waits.

**3. The support-operator rota: EXPOSED AS A LAUNCH GATE, 21 September.** Q6 and the build spec now state
that emergency access cannot launch until staffing, escalation, backup routing, answered-call rate and
time-to-human have been measured. This resolves the submission overclaim, not the operating dependency.

---

## 5. Where this leaves the submission

The answers now match the build while remaining readable enough for a form and an AI-assisted first pass.
The remaining product gaps are explicit rather than hidden:

1. Specify which workers populate the Emergency Case Brief and how stale fields are refreshed or labelled.
2. Design and test the support-operator operating model before offering emergency access.
3. Test the Gnani console and live voice flow.
4. Test the Pine Labs payment-to-issuance reconciliation path.
5. Obtain a licensed distribution partner and qualified review of data handling and delegated authority.

These are implementation dependencies. They should not be filled with invented capabilities or targets in
the Round 2 paper design.
