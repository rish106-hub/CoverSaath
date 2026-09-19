# The Ken: opening, submission and pressure test

Verified against the public [competition page](https://the-ken.com/case-competition-2026/) in the browser on 07 September 2026. Refer to the opening by title, **Buying the insurance**, because its displayed number has changed. The logged-in submission form and private upload constraints have not been verified.

## Fit in one sentence

Coversaath helps a household buy the right health cover by reconstructing what exists, verifying who can
operate it, pricing the gap against voluntary affordability inputs, and turning the result into a
Household Health Card. The agent leads; a licensed human enters only at a purchase gate, exception or request.

**Our one confident claim:** a family should not buy another health policy until it knows what protection already exists and whether someone else can operate it during an emergency.

## The scope risk, corrected

An earlier draft of this pack described readiness and the family handover as the entry point, with purchase following it. That was the wrong order for this opening. The opening is titled "Buying the insurance". A submission whose first four steps are consent and document collection, with purchase arriving late, reads as a different product.

The order is now buying-led. Reconstructing cover, verifying the operator and running the five-minute drill are the first half of buying properly, not an activity before buying. They are what makes the recommendation honest rather than a guess about a household nobody examined. This is a change of sequence and framing, not a new product.

The remaining scope risk is the opposite of the earlier one: a sophisticated treatment-spend optimiser,
a family-readiness ritual, or a generic finance planner that never helps someone choose and complete a
purchase does not answer this opening. The Treasury is supporting evidence for buying, not the headline.

## Every major part of the opening

| Opening theme, paraphrased | Response in our design | Pressure test or honest limit |
|---|---|---|
| Important purchases are delayed | User-selected decision date, bounded questions, next action | Does completion improve without repeated researcher chasing? |
| First purchase has no natural deadline | Help the buyer choose a date and resolve a specific decision | A reminder alone cannot create demand |
| Renewal has a hard deadline | Start early, compare changes and preserve pending questions | Last-day cases may not permit switching safely |
| Young adult researching after a parent's warning | Buying trigger at workforce entry, cover reconstruction, operator verification, then guided first purchase | The trigger must cause action without a parent's warning, and ignorance is not demand |
| Long delay because insurance feels like a once-only choice | Explain decision trade-offs and future review triggers | Do not suggest every contract can be freely reversed later |
| Rejected term application followed by missed reapplication | Track institution-provided next steps and dates | Term underwriting is outside the first health-only module |
| Last-minute motor renewal | Shared deadline and payment-status pattern | We do not yet compare motor policies |
| Pending bike cover | Clear incomplete status and next action | Not solved by a health-only policy engine |
| Health renewal gets costlier | Compare current and proposed terms, not premium alone | Lower price can mean weaker protection |
| PDFs, calls and emails scattered | Source-linked reconstruction of existing cover, with owner and unresolved questions | A vault without a completed decision is insufficient |
| Repeated automated calls add no value | Permissioned contact and meaningful updates | Do not become another insurer-sales calling bot |
| Advisers give inconsistent answers | Retain interpretations and obtain written clarification | Our adviser is also fallible and cannot bind the insurer |
| Misunderstood or mis-sold policy, hard to exit | Explain documented options and trade-offs; refuse to recommend before reading what exists | No promise to undo losses or override contract terms |
| Old premium portal is difficult to navigate | Approved payment flow where access exists | No universal LIC or insurer-portal automation claim |
| Friends and basic research substitute for formal advice | Let users bring current advice and compare it | Familiarity and trust may beat our service |
| Family review depends on one knowledgeable person | Verify the real operator and test a backup with the five-minute drill | A named relative may not actually know or have authority |
| People want policy PDFs and riders analysed | Retrieve exact documents and show source-backed differences | A summariser alone is already easy to find |
| People want medical and financial context retained | Capture relevant cover facts and optional affordability inputs once with freshness and role controls | Income and loans do not make cash or eligibility certain; broad wealth planning remains out |
| A headline sum insured can hide treatment-specific caps | Reconstruct policy-level benefit conditions and expose unknown corporate terms before purchase or planned care | No claim approval or payment prediction without a written institutional response |
| Renewal negotiation based on past cases | Draft evidence-backed questions and track replies | Negotiation leverage and insurer agreement are unproven |
| People want calls handled | Agent manages routine follow-up, adviser handles judgment | Measure work actually removed, not calls merely placed |
| Commission creates distrust | Disclose commission at recommendation, permit and expect a no-purchase outcome, never gate help on buying | We are commission-funded, so this is a real conflict we manage, not one we escape |
| Opening suggests one Ditto user pays for advice | Do not treat this as direct willingness-to-pay proof | Ditto publicly describes free consultation; the respondent's transaction is unresolved |
| Desired ending: understand, choose and buy | Adviser review, disclosed commission, approval, verified issued terms, updated handover and family guide | Paid premium alone does not close the case |

The opening's respondents are a research sample, not a national market estimate. We intentionally do not solve every motor, life, savings-policy and exit problem in the first release. Shared workflow potential is not current capability.

### Claims-backwards extension, added 15 September

External practitioner comments point to a credible extension: the purchase engine should inspect benefit
conditions that can matter at admission, not only headline sum insured. The competition story still starts
with buying insurance. The extension is an Admission Readiness Brief for a planned procedure, built from
the same household record and routed to the hospital desk, HR, TPA and insurer. Do not claim claims-API
access, autonomous filing or an approved outcome. This is a design hypothesis that needs a real case.

## Rails and partners

The public page identifies **Zerodha as main partner**, with **Pine Labs for payments, Delhivery for logistics and Gnani for voice**. Do not omit Pine Labs or describe Zerodha as the required payment rail.

Voice has the strongest role: consented multilingual intake to reach the parent or outside relative who actually operates the cover. Gnani already advertises full-context transfer, so our proposed capability must go further: permission-preserving transfer across a young adult, parent, outside relative and expert, with source provenance and unresolved facts. Treat the gap as a question for office hours, not an established absence.

Payments support approved premiums and reconciliation, kept separate from commission disclosure and from
policy issuance. Logistics has no core role in this build because policy and consent flow should be digital.
Zerodha is a later optional source for a user-selected affordability scenario, never a default feed or trading
rail. Do not manufacture shipping or investing to fill a slide.

## Public question checklist

Prompts below are paraphrases. Ready-to-review drafts are in [answers.md](../answers.md).

| Question | Required content | Public limit |
|---|---|---|
| 1 | Members, personal connection and team edge | 50 words total; one line per member |
| 2 | One real customer insight missing from the opening and its design effect | 60 words |
| 3 | Trigger, knowledge, work, counterparties, human decision, completion | Six sentences; at most 15 words each |
| 4 | Role of payments, logistics and voice, including justified non-use | One sentence per rail |
| 5 | One missing capability in one rail | 40 words |
| 6 | One customer asset and why it matters | 30 words |
| 7 | One adjacent use case and why this agent should own it | 30 words |
| 8 | One opening you personally would not delegate even to flawless AI | One sentence |
| 9 | Indian incumbent that could have built this and a reason it has not | 60 words; distinguish inference |
| 10 | Track selection | Product Strategy, subject to the team's final confirmation |

The team has previously reported registration completed. Public registration closes 08 September. Solution Assembly is due **10 September, 23:59 IST**. Shortlist is scheduled for 15 September and finale for 10 October. Recheck the live page for changes before submission. Do not claim a public-page audit verified the state of the team's registration or form.

## Evidence position after the 15 conversations

### Recheck during the paired-agent rerun

The live public page was reread on 07 September 2026. Question 2 explicitly says: "No AI tool can discover how human beings actually behave in the world". Rishav now reports 15 actual student conversations. These can support Question 2. The paired AI interviews remain working material only.

The opening already says insurance knowledge can live in one family member's head. Therefore "young people do not know the policy" is not enough as the missing insight. The sharper observation is that students expected maternal or paternal relatives outside the immediate family to operate the policy, without knowing whether those relatives had the document, knowledge or authority.

The design effect must be the falsifiable one: the five-minute readiness drill, run with a backup person before any recommendation. A drill can be passed or failed and reported honestly. "We verify the operator" is a claim about intent; "a backup person found the cover in five minutes, or did not" is a result.

The answer must still be evidence-safe. Use "most" until the exact numerator is confirmed. Before attaching proof, record participant mix, question wording, raw responses and publication consent. Do not claim that parents caused disengagement. That remains one explanation to test through separate student and parent interviews. Do not present not knowing a policy as evidence that anyone will act, share records or buy.

Describe the work positively and precisely: "We conducted adversarial AI-simulated interviews to identify assumptions, contradictions and design changes." Do not write "we interviewed eight customers", convert hypothetical responses into observed behaviour, or invent recording timestamps and participant consent. An interview format does not turn its simulated subject into a real customer.

Proof attachments are optional and scored; that does not turn fictional interviews into a real discovered insight. The page welcomes evidence such as consented recordings, actual workarounds, raw survey answers, working notes and AI logs. Evidence may be checked and published under the competition's terms. Obtain explicit consent and redact unnecessary identifiers.

No prescribed interview count means we do not need to invent eight to satisfy a quota. One genuine, specific observation is more useful than eight generated endorsements. AI logs can show reasoning; they cannot prove a customer behaved as described.

Question 1 still needs Tiya's confirmed personal details. Question 8 is a personal belief and requires the submitter's approval. Those cannot be completed honestly by inventing biography or conviction.

## Rubric audit

| Criterion | What the pack provides | What is not yet proved |
|---|---|---|
| Evidence | Fifteen user-reported conversations, explicit limits, sources and fictional counterexamples | Exact raw evidence, consent, paired parent checks and one completed real buying case |
| Creativity | Refusing to recommend before reconstruction, verified delegation, the drill and Household Health Card | Whether users value the Treasury beyond an existing broker or app |
| Clarity | Buying sequence, optional affordability plan, named roles and one card | Whether real families complete it without explanation or chasing |
| Feasibility | Agent-led architecture, consent layer, metered human gates and disclosed commission | Licence structure, adviser capacity, financial-data permissions and legal review |
| Thoroughness | Segments, negative cases, scope exclusions, stop rules and continuity | Real performance across diverse households |

No invented score or shortlist probability. Better prose cannot repair missing evidence.

## Editorial approach

Use a specific observed incident, the contradiction it reveals, the design response and the remaining doubt. Lead with the confident claim, then the evidence, then the limit. Keep costs, incentives and alternatives visible, including our own commission. Link the relevant Ken opening rather than decorating every answer with unrelated articles. This is our writing recommendation from the competition's evidence-led format, not a claim to know unpublished judging preferences or an exhaustive audit of The Ken's editorial archive.

Do not tailor to assumed Kerala origins, IIT/IIM education, migration stories or personality traits of judges. Those claims are not established here. Write to the published rubric and the stated customer problem.

## Work before submission

### What changed in the reordering pass

| Decision | Before | Now |
|---|---|---|
| Sequence | Readiness handover as entry point, purchase following | Buying sequence with reconstruction, operator verification, drill, affordability plan and card inside it |
| Payer | Employer or service partner funds free human support | Disclosed distribution commission through a licensed partner; employer channel later |
| Conflict | Criticised commission-driven advice without choosing a funding route | Commission-funded, with disclosure, a no-purchase path and separated adviser pay, stated as a managed conflict not an escape |
| Consent | Production hardening step | Core mechanic and roadmap phase B, enforced in tested code |
| Financial data | Credit, investment and tax data assumed available | Voluntary income, loans, commitments and savings for a specific plan; other sources later and optional |
| Answer 2 design effect | Verify the operator and build a handover | The five-minute drill, a falsifiable test, before any recommendation |
| Engagement | Monthly usage discussed and defended | Abandoned as a goal and a metric |
| Long-term framing | Household Health Treasury named as the direction | Restored as the planning layer beneath the buying agent, without becoming a generic finance app |

### Consolidated result of the five paired reviews

Full reviewer opinions and the exchanges behind them are preserved in [02-customer-tests.md](02-customer-tests.md). The following is the main agent's disposition, not a vote between models. Each interviewer checked all ten answers; their differing wording and dissent remain in the record. Their verdicts were written against the earlier answer drafts, so several dispositions below have moved since.

| Answer | What the review caught | Disposition after edits |
|---|---|---|
| 1 | Tiya's line and personal contribution cannot come from an invented persona | Still needs her approved facts; Rishav must confirm his line |
| 2 | Simulation work could not satisfy firsthand evidence | Replaced by the reported student insight, with the five-minute drill as the design effect; exact count and proof still need documentation |
| 3 | Earlier flow began too late at purchase, then a later draft began too far before it | Now one agent-led sequence: trigger, reconstruction, drill, gap, optional affordability plan, purchase or retain and card |
| 4 | Proposed permission handling could be mistaken for an existing vendor feature | Proposed rail usage stated; our consent layer owns permissions; logistics conditional; Zerodha explicitly unused |
| 5 | Generic contextual transfer already exists; deeper gap unverified | Specific permission and provenance handoff request retained as an open capability test |
| 6 | A young adult may not possess policy documents | Requests policies plus voluntary affordability inputs in exchange for a cover, cost and emergency card |
| 7 | Adjacent use must reuse a real product asset | Planned admission reuses reconstructed cover, permissions, affordability plan and named helpers |
| 8 | No agent can supply the submitter's personal conviction | Requires Rishav's approval, not a product-validation exercise |
| 9 | An incumbent incentive story could be presented as knowledge | Names the unresolved job as refusing to recommend before reconstruction, and labels the incentive explanation a guess |
| 10 | Strategy direction does not verify a locked form selection | Product Strategy draft retained; confirm in the actual submission |

Follow-up defences now cover: whether readiness is a separate product, who pays and why not the employer, whether commission is the conflict we criticise, why consent is core, why financial data left the scope, an existing broker completing the job, why monthly engagement was abandoned, what an adviser actually owns, what the simulations contributed, why they are not human evidence, where the independent agent opinions are stored, and which design changes followed contradiction.

The most important product dissent is preserved: the service may add another person to an already
adequate workflow. The strongest methodological dissent is also preserved: concept-aware agents
produced convenient language and inconsistent fictional details. More agents did not eliminate that.

A third dissent belongs beside them, from the audit of this pack rather than from an agent: the drill on
its own is a feature, and the reconstruction step may be a feature of a distribution platform rather than
a company. The counter-bet is that the household record and delegation history compound for whoever owns
the buying relationship over years. That is a bet, and the pack should say so.

### Word-limit verification after the reordering pass

All answers were recounted after rewriting: Q1 37 of 50, Q2 57 of 60, Q5 30 of 40, Q6 26 of 30, Q7 27 of 30, Q9 57 of 60, and every Q3 step between 12 and 14 of 15 words. Recount again after any final wording change. The actual form's counter takes precedence, especially for hyphenated words. No answer may use an invented numerator for the 15 conversations.

### Remaining preparation

- **07 September:** reconstruct the 15-conversation evidence, exact count, questions, raw answers and consent status. Confirm the buying-led sequence reads correctly in every answer.
- **08 September:** run policy-retrieval and relative-verification tests; interview students and parents separately; verify team facts; get qualified guidance on the distribution licence route and data-protection duties.
- **09 September:** rehearse the trigger-to-reconstruction-to-drill-to-purchase flow, including a case that correctly ends in retain-existing-cover, and validate the rail ask where office hours are available.
- **10 September:** recount limits, verify uploads, personal consent and form fields, then have the user submit before the published deadline.

For a later stage, add actual case outcomes, the purchase and retain mix, adviser hours per case, partner feedback and failure logs. Keep consistent evidence identifiers so a later slide can trace back to the original consented observation. Do not retroactively relabel simulations as research after interviewing someone similar.
