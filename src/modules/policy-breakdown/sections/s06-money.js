// Section 6 — Money: the bill-to-payout waterfall.
// Ceiling (sum insured, bonuses, restoration), reducers (room rent, ICU, proportionate deduction,
// sub-limits, co-pays, deductibles, non-payables) and multi-policy combination rules.
// A deterministic cash-exposure calculator consumes the estimateInput parameters; the emergency card
// shows the emergencyCard parameters to a human operator. Nothing here gives advice.

import { defineSection } from '../contracts.js';

const RUPEE = 100; // minor units per rupee
const CRORE = 1_00_00_000;

/** Money validator: rejects amounts outside [minRupees, maxRupees]. */
const moneyRange = (minRupees, maxRupees, what) => value => {
  if (!value || value.kind !== 'money') return `${what} must be a money value`;
  if (value.amountMinor < minRupees * RUPEE) return `${what} below plausible minimum of ₹${minRupees}`;
  if (value.amountMinor > maxRupees * RUPEE) return `${what} above plausible maximum of ₹${maxRupees}`;
  return null;
};

/** Percent validator: rejects values outside [min, max]. */
const percentRange = (min, max, what) => value => {
  if (!value || value.kind !== 'percent') return `${what} must be a percent value`;
  if (value.percent < min || value.percent > max) return `${what} must be between ${min}% and ${max}%`;
  return null;
};

/** Count validator for integer types. */
const countRange = (min, max, what) => value => {
  if (!value || typeof value.count !== 'number') return `${what} must be a count`;
  if (value.count < min || value.count > max) return `${what} must be between ${min} and ${max}`;
  return null;
};

const SUB_LIMIT_MAX = 10 * CRORE;

const expertise = `
SECTION 6 — MONEY: THE BILL-TO-PAYOUT WATERFALL (Indian health insurance)

Your job: find every money parameter that decides how much of a hospital bill the policy pays, exactly as
this policy states it. A deterministic calculator will use your numbers to estimate household cash
exposure, so a wrong number causes real cash harm. Report only what the supplied pages say.

HARD RULES
- Quote verbatim. Every found=true item needs a citation whose quote is copied character-for-character from
  the page text (keep the source's spacing, punctuation, "Rs.", "INR", "₹", "/-").
- Never infer from general knowledge, IRDAI regulations, product brochures, other policies or "typical"
  market values. If this source pack does not state the value, answer found=false with null values.
  Do not compute derived values (e.g. do NOT turn "1% of Sum Insured per day" into ₹10,000 for
  room_rent_limit_amount — that stays found=false unless a rupee figure is printed).
- Never fill a value from a different policy, a sample illustration, a premium table or a "for example" box.
- Report each distinct value once. If the schedule and the wording state the same value, report it once and
  cite both. If they state DIFFERENT values, report both items for that key with notes explaining the
  conflict; do not choose. The schedule normally prevails over the wording for amounts, but leave that
  judgement to the pipeline.
- Use memberScope only when a value applies to a NAMED insured member (e.g. "Co-pay 20% for Kaushalya Devi").
  A condition that applies by age, zone or network ("members aged 61 or above") is NOT member-scoped:
  leave memberScope null and put the trigger in conditions.
- Do not give advice, recommendations or opinions in notes. Notes explain extraction choices only.

RUPEE NOTATION
- valueNumber for money is ALWAYS plain rupees as a number: "₹10,00,000", "Rs. 10,00,000/-",
  "INR 1000000", "Rupees Ten Lakh", "10 lakh", "10 L" all = 1000000. "1 crore"/"1 Cr"/"₹1,00,00,000"
  = 10000000. "50K"/"50,000" = 50000. Indian digit grouping (2-digit groups after the thousands) is normal.
- Percent valueNumber is the number without "%": "20%" -> 20. "1% of SI per day" -> 1.
- Never put a percent into a money key or a money amount into a percent key. "Up to 50% of Sum Insured"
  is a percent key (e.g. modern_treatment_limit_percent = 50), not a money key.
- Set unit to "INR" for money, "%" for percent, "days"/"years"/"deliveries" etc. for counts.

BASIS (the "basis" field) — always set it for limits:
- per_day: room rent, ICU, daily cash, attendant allowance.
- per_eye (cataract), per_joint (joint replacement), per_limb.
- per_policy_year: most sub-limits, bonuses, restoration frequency, aggregate (super top-up) deductibles.
- per_event: "per hospitalisation", "per admission", "per trip" of a road ambulance, "per event".
- per_claim: co-pays and top-up (per-claim) deductibles.
- per_lifetime: "during the lifetime of the policy" (e.g. maximum deliveries).
- per_person vs per_policy: whether a limit is per insured member or shared by the floater.
- Watch for double bases: "₹40,000 per eye per policy year" -> basis per_eye, and put "per policy year"
  in conditions.

ROOM RENT (critical)
Look for: "Room Rent", "Room, Boarding and Nursing", "Accommodation", "Normal room", "Room category".
- room_rent_limit_kind:
  no_limit = "no capping", "any room", "no sub-limit on room rent" (also set category any_room).
  fixed_amount_per_day = "up to ₹5,000 per day".
  percent_of_si_per_day = "1% of SI per day" with no category.
  room_category = a category only ("Single Private A/C room", "shared room", "general ward").
  category_or_percent = a category AND a % or ₹ figure in the same clause, including "whichever is lower",
  "where the hospital has no such room, up to 1% of SI per day", or "single private room or 1% of SI,
  whichever is less". Record the category in room_rent_eligible_category and the figure in
  room_rent_limit_percent / room_rent_limit_amount, and copy the linking words ("whichever is lower",
  "where ... not available") into conditions.
- "Single private room" without "AC/air-conditioned" is single_private_room, not single_private_ac_room.
- Room rent figures that apply only to some members, plans or sum-insured bands: report the one for this
  policy's sum insured; put band text in conditions.

ICU (critical)
Often separate: "ICU/ICCU charges", "Intensive Care Unit". "Actuals", "no limit", "up to SI" -> actuals.
"2% of SI per day" -> percent_of_si_per_day. If ICU is silent, icu_limit_kind is found=false — do not copy
the room rent limit. Note whether ICCU, HDU, step-down are named (icu_scope_rule).

PROPORTIONATE DEDUCTION (critical)
Titles: "Proportionate Deduction", "Ratable proportion", "Associated Medical Expenses". If the policy says
the insured bears a ratable proportion of associated expenses when staying in a higher room than eligible,
proportionate_deduction_applies = true. List the heads the clause EXEMPTS exactly as worded in this policy
(e.g. pharmacy and consumables, implants, medical devices, diagnostics, ICU) in
proportionate_deduction_exempt_heads — do not add heads the regulator lists but this wording omits.

CO-PAYMENT — each trigger is a separate key
- copay_general_percent: applies to every claim regardless of age/zone/network.
- copay_age_percent + copay_age_threshold_years: "20% co-pay for insured aged 61 years and above",
  "for persons entering the policy after 60". If the age trigger is "at entry" vs "at time of claim",
  put that in conditions — it changes who pays. "61 years or above" -> threshold 61; "above 60" -> 61 with
  the exact words in conditions; "60 and above" -> 60.
- copay_zone_percent + policy_zone: "Zone A/B/C", "Tier 1 city", "treatment in a higher zone". Zone A is
  usually the costliest (Delhi NCR, Mumbai etc.), but report only the zone printed for this policy.
- copay_non_network_percent: co-pay for treatment at a non-network / non-empanelled hospital.
- copay_ped_disease_percent: co-pay only on pre-existing or named diseases. Protected: if it names a
  member's condition, set memberScope to that member.
A schedule line "Co-payment: Nil" means the relevant key is found=true with value 0. "As per Section X"
is a pointer, not a value — follow it.

DEDUCTIBLES
- deductible_amount: a deductible on the base policy ("Deductible: ₹25,000 per policy year",
  "voluntary deductible"). "Deductible: Nil" -> found=true, valueNumber 0. deductible_kind records
  mandatory vs voluntary.
- topup_deductible_kind / topup_deductible_amount: only for top-up (per_claim threshold) or super top-up
  (aggregate_per_year threshold) products. Note whether the base policy's payout counts towards it in
  base_payout_counts_toward_deductible.

BONUSES, RESTORATION, ADDITIONAL SUM INSURED
- additional_sum_insured_amount: a rupee amount added on top of the base SI by a named benefit or opted
  add-on ("Secure Benefit ₹X", "Plus benefit", "SI booster", "additional sum insured equal to base SI").
  Schedules often print it in a separate column or row next to the base SI. It is not a cumulative bonus
  and not restoration. Name the benefit and any condition (e.g. "usable after base SI is exhausted") in
  conditions. Never add it into sum_insured_amount.
- cumulative_bonus_percent_per_year ("No Claim Bonus", "Cumulative Bonus", "Loyalty bonus" if claim
  linked), cumulative_bonus_max_percent, cumulative_bonus_reduction_percent (amount lost after a claim year).
- guaranteed_bonus_percent_per_year: added regardless of claims. inflation_protection_percent: SI indexed.
- restoration_available / restoration_percent / restoration_trigger (complete exhaustion only, or partial
  or complete) / restoration_frequency_per_year / restoration_same_illness_allowed /
  restoration_conditions (verbatim-faithful summary: same illness, same person, carry forward, floater).
  "Unlimited restoration": restoration_frequency_per_year found=false with the word in notes.

SUB-LIMITS (each with basis)
cataract_limit_per_eye, joint_replacement_limit_per_joint, maternity_normal_limit,
maternity_csection_limit, maternity_max_deliveries, road_ambulance_limit, air_ambulance_limit,
modern_treatment_limit_percent (Robotic surgery, Stem cell, Balloon sinuplasty, etc. "up to 50% of SI"),
ayush_limit_kind / ayush_limit_amount, domiciliary_limit_amount / domiciliary_limit_percent,
organ_donor_limit_amount, hospital_daily_cash_amount / hospital_daily_cash_max_days,
attendant_allowance_amount. Any other disease or procedure sub-limit (hernia, hysterectomy, stones,
ENT, cardiac) goes in other_disease_sublimits, one item per limit including amount and basis, e.g.
"Hernia — ₹50,000 per policy year". Do not repeat a limit that has its own key. A coverage that is
listed but has no limit printed ("covered up to SI") is a sub-limit only where a key has an
up_to_sum_insured enum; otherwise found=false.

OTHER REDUCERS
- reasonable_customary_clause: true if the policy limits payment to "Reasonable and Customary Charges".
- non_payable_items_rule: the clause saying listed non-payable items (Annexure, IRDAI List I–IV) are NOT
  paid. A clause that PAYS for those items ("Payment towards Non-Medical Expenses listed under Annexure B",
  a Protect/consumables benefit) is the opposite meaning: never cite it here; it supports
  consumables_payable / consumables_cover_addon. found=false if the policy pack only has the paying clause.
- consumables_payable: true only if the policy (or an opted add-on in this schedule) pays the non-medical
  consumables of List I; false if it says they are not payable. consumables_cover_addon: whether a
  "Consumables Cover"/"Protector" add-on is opted in THIS schedule.
- package_rate_rule: negotiated packages / PPN rates that cap the bill.
- surgery_component_caps: surgeon/anaesthetist/OT fees linked to room category or capped.
- proportionate_deduction_formula: the sentence defining the ratio.

ORDER OF REDUCERS (reducer_order)
Only if the policy states the order in which deductible, co-pay, sub-limits and room-rent proportion are
applied (e.g. "Co-payment shall apply on the admissible claim amount after applying sub-limits"). If the
order is not written, answer found=false — never assume an order.

COMBINING POLICIES
claim_order_rule ("Multiple Policies": insured chooses which policy pays first, balance to the next),
contribution_clause (whether insurers share/contribute), base_payout_counts_toward_deductible.
corporate_buffer_amount for group policies: printed buffer only; it is discretionary.

WHERE TO LOOK
Policy schedule / certificate of insurance (amounts, zone, deductible, opted add-ons), Customer
Information Sheet (summary table — useful but the schedule and wording are more specific), "Section:
Limits / Sub-limits / Co-payment", "Table of Benefits", definitions (Reasonable and Customary Charges,
Associated Medical Expenses), annexures (non-payables), general conditions (Multiple Policies).

found=false examples: air ambulance not mentioned; no fixed rupee room-rent figure printed; reducer order
not stated; no non-network co-pay.
`.trim();

const money = (key, label, description, extra = {}) => ({
  key, label, description, valueType: 'money', visibility: 'cover', effects: ['cap_amount', 'cap_per_day', 'deduct', 'pay'], ...extra,
});
const percent = (key, label, description, extra = {}) => ({
  key, label, description, valueType: 'percent', visibility: 'cover', effects: ['pay_percent', 'deduct', 'cap_amount'], ...extra,
});

const parameters = [
  // ---------- 6.1 Ceiling ----------
  money('sum_insured_amount', 'Sum insured', 'Base sum insured in rupees for this policy year (floater total or per-member as the policy defines). Excludes bonuses and restoration. valueNumber in rupees; basis per_policy_year (per_person if individual sum insured).', {
    effects: ['cap_amount'], bases: ['per_policy_year', 'per_person', 'per_policy'], critical: true, emergencyCard: true, estimateInput: true,
    extractionHints: ['Sum Insured', 'Base Sum Insured', 'Floater Sum Insured', 'SI', 'Basic Sum Insured', 'Rupees Ten Lakh'],
    validate: moneyRange(10_000, 10 * CRORE, 'Sum insured'),
  }),
  money('sum_insured_per_member_cap', 'Per-member cap within floater', 'A rupee cap on what one member (e.g. a parent) can draw from a floater or corporate pool. found=false if not printed.', {
    effects: ['cap_amount'], bases: ['per_person', 'per_policy_year'], memberScoped: true, estimateInput: true,
    extractionHints: ['per member limit', 'parental cap', 'maximum per insured person'],
    validate: moneyRange(1_000, 10 * CRORE, 'Per-member cap'),
  }),
  money('corporate_buffer_amount', 'Corporate buffer', 'Discretionary corporate/family buffer printed in a group policy. Never guaranteed; the record treats it as Dynamic.', {
    effects: ['cap_amount'], bases: ['per_policy_year', 'per_event'], visibility: 'operational',
    extractionHints: ['Corporate Buffer', 'Family Buffer', 'HR approval'],
    validate: moneyRange(1_000, 10 * CRORE, 'Corporate buffer'),
  }),
  money('additional_sum_insured_amount', 'Additional sum insured', 'Extra sum insured in rupees added on top of the base sum insured by a named benefit or opted add-on ("Secure Benefit", "Plus Benefit", "SI Booster", "Double cover"). Not cumulative/no-claim bonus and not restoration, which have their own keys. Record the benefit name and when it applies in conditions.', {
    effects: ['cap_amount'], bases: ['per_policy_year', 'per_person', 'per_policy'], estimateInput: true,
    extractionHints: ['Secure Benefit', 'Plus Benefit', 'Additional Sum Insured', 'SI Booster', 'Additional cover equal to'],
    validate: moneyRange(10_000, 10 * CRORE, 'Additional sum insured'),
  }),
  percent('cumulative_bonus_percent_per_year', 'Cumulative bonus accrual', 'Percent of base sum insured added for each claim-free policy year.', {
    effects: ['pay_percent'], bases: ['per_policy_year'],
    extractionHints: ['Cumulative Bonus', 'No Claim Bonus', 'claim-free Policy Year'],
    validate: percentRange(1, 100, 'Cumulative bonus accrual'),
  }),
  percent('cumulative_bonus_max_percent', 'Cumulative bonus cap', 'Maximum accumulated bonus as percent of base sum insured. A cap above 100% cannot be stored as a percent: answer found=false and quote the text in notes.', {
    effects: ['cap_amount'], bases: ['per_policy'],
    extractionHints: ['maximum up to', 'subject to a maximum of', 'Cumulative Bonus'],
    validate: percentRange(1, 100, 'Cumulative bonus cap'),
  }),
  percent('cumulative_bonus_reduction_percent', 'Cumulative bonus reduction after a claim', 'Percent of base sum insured by which accrued bonus reduces after a claim year.', {
    effects: ['deduct'], bases: ['per_policy_year'],
    extractionHints: ['shall be reduced by', 'in case of a claim', 'Cumulative Bonus'],
    validate: percentRange(1, 100, 'Cumulative bonus reduction'),
  }),
  percent('guaranteed_bonus_percent_per_year', 'Guaranteed / loyalty bonus', 'Percent of sum insured added each year regardless of claims.', {
    effects: ['pay_percent'], bases: ['per_policy_year'],
    extractionHints: ['Guaranteed Bonus', 'Loyalty Bonus', 'irrespective of claims'],
    validate: percentRange(1, 100, 'Guaranteed bonus'),
  }),
  percent('inflation_protection_percent', 'Inflation protection', 'Annual percent increase of sum insured linked to an index (e.g. CPI).', {
    effects: ['pay_percent'], bases: ['per_policy_year'],
    extractionHints: ['Inflation Protector', 'Consumer Price Index', 'CPI'],
    validate: percentRange(0.5, 100, 'Inflation protection'),
  }),
  { key: 'restoration_available', label: 'Restoration available', description: 'Whether the sum insured is restored/recharged/reinstated after exhaustion within the policy year.', valueType: 'boolean', visibility: 'cover', effects: ['pay'], bases: ['per_policy_year'],
    extractionHints: ['Restoration', 'Recharge', 'Reinstatement', 'Refill', 'Automatic Restore'] },
  percent('restoration_percent', 'Restoration amount', 'Percent of base sum insured restored on each restoration.', {
    effects: ['pay_percent'], bases: ['per_policy_year'],
    extractionHints: ['restore 100%', 'Restoration of Sum Insured'],
    validate: percentRange(1, 100, 'Restoration amount'),
  }),
  { key: 'restoration_trigger', label: 'Restoration trigger', description: 'Whether restoration triggers only on complete exhaustion, or on partial or complete exhaustion.', valueType: 'enum',
    enumValues: ['complete_exhaustion_only', 'partial_or_complete_exhaustion', 'not_stated'], visibility: 'cover', effects: ['pay'], bases: ['per_policy_year'],
    extractionHints: ['complete or partial exhaustion', 'total exhaustion', 'exhausted'] },
  { key: 'restoration_frequency_per_year', label: 'Restorations per year', description: 'Number of restorations allowed per policy year. "Unlimited" is found=false with a note.', valueType: 'count', visibility: 'cover', effects: ['pay'], bases: ['per_policy_year'],
    extractionHints: ['once in a Policy Year', 'once during the Policy Year', 'unlimited times'],
    validate: countRange(1, 50, 'Restorations per year') },
  { key: 'restoration_same_illness_allowed', label: 'Restoration usable for same illness', description: 'Whether restored sum insured can be used for the same illness/injury already claimed in the year.', valueType: 'boolean', visibility: 'cover', effects: ['exclude', 'pay'], bases: ['per_illness', 'per_policy_year'],
    extractionHints: ['same illness', 'same disease', 'for which a claim has already been paid'] },
  { key: 'restoration_conditions', label: 'Restoration conditions', description: 'Faithful summary of restoration conditions: same illness/person, same claim, carry forward, floater vs member.', valueType: 'rule', visibility: 'cover', effects: ['pay', 'exclude'], bases: ['per_policy_year', 'per_illness', 'per_person'],
    extractionHints: ['Restoration of Sum Insured', 'not be carried forward', 'same illness'] },
  { key: 'topup_deductible_kind', label: 'Top-up deductible kind', description: 'For top-up / super top-up products: per_claim threshold (top-up) or aggregate_per_year (super top-up). found=false for a base indemnity policy that has no threshold.', valueType: 'enum',
    enumValues: ['per_claim', 'aggregate_per_year', 'not_stated'], visibility: 'cover', effects: ['deduct'], bases: ['per_claim', 'per_policy_year'], estimateInput: true,
    extractionHints: ['Threshold', 'Aggregate Deductible', 'Super Top Up', 'Top Up', 'in excess of'] },
  money('topup_deductible_amount', 'Top-up deductible amount', 'Threshold rupee amount below which a top-up / super top-up pays nothing.', {
    effects: ['deduct'], bases: ['per_claim', 'per_policy_year'], estimateInput: true,
    extractionHints: ['Deductible', 'Threshold', 'Aggregate Deductible'],
    validate: moneyRange(10_000, 10 * CRORE, 'Top-up deductible'),
  }),

  // ---------- 6.2 Reducers ----------
  { key: 'room_rent_limit_kind', label: 'Room rent limit type', description: 'How room rent is capped: none, fixed rupees per day, percent of SI per day, a room category, or a category combined with a figure (incl. "whichever is lower").', valueType: 'enum',
    enumValues: ['no_limit', 'fixed_amount_per_day', 'percent_of_si_per_day', 'room_category', 'category_or_percent'], visibility: 'cover', effects: ['cap_per_day'], bases: ['per_day'],
    critical: true, emergencyCard: true, estimateInput: true,
    extractionHints: ['Room Rent', 'Room, Boarding and Nursing', 'Single Private', 'whichever is lower', 'per day'] },
  { key: 'room_rent_eligible_category', label: 'Eligible room category', description: 'The room category the policy pays for.', valueType: 'enum',
    enumValues: ['general_ward', 'shared_room', 'single_private_room', 'single_private_ac_room', 'any_room', 'not_stated'], visibility: 'cover', effects: ['cap_per_day'], bases: ['per_day'], estimateInput: true,
    extractionHints: ['Single Private A/C Room', 'Shared Room', 'General Ward', 'any room'] },
  money('room_rent_limit_amount', 'Room rent limit (₹/day)', 'Printed rupee cap per day on room rent. Never computed from a percent.', {
    effects: ['cap_per_day'], bases: ['per_day'], estimateInput: true,
    extractionHints: ['per day', 'Room Rent up to Rs.'],
    validate: moneyRange(100, 5_00_000, 'Room rent per day'),
  }),
  percent('room_rent_limit_percent', 'Room rent limit (% of SI/day)', 'Room rent cap as percent of sum insured per day.', {
    effects: ['cap_per_day'], bases: ['per_day'], estimateInput: true,
    extractionHints: ['1% of Sum Insured per day', '% of SI'],
    validate: percentRange(0.1, 10, 'Room rent percent per day'),
  }),
  { key: 'icu_limit_kind', label: 'ICU limit type', description: 'How ICU/ICCU charges are capped, separately from room rent.', valueType: 'enum',
    enumValues: ['no_limit', 'actuals', 'fixed_amount_per_day', 'percent_of_si_per_day'], visibility: 'cover', effects: ['cap_per_day', 'pay'], bases: ['per_day'],
    critical: true, emergencyCard: true, estimateInput: true,
    extractionHints: ['ICU', 'ICCU', 'Intensive Care Unit', 'actuals'] },
  money('icu_limit_amount', 'ICU limit (₹/day)', 'Printed rupee cap per day on ICU charges.', {
    effects: ['cap_per_day'], bases: ['per_day'], estimateInput: true,
    extractionHints: ['ICU charges up to Rs.', 'per day'],
    validate: moneyRange(500, 10_00_000, 'ICU per day'),
  }),
  percent('icu_limit_percent', 'ICU limit (% of SI/day)', 'ICU cap as percent of sum insured per day.', {
    effects: ['cap_per_day'], bases: ['per_day'], estimateInput: true,
    extractionHints: ['2% of Sum Insured per day', 'ICU'],
    validate: percentRange(0.1, 20, 'ICU percent per day'),
  }),
  { key: 'icu_scope_rule', label: 'ICU scope', description: 'Which units are treated as ICU for the limit (ICU, ICCU, HDU, NICU, step-down).', valueType: 'rule', visibility: 'cover', effects: ['inform'], bases: ['per_day'],
    extractionHints: ['Intensive Cardiac Care Unit', 'High Dependency Unit', 'ICU means'] },
  { key: 'proportionate_deduction_applies', label: 'Proportionate deduction', description: 'Whether associated medical expenses are reduced in the ratio of eligible to actual room rent when a higher room is taken.', valueType: 'boolean', visibility: 'cover', effects: ['deduct'], bases: ['per_claim'],
    critical: true, estimateInput: true,
    extractionHints: ['Proportionate Deduction', 'ratable proportion', 'Associated Medical Expenses'] },
  { key: 'proportionate_deduction_exempt_heads', label: 'Heads exempt from proportionate deduction', description: 'Expense heads this policy exempts from proportionate deduction, as worded in this policy only.', valueType: 'text_list', visibility: 'cover', effects: ['pay'], bases: ['per_claim'], estimateInput: true,
    extractionHints: ['shall not apply in respect of', 'pharmacy and consumables', 'implants', 'diagnostics'] },
  { key: 'proportionate_deduction_formula', label: 'Proportionate deduction formula', description: 'The sentence defining the ratio (eligible room rent ÷ actual room rent) and what it is applied to.', valueType: 'rule', visibility: 'cover', effects: ['deduct'], bases: ['per_claim'], estimateInput: true,
    extractionHints: ['in the proportion of', 'room rent actually incurred'] },
  percent('copay_general_percent', 'Co-pay (general)', 'Co-payment on every claim regardless of age, zone or network.', {
    effects: ['pay_percent', 'deduct'], bases: ['per_claim'], estimateInput: true,
    extractionHints: ['Co-payment', 'Co-pay', 'each and every claim'],
    validate: percentRange(0, 100, 'General co-pay'),
  }),
  percent('copay_age_percent', 'Co-pay (age)', 'Co-payment percent that applies to insured members above an age threshold.', {
    effects: ['pay_percent', 'deduct'], bases: ['per_claim'], critical: true, emergencyCard: true, estimateInput: true,
    extractionHints: ['aged 61 years or above', 'senior citizen', 'Age related co-payment'],
    validate: percentRange(1, 100, 'Age co-pay'),
  }),
  { key: 'copay_age_threshold_years', label: 'Age co-pay threshold', description: 'The age (years) from which the age co-pay applies. Record "at entry" vs "at time of claim" in conditions.', valueType: 'years', visibility: 'cover', effects: ['pay_percent'], bases: ['per_claim'],
    critical: true, estimateInput: true,
    extractionHints: ['years or above', 'above the age of', 'at the time of claim', 'at entry'],
    validate: countRange(18, 100, 'Age co-pay threshold') },
  percent('copay_zone_percent', 'Co-pay (zone)', 'Co-payment when treatment is taken in a costlier zone than the policy is priced for.', {
    effects: ['pay_percent', 'deduct'], bases: ['per_claim'], estimateInput: true,
    extractionHints: ['Zone related co-payment', 'Zone A city', 'Tier'],
    validate: percentRange(1, 100, 'Zone co-pay'),
  }),
  { key: 'policy_zone', label: 'Pricing zone', description: 'The zone the policy is priced for.', valueType: 'enum',
    enumValues: ['zone_a', 'zone_b', 'zone_c', 'not_zoned'], visibility: 'cover', effects: ['inform'], bases: ['per_policy'],
    extractionHints: ['Zone of Cover', 'priced for Zone', 'Zone A', 'Zone B'] },
  percent('copay_non_network_percent', 'Co-pay (non-network)', 'Co-payment for treatment at a non-network hospital.', {
    effects: ['pay_percent', 'deduct'], bases: ['per_claim'], estimateInput: true,
    extractionHints: ['non-network hospital', 'non-empanelled'],
    validate: percentRange(1, 100, 'Non-network co-pay'),
  }),
  percent('copay_ped_disease_percent', 'Co-pay (PED / named disease)', 'Co-payment that applies only to pre-existing or named diseases. Protected because it can reveal a member condition.', {
    effects: ['pay_percent', 'deduct'], bases: ['per_claim', 'per_illness'], visibility: 'protected', memberScoped: true, estimateInput: true,
    extractionHints: ['pre-existing disease co-payment', 'co-payment for the following diseases'],
    validate: percentRange(1, 100, 'PED co-pay'),
  }),
  money('deductible_amount', 'Deductible (base policy)', 'Deductible on the base policy in rupees. "Nil" is found=true with 0. Top-up thresholds go to topup_deductible_amount.', {
    effects: ['deduct'], bases: ['per_claim', 'per_policy_year', 'per_person'], estimateInput: true,
    extractionHints: ['Deductible', 'Voluntary Deductible', 'Nil'],
    validate: moneyRange(0, 1 * CRORE, 'Deductible'),
  }),
  { key: 'deductible_kind', label: 'Deductible kind', description: 'Mandatory or voluntary (opted for a premium discount).', valueType: 'enum',
    enumValues: ['mandatory', 'voluntary', 'not_stated'], visibility: 'cover', effects: ['deduct'], bases: ['per_claim', 'per_policy_year'],
    extractionHints: ['Voluntary Deductible', 'Compulsory Deductible'] },
  money('cataract_limit_per_eye', 'Cataract limit', 'Rupee cap on cataract surgery, normally per eye; put "per policy year" in conditions.', {
    effects: ['cap_amount'], bases: ['per_eye', 'per_policy_year'], estimateInput: true,
    extractionHints: ['Cataract', 'per eye'],
    validate: moneyRange(1_000, SUB_LIMIT_MAX, 'Cataract limit'),
  }),
  money('joint_replacement_limit_per_joint', 'Joint replacement limit', 'Rupee cap on knee/hip joint replacement, normally per joint.', {
    effects: ['cap_amount'], bases: ['per_joint', 'per_policy_year'], estimateInput: true,
    extractionHints: ['Joint Replacement', 'Knee Replacement', 'per joint'],
    validate: moneyRange(1_000, SUB_LIMIT_MAX, 'Joint replacement limit'),
  }),
  money('maternity_normal_limit', 'Maternity limit (normal)', 'Rupee cap for a normal delivery.', {
    effects: ['cap_amount'], bases: ['per_event', 'per_policy_year'], estimateInput: true,
    extractionHints: ['Normal delivery', 'Maternity Expenses'],
    validate: moneyRange(1_000, SUB_LIMIT_MAX, 'Normal delivery limit'),
  }),
  money('maternity_csection_limit', 'Maternity limit (C-section)', 'Rupee cap for a caesarean delivery.', {
    effects: ['cap_amount'], bases: ['per_event', 'per_policy_year'], estimateInput: true,
    extractionHints: ['Caesarean', 'C-section', 'LSCS'],
    validate: moneyRange(1_000, SUB_LIMIT_MAX, 'C-section limit'),
  }),
  { key: 'maternity_max_deliveries', label: 'Maximum deliveries', description: 'Maximum number of deliveries payable and its basis (lifetime or policy period).', valueType: 'count', visibility: 'cover', effects: ['cap_amount'], bases: ['per_lifetime', 'per_policy'],
    extractionHints: ['maximum of 2 deliveries', 'two deliveries'], validate: countRange(1, 10, 'Maximum deliveries') },
  money('road_ambulance_limit', 'Road ambulance limit', 'Rupee cap on road ambulance; "per hospitalisation" is basis per_event.', {
    effects: ['cap_amount'], bases: ['per_event', 'per_trip', 'per_policy_year'], estimateInput: true,
    extractionHints: ['Road Ambulance', 'Emergency Ambulance', 'per hospitalisation'],
    validate: moneyRange(100, SUB_LIMIT_MAX, 'Road ambulance limit'),
  }),
  money('air_ambulance_limit', 'Air ambulance limit', 'Rupee cap on air ambulance.', {
    effects: ['cap_amount'], bases: ['per_event', 'per_policy_year'], estimateInput: true,
    extractionHints: ['Air Ambulance'],
    validate: moneyRange(1_000, SUB_LIMIT_MAX, 'Air ambulance limit'),
  }),
  percent('modern_treatment_limit_percent', 'Modern treatment limit', 'Cap on modern / advanced treatments as percent of sum insured.', {
    effects: ['cap_amount'], bases: ['per_policy_year', 'per_illness'], estimateInput: true,
    extractionHints: ['Modern Treatment Methods', 'Advanced Technology Methods', '% of Sum Insured'],
    validate: percentRange(1, 100, 'Modern treatment limit'),
  }),
  { key: 'ayush_limit_kind', label: 'AYUSH limit type', description: 'How AYUSH in-patient treatment is capped.', valueType: 'enum',
    enumValues: ['up_to_sum_insured', 'fixed_amount', 'percent_of_si'], visibility: 'cover', effects: ['cap_amount', 'pay'], bases: ['per_policy_year'], estimateInput: true,
    extractionHints: ['AYUSH Treatment', 'Ayurveda', 'Up to Sum Insured'] },
  money('ayush_limit_amount', 'AYUSH limit amount', 'Rupee cap on AYUSH treatment, if printed.', {
    effects: ['cap_amount'], bases: ['per_policy_year'], estimateInput: true, extractionHints: ['AYUSH'],
    validate: moneyRange(1_000, SUB_LIMIT_MAX, 'AYUSH limit'),
  }),
  money('domiciliary_limit_amount', 'Domiciliary limit amount', 'Rupee cap on domiciliary hospitalisation.', {
    effects: ['cap_amount'], bases: ['per_policy_year'], estimateInput: true, extractionHints: ['Domiciliary Hospitalisation'],
    validate: moneyRange(1_000, SUB_LIMIT_MAX, 'Domiciliary limit'),
  }),
  percent('domiciliary_limit_percent', 'Domiciliary limit percent', 'Domiciliary hospitalisation cap as percent of sum insured.', {
    effects: ['cap_amount'], bases: ['per_policy_year'], estimateInput: true, extractionHints: ['Domiciliary', '% of Sum Insured'],
    validate: percentRange(1, 100, 'Domiciliary limit'),
  }),
  money('organ_donor_limit_amount', 'Organ donor limit', 'Rupee cap on organ donor harvesting expenses.', {
    effects: ['cap_amount'], bases: ['per_event', 'per_policy_year'], estimateInput: true, extractionHints: ['Organ Donor', 'harvesting'],
    validate: moneyRange(1_000, SUB_LIMIT_MAX, 'Organ donor limit'),
  }),
  money('hospital_daily_cash_amount', 'Hospital daily cash', 'Fixed rupee amount paid per day of hospitalisation.', {
    effects: ['pay'], bases: ['per_day'], extractionHints: ['Hospital Cash', 'Daily Cash Allowance'],
    validate: moneyRange(100, 1_00_000, 'Daily cash'),
  }),
  { key: 'hospital_daily_cash_max_days', label: 'Daily cash maximum days', description: 'Maximum days of daily cash per hospitalisation or year.', valueType: 'count', visibility: 'cover', effects: ['cap_amount'], bases: ['per_event', 'per_policy_year'],
    extractionHints: ['maximum of', 'days per hospitalisation'], validate: countRange(1, 365, 'Daily cash days') },
  money('attendant_allowance_amount', 'Attendant allowance', 'Daily rupee amount for an attendant/companion.', {
    effects: ['pay'], bases: ['per_day'], extractionHints: ['Attendant Allowance', 'Companion'],
    validate: moneyRange(100, 1_00_000, 'Attendant allowance'),
  }),
  { key: 'other_disease_sublimits', label: 'Other disease / procedure sub-limits', description: 'Sub-limits without their own key, one item each with amount and basis, e.g. "Hernia — ₹50,000 per policy year".', valueType: 'text_list', visibility: 'cover', effects: ['cap_amount'], bases: ['per_illness', 'per_policy_year', 'per_claim', 'per_joint', 'per_limb'], estimateInput: true,
    extractionHints: ['Sub-limits', 'Table of Benefits', 'Hysterectomy', 'Hernia', 'Stones'] },
  { key: 'surgery_component_caps', label: 'Surgery component caps', description: 'Caps on or room-rent linkage of surgeon, anaesthetist, OT, nursing or doctor fees.', valueType: 'rule', visibility: 'cover', effects: ['cap_amount', 'deduct'], bases: ['per_claim'], estimateInput: true,
    extractionHints: ['Surgeon fees', 'Anaesthetist', 'Operation Theatre', 'linked to room category'] },
  { key: 'package_rate_rule', label: 'Package rates / PPN', description: 'Negotiated package or PPN rates that cap the payable amount.', valueType: 'rule', visibility: 'cover', effects: ['cap_amount'], bases: ['per_event'],
    extractionHints: ['Preferred Provider Network', 'PPN', 'package rates'] },
  { key: 'reasonable_customary_clause', label: 'Reasonable and customary charges', description: 'True if payment is limited to Reasonable and Customary Charges.', valueType: 'boolean', visibility: 'cover', effects: ['cap_amount'], bases: ['per_claim'],
    extractionHints: ['Reasonable and Customary Charges', 'customary charges'] },
  { key: 'non_payable_items_rule', label: 'Non-payable items', description: 'The clause stating that listed non-payable / non-medical items (e.g. Annexure II / IRDAI List I) are NOT paid. Never cite an add-on or benefit clause that pays for those items (e.g. a consumables/"Protect" benefit); that belongs in consumables_payable / consumables_cover_addon. found=false if only the paying clause is present.', valueType: 'rule', visibility: 'cover', effects: ['exclude'], bases: ['per_claim'], estimateInput: true,
    extractionHints: ['Non-payable items', 'Annexure II', 'List I', 'Items for which coverage is not available', 'not payable', 'excluded items'] },
  { key: 'consumables_payable', label: 'Consumables payable', description: 'Whether non-medical consumables (List I items) are payable under this policy as issued.', valueType: 'boolean', visibility: 'cover', effects: ['pay', 'exclude'], bases: ['per_claim'], estimateInput: true,
    extractionHints: ['Consumables', 'non-payable', 'Annexure II'] },
  { key: 'consumables_cover_addon', label: 'Consumables add-on opted', description: 'Whether a consumables add-on is opted in this schedule.', valueType: 'boolean', visibility: 'cover', effects: ['pay'], bases: ['per_policy'], estimateInput: true,
    extractionHints: ['Consumables Cover', 'Protector', 'Optional Add-on'] },
  { key: 'reducer_order', label: 'Order of reducers', description: 'The stated order in which deductible, co-pay, sub-limits and proportionate deduction are applied. found=false if not stated.', valueType: 'rule', visibility: 'cover', effects: ['deduct'], bases: ['per_claim'], estimateInput: true,
    extractionHints: ['after applying', 'shall be applied on the admissible claim amount', 'before applying co-payment'] },

  // ---------- 6.3 Combining policies ----------
  { key: 'claim_order_rule', label: 'Claim order across policies', description: 'Who chooses which policy pays first and how the balance moves to the next policy.', valueType: 'rule', visibility: 'cover', effects: ['inform'], bases: ['per_claim'],
    extractionHints: ['Multiple Policies', 'right to require a settlement', 'balance amount'] },
  { key: 'contribution_clause', label: 'Contribution clause', description: 'Whether and when insurers share (contribute to) a claim.', valueType: 'rule', visibility: 'cover', effects: ['inform'], bases: ['per_claim'],
    extractionHints: ['Contribution', 'rateable proportion between insurers'] },
  { key: 'base_payout_counts_toward_deductible', label: 'Base payout counts toward top-up deductible', description: 'Whether a payout from another policy satisfies the top-up / super top-up deductible.', valueType: 'boolean', visibility: 'cover', effects: ['deduct'], bases: ['per_claim', 'per_policy_year'], estimateInput: true,
    extractionHints: ['deductible may be satisfied by', 'paid by any other policy'] },
];

export default defineSection({
  number: 6,
  id: 'section-06-money',
  title: 'Money — the bill-to-payout waterfall',
  question: 'How much of a hospital bill will this policy pay, and which limits, co-pays, deductibles and sub-limits reduce it?',
  kind: 'extraction',
  expertise,
  parameters,
  reviewGuidance: [
    'Sum insured: compare the rupee figure with the schedule; check lakh/crore conversion (₹10,00,000 = 1000000) and that bonus or restoration was not added.',
    'Room rent: confirm the kind (category vs percent vs both/whichever-lower), the category spelling (AC or not), and that no rupee amount was computed from a percent.',
    'ICU: confirm ICU has its own clause; a silent ICU must stay Unknown, not copy the room-rent limit.',
    'Proportionate deduction: confirm it applies and that exempt heads are exactly the ones this wording lists.',
    'Age co-pay: confirm percent, threshold age, and whether the age is at entry or at claim; confirm it was not member-scoped unless a named member is stated.',
    'Deductible and co-pays: "Nil" means 0 only if printed; "as per section" pointers must be followed.',
    'Reducer order: must be Unknown unless the wording states the sequence.',
  ].join('\n'),
});
