# Answer-to-build map

Updated 20 September 2026. Traceability between the eight Round 2 answers in
[`round2_answers.md`](../round2_answers.md) and the build spec in
[`working.md`](working.md), [`planned-expense.md`](planned-expense.md) and
[`insurance.md`](../building/insurance.md).

Two artefacts, two jobs. **The build spec is the machine.** The A–K decomposition tree, the workers and the
six output states are how a policy actually gets read. **The eight answers are the pitch.** They are judged
on evidence, creativity, clarity, feasibility and thoroughness.

This file exists because those two drifted apart, and because the honest finding is that **the answers
currently under-use the machine.** See section 3.

---

## 1. Objective to build component, answer by answer

### Q1 — What outcome is the agent accountable for?

**Objective:** a completion condition a judge can test.

| Claim in the answer | What actually delivers it | Evidence |
|---|---|---|
| "Person-specific, source-linked route" | Person worker (C), joined to a named enrolment record, not a master-policy definition | 7 of 19 schedules mismatched |
| "What cash may be needed by which deadline" | Cash-exposure worker, low/expected/high scenarios | Vikas: families arrive empty-handed [T2 00:03:42] |
| "No material question disappears into a summary" | Unresolved-facts block in the recommendation output contract | Faizan: "I want the next step" [T7 00:05:41] |
| "Never added into one reassuring number" | Financial-rules worker, D — explicit prohibition on summing sums insured | Meghna's ₹2L dead zone [T4 00:01:43] |

**Status: fully backed.** Every clause in Q1 has a named worker behind it.

### Q2 — Autonomy

**Objective:** a defensible level with real limits.

| Claim | Build component | Note |
|---|---|---|
| L3 inside approved limits | Main-agent operating contract, `working.md` | The "must / must never" lists are the autonomy boundary |
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
| Continuity: 120/90/60/30-day deadlines | Continuity worker (B) |
| Unhappy flow | Distributed across B, F, G, H worker interpretations |

**Status: fully backed.** Q3 is the closest of the eight to the machine.

### Q4 — Rails

**Objective:** depth on each rail, with honest non-use permitted.

| Rail | Build component | Status |
|---|---|---|
| Gnani | `working.md` Uses 1–3, plus the read-back rule | Backed. The three-language cap is a real ceiling, stated |
| Pine Labs | Payment boundary section (`insurance.md`), payment worker | Backed, and narrowed. The hospital-deposit hold is withdrawn |
| Delhivery | Hospital worker (G) — desk location, contact, hours | **Thinnest link.** G covers hospital access; it does not require Delhivery to do it |

**Gap: Delhivery.** The answer says "useful but not load-bearing". The build spec does not mention it at all.
That is consistent, but it means the honest answer on Delhivery is even more honest than we wrote it.

### Q5 — Fourth rail

**Objective:** identify a missing primitive, name a builder.

| Claim | Build component |
|---|---|
| The gap is confirmation, not information | The **Dynamic** state — "can change, needs a dated institutional source" |
| Enrolment, not eligibility | Person worker (C) |
| Network status cannot be asserted | Hospital worker (G): "must use a dated official network source" |
| Pre-auth status, claim status | Claims-process worker (H) |

**Status: this is the tightest derivation in the submission.** Q5 is not an idea bolted on; it is the name of
the state the machine is forced to emit when no rail can answer. Dynamic is the rail-shaped hole.

### Q6 — Human interaction

**Objective:** a real interface, not a chat box.

| Claim | Build component |
|---|---|
| Household matrix first, no dashboard | `planned-expense.md` opening screen |
| Four answer layers, `Why` on demand | `working.md` concise-answer-first rule |
| Evidence hierarchy, Reddit stays in the research layer | `working.md` evidence hierarchy + worker J |
| `Emergency access` → human operator, no voice agent | Emergency handoff rule (H) |
| Seniors: default out, never locked out | `working.md` Use 3 |
| Per-field, per-viewer permissions | **Partly unbacked — see section 4** |

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

## 3. The gap: depth the machine has that the answers do not claim

Counted across both files:

| Term | In the build spec | In the answers |
|---|---|---|
| Mechanism | Build spec | Answers, before | Answers, now |
|---|---|---|---|
| Room-rent sub-limit + proportionate deduction | 1 | 1, in a subclause | **Developed, with the numbers** |
| Deductible dead zone | 2 | 1 | 2 |
| Accrued waiting-period credit on portability | 5 | **0** | **Developed, with the numbers** |
| Grace period, lapse and revival | 2 | 0 | 1 |
| No-claim / cumulative bonus | 1 | 0 | 1 |
| Restoration / recharge | 1 | 0 | 1 |
| ICU and treatment-specific sub-limits | 1 | 0 | 1 |
| Day-care, AYUSH, migration, grievance | 2 each | 0 | 0 — genuinely out of scope for these eight questions |

**Correction to an earlier version of this file.** It reported room rent as appearing zero times in the
answers. That count was wrong: the file wrote "room-rent" hyphenated and the check missed it. The mechanism
was named once, in a subclause. The real gap was that it was named but never developed — the numbers that
make it land (₹10 lakh sum insured, a one-percent daily cap of ₹10,000, a ₹11,200 room, a proportionate
deduction applied to the surgeon's fee and OT charges, a ₹7,000 shared room that was available) were all
absent. That is now fixed.

**The genuine zero was accrued waiting-period credit.** Nikhil's entire story turns on it and the answers
never named it. Group cover typically waives pre-existing-disease waiting periods; retail cover applies two
to four years; porting group-to-retail with the same insurer carries the accrued credit. Missing the window
does not cost a premium, it resets the clock on exactly the conditions being insured against. Now developed
in Q1 and Q3, with his ₹54,000-versus-₹28,000 comparison and his ₹2–8 lakh estimate.

**Also added from the transcripts, previously unused:** Arnab's "On the internet you get the definition. You
don't get your number" [T1 00:09:44], which is the sharpest one-line statement of the problem anyone in the
study produced; and his willingness-to-pay response attached to a specific sentence containing a specific
number [T1 00:15:31], deliberately paired with his calm-month reluctance [T1 00:16:03] so the finding is not
overstated.

---

## 4. The reverse gap: what the answers claim that the machine does not yet do

**1. Per-field, per-viewer permissions. — RESOLVED, 20 September.** The build spec now carries a full
permission model under section C of `insurance.md`: three visibility classes (cover, operational, protected),
per-viewer and per-member grants with purpose, expiry, live revocation and an audit trail, a pre-authorised
emergency override, and six worker constraints. The load-bearing one: **unknown and not-permitted are
different states and must never be collapsed**, because rendering a withheld field as "unknown" leaks a fact
and misinforms the viewer at the same time. Q6 now names the three classes so both sides match.

**2. The Emergency Case Brief assembly path.** Q6 specifies exactly what the operator sees. The build spec
names the brief but does not say which workers populate it or how it stays current when the household record
is stale. This matters because the brief is assembled under time pressure.

**3. The support-operator rota.** Q6 now promises a human answers. Nothing in the build spec describes
staffing, hours, escalation or time-to-human. That is an operations gap, not a code gap, but it is the
promise most likely to be tested by a judge — and Sourav's seven lost hours are the reason it exists.

---

## 5. Where this leaves the submission

The machine is deeper than the pitch. That is the right direction to be wrong in — it is far easier to
surface existing depth than to invent it in five days.

Three edits, in priority order:

1. ~~Name the room-rent proportionate deduction in Q1, and waiting-period credit in Q3.~~ **Done, 20 September.**
2. ~~Add a permission bracket to `insurance.md` under C.~~ **Done, 20 September.**
3. Specify which workers populate the Emergency Case Brief and how it stays current when the household record
   is stale. It is assembled under time pressure and nothing says how.
4. Decide whether the support-operator rota is in scope for the submission or named as an open operational
   dependency. Either is defensible. Silence is not.
