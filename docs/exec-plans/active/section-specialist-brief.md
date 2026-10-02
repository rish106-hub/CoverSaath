# Section specialist brief

You are one of 12 section specialists building Knowvia's policy breakdown backend on branch
`claude/policy-backend`. The central agent owns integration. Read this whole brief, then
`src/modules/policy-breakdown/contracts.js` (the binding contract) and `building/policy-parameters.md`
(the parameter catalogue for your section). Do not edit any file outside your ownership list.

## What Knowvia is

Knowvia turns a household's Indian health-insurance policy PDF into a source-backed record of every
parameter, so two later tracks work: planned-procedure chat (cash estimate, steps) and emergency
call/chat (a human operator with a read-only card). Accuracy beats cost. A model only proposes values
with verbatim quotes; deterministic code verifies quotes against page text; critical fields get a second
model opinion and a human confirmation.

## Your deliverables (exactly these files)

1. `src/modules/policy-breakdown/sections/sNN-<slug>.js` — `export default defineSection({...})` importing
   from `../contracts.js`. Contains:
   - `expertise`: a precise, expert prompt section (plain prose, ≤ 12,000 chars) that teaches an
     extraction model how Indian health policies express this section: typical clause titles, synonyms,
     where it usually appears (schedule vs wording vs CIS), traps (e.g. "room rent 1% of SI per day" vs
     "single private AC room"; "per eye"; co-pay applying only above an age), how to read IRDAI-standardised
     wording, and when to answer found=false. It must instruct: quote verbatim, never infer from general
     knowledge or regulation, never fill a value from another policy, report each distinct value once,
     use memberScope when a value applies to a named member only. Never instruct the model to give advice.
   - `parameters`: every parameter for your section. Must include **all required keys below with exactly
     the given valueType**. Add further parameters from `building/policy-parameters.md` for your section
     (aim for complete coverage of that section's table). Keys are snake_case and must not reuse any key
     listed for another section in this brief.
   - For each parameter: `label`, `description` (what exactly counts, unit and basis expectations),
     `valueType`, `enumValues` for enums, `effects`/`bases` (restrict to the sensible subset), `critical`
     (true only where a wrong value could cause cash or emergency harm), `visibility`
     (`cover` | `operational` | `protected` — medical declarations, loadings, claim reasons are protected),
     `memberScoped`, `extractionHints` (clause titles and phrases to look for), `emergencyCard`,
     `estimateInput`, and optional `validate(value)` returning an error string or null for impossible
     values (e.g. a waiting period of 900 months).
   - Analysis sections (10–12) set `kind: 'analysis'` and implement `analyze(context)` (see below).
   - `reviewGuidance`: what a human reviewer should check for this section's critical parameters.
2. `tests/fixtures/policy-breakdown/sNN-wording.txt` (extraction sections 1–9): synthetic policy wording
   for your section only, written like a real Indian policy wording/schedule/CIS, 1–3 pages separated by a
   line containing exactly `=== PAGE BREAK ===`. Use the fixture story below. Include at least one
   realistic trap (an exception, a member-specific condition, a cap with a basis) and leave at least one
   of your parameters genuinely absent so the expected answer is `found: false`.
3. `tests/fixtures/policy-breakdown/sNN-gold.json` (extraction sections): the exact answer a perfect
   extraction model would return, shaped as `{ "section": N, "expected": [ item, ... ] }` where each item
   has the model output fields from `sectionOutputSchema` **except** `citations`, plus `"quote"`: one
   verbatim substring of your wording file (whitespace exactly as written) that proves the value. For
   `found: false` items set all values null, lists empty, `quote: null`, `confidence: "high"`.
   For analysis sections, provide `sNN-cases.json` instead: `{ "section": N, "cases": [ { "name",
   "context", "expected": { "<key>": { "evidenceState", "value" } } } ] }` with at least four cases
   (normal, missing input, conflicting input, edge).
4. `tests/policy-breakdown-sNN.test.mjs` using `node:test` and `node:assert/strict`. It must:
   - import your section and assert it is a valid `defineSection` result with the required keys/types;
   - (extraction) assert every gold item's key exists, every `found: true` item passes
     `normaliseValue(parameter, item)`, every quote is a verbatim substring of the wording file, at
     least one item is `found: false`, every critical parameter appears in gold;
   - (analysis) run every case through `analyze` and assert the expected states/values, including that
     missing input yields `Unknown` (never a guessed value) and nothing is ever `Proven`.

Run `node --test tests/policy-breakdown-sNN.test.mjs` until it passes. Do not run or change other tests.

## Fixture story (shared by all sections — keep facts consistent)

Synthetic only. No real insurer, person or policy.

- Insurer: **Example General Insurance Company Limited**. Product: **Example Family Health Plan**.
  UIN: **EXAHLIP26001V012526**. TPA: **Example Health TPA Private Limited**.
- Policy number **EX/FHP/2026/000123**, family floater, policy period **2026-04-01 to 2027-03-31**,
  first inception with this insurer **2023-04-01** (continuous since then).
- Insured members: **Ram Kumar** (proposer, self, DOB 1988-05-14), **Sita Kumar** (spouse, DOB
  1991-02-02), **Luv Kumar** (son, DOB 2018-09-30), **Kaushalya Devi** (mother, DOB 1962-07-21).
  Kaushalya has a declared pre-existing condition (hypertension) — protected.
- Sum insured **₹10,00,000** floater. Zone **B** pricing. Cumulative bonus **10% of SI per claim-free
  year, maximum 50%**, reduced by 10% on a claim year.
- Room rent: **single private AC room**, otherwise up to **1% of sum insured per day**; ICU **actuals**.
  Proportionate deduction applies when a higher room is chosen, **except** pharmacy, consumables,
  implants and diagnostics.
- Co-pay **20%** on every claim for any insured member aged **61 years or above** at the time of claim
  (so Kaushalya, not the others). **10%** zone co-pay when a Zone B policy is used for treatment in a Zone
  A city. No general deductible.
- Restoration **100% of base sum insured once per policy year**, not for the same illness in the same year.
- Waiting periods: initial **30 days** (not for accidents), PED **36 months**, specified diseases
  **24 months** (cataract, hernia, joint replacement, kidney stones, among others), maternity
  **24 months**. Moratorium wording: **60 continuous months**.
- Sub-limits: cataract **₹40,000 per eye per policy year**; maternity **₹50,000 normal / ₹75,000
  C-section**, max **2 deliveries** in the policy lifetime; road ambulance **₹3,000 per hospitalisation**;
  modern treatments **50% of sum insured**; AYUSH up to sum insured in a government-recognised hospital.
- Pre-hospitalisation **60 days**, post-hospitalisation **180 days**; minimum in-patient admission
  **24 hours** except listed day-care procedures.
- Cashless: network hospitals; planned admission pre-authorisation **at least 72 hours** before; emergency
  intimation **within 24 hours** of admission. TPA helpline **1800-000-0000** (fictional).
- Reimbursement claim documents within **30 days** of discharge. Grievance: insurer grievance officer,
  then Bima Bharosa, then Insurance Ombudsman.
- Renewal: lifelong renewability; grace period **30 days** (no cover during grace); portability per
  regulation; cancellation refund **pro-rata** for the unexpired period if no claim.

## Required keys per section (exact key and valueType; you may add more)

S1 document-authority: `insurer_name` text (critical, emergencyCard), `product_name` text,
`product_uin` text, `policy_type` enum[individual, family_floater, group, top_up, super_top_up,
critical_illness, fixed_benefit, other] (critical), `policy_number` text (critical, operational,
emergencyCard), `tpa_name` text (emergencyCard), `document_precedence` rule, `add_on_covers` text_list,
`intermediary_name` text.

S2 people: `insured_members` text_list (critical, emergencyCard; each item "Name — relationship"),
`sum_insured_structure` enum[individual, family_floater, individual_per_member, group_pool] (critical),
`eligible_relationships` text_list, `max_entry_age_years` years, `dependent_child_max_age_years` years
(critical), `newborn_cover` rule, `nominee_required` boolean, `member_specific_conditions` rule
(protected, memberScoped).

S3 time: `policy_start_date` date (critical, emergencyCard), `policy_end_date` date (critical,
emergencyCard), `first_inception_date` date, `grace_period_days` days, `initial_waiting_period_days`
days (critical, emergencyCard), `ped_waiting_period_months` months (critical, emergencyCard),
`specified_disease_waiting_months` months (critical), `specified_disease_list` text_list,
`maternity_waiting_period_months` months, `accident_exempt_from_initial_wait` boolean,
`moratorium_period_months` months, `free_look_period_days` days, `continuity_credit_rule` rule,
`relapse_window_days` days.

S4 treatment: `inpatient_minimum_hours` count, `daycare_covered` boolean, `pre_hospitalisation_days`
days (critical), `post_hospitalisation_days` days (critical), `hospital_definition` rule,
`maternity_covered` boolean, `modern_treatments_covered` boolean, `modern_treatment_list` text_list,
`ayush_covered` boolean, `domiciliary_covered` boolean, `organ_donor_covered` boolean,
`mental_illness_covered` boolean, `opd_covered` boolean, `treatment_abroad_covered` boolean.

S5 exclusions: `standard_exclusions` text_list (critical), `permanent_exclusions` text_list,
`ped_definition` rule, `disclosure_at_renewal_required` boolean, `non_disclosure_consequence` rule,
`fraud_clause` rule, `investigation_only_admission_excluded` boolean.

S6 money: `sum_insured_amount` money (critical, emergencyCard, estimateInput), `room_rent_limit_kind`
enum[no_limit, fixed_amount_per_day, percent_of_si_per_day, room_category, category_or_percent]
(critical, emergencyCard, estimateInput), `room_rent_eligible_category` enum[general_ward, shared_room,
single_private_room, single_private_ac_room, any_room, not_stated] (estimateInput), `room_rent_limit_amount`
money (estimateInput), `room_rent_limit_percent` percent (estimateInput), `icu_limit_kind`
enum[no_limit, actuals, fixed_amount_per_day, percent_of_si_per_day] (critical, emergencyCard,
estimateInput), `icu_limit_amount` money, `icu_limit_percent` percent, `proportionate_deduction_applies`
boolean (critical, estimateInput), `proportionate_deduction_exempt_heads` text_list (estimateInput),
`copay_general_percent` percent (estimateInput), `copay_age_percent` percent (critical, emergencyCard,
estimateInput), `copay_age_threshold_years` years (critical, estimateInput), `copay_zone_percent`
percent (estimateInput), `policy_zone` enum[zone_a, zone_b, zone_c, not_zoned], `copay_non_network_percent`
percent (estimateInput), `deductible_amount` money (estimateInput), `cumulative_bonus_percent_per_year`
percent, `cumulative_bonus_max_percent` percent, `restoration_available` boolean, `restoration_percent`
percent, `restoration_conditions` rule, `cataract_limit_per_eye` money (estimateInput),
`maternity_normal_limit` money (estimateInput), `maternity_csection_limit` money (estimateInput),
`road_ambulance_limit` money (estimateInput), `modern_treatment_limit_percent` percent (estimateInput),
`reasonable_customary_clause` boolean, `consumables_payable` boolean (estimateInput), `reducer_order`
rule (estimateInput: the order deductible / co-pay / sub-limit apply, if stated).

S7 hospital-access: `cashless_network_available` boolean (critical, emergencyCard),
`cashless_non_network_available` boolean, `network_list_reference` text, `planned_preauth_notice_hours`
count (critical, emergencyCard), `emergency_intimation_hours` count (critical, emergencyCard),
`tpa_helpline` text (critical, operational, emergencyCard), `insurer_helpline` text (emergencyCard),
`cashless_process` rule (emergencyCard), `preauth_documents` text_list, `excluded_hospitals_rule` rule,
`cashless_decision_hours` count, `discharge_authorisation_hours` count.

S8 claims: `reimbursement_submission_days` days (critical), `reimbursement_documents` text_list,
`claim_settlement_days` days, `interest_on_delayed_settlement` rule, `grievance_officer_contact` text,
`grievance_escalation_path` text_list, `ombudsman_available` boolean, `claim_rejection_process` rule.

S9 renewal: `lifelong_renewal` boolean (critical), `renewal_refusal_grounds` rule,
`portability_window_days` days, `migration_option` rule, `group_to_individual_conversion` rule,
`premium_revision_rule` rule, `cancellation_refund_basis` enum[pro_rata, short_period_scale, no_refund,
not_stated], `premium_payment_modes` text_list, `instalment_lapse_consequence` rule,
`grace_period_cover` enum[covered, not_covered, not_stated], `product_withdrawal_rule` rule.

S10 insurer-quality (analysis): `claim_settlement_ratio_count` percent, `claim_settlement_ratio_amount`
percent, `incurred_claim_ratio` percent, `repudiation_ratio` percent, `complaints_per_10k_claims` count,
`solvency_ratio` percent, `average_settlement_days` days, `claims_handling_model` enum[in_house, tpa,
unknown], `network_hospitals_in_city` count.

S11 household (analysis): `members_without_evidenced_cover` text_list, `floater_concentration_risk`
boolean, `eldest_member_age_years` years, `members_attracting_age_copay` text_list,
`next_cover_change_date` date, `next_cover_change_reason` text, `employer_cover_dependence_percent`
percent, `sum_insured_adequacy` rule, `layering_gap` rule.

S12 regulatory (analysis): `regulatory_floor_version` text, `ped_wait_within_floor` boolean,
`specified_wait_within_floor` boolean, `moratorium_within_floor` boolean, `free_look_within_floor`
boolean, `initial_wait_within_floor` boolean, `cashless_timeline_within_floor` boolean,
`proportionate_deduction_exemptions_within_floor` boolean, `regulatory_deviations` text_list.

## Analysis sections (10–12) `analyze(context)` contract

```js
analyze({
  asOf,               // ISO date string of the analysis
  parameters,         // Map-like object: key -> stored parameter result from sections 1–9
                      // (shape: emptyParameterResult(); look at .value, .evidenceState, .memberScope)
  household,          // { members: [{ id, displayName, relationship, dateOfBirth|null }], city|null }
  otherRecords,       // [] or other policy records for the same household, same shape as `parameters`
  references,         // { insurerDisclosures?: [{ insurerName, metric, value, period, publishedOn, source }],
                      //   regulatoryFloor?: override table, procedureCostReference?: null }
}) // returns [{ key, value, evidenceState, stateReason, derivedFrom: [keys], notes }]
```

Rules: return every one of your parameters. `value` uses the normalised value shapes from
`normaliseValue` (e.g. `{ kind: 'percent', percent: 92.5 }`), or null. Allowed states: `Calculated`
(deterministic from Proven inputs), `Dynamic` (depends on a dated external figure — include the date in
`stateReason`), `Unknown` (input missing or not Proven — never guess), `Conflicting`. Never `Proven`.
Inputs that are `Unknown`/`Conflicting`/`NotPermitted` propagate; a `NotPermitted` input yields
`NotPermitted` for the derived parameter, not Unknown. Section 12 holds its floor table in the section
file as a frozen, dated, versioned constant with a `source` label and `verifyBeforeUse: true`; every
comparison result is `Dynamic` when inputs are Proven. Section 10 uses only supplied
`references.insurerDisclosures` matching the insurer name; otherwise Unknown.

## Report back (≤ 200 words)

Completed work, files, parameter count, critical parameters, test command and result, any key you had to
add that might collide, risks or judgement calls.
