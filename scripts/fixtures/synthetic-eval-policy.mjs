// Synthetic two-document policy for the 100-question eval (E1). EXTENDS the thin three-page fixture in
// synthetic-policy-pages.mjs, which has too few facts for 100 honest questions. Same invented insurer
// (Zephyr Mutual Health, synthetic); every number, rule and member below is invented, nothing is copied from a real
// policy and there is no personal data. Two documents, as in the P0 journey: a schedule and the terms and conditions.
// Each FACTS row is one printed line plus the rule the offline stub extractor uses to read it back.
//   [factKey, category, documentKind, page, printedLine, valuePattern (group 1 = value), topicTerms]
// topicTerms are what the offline stub answerer matches a question against. The stub is NOT a model: scores from it
// say the harness works, not that any real extractor or answerer is accurate.

export const SYNTHETIC_DOCUMENTS = Object.freeze([
  Object.freeze({ documentId: 'doc-schedule', documentKind: 'schedule', title: 'Policy Schedule' }),
  Object.freeze({ documentId: 'doc-terms', documentKind: 'terms', title: 'Terms and Conditions' }),
]);

const F = (factKey, category, documentKind, page, line, pattern, topics) => Object.freeze({ factKey, category, documentKind, page, line, pattern, topics: Object.freeze(topics) });

export const SYNTHETIC_FACTS = Object.freeze([
  // Schedule page 1: policy and premium
  F('plan_type', 'renewal_premium', 'schedule', 1, 'Plan type: Family floater', 'Plan type: (.+)$', ['plan type', 'floater', 'individual or family']),
  F('policy_start', 'renewal_premium', 'schedule', 1, 'Policy start date: 1 April 2026', 'Policy start date: (.+)$', ['start date', 'policy start', 'begin', 'commence']),
  F('policy_end', 'renewal_premium', 'schedule', 1, 'Policy end date: 31 March 2027', 'Policy end date: (.+)$', ['end date', 'policy end', 'expire', 'valid until']),
  F('premium_total', 'renewal_premium', 'schedule', 1, 'Total premium payable: Rs. 21,240 including GST', 'Total premium payable: Rs\\. ([\\d,]+)', ['total premium', 'premium payable', 'how much premium', 'pay for the policy']),
  F('premium_base', 'renewal_premium', 'schedule', 1, 'Base premium: Rs. 18,000', 'Base premium: Rs\\. ([\\d,]+)', ['base premium', 'premium before gst', 'premium before tax']),
  F('premium_gst', 'renewal_premium', 'schedule', 1, 'GST on premium: Rs. 3,240 at 18%', 'GST on premium: Rs\\. ([\\d,]+)', ['gst', 'tax on premium']),
  F('members_count', 'renewal_premium', 'schedule', 1, 'Number of insured members: 2', 'Number of insured members: (\\d+)', ['how many members', 'number of insured', 'members covered']),
  F('renewal_due', 'renewal_premium', 'schedule', 1, 'Renewal due date: 31 March 2027', 'Renewal due date: (.+)$', ['renewal due', 'renewal date', 'when is renewal', 'renew by']),
  F('payment_mode', 'renewal_premium', 'schedule', 1, 'Premium payment mode: Annual', 'Premium payment mode: (.+)$', ['payment mode', 'premium frequency', 'annual or monthly', 'instalment']),
  // Schedule page 2: limits and benefits
  F('sum_insured', 'sum_insured_limits', 'schedule', 2, 'Sum insured: Rs. 5,00,000', 'Sum insured: Rs\\. ([\\d,]+)', ['sum insured', 'coverage amount', 'cover amount', 'total cover']),
  F('room_rent_limit', 'room_rent_sublimits', 'schedule', 2, 'Room rent: Rs. 5,000 per day', 'Room rent: Rs\\. ([\\d,]+)', ['room rent', 'room limit', 'room charges per day']),
  F('icu_limit', 'room_rent_sublimits', 'schedule', 2, 'ICU charges: Rs. 10,000 per day', 'ICU charges: Rs\\. ([\\d,]+)', ['icu', 'intensive care']),
  F('copay', 'copay_deductible', 'schedule', 2, 'Co-payment: 10% of every admissible claim', 'Co-payment: (\\d+)%', ['co-payment', 'copay', 'co-pay', 'share of the claim']),
  F('deductible', 'copay_deductible', 'schedule', 2, 'Aggregate deductible: Rs. 25,000 per policy year', 'Aggregate deductible: Rs\\. ([\\d,]+)', ['deductible']),
  F('cataract_sublimit', 'room_rent_sublimits', 'schedule', 2, 'Cataract sub-limit: Rs. 40,000 per eye', 'Cataract sub-limit: Rs\\. ([\\d,]+)', ['cataract']),
  F('joint_sublimit', 'room_rent_sublimits', 'schedule', 2, 'Joint replacement sub-limit: Rs. 1,50,000', 'Joint replacement sub-limit: Rs\\. ([\\d,]+)', ['joint replacement', 'knee replacement']),
  F('ambulance_limit', 'sum_insured_limits', 'schedule', 2, 'Ambulance cover: Rs. 2,000 per hospitalisation', 'Ambulance cover: Rs\\. ([\\d,]+)', ['ambulance']),
  F('checkup_limit', 'sum_insured_limits', 'schedule', 2, 'Health check-up benefit: Rs. 3,000 once every 2 policy years', 'Health check-up benefit: Rs\\. ([\\d,]+)', ['health check-up', 'checkup', 'check-up']),
  F('bonus_rate', 'sum_insured_limits', 'schedule', 2, 'Cumulative bonus: 10% of sum insured for every claim-free year, up to 50%', 'Cumulative bonus: (\\d+)%', ['cumulative bonus', 'no claim bonus', 'claim-free']),
  F('bonus_cap', 'sum_insured_limits', 'schedule', 2, 'Maximum cumulative bonus: 50% of sum insured', 'Maximum cumulative bonus: (\\d+)%', ['maximum bonus', 'bonus cap', 'bonus maximum']),
  F('restoration', 'sum_insured_limits', 'schedule', 2, 'Restoration of sum insured: once per policy year', 'Restoration of sum insured: (.+)$', ['restoration', 'restore', 'recharge', 'reinstate']),
  F('prehosp_days', 'sum_insured_limits', 'schedule', 2, 'Pre-hospitalisation cover: 30 days', 'Pre-hospitalisation cover: (\\d+) days', ['pre-hospitalisation', 'before admission', 'before hospital']),
  F('posthosp_days', 'sum_insured_limits', 'schedule', 2, 'Post-hospitalisation cover: 60 days', 'Post-hospitalisation cover: (\\d+) days', ['post-hospitalisation', 'after discharge']),
  F('ayush_limit', 'sum_insured_limits', 'schedule', 2, 'AYUSH treatment: up to Rs. 50,000 per policy year', 'AYUSH treatment: up to Rs\\. ([\\d,]+)', ['ayush', 'ayurveda', 'homeopathy']),
  F('maternity_limit', 'sum_insured_limits', 'schedule', 2, 'Maternity expenses: up to Rs. 50,000 per delivery', 'Maternity expenses: up to Rs\\. ([\\d,]+)', ['maternity limit', 'delivery limit', 'childbirth limit', 'maternity cover amount']),
  // Terms page 1: definitions
  F('def_hospital', 'definitions', 'terms', 1, 'Hospital means an institution with at least 10 inpatient beds that is registered with the local authority.', 'Hospital means an institution with at least (\\d+) inpatient beds', ['define hospital', 'what counts as a hospital', 'hospital means', 'minimum beds']),
  F('def_daycare', 'definitions', 'terms', 1, 'Day care procedure means a treatment that needs less than 24 hours of hospitalisation.', 'Day care procedure means a treatment that needs less than (\\d+) hours', ['day care', 'daycare']),
  F('def_ped', 'definitions', 'terms', 1, 'Pre-existing disease means any condition diagnosed or treated within 48 months before the first policy start date.', 'diagnosed or treated within (\\d+) months', ['define pre-existing', 'pre-existing disease mean', 'what is a pre-existing', 'ped definition', 'look-back']),
  F('def_accident', 'definitions', 'terms', 1, 'Accident means a sudden, unforeseen and involuntary event caused by external, visible and violent means.', 'Accident means a (sudden, unforeseen and involuntary) event', ['define accident', 'accident mean', 'what is an accident']),
  F('def_network', 'definitions', 'terms', 1, 'Network hospital means a hospital listed by the insurer for cashless treatment.', 'Network hospital means a hospital (listed by the insurer for cashless treatment)', ['network hospital']),
  F('def_grace', 'renewal_premium', 'terms', 1, 'Grace period means 30 days after the premium due date within which renewal keeps continuity of cover.', 'Grace period means (\\d+) days', ['grace period', 'late renewal', 'miss the renewal', 'lapse']),
  // Terms page 2: waiting periods
  F('wait_initial', 'waiting_periods', 'terms', 2, 'Initial waiting period: 30 days from the policy start date, except accidents.', 'Initial waiting period: (\\d+) days', ['initial waiting', 'first 30', 'first month', 'waiting period at the start']),
  F('wait_ped', 'waiting_periods', 'terms', 2, 'Pre-existing disease waiting period: 36 months of continuous cover.', 'Pre-existing disease waiting period: (\\d+) months', ['pre-existing waiting', 'ped waiting', 'pre-existing diseases covered after', 'existing illness waiting']),
  F('wait_specific', 'waiting_periods', 'terms', 2, 'Specified diseases (cataract, hernia, joint replacement): waiting period of 24 months.', 'Specified diseases \\(.+\\): waiting period of (\\d+) months', ['specified disease', 'hernia', 'cataract waiting', 'joint replacement waiting']),
  F('wait_maternity', 'waiting_periods', 'terms', 2, 'Maternity expenses: waiting period of 24 months.', 'Maternity expenses: waiting period of (\\d+) months', ['maternity waiting', 'pregnancy waiting', 'childbirth waiting']),
  F('wait_accident', 'waiting_periods', 'terms', 2, 'Hospitalisation caused by an accident has no waiting period.', 'Hospitalisation caused by an accident has (no) waiting period', ['accident waiting', 'accidental hospitalisation waiting', 'accident covered from day one']),
  // Terms page 3: exclusions (value = verdict)
  F('excl_cosmetic', 'exclusions', 'terms', 3, 'Cosmetic or plastic surgery is excluded, except reconstruction following an accident.', '(Cosmetic or plastic surgery is excluded)', ['cosmetic', 'plastic surgery']),
  F('excl_dental', 'exclusions', 'terms', 3, 'Dental treatment is excluded unless it is caused by an accident.', '(Dental treatment is excluded)', ['dental', 'teeth', 'tooth']),
  F('excl_refractive', 'exclusions', 'terms', 3, 'Correction of eyesight (refractive error) below 7.5 dioptres is excluded.', 'refractive error\\) below ([\\d.]+) dioptres is excluded', ['refractive', 'lasik', 'spectacles', 'eyesight', 'dioptre']),
  F('excl_infertility', 'exclusions', 'terms', 3, 'Infertility and assisted reproduction treatment are excluded.', '(Infertility and assisted reproduction treatment are excluded)', ['infertility', 'ivf', 'assisted reproduction']),
  F('excl_war', 'exclusions', 'terms', 3, 'Injury caused by war or nuclear risk is excluded.', '(Injury caused by war or nuclear risk is excluded)', ['war', 'nuclear']),
  F('excl_selfharm', 'exclusions', 'terms', 3, 'Intentional self-inflicted injury is excluded.', '(Intentional self-inflicted injury is excluded)', ['self-inflicted', 'self harm', 'suicide']),
  F('excl_nonmedical', 'exclusions', 'terms', 3, 'Non-medical expenses such as gloves and masks are not payable.', '(Non-medical expenses such as gloves and masks are not payable)', ['non-medical', 'consumables', 'gloves', 'masks']),
  F('excl_obesity', 'exclusions', 'terms', 3, 'Weight-loss surgery is excluded unless the BMI is 40 or above.', 'unless the BMI is (\\d+) or above', ['weight-loss', 'obesity', 'bariatric', 'bmi']),
  F('excl_opd', 'exclusions', 'terms', 3, 'Outpatient consultations without hospital admission are not covered.', '(Outpatient consultations without hospital admission are not covered)', ['outpatient', 'opd', 'doctor visit', 'consultation']),
  // Terms page 4: claims process
  F('claim_planned_notice', 'claims_process', 'terms', 4, 'Intimate a planned hospitalisation at least 48 hours before admission.', 'Intimate a planned hospitalisation at least (\\d+) hours before admission', ['planned hospitalisation', 'planned admission', 'planned treatment intimat']),
  F('claim_emergency_notice', 'claims_process', 'terms', 4, 'Intimate an emergency hospitalisation within 24 hours of admission.', 'Intimate an emergency hospitalisation within (\\d+) hours of admission', ['emergency hospitalisation', 'emergency admission', 'emergency intimat']),
  F('claim_submit_days', 'claims_process', 'terms', 4, 'Submit reimbursement documents within 15 days of discharge.', 'Submit reimbursement documents within (\\d+) days of discharge', ['reimbursement deadline', 'submit documents', 'submit bills', 'submission deadline', 'file reimbursement']),
  F('claim_cashless_hours', 'claims_process', 'terms', 4, 'The insurer decides a cashless request within 3 hours of receiving complete documents.', 'decides a cashless request within (\\d+) hours', ['cashless decision', 'cashless request', 'cashless approval', 'pre-authorisation']),
  F('claim_settle_days', 'claims_process', 'terms', 4, 'Claims are settled within 30 days of receiving the last document.', 'Claims are settled within (\\d+) days', ['claim settled', 'claim settlement', 'settle my claim', 'how long to settle']),
  F('claim_documents', 'claims_process', 'terms', 4, 'Documents required: claim form, discharge summary, original bills and investigation reports.', 'Documents required: (.+)\\.$', ['documents required', 'documents needed', 'what documents', 'claim form']),
  // Terms page 5: renewal, cancellation, grievance
  F('free_look', 'renewal_premium', 'terms', 5, 'Free look period: 15 days from receipt of the policy document.', 'Free look period: (\\d+) days', ['free look', 'cancel after buying', 'cooling']),
  F('renewal_guarantee', 'renewal_premium', 'terms', 5, 'Renewal is guaranteed for life, subject to payment of premium.', 'Renewal is (guaranteed for life)', ['guaranteed renewal', 'lifelong renewal', 'renewable for life']),
  F('cancellation_refund', 'renewal_premium', 'terms', 5, 'Cancellation after the free look period refunds premium on a short-period scale.', 'refunds premium on a (short-period scale)', ['cancellation refund', 'cancel mid-term', 'refund after free look', 'cancel the policy']),
  F('rate_notice_days', 'renewal_premium', 'terms', 5, 'The insurer gives 90 days notice of any change in premium rates.', 'gives (\\d+) days notice of any change in premium rates', ['premium change notice', 'rate change notice', 'notice of rate', 'premium increase notice']),
  F('portability_days', 'renewal_premium', 'terms', 5, 'Portability: apply to the new insurer at least 45 days before the renewal date.', 'Portability: apply to the new insurer at least (\\d+) days', ['portability', 'port to another insurer', 'switch insurer']),
  F('grievance_days', 'claims_process', 'terms', 5, 'Grievances: contact the insurer grievance cell within 30 days of the event.', 'Grievances: contact the insurer grievance cell within (\\d+) days', ['grievance cell', 'complaint window', 'raise a grievance', 'file a complaint']),
  F('grievance_reply', 'claims_process', 'terms', 5, 'The grievance cell replies within 7 days.', 'grievance cell replies within (\\d+) days', ['grievance reply', 'complaint response time', 'grievance response']),
  // Terms page 6: other conditions
  F('disclosure', 'claims_process', 'terms', 6, 'Non-disclosure of a material fact can lead to rejection of a claim.', '(Non-disclosure of a material fact can lead to rejection of a claim)', ['non-disclosure', 'hide a condition', 'misstatement', 'material fact']),
  F('room_rent_proportion', 'room_rent_sublimits', 'terms', 6, 'If the room rent is above the limit, other charges are reduced in the same proportion.', '(other charges are reduced in the same proportion)', ['proportionate deduction', 'room above the limit', 'higher room', 'costlier room']),
  F('entry_age_adult', 'renewal_premium', 'terms', 6, 'Entry age: 18 to 65 years for adults.', 'Entry age: (\\d+) to (\\d+) years for adults', ['entry age', 'maximum age', 'age limit']),
  F('entry_age_child', 'renewal_premium', 'terms', 6, 'Dependent children are covered from 91 days to 25 years of age.', 'covered from (\\d+) days to (\\d+) years', ['dependent children', 'child age', 'children covered']),
]);

export const SYNTHETIC_CATEGORIES = Object.freeze(['sum_insured_limits', 'waiting_periods', 'exclusions', 'copay_deductible', 'room_rent_sublimits', 'renewal_premium', 'claims_process', 'definitions']);

/** OCR-shaped stored pages per document: [{ page, status, blocks }], the shape buildClauses expects. */
export function syntheticStoredPages(documentKind) {
  const doc = SYNTHETIC_DOCUMENTS.find(entry => entry.documentKind === documentKind);
  const pages = [...new Set(SYNTHETIC_FACTS.filter(fact => fact.documentKind === documentKind).map(fact => fact.page))].sort((a, b) => a - b);
  return {
    pages: pages.map(page => ({
      page, status: 'stored',
      blocks: [
        ...(page === pages[0] ? [{ text: `Zephyr Mutual Health (synthetic): ${doc.title}`, tag: 'headline' }] : []),
        ...SYNTHETIC_FACTS.filter(fact => fact.documentKind === documentKind && fact.page === page).map(fact => ({ text: fact.line, tag: 'paragraph' })),
        { text: `Page ${page}`, tag: 'page-number' },
      ],
    })),
  };
}
