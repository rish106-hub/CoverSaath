// question-catalogue/v1: 13 starter questions (12 plus the B6 portability question). Tap first, short plain English. All wording is FOR LEGAL REVIEW.
// hi is null on purpose: TODO human translation (never machine translated).
//
// Fact-key mapping (map, do not invent): declared_ped (scopeKey any | conditions | started_on), declared_prior_claims and
// declared_other_cover reuse registry keys. The user's profile answers map by profileKey: city -> home_city, has_employer_cover ->
// declared_employer_cover, covered_people -> member_covered. member_covered, member_relationship, declared_employer_cover,
// home_city, prior_cover_years, preference_cashless, preference_language, purchase_channel are proposed registry appends (PROPOSED_FACT_KEYS).
import { assertCatalogue, DATE_PRESET_IDS, NOT_SURE, OTHER } from '../../contracts/question-catalogue.js';

const t = en => Object.freeze({ en, hi: null });
const opt = (id, en) => Object.freeze({ id, label: t(en) });
const NS = opt(NOT_SURE, 'Not sure');
const YES_NO = Object.freeze([opt('yes', 'Yes'), opt('no', 'No'), NS]);
const DATES = Object.freeze([
  opt('this_year', 'This year'), opt('last_year', 'Last year'), opt('two_to_four_years', '2 to 4 years ago'), opt('longer', 'Longer ago'), NS,
]);

const q = (id, slot, prompt, why, input, extra) => Object.freeze({
  id, slot: Object.freeze(slot), prompt: t(prompt), why: t(why), input: Object.freeze(input),
  followups: Object.freeze(extra.followups ?? {}), perMember: extra.perMember, sensitivity: extra.sensitivity ?? 'none', phase: extra.phase ?? 'strip',
  requiredInputOf: Object.freeze(extra.requiredInputOf ?? []),
  coverageRelevant: extra.coverageRelevant === true,
  valueOfInformation: Object.freeze({ unlocksTiles: Object.freeze(extra.tiles), weight: extra.weight }),
  legalReview: 'pending',
});

export const CATALOGUE_V1 = assertCatalogue(Object.freeze([
  q('members.confirm', { factKey: 'member_covered', memberScope: 'dependent', profileKey: 'covered_people' },
    'Is this person covered under this policy?', 'We show cover for each person on the policy.',
    { kind: 'yes_no_unsure', options: YES_NO }, { phase: 'before_card', perMember: true, coverageRelevant: true, tiles: ['sum_insured', 'waiting_periods'], weight: 0.95 }),
  q('members.relationship', { factKey: 'member_relationship', memberScope: 'dependent' },
    'How is this person related to you?', 'Some rules depend on the relationship.',
    { kind: 'single_choice', options: [opt('self', 'Myself'), opt('spouse', 'Spouse'), opt('child', 'Child'), opt('parent', 'Parent'), opt(OTHER, 'Someone else'), NS] },
    { phase: 'before_card', perMember: true, coverageRelevant: true, tiles: ['sum_insured'], weight: 0.6 }),
  q('ped.has_any', { factKey: 'declared_ped', scopeKey: 'any', memberScope: 'dependent' },
    'When you bought this policy, did you tell the insurer about any illness this person had?', 'Illnesses you told them about have their own waiting period.',
    { kind: 'yes_no_unsure', options: YES_NO }, { phase: 'before_card', perMember: true, sensitivity: 'health', coverageRelevant: true, tiles: ['waiting_periods', 'exclusions'], weight: 0.9, followups: { yes: ['ped.which_conditions'] } }),
  q('ped.which_conditions', { factKey: 'declared_ped', scopeKey: 'conditions', memberScope: 'dependent' },
    'Which illnesses did you tell them about?', 'Each illness can have a different waiting period.',
    { kind: 'multi_choice_chips', options: [opt('diabetes', 'Diabetes'), opt('high_bp', 'High blood pressure'), opt('thyroid', 'Thyroid'), opt('heart', 'Heart'), opt('asthma', 'Asthma'), opt(OTHER, 'Other')] },
    { phase: 'before_card', perMember: true, sensitivity: 'health', coverageRelevant: true, tiles: ['waiting_periods', 'exclusions'], weight: 0.8, followups: { '*': ['ped.started_on'] } }),
  q('ped.started_on', { factKey: 'declared_ped', scopeKey: 'started_on', memberScope: 'dependent' },
    'When did it start?', 'The waiting period counts from the start of the policy, so timing matters.',
    { kind: 'date_presets', options: DATES }, { phase: 'before_card', perMember: true, sensitivity: 'health', coverageRelevant: true, tiles: ['waiting_periods'], weight: 0.6 }),
  q('claims.prior_4y', { factKey: 'declared_prior_claims', memberScope: 'dependent' },
    'Has this person made a health claim in the last 4 years?', 'Past claims can change how new claims are read.',
    { kind: 'yes_no_unsure', options: YES_NO }, { perMember: true, sensitivity: 'health', coverageRelevant: true, tiles: ['sum_insured', 'copay_deductible'], weight: 0.55 }),
  q('cover.other_health', { factKey: 'declared_other_cover', memberScope: 'household' },
    'Do you have any other health cover?', 'Other cover can pay first or share a claim.',
    { kind: 'yes_no_unsure', options: YES_NO }, { sensitivity: 'money', perMember: false, tiles: ['sum_insured', 'copay_deductible'], weight: 0.5 }),
  q('cover.employer', { factKey: 'declared_employer_cover', memberScope: 'household', profileKey: 'has_employer_cover' },
    'Does your employer give you health cover?', 'Employer cover usually ends when the job ends.',
    { kind: 'yes_no_unsure', options: YES_NO }, { sensitivity: 'money', perMember: false, tiles: ['sum_insured'], weight: 0.45 }),
  q('portability.prior_cover_years', { factKey: 'prior_cover_years', memberScope: 'policyholder' },
    'Did you move from another insurer? When did you first get health cover?', 'Time on earlier cover can count toward waiting periods.',
    { kind: 'date_presets', options: DATES },
    { perMember: false, sensitivity: 'money', tiles: ['waiting_periods'], requiredInputOf: ['waiting_periods'], weight: 0.8 }),
  q('home.city', { factKey: 'home_city', memberScope: 'household', profileKey: 'city' },
    'Which city do you live in?', 'We use it to find hospitals near you.',
    { kind: 'single_choice', options: [opt('delhi', 'Delhi'), opt('mumbai', 'Mumbai'), opt('bengaluru', 'Bengaluru'), opt('kolkata', 'Kolkata'), opt(OTHER, 'Another city'), NS] },
    { perMember: false, tiles: ['cashless'], weight: 0.7 }),
  q('pref.cashless', { factKey: 'preference_cashless', memberScope: 'household' },
    'In a hospital stay, what matters more to you?', 'It decides which steps we show first.',
    { kind: 'single_choice', options: [opt('cashless_always', 'No upfront payment'), opt('reimburse_ok', 'I can pay and claim later'), opt('depends', 'Depends on the hospital'), NS].filter(Boolean) },
    { perMember: false, tiles: ['cashless'], weight: 0.35 }),
  q('pref.language', { factKey: 'preference_language', memberScope: 'household' },
    'Which language do you prefer?', 'We show answers in that language.',
    { kind: 'single_choice', options: [opt('en', 'English'), opt('hi', 'Hindi'), opt('hinglish', 'Hinglish'), NS] },
    { perMember: false, tiles: [], weight: 0.3 }),
  q('purchase.channel', { factKey: 'purchase_channel', memberScope: 'policy' },
    'How did you buy this policy?', 'It tells us who to contact about the policy.',
    { kind: 'single_choice', options: [opt('agent', 'Through an agent'), opt('online', 'Online'), opt('bank', 'Through a bank'), opt('employer', 'Through my employer'), NS] },
    { perMember: false, tiles: [], weight: 0.25 }),
]));

export { DATE_PRESET_IDS };
