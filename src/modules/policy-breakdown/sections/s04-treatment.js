// Section 4 — Treatment: is this event an affirmative benefit?
// Records whether each benefit exists and its definition/conditions (booleans, rules, lists, day counts).
// Every rupee limit and percentage cap belongs to Section 6 (money); none are declared here.

import { defineSection } from '../contracts.js';

const BOOL_EFFECTS = ['pay', 'exclude', 'require', 'inform'];
const RULE_EFFECTS = ['pay', 'exclude', 'require', 'wait_until', 'inform'];
const BENEFIT_BASES = ['per_claim', 'per_illness', 'per_event', 'per_person', 'per_policy_year', 'per_lifetime', 'per_policy', 'not_applicable'];

const intRange = (min, max, unit) => value => {
  const count = value?.count;
  if (!Number.isInteger(count) || count < min || count > max) return `${unit} must be an integer between ${min} and ${max}.`;
  return null;
};

const flag = (key, label, description, hints, extra = {}) => ({
  key, label, description, valueType: 'boolean', effects: BOOL_EFFECTS, bases: BENEFIT_BASES,
  critical: false, visibility: 'cover', memberScoped: false, extractionHints: hints,
  emergencyCard: false, estimateInput: false, ...extra,
});

const rule = (key, label, description, hints, extra = {}) => ({
  key, label, description, valueType: 'rule', effects: RULE_EFFECTS, bases: BENEFIT_BASES,
  critical: false, visibility: 'cover', memberScoped: false, extractionHints: hints,
  emergencyCard: false, estimateInput: false, ...extra,
});

const list = (key, label, description, hints, extra = {}) => ({
  key, label, description, valueType: 'text_list', effects: ['pay', 'exclude', 'inform'], bases: BENEFIT_BASES,
  critical: false, visibility: 'cover', memberScoped: false, extractionHints: hints,
  emergencyCard: false, estimateInput: false, ...extra,
});

const parameters = [
  // In-patient hospitalisation and hospital definition
  {
    key: 'inpatient_minimum_hours', label: 'Minimum in-patient admission (hours)',
    description: 'Minimum continuous hours of hospital stay for an in-patient claim to be admissible, as stated in the in-patient benefit or the In-patient Care definition (commonly 24). Integer hours in valueNumber. Record the day-care exception in exceptions. If wording says "more than 24 hours", record 24 and note "more than".',
    valueType: 'count', effects: ['require'], bases: ['per_claim', 'per_event'], critical: true, visibility: 'cover',
    memberScoped: false, emergencyCard: true, estimateInput: true,
    extractionHints: ['In-patient Hospitalisation', 'In-patient Care means', 'minimum period of 24 consecutive hours', 'not less than 24 hours', 'shall not apply to Day Care Treatment'],
    validate: intRange(1, 96, 'Minimum admission hours'),
  },
  list('inpatient_covered_expenses', 'In-patient expense heads covered',
    'Each expense head the in-patient benefit names as payable (room and nursing, ICU, surgeon and specialist fees, anaesthesia, OT, medicines, diagnostics, implants, blood, oxygen). One head per item, in the wording\'s own words. Do not include amounts or caps.',
    ['Room, Boarding and Nursing', 'Surgeon, Anaesthetist, Medical Practitioner', 'operation theatre charges', 'medicines and drugs', 'diagnostic procedures', 'prosthetic and other devices']),
  rule('hospital_definition', 'Definition of "Hospital"',
    'The policy\'s definition of an eligible Hospital: registration route (Clinical Establishments Act 2010 or local authority) or minimum criteria — 24-hour qualified nursing, in-patient bed count by town population, medical practitioner in charge round the clock, own operation theatre, daily patient records. valueText summarises the alternatives; conditions lists each criterion with its number (e.g. beds). A small nursing home can fail this definition.',
    ['Hospital means', 'Clinical Establishments (Registration and Regulation) Act, 2010', 'in-patient beds', 'qualified nursing staff', 'fully equipped operation theatre', 'daily records of patients'],
    { critical: true, emergencyCard: true, effects: ['require'] }),
  rule('medical_necessity_rule', 'Medical necessity / active treatment requirement',
    'Whether admission must be Medically Necessary and involve active treatment; the definition elements (required for management of the illness, prescribed by a medical practitioner, not exceeding necessary level of care). Record the investigation/evaluation-only exclusion as an exception or condition here only as the benefit condition; Section 5 records the exclusion itself.',
    ['Medically Necessary Treatment means', 'active treatment', 'primarily for diagnostic or evaluation purposes', 'must have been prescribed by a Medical Practitioner'],
    { effects: ['require', 'exclude'] }),
  rule('accident_cover_rule', 'Accident versus illness treatment rule',
    'How the wording treats accidental injury differently from illness for treatment: required documents (FIR, Medico-Legal Certificate), benefits available only after an accident. Waiting-period exemption for accidents is Section 3; do not record it here.',
    ['In case of an Accident', 'First Information Report', 'Medico-Legal Certificate', 'MLC', 'accidental bodily injury'],
    { effects: ['require', 'pay', 'inform'] }),

  // Day care
  flag('daycare_covered', 'Day-care treatment covered',
    'True when day-care procedures (treatment completed in under 24 hours due to technological advancement, under anaesthesia) are an affirmative benefit. False only when the wording says day care is not covered.',
    ['Day Care Treatment', 'Day Care procedures', 'Annexure I', 'less than 24 hours because of technological advancement'],
    { emergencyCard: true, estimateInput: true }),
  {
    key: 'daycare_list_basis', label: 'Day-care list basis',
    description: 'Whether day care is limited to a listed annexure (listed), open to any day-care procedure (open_ended), both a list plus "any other day care" (listed_and_open_ended), or not stated.',
    valueType: 'enum', enumValues: ['listed', 'open_ended', 'listed_and_open_ended', 'not_stated'],
    effects: ['pay', 'inform'], bases: ['not_applicable'], critical: false, visibility: 'cover', memberScoped: false,
    emergencyCard: false, estimateInput: true,
    extractionHints: ['listed in Annexure', 'List of Day Care Procedures', 'all day care treatments', 'any day care procedure'],
  },
  {
    key: 'daycare_procedure_count', label: 'Number of listed day-care procedures',
    description: 'Count of day-care procedures the wording states its annexure contains (e.g. "586 procedures"). Only when the wording states the number; never count annexure lines yourself.',
    valueType: 'count', effects: ['inform'], bases: ['not_applicable'], critical: false, visibility: 'cover', memberScoped: false,
    emergencyCard: false, estimateInput: false,
    extractionHints: ['contains', 'procedures', 'Day Care Procedures annexure'],
    validate: intRange(1, 5_000, 'Day-care procedure count'),
  },

  // Pre- and post-hospitalisation
  {
    key: 'pre_hospitalisation_days', label: 'Pre-hospitalisation days',
    description: 'Number of days immediately before admission for which related medical expenses are payable. Integer days in valueNumber. If expressed differently by plan variant or member, report each distinct value with memberScope.',
    valueType: 'days', effects: ['pay'], bases: ['per_claim', 'per_illness', 'per_event'], critical: true, visibility: 'cover',
    memberScoped: false, emergencyCard: false, estimateInput: true,
    extractionHints: ['Pre-hospitalisation Medical Expenses', 'days immediately before', 'prior to the date of admission', 'Pre-hospitalization'],
    validate: intRange(0, 365, 'Pre-hospitalisation days'),
  },
  {
    key: 'post_hospitalisation_days', label: 'Post-hospitalisation days',
    description: 'Number of days immediately after discharge for which related medical expenses are payable. Integer days in valueNumber. Watch for a separate figure in a sentence that also gives the pre-hospitalisation days.',
    valueType: 'days', effects: ['pay'], bases: ['per_claim', 'per_illness', 'per_event'], critical: true, visibility: 'cover',
    memberScoped: false, emergencyCard: false, estimateInput: true,
    extractionHints: ['Post-hospitalisation Medical Expenses', 'days immediately after', 'after the date of discharge', 'Post-hospitalization'],
    validate: intRange(0, 365, 'Post-hospitalisation days'),
  },
  flag('pre_post_linked_to_admitted_claim', 'Pre/post expenses require an admitted in-patient or day-care claim',
    'True when pre- and post-hospitalisation expenses are payable only if the related in-patient or day-care claim is admitted and the expenses relate to the same condition.',
    ['provided that a claim', 'has been admitted', 'admissible under', 'relate to the same condition'],
    { effects: ['require'], estimateInput: true }),

  // Maternity and newborn
  flag('maternity_covered', 'Maternity benefit covered',
    'True when delivery (normal or caesarean) is an affirmative benefit. If the schedule restricts it to a named insured person, set memberScope to that person. The maternity waiting period is Section 3 and money limits are Section 6.',
    ['Maternity Benefit', 'Maternity Expenses', 'delivery of a child', 'caesarean section', 'female Insured Person'],
    { memberScoped: true, estimateInput: true }),
  rule('maternity_conditions', 'Maternity benefit conditions',
    'Conditions on the maternity benefit other than money and the waiting period: eligible person, medical termination of pregnancy, ectopic pregnancy treatment, exclusions within the benefit.',
    ['lawful medical termination of pregnancy', 'Ectopic pregnancy', 'female Insured Person', 'Maternity Benefit']),
  {
    key: 'maternity_delivery_count_limit', label: 'Maximum deliveries covered',
    description: 'Maximum number of deliveries or terminations payable, with basis (per_lifetime of the policy, per_policy_year). Integer in valueNumber.',
    valueType: 'count', effects: ['require', 'inform'], bases: ['per_lifetime', 'per_policy_year', 'per_person', 'per_policy'],
    critical: false, visibility: 'cover', memberScoped: true, emergencyCard: false, estimateInput: true,
    extractionHints: ['maximum of 2 deliveries', 'two deliveries', 'during the lifetime of the Policy', 'number of deliveries'],
    validate: intRange(1, 10, 'Delivery count'),
  },
  flag('maternity_complications_covered', 'Pregnancy complications covered',
    'True when complications of pregnancy requiring hospitalisation are covered (within maternity or as in-patient).',
    ['complications of pregnancy', 'complications arising out of pregnancy']),
  rule('prenatal_postnatal_rule', 'Pre-natal and post-natal expense rule',
    'Whether pre-natal and post-natal expenses are payable and on what condition (e.g. only during the delivery hospitalisation, or for N days).',
    ['Pre-natal', 'post-natal', 'ante-natal']),
  flag('newborn_treatment_covered', 'New-born baby treatment covered',
    'True when medical expenses of the new-born baby are covered as a treatment benefit (e.g. from day one within the maternity limit). Membership/addition of the newborn to the policy is Section 2.',
    ['New Born Baby', 'new born baby are covered from day one', 'newborn', 'baby born during the Policy Period']),

  // Chronic and high-cost care
  rule('chronic_condition_care_rule', 'Pre-existing and chronic condition care',
    'Treatment-benefit wording that specifically covers chronic or pre-existing conditions (e.g. chronic care management programme, diabetes/hypertension day-one cover rider). Not the PED waiting period (Section 3) or PED definition (Section 5).',
    ['chronic care', 'chronic disease management', 'day 1 cover for', 'pre-existing diseases covered from']),
  list('high_cost_treatments_covered', 'High-cost treatments expressly covered',
    'Named high-cost treatments the wording expressly states are covered (dialysis, chemotherapy, radiotherapy, organ transplant, cardiac procedures). Only those expressly named as covered.',
    ['Dialysis', 'chemotherapy', 'radiotherapy', 'transplant', 'cardiac']),

  // Modern treatments
  flag('modern_treatments_covered', 'Modern treatment methods covered',
    'True when the IRDAI "Modern Treatment Methods and Advancement in Technologies" benefit (or equivalent) is present. Its percentage or rupee cap belongs to Section 6.',
    ['Modern Treatment Methods', 'Advancement in Technologies', 'Robotic surgeries', 'Oral Chemotherapy'],
    { estimateInput: true }),
  list('modern_treatment_list', 'Modern treatment methods named',
    'Each named modern treatment method as written (e.g. Uterine Artery Embolization and HIFU; Balloon Sinuplasty; Deep Brain Stimulation; Oral Chemotherapy; Immunotherapy; Intra vitreal injections; Robotic surgeries; Stereotactic radio surgeries; Bronchial Thermoplasty; Vaporisation of the prostate; IONM; Stem cell therapy). One method per item; keep the wording\'s spelling; drop the letter prefix.',
    ['Uterine Artery Embolization', 'Balloon Sinuplasty', 'Deep Brain Stimulation', 'Immunotherapy', 'Stem cell therapy', 'IONM']),
  rule('modern_treatment_conditions', 'Modern treatment conditions',
    'Setting and other conditions on modern treatments other than money: in-patient or day care in a hospital, stem-cell restriction to haematological conditions, per-method notes.',
    ['covered either as In-patient Care or as part of Day Care Treatment', 'haematological conditions', 'Hematopoietic stem cells']),

  // Organ donor, bariatric, mental health
  flag('organ_donor_covered', 'Organ donor expenses covered',
    'True when the organ donor\'s in-patient expenses for harvesting an organ donated to the insured person are a benefit.',
    ['Organ Donor Expenses', 'harvesting of the organ', 'organ donor']),
  {
    key: 'organ_donor_scope', label: 'Organ donor cover scope',
    description: 'harvesting_only when only the donor\'s harvesting hospitalisation is paid; harvesting_and_donor_care when the donor\'s pre/post-operative care or complications are also paid; not_stated otherwise.',
    valueType: 'enum', enumValues: ['harvesting_only', 'harvesting_and_donor_care', 'not_stated'],
    effects: ['pay', 'exclude'], bases: ['per_event', 'per_claim', 'not_applicable'], critical: false, visibility: 'cover',
    memberScoped: false, emergencyCard: false, estimateInput: true,
    extractionHints: ['harvesting of the organ', 'expenses of the donor', 'donor\'s pre-hospitalisation', 'costs of acquiring the organ'],
  },
  flag('bariatric_covered', 'Bariatric surgery covered',
    'True when bariatric (obesity/weight-control) surgery is covered; false when the wording excludes it outright. Absent if not mentioned.',
    ['Bariatric surgery', 'obesity', 'weight control', 'morbid obesity']),
  rule('bariatric_conditions', 'Bariatric surgery conditions',
    'Clinical conditions for bariatric cover: BMI thresholds (e.g. ≥40, or ≥35 with comorbidities), age ≥18, failed less invasive methods, prescribed by a doctor. List each in conditions.',
    ['BMI', 'Body Mass Index', 'co-morbidities', 'less invasive methods of weight loss']),
  flag('mental_illness_covered', 'Mental illness treatment covered',
    'True when in-patient treatment of mental illness is an affirmative benefit (Mental Healthcare Act 2017 parity wording).',
    ['Mental Illness', 'Mental Healthcare Act, 2017', 'psychiatric', 'mental health professional']),
  rule('mental_illness_conditions', 'Mental illness treatment conditions',
    'Conditions on mental illness cover: hospital registered under the Mental Healthcare Act 2017, advice of psychiatrist or mental health professional, excluded conditions.',
    ['registered under the Mental Healthcare Act', 'on the advice of a psychiatrist', 'mental health establishment']),

  // Domiciliary, home care, rehabilitation
  flag('domiciliary_covered', 'Domiciliary hospitalisation covered',
    'True when treatment at home that would otherwise need hospitalisation (patient cannot be moved, or no hospital bed) is a benefit.',
    ['Domiciliary Hospitalisation', 'confined at home', 'not in a condition to be removed to a Hospital', 'non-availability of room']),
  {
    key: 'domiciliary_minimum_days', label: 'Domiciliary minimum treatment days',
    description: 'Minimum consecutive days domiciliary treatment must continue to be payable (commonly 3). Integer days.',
    valueType: 'days', effects: ['require'], bases: ['per_illness', 'per_claim', 'per_event'], critical: false, visibility: 'cover',
    memberScoped: false, emergencyCard: false, estimateInput: true,
    extractionHints: ['at least 3 consecutive days', 'exceeds three days', 'continues for a period exceeding'],
    validate: intRange(1, 30, 'Domiciliary minimum days'),
  },
  rule('domiciliary_conditions', 'Domiciliary hospitalisation conditions',
    'The triggering circumstances (cannot be moved; no hospital room) and other conditions (prescription, no pre/post-hospitalisation under this benefit).',
    ['under any of the following circumstances', 'prescribed by a Medical Practitioner', 'No pre-hospitalisation or post-hospitalisation']),
  list('domiciliary_excluded_conditions', 'Conditions excluded from domiciliary cover',
    'Each disease the wording excludes from the domiciliary benefit (asthma, bronchitis, diabetes, hypertension, etc.), one per item, exactly as written.',
    ['The following are not covered under Domiciliary', 'asthma, bronchitis', 'pyrexia of unknown origin'],
    { effects: ['exclude'] }),
  flag('home_care_covered', 'Home care treatment covered',
    'True when a "home care" / "hospitalisation at home" benefit (treatment at home in place of admission for listed conditions with prior approval) exists. Distinct from domiciliary hospitalisation.',
    ['Home Care Treatment', 'Hospitalisation at home', 'Home Treatment', 'home care']),
  rule('home_care_conditions', 'Home care conditions',
    'Conditions for home care: listed conditions, written medical advice, prior insurer/TPA approval, monitoring records, network provider.',
    ['prior approval', 'advises it in writing', 'daily monitoring records', 'Annexure IV']),
  flag('rehabilitation_covered', 'Rehabilitation covered',
    'True when in-patient or post-acute rehabilitation (e.g. after stroke or major surgery) is expressly covered.',
    ['Rehabilitation', 'physiotherapy after discharge', 'post-acute care']),

  // AYUSH
  flag('ayush_covered', 'AYUSH in-patient treatment covered',
    'True when in-patient treatment under Ayurveda, Yoga and Naturopathy, Unani, Siddha and Homeopathy is a benefit. Its cap belongs to Section 6.',
    ['AYUSH Treatment', 'Ayurveda, Yoga and Naturopathy, Unani, Siddha and Homeopathy', 'AYUSH Hospital'],
    { estimateInput: true }),
  rule('ayush_conditions', 'AYUSH facility and other conditions',
    'Which facilities qualify (government AYUSH hospital, teaching hospital of a recognised AYUSH college, registered AYUSH hospital), in-patient requirement, and exclusions (wellness centre, spa, resort).',
    ['only when the treatment is taken in an AYUSH Hospital', 'AYUSH Hospital is a healthcare facility', 'wellness centre, spa or resort']),

  // Dental, vision, OPD and ancillary
  rule('dental_vision_rule', 'Dental and vision treatment rule',
    'When dental or vision/spectacle treatment is payable (commonly only after an accident requiring hospitalisation, or via OPD add-on).',
    ['Dental treatment', 'spectacles', 'contact lenses', 'necessitated by an Accident'],
    { effects: ['pay', 'exclude', 'require'] }),
  flag('opd_covered', 'Out-patient (OPD) treatment covered',
    'True when out-patient consultations, diagnostics or pharmacy outside admission are a benefit; false when the schedule or wording says OPD is not covered. Teleconsultation is recorded separately.',
    ['Out-patient (OPD) Treatment', 'OPD', 'out-patient consultation', 'OPD wallet']),
  flag('teleconsultation_covered', 'Teleconsultation covered',
    'True when teleconsultation with a medical practitioner is an available benefit.',
    ['Tele-consultation', 'teleconsultation', 'virtual consultation', 'mobile application']),
  flag('health_checkup_covered', 'Health check-up covered',
    'True when a preventive health check-up is a benefit.',
    ['Health Check-up', 'preventive health check', 'annual health check-up']),
  rule('health_checkup_conditions', 'Health check-up conditions',
    'Frequency and eligibility for the health check-up: every year vs after N claim-free years, eligible age, network centre requirement.',
    ['claim-free Policy Years', 'once at every renewal', 'aged 18 years or above', 'network diagnostic centre']),
  rule('wellness_benefit_rule', 'Wellness programme benefit',
    'Wellness programme or reward points and what they convert into (premium discount, OPD credit). Not health check-up.',
    ['Wellness Program', 'wellness points', 'reward points', 'discount on renewal premium']),
  flag('vaccination_covered', 'Vaccination covered',
    'True when vaccination (including post-bite anti-rabies) is covered.',
    ['Vaccination', 'anti-rabies', 'post-bite', 'immunisation']),
  flag('second_opinion_covered', 'Second medical opinion covered',
    'True when an e-opinion / second medical opinion service is a benefit (often for named critical illnesses).',
    ['Second Medical Opinion', 'second opinion', 'e-opinion']),
  flag('critical_illness_benefit_covered', 'Critical illness / fixed benefit covered',
    'True when a lump-sum critical illness or fixed benefit (separate from indemnity) is part of this policy or an attached rider. Lump-sum amount belongs to Section 6.',
    ['Critical Illness', 'lump sum', 'Fixed Benefit', 'first diagnosis']),
  rule('critical_illness_conditions', 'Critical illness trigger and survival rule',
    'Critical illness trigger definition, list of covered illnesses, survival period in days, and interaction with indemnity cover.',
    ['survival period', 'survives for', 'first diagnosed', 'listed Critical Illnesses']),
  flag('hospital_daily_cash_covered', 'Hospital daily cash covered',
    'True when a per-day hospital cash benefit exists. The per-day amount belongs to Section 6.',
    ['Hospital Daily Cash', 'Daily Hospital Cash', 'per day of hospitalisation']),
  rule('hospital_daily_cash_conditions', 'Hospital daily cash conditions',
    'Day deductible (first N days not paid), maximum days per event or year, minimum stay.',
    ['maximum of', 'days per Policy Year', 'first 24 hours', 'deductible of']),
  flag('air_ambulance_covered', 'Air ambulance covered',
    'True when air ambulance is a benefit; false when stated not covered. Ambulance amounts belong to Section 6.',
    ['Air Ambulance', 'air transportation']),

  // Geography
  flag('treatment_abroad_covered', 'Treatment outside India covered',
    'True when planned or emergency treatment outside India is payable; false when the wording limits treatment to India.',
    ['Treatment outside India', 'Worldwide cover', 'Global cover', 'taken in India'],
    { emergencyCard: false }),
  {
    key: 'geographic_scope', label: 'Geographic scope of treatment',
    description: 'Where treatment must be taken: india_only, worldwide, worldwide_emergency_only, worldwide_excluding_us_canada, india_and_named_countries, or not_stated.',
    valueType: 'enum',
    enumValues: ['india_only', 'worldwide', 'worldwide_emergency_only', 'worldwide_excluding_us_canada', 'india_and_named_countries', 'not_stated'],
    effects: ['pay', 'exclude', 'require'], bases: ['not_applicable', 'per_policy'], critical: false, visibility: 'cover',
    memberScoped: false, emergencyCard: true, estimateInput: false,
    extractionHints: ['Territorial Scope', 'Geographical Scope', 'shall be taken in India', 'payable in Indian Rupees'],
  },
  rule('treatment_abroad_conditions', 'Treatment abroad conditions',
    'Conditions on overseas treatment when it is covered: emergency only, diagnosis made in India, pre-approval, exchange-rate date, excluded countries.',
    ['diagnosed in India', 'rate of exchange', 'outside India', 'planned treatment abroad']),
];

const expertise = `SECTION 4 — TREATMENT: IS THIS EVENT AN AFFIRMATIVE BENEFIT?

Your job is to record, for this one policy, which treatments are affirmatively covered and the definitions and conditions that make them admissible. You record existence (true/false), rules, lists and day/hour/count figures. You do NOT record rupee limits, percentage-of-sum-insured caps, sub-limits, co-pays or ambulance amounts — those belong to Section 6 even when they sit in the same schedule row. You do NOT record waiting periods (Section 3) or exclusion lists (Section 5) except where a parameter here asks for an in-benefit condition.

WHERE IT APPEARS
- Policy Schedule / Table of Benefits: one row per benefit ("Covered", "Not Covered", "Optional", a limit). Gives existence fast, and member-specific restrictions (e.g. "Maternity: Insured Person X only").
- Policy Wording "Definitions" section: IRDAI-standardised definitions of Hospital, In-patient Care, Day Care Treatment, Medically Necessary Treatment, Domiciliary Hospitalisation, AYUSH Hospital, Mental Illness.
- Policy Wording "Benefits / Coverage / Scope of Cover" section: operative clauses ("The Company shall indemnify...", "shall pay...") with conditions.
- Customer Information Sheet (CIS): a summary; use it if the wording is absent, but the wording governs.
- Annexures: day-care procedure list, home-care conditions list, modern treatment list.

HOW TO READ EACH BENEFIT
- In-patient hospitalisation: minimum admission hours come from the benefit clause or the "In-patient Care" definition ("stay in a Hospital for more than 24 hours"). Record the hour figure; record "does not apply to Day Care Treatment" as an exception. List each expense head named as payable, without amounts.
- Hospital definition (IRDAI standard): registered under the Clinical Establishments (Registration and Regulation) Act 2010 OR meets all minimum criteria — qualified nursing staff round the clock; at least 10 in-patient beds in towns under 10 lakh population and 15 elsewhere; medical practitioner in charge round the clock; own fully equipped operation theatre; daily patient records. Put each criterion in conditions, keeping its numbers. Note any insurer deviation (different bed counts, extra registration demand).
- Medical necessity: record the requirement that admission be Medically Necessary / for active treatment, and the "admission primarily for diagnostic or evaluation purposes" carve-out as an exception. Section 5 separately records the exclusion flag.
- Day care: treatment under general or local anaesthesia completed in under 24 hours because of technological advancement. Decide if the list is closed ("procedures listed in Annexure I"), open ("all day care treatments"), or both. Record the procedure count only if the wording states a number. Out-patient treatment is not day care.
- Pre- and post-hospitalisation: day counts before admission and after discharge (common pairs 30/60, 60/90, 60/180). Trap: one sentence often gives both numbers — assign carefully. Record whether payment requires an admitted in-patient/day-care claim and the same condition.
- Accident: FIR / Medico-Legal Certificate requirements, benefits available only after accidents (e.g. dental). The accident waiting-period exemption belongs to Section 3.
- Maternity and newborn: existence, who is eligible (if the schedule names one insured person, use memberScope with that name exactly), maximum number of deliveries and its basis (lifetime of policy vs per year), medical termination, ectopic pregnancy routing, complications, pre/post-natal limits on timing, newborn treatment from day one. Delivery rupee limits belong to Section 6; maternity waiting period belongs to Section 3.
- Modern treatment methods (IRDAI list): Uterine Artery Embolization and HIFU; Balloon Sinuplasty; Deep Brain Stimulation; Oral Chemotherapy; Immunotherapy (monoclonal antibody injection); Intra-vitreal injections; Robotic surgeries; Stereotactic radio surgeries; Bronchial Thermoplasty; Vaporisation of the prostate (green/holmium laser); IONM; Stem cell therapy (haematopoietic stem cells for bone marrow transplant for haematological conditions). List only methods the wording names, in its own spelling (insurers often misspell — keep the misspelling). The "50% of sum insured" style cap is Section 6.
- High-cost care: list treatments the wording expressly names as covered (dialysis, chemotherapy, radiotherapy, transplant).
- Organ donor: harvesting-only versus harvesting plus donor's pre/post-operative care; payability usually linked to the recipient's admissible transplant claim.
- Bariatric: BMI thresholds, comorbidities, age, failure of less invasive methods. Often in exclusions with exceptions — if excluded outright, found=true with false.
- Mental illness: Mental Healthcare Act 2017 parity; conditions such as hospital registered under the Act and psychiatrist advice.
- Domiciliary hospitalisation: "cannot be moved to hospital" or "no room in hospital"; minimum consecutive days (commonly 3); the standard excluded-disease list (asthma, bronchitis, chronic nephritis, diarrhoea, diabetes, epilepsy, hypertension, influenza, pyrexia of unknown origin under 10 days, tonsillitis, arthritis, gout, rheumatism) — list each as written.
- Home care / hospitalisation at home: distinct from domiciliary; needs written advice, prior approval, monitoring.
- AYUSH: covered only for in-patient treatment in a qualifying AYUSH hospital (government hospital, teaching hospital of a recognised AYUSH college, or registered AYUSH hospital). Wellness/spa/resort treatment is typically excluded.
- OPD, teleconsultation, health check-up, wellness, vaccination, second opinion: record each separately. Health check-up trap: "after every block of N claim-free years" is not "annual"; age eligibility is a condition.
- Critical illness / fixed benefit, hospital daily cash: existence and trigger/survival/day-deductible rules only; amounts are Section 6.
- Geography: "treatment shall be taken in India" means india_only and treatment abroad false. Worldwide cover usually has emergency-only, diagnosed-in-India and exclude-USA/Canada conditions.

VALUE RULES
- Quote verbatim. Every value must be supported by an exact substring of the page text, whitespace as printed. Prefer the operative wording clause; use the schedule row when that is the only place the fact appears.
- Never infer from general knowledge, IRDAI regulation, or what most policies say. If the wording does not mention a benefit, answer found=false — not false. "Not Covered" in the schedule is found=true, valueBoolean=false.
- Never fill a value from another policy, a sample wording, or a different plan variant than the one in the schedule.
- Report each distinct value once. If two plan variants or members have different values, report each with memberScope or a condition; if two documents disagree, report both and the pipeline will mark it Conflicting.
- Use memberScope only when the wording names a specific insured person or member class for that value; otherwise null.
- Booleans in valueBoolean; day/hour/count figures as integers in valueNumber with unit ("days", "hours", "deliveries"); lists in valueList, one concept per item; rules in valueText as a short faithful summary, with conditions and exceptions as separate short strings.
- Set effect and basis only when the clause makes them clear (e.g. maximum deliveries per_lifetime). Otherwise null.
- Do not give advice, recommendations or opinions about adequacy. Record what the document says.`;

export default defineSection({
  number: 4,
  id: 'section-04-treatment',
  title: 'Treatment',
  question: 'Is this event an affirmative benefit, and under what definitions and conditions?',
  kind: 'extraction',
  expertise,
  parameters,
  reviewGuidance: 'Check minimum admission hours against both the benefit clause and the In-patient Care definition, and that the day-care exception is recorded. Check the hospital definition keeps the registration alternative and every numeric criterion (bed counts by population, round-the-clock nursing, own operation theatre). Check pre- and post-hospitalisation day counts were not swapped when both appear in one sentence, and whether payment is linked to an admitted claim for the same condition. Confirm any member-restricted benefit (e.g. maternity) carries the right member in memberScope. Confirm no rupee or percentage limit was captured here (those are Section 6). Confirm "Not Covered" rows were stored as found with false, and silent benefits as not found.',
});
