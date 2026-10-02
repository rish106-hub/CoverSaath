// Section 2 — People: who is covered, as of the event date?
// Extraction section. Separates named enrolment (schedule) from eligibility (wording definitions).

import { defineSection } from '../contracts.js';

const yearsBetween = (min, max, label) => value =>
  value.count < min || value.count > max ? `${label} must be between ${min} and ${max} years.` : null;

const plausibleDate = (earliest, label) => value => {
  if (value.date < earliest) return `${label} before ${earliest} is not plausible.`;
  if (value.date > '2100-12-31') return `${label} after 2100 is not plausible.`;
  return null;
};

const expertise = `
SECTION 2 — PEOPLE: WHO IS COVERED, AS OF THE EVENT DATE?

Your job is to record, from this policy's own documents only, which named people are insured, how the sum insured is shared between them, which relationships the wording makes eligible, the age and status rules that bring people in or take them out, when each member's cover started, how newborns and mid-term additions are handled, nomination, and any member-specific underwriting outcome.

WHERE THIS USUALLY APPEARS
- Policy Schedule / Certificate of Insurance: the table titled "Details of Insured Persons", "Insured Members", "Member Details" or "Persons Insured". Columns usually include name, relationship to proposer, date of birth or age, sum insured (per member for individual plans), "Date of First Enrolment", "Continuous coverage since", "Member inception date", pre-existing disease declared, loading, and sometimes "Pre-policy medical check-up". The schedule also carries "Plan Type" / "Cover Type" (Individual / Family Floater), the Proposer, and the Nominee.
- Policy wording: Definitions ("Family", "Spouse", "Dependent Child", "Parents", "Parents-in-law", "Insured Person", "Proposer"), "Eligibility", "Entry Age", "Renewal", "Addition / Deletion of Insured Persons", "Newborn Baby Cover", "Nomination".
- Customer Information Sheet (CIS): may summarise entry age and floater structure. The CIS is a summary, not the contract; if it disagrees with schedule or wording, report each value you see with its own quote and note the disagreement rather than choosing.
- Endorsements and underwriting letters: "Member-specific endorsement", "Underwriting decision", "Counter offer", "Special conditions", "Loading", "Permanent exclusion for the insured person". These are the source of member-specific conditions.

THE CORE TRAP: ELIGIBILITY IS NOT ENROLMENT
- A wording that says "Family means Self, Spouse, Dependent Children, Parents and Parents-in-law" only describes who MAY be covered. A person is insured only if they are named in the schedule or certificate. Never add a person to insured_members because a definition permits their relationship. Never add a household member who is not named. Report eligible relationships under eligible_relationships and named people under insured_members — these are different answers.
- insured_members: one item per named person in the form "Name — Relationship" using the relationship exactly as the schedule labels it (Self, Spouse, Son, Daughter, Mother, Father, Mother-in-law, etc.). Use an em dash with spaces between name and relationship. Do not include the nominee or proposer unless they are also listed as an insured person.

SUM-INSURED STRUCTURE
- family_floater: one sum insured shared by all named members ("floater", "available for any one or all insured persons together").
- individual: a single-person policy.
- individual_per_member: several members on one policy, each with their own separate sum insured (schedule shows a sum insured against each member). Do not call this a floater.
- group_pool: an employer/group pool, corporate buffer or family pool shared by a group.
- Watch for hybrids: a floater with a per-parent cap ("parents covered up to Rs. X each within the floater"), or parents on a separate sum insured. Record the cap only if a figure is stated.
- floater_shared_exhaustion: true only when the wording states that a claim by one member reduces what remains for others for the rest of the policy year (or equivalent "any one or all" language that makes the shared drawdown explicit).

AGES AND STATUS RULES
- Entry ages are stated per member type: adults (often 18 years minimum, 45/55/65 years or "no limit" maximum), dependent children (often 90 or 91 days minimum, sometimes from day one). Report the adult maximum entry age in max_entry_age_years only if a number is stated; "no maximum entry age" means no number — use found=false for the number and mention the wording in notes only if you also report it elsewhere.
- dependent_child_max_age_years: the age until which a dependent child can stay covered (commonly 18, 21, 23, 25 or 26). Read the exit clause carefully: "up to 25 years", "till the renewal following the 25th birthday", "up to 25 if a full-time student, otherwise 18". When a different age applies under a condition (student, unmarried daughter, disabled child), report the main number with that condition in conditions and the alternative in exceptions. Do not confuse the child minimum entry age (in days) with the maximum.
- dependent_child_conditions: unmarried, financially dependent, no independent income, full-time student, legally adopted / step-child included. Quote the definition.
- dependent_child_exit_rule: when a child stops being covered (birthday, renewal date after birthday, marriage, employment) and any option to migrate to a separate policy with credit for waiting periods.
- Maximum renewal age: modern IRDAI-aligned products usually say lifelong renewal with no maximum renewal age; older or group products may stop at 65/70/80. Record the clause text as stated.
- Residency and occupation: "available only to residents of India", NRI/OCI conditions, long stays abroad, hazardous occupation loadings or exclusions (armed forces, mining, adventure sports professionals). Report each only if the policy states it; otherwise found=false.

MEMBER EFFECTIVE DATES AND DATES OF BIRTH
- member_effective_date is the date each member's continuous cover started ("Date of First Enrolment", "Insured since", "Continuous coverage since", "Member inception date"). It drives that member's waiting clocks and may differ from the policy's first inception for members added later. Report one item per member with memberScope set to the member's name and valueText in ISO yyyy-mm-dd. Indian schedules write dd/mm/yyyy — 01/04/2023 is 1 April 2023, not 4 January. Never copy the policy period start date into this field unless the schedule labels it as the member's date.
- member_date_of_birth: one item per member, ISO date, from the schedule. If only age is given, do not compute a date; use found=false for that member's date of birth and say the age in notes.

NEWBORN, ADOPTION, MARRIAGE
- newborn_cover: quote what is covered for a newborn (from day one / from day 91 / only if maternity benefit is admissible / within mother's sum insured / within floater), the intimation deadline and premium. Many policies cover the newborn only when the mother's maternity claim is admissible — this is a condition, record it in conditions. If the policy says nothing about newborns, found=false.
- mid_term_addition_rule: spouse on marriage, adopted child, newborn — time window, pro-rata premium, and whether waiting periods restart from the date of addition.

NOMINATION
- nominee_required: true when the wording says a nomination must be (or is required to be) made. A nominee name in the schedule alone shows a nominee exists; it does not by itself prove a requirement — report nominee_name separately.

UNDERWRITING OUTCOMES (PROTECTED)
- member_specific_conditions: any condition that applies to one named member only — a disease-specific waiting period, a permanent exclusion for that person, a co-pay or sub-limit applied only to them by endorsement, a counter-offer term. Always set memberScope to the member's name exactly as in the schedule. Report each member's set of conditions as one item.
- member_premium_loading_percent: a premium loading percentage for a named member, with memberScope. The reason (the declared condition) goes in declared_conditions, not in this field.
- declared_conditions: conditions declared in the proposal or listed against a member in the schedule ("PED declared: Hypertension"). One item per member, with memberScope.
- underwriting_outcome: standard_terms when the member was accepted at standard terms; modified_terms when accepted with a loading, member-specific exclusion, condition-specific wait or counter-offer; declined when cover was refused. One item per distinct outcome, with memberScope naming the member(s).
- pre_policy_checkup_status: done, waived, or not_required per member, only as stated in the documents.
These fields are medical and personal; extract them exactly but never comment on their implications.

GENERAL RULES
- Quote verbatim. Every value must be supported by a quote copied character-for-character from the page text, including punctuation and spacing. Prefer the shortest quote that proves the value.
- Never infer from general knowledge, typical market practice or IRDAI regulations. If this policy does not state a value, answer found=false for that key with all value fields null.
- Never fill a value from another policy, another member's row, or another section of the household's records.
- Report each distinct value once. When a value applies only to one named member, set memberScope to that member's name; otherwise memberScope is null.
- When the schedule and the wording disagree (for example the schedule names a relationship the wording does not define), report both with their own quotes and explain in notes.
- basis and effect must always be set; use "not_stated" when the document does not establish them (and always for found=false items).
- Numbers go in valueNumber (years, days, months, percent as plain numbers; money in rupees). Enum values go in valueText as the exact enum token. Dates go in valueText as yyyy-mm-dd.
- Do not give advice, opinions or recommendations; only record what the documents say.
`.trim();

export default defineSection({
  number: 2,
  id: 'section-02-people',
  title: 'People',
  question: 'Who is covered, as of the event date?',
  kind: 'extraction',
  expertise,
  parameters: [
    {
      key: 'insured_members',
      label: 'Named insured members',
      description: 'Every person named as an insured person in the schedule or certificate, one item per person as "Name — Relationship" using the schedule relationship label. Only named people; never people merely eligible under a definition.',
      valueType: 'text_list',
      effects: ['inform'],
      bases: ['per_policy'],
      critical: true,
      visibility: 'cover',
      extractionHints: ['Details of Insured Persons', 'Insured Members', 'Member Details', 'Persons Insured', 'Relationship to Proposer', 'Certificate of Insurance'],
      emergencyCard: true,
      validate: value => value.items.every(item => /\S\s+—\s+\S/.test(item)) ? null : 'Each insured member must be "Name — Relationship".',
    },
    {
      key: 'proposer_name',
      label: 'Proposer',
      description: 'The person who proposed and holds the policy, as named in the schedule. The proposer may or may not also be an insured person.',
      valueType: 'text',
      effects: ['inform'],
      bases: ['per_policy'],
      visibility: 'operational',
      extractionHints: ['Proposer', 'Policyholder', 'Name of Proposer'],
    },
    {
      key: 'sum_insured_structure',
      label: 'Sum-insured structure',
      description: 'How the sum insured is allocated: individual (one person), family_floater (one sum insured shared by all named members), individual_per_member (several members, each with own sum insured), group_pool (employer or group pool).',
      valueType: 'enum',
      enumValues: ['individual', 'family_floater', 'individual_per_member', 'group_pool'],
      effects: ['cap_amount', 'inform'],
      bases: ['per_policy_year', 'per_person', 'per_policy'],
      critical: true,
      visibility: 'cover',
      extractionHints: ['Plan Type', 'Cover Type', 'Family Floater', 'Floater Sum Insured', 'Individual Sum Insured', 'Sum Insured per Insured Person'],
      estimateInput: true,
    },
    {
      key: 'floater_shared_exhaustion',
      label: 'Floater claims reduce cover for other members',
      description: 'True when the wording states that a claim paid for one member reduces the sum insured available to the other members for the rest of the policy year.',
      valueType: 'boolean',
      effects: ['cap_amount', 'inform'],
      bases: ['per_policy_year'],
      visibility: 'cover',
      extractionHints: ['available for any one or all Insured Persons', 'reduces the Sum Insured available', 'floater basis'],
      estimateInput: true,
    },
    {
      key: 'parent_sum_insured_cap',
      label: 'Per-parent cap within the sum insured',
      description: 'A rupee cap on what is payable for a parent or parent-in-law within a floater or family pool, if stated. Rupees in valueNumber.',
      valueType: 'money',
      effects: ['cap_amount'],
      bases: ['per_person', 'per_policy_year'],
      visibility: 'cover',
      memberScoped: true,
      extractionHints: ['parental sub-limit', 'parents covered up to', 'per parent', 'parents-in-law limit'],
      estimateInput: true,
    },
    {
      key: 'eligible_relationships',
      label: 'Eligible relationships',
      description: 'Relationships the wording allows to be covered (e.g. Spouse, Dependent Children, Parents, Parents-in-law). Eligibility only — not proof that anyone with that relationship is insured.',
      valueType: 'text_list',
      effects: ['inform'],
      bases: ['per_policy'],
      visibility: 'cover',
      extractionHints: ['Family means', 'Eligibility', 'Who can be covered', 'Insured Person means'],
    },
    {
      key: 'relationship_definitions',
      label: 'Relationship definitions',
      description: 'Exact wording that defines a relationship such as Spouse, Parent or Parent-in-law, including whether the person must be named in the schedule or added by endorsement.',
      valueType: 'rule',
      effects: ['require', 'inform'],
      bases: ['per_person', 'not_applicable'],
      visibility: 'cover',
      extractionHints: ['Spouse means', 'Parents means', 'Parents-in-law means', 'Definitions'],
    },
    {
      key: 'dependent_child_max_age_years',
      label: 'Dependent child maximum age',
      description: 'Age in completed years until which a dependent child remains covered. Report conditional alternatives (e.g. student) in conditions/exceptions.',
      valueType: 'years',
      effects: ['require'],
      bases: ['per_person'],
      critical: true,
      visibility: 'cover',
      extractionHints: ['Dependent Children are covered up to', 'child up to the age of', 'till the age of', 'ceases to be covered', '25th birthday'],
      validate: yearsBetween(1, 40, 'Dependent child maximum age'),
    },
    {
      key: 'dependent_child_min_entry_age_days',
      label: 'Dependent child minimum entry age',
      description: 'Minimum age for a dependent child to enter the policy, in days (convert stated months or years to days only if the wording gives days; otherwise report the figure as stated and its unit).',
      valueType: 'days',
      effects: ['require'],
      bases: ['per_person'],
      visibility: 'cover',
      extractionHints: ['minimum entry age', '91 days', '90 days', 'day one'],
      validate: value => value.count > 366 * 18 ? 'Child minimum entry age in days is implausible.' : null,
    },
    {
      key: 'dependent_child_conditions',
      label: 'Dependent child conditions',
      description: 'Status conditions a child must meet to count as dependent: unmarried, financially dependent, no independent income, student, natural or adopted.',
      valueType: 'rule',
      effects: ['require'],
      bases: ['per_person'],
      visibility: 'cover',
      extractionHints: ['Dependent Child means', 'unmarried', 'financially dependent', 'independent source of income', 'full-time student'],
    },
    {
      key: 'dependent_child_exit_rule',
      label: 'Dependent child age-out rule',
      description: 'When a dependent child stops being covered (birthday, renewal after birthday, marriage, employment) and any migration option with waiting-period credit.',
      valueType: 'rule',
      effects: ['void', 'inform'],
      bases: ['per_person'],
      visibility: 'cover',
      extractionHints: ['shall cease to be covered', 'whichever is earliest', 'separate individual policy', 'on marriage', 'taking up employment'],
    },
    {
      key: 'min_entry_age_adult_years',
      label: 'Adult minimum entry age',
      description: 'Minimum entry age for an adult insured person, in years.',
      valueType: 'years',
      effects: ['require'],
      bases: ['per_person'],
      visibility: 'cover',
      extractionHints: ['minimum entry age', '18 years for adults'],
      validate: yearsBetween(0, 100, 'Adult minimum entry age'),
    },
    {
      key: 'max_entry_age_years',
      label: 'Adult maximum entry age',
      description: 'Maximum age at which an adult may first enter the policy, in years. Found=false if the policy says there is no maximum.',
      valueType: 'years',
      effects: ['require'],
      bases: ['per_person'],
      visibility: 'cover',
      extractionHints: ['maximum entry age', 'Entry age', 'Age at entry'],
      validate: yearsBetween(1, 120, 'Maximum entry age'),
    },
    {
      key: 'max_renewal_age_rule',
      label: 'Maximum renewal age',
      description: 'The clause stating any maximum age at renewal, or that there is none (renewal for life), per member type.',
      valueType: 'rule',
      effects: ['void', 'inform'],
      bases: ['per_person'],
      visibility: 'cover',
      extractionHints: ['no maximum age at renewal', 'maximum renewal age', 'renew the Policy for life', 'exit age'],
    },
    {
      key: 'max_family_members',
      label: 'Maximum persons per policy',
      description: 'Maximum number of persons who may be covered under one policy; report adult/child sub-limits in conditions.',
      valueType: 'count',
      effects: ['require'],
      bases: ['per_policy'],
      visibility: 'cover',
      extractionHints: ['maximum of', 'persons may be covered', 'adults and children', 'family size'],
      validate: value => value.count < 1 || value.count > 60 ? 'Maximum persons per policy must be 1–60.' : null,
    },
    {
      key: 'member_effective_date',
      label: 'Member effective date',
      description: "Date the named member's continuous cover started (Date of First Enrolment / Insured since). One item per member with memberScope; ISO date. Drives that member's waiting clocks.",
      valueType: 'date',
      effects: ['wait_until', 'inform'],
      bases: ['per_person'],
      critical: true,
      visibility: 'cover',
      memberScoped: true,
      extractionHints: ['Date of First Enrolment', 'Insured since', 'Continuous coverage since', 'Member inception date', 'Date of joining'],
      validate: plausibleDate('1950-01-01', 'Member effective date'),
    },
    {
      key: 'member_date_of_birth',
      label: 'Member date of birth',
      description: 'Date of birth of a named member as shown in the schedule. One item per member with memberScope; ISO date. Not computed from a stated age.',
      valueType: 'date',
      effects: ['inform'],
      bases: ['per_person'],
      visibility: 'protected',
      memberScoped: true,
      extractionHints: ['Date of Birth', 'DOB', 'Details of Insured Persons'],
      estimateInput: true,
      validate: plausibleDate('1900-01-01', 'Date of birth'),
    },
    {
      key: 'newborn_cover',
      label: 'Newborn cover',
      description: 'What is covered for a newborn and from when (day one, day 91), within whose sum insured, conditions such as admissible maternity claim, and the deadline/premium to add the baby.',
      valueType: 'rule',
      effects: ['pay', 'require', 'wait_until'],
      bases: ['per_person', 'per_policy_year'],
      visibility: 'cover',
      extractionHints: ['Newborn baby', 'New born', 'covered from day one', 'within 90 days of birth', 'Maternity Benefit'],
    },
    {
      key: 'mid_term_addition_rule',
      label: 'Mid-term addition of members',
      description: 'Rules for adding a spouse on marriage, an adopted child or other member during the policy period: window, pro-rata premium, whether waiting periods restart.',
      valueType: 'rule',
      effects: ['require', 'wait_until'],
      bases: ['per_person'],
      visibility: 'cover',
      extractionHints: ['Addition of Insured Persons', 'mid-term inclusion', 'on marriage', 'legally adopted', 'pro-rata premium', 'by endorsement'],
    },
    {
      key: 'nominee_required',
      label: 'Nomination required',
      description: 'True when the wording requires the policyholder to make a nomination.',
      valueType: 'boolean',
      effects: ['require'],
      bases: ['per_policy'],
      visibility: 'operational',
      extractionHints: ['Nomination', 'required at the inception of the policy to make a nomination'],
    },
    {
      key: 'nominee_name',
      label: 'Nominee',
      description: 'Nominee named in the schedule, with relationship if stated.',
      valueType: 'text',
      effects: ['inform'],
      bases: ['per_policy'],
      visibility: 'operational',
      extractionHints: ['Nominee', 'Nominee Name', 'Relationship with Nominee'],
    },
    {
      key: 'member_specific_conditions',
      label: 'Member-specific conditions',
      description: 'Conditions applying to one named member only: condition-specific waiting period, member exclusion, member co-pay or sub-limit by endorsement, counter-offer terms. One item per member, memberScope required.',
      valueType: 'rule',
      effects: ['exclude', 'wait_until', 'pay_percent', 'cap_amount', 'require'],
      bases: ['per_person', 'per_illness', 'per_claim', 'per_policy_year'],
      critical: true,
      visibility: 'protected',
      memberScoped: true,
      extractionHints: ['Member-specific endorsement', 'Underwriting decision', 'Special conditions', 'Counter offer', 'covered only after', 'Permanent exclusion for'],
    },
    {
      key: 'member_premium_loading_percent',
      label: 'Member premium loading',
      description: 'Premium loading percentage applied to a named member at underwriting, with memberScope.',
      valueType: 'percent',
      effects: ['inform'],
      bases: ['per_person'],
      visibility: 'protected',
      memberScoped: true,
      extractionHints: ['loading', 'premium loading of', 'medical loading'],
      validate: value => value.percent <= 0 ? 'A loading must be greater than 0%.' : null,
    },
    {
      key: 'declared_conditions',
      label: 'Declared conditions',
      description: 'Medical conditions declared in the proposal or recorded against a named member (e.g. PED declared). One item per member, memberScope required.',
      valueType: 'text_list',
      effects: ['inform'],
      bases: ['per_person'],
      visibility: 'protected',
      memberScoped: true,
      extractionHints: ['Declared condition', 'PED declared', 'Pre-existing disease declared', 'Medical history'],
    },
    {
      key: 'underwriting_outcome',
      label: 'Underwriting outcome',
      description: 'Per member: standard_terms, modified_terms (loading, member exclusion, condition-specific wait, counter-offer) or declined. memberScope names the member(s).',
      valueType: 'enum',
      enumValues: ['standard_terms', 'modified_terms', 'declined'],
      effects: ['inform'],
      bases: ['per_person'],
      visibility: 'protected',
      memberScoped: true,
      extractionHints: ['Accepted at standard terms', 'Accepted with', 'Underwriting decision', 'Counter offer', 'Declined'],
    },
    {
      key: 'pre_policy_checkup_status',
      label: 'Pre-policy medical check-up',
      description: 'Per member: done, waived or not_required, exactly as stated.',
      valueType: 'enum',
      enumValues: ['done', 'waived', 'not_required'],
      effects: ['inform'],
      bases: ['per_person'],
      visibility: 'operational',
      memberScoped: true,
      extractionHints: ['Pre-policy Medical Check-up', 'PPMC', 'medical tests', 'waived'],
    },
    {
      key: 'residency_condition',
      label: 'Residency condition',
      description: 'Residency requirement (resident in India, NRI/OCI rules, long stays abroad).',
      valueType: 'rule',
      effects: ['require', 'void'],
      bases: ['per_person'],
      visibility: 'cover',
      extractionHints: ['resident in India', 'NRI', 'OCI', 'stay outside India'],
    },
    {
      key: 'occupation_condition',
      label: 'Occupation condition',
      description: 'Occupation-based loading, exclusion or eligibility restriction (hazardous occupations, armed forces, professional sports).',
      valueType: 'rule',
      effects: ['exclude', 'require', 'inform'],
      bases: ['per_person'],
      visibility: 'cover',
      extractionHints: ['occupation', 'hazardous', 'armed forces', 'professional sports'],
    },
  ],
  reviewGuidance: [
    'insured_members: compare every item against the schedule table; confirm no one was added from the "Family means" definition and no named person is missing. Relationship labels must match the schedule.',
    'sum_insured_structure: confirm Plan Type / Cover Type in the schedule; per-member sums insured mean individual_per_member, not floater.',
    'dependent_child_max_age_years: read the exit clause, including renewal-date timing and student/marriage/employment conditions; check the minimum entry age in days was not reported as the maximum.',
    "member_effective_date: check each member's date against the schedule column, read as dd/mm/yyyy; a member added later must not inherit the policy's first inception date.",
    'member_specific_conditions: protected. Confirm memberScope names the right person, and that the condition text is quoted from the endorsement or underwriting decision, not inferred from a declared condition.',
  ].join('\n'),
});
