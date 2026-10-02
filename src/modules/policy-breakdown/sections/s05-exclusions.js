import { defineSection } from '../contracts.js';

const EXCLUSION_CODE = /^Excl\d{2}$/;

const ruleParameter = ({ key, label, description, hints, effects = ['exclude'], critical = false }) => ({
  key,
  label,
  description,
  valueType: 'rule',
  effects,
  bases: ['per_claim', 'per_policy', 'not_applicable'],
  critical,
  visibility: 'cover',
  memberScoped: false,
  extractionHints: hints,
  emergencyCard: false,
  estimateInput: false,
});

const expertise = `
SECTION 5 — EXCLUSIONS AND DISCLOSURE. Question: what is carved out of cover, and what can unwind cover?
You extract only what this policy's own documents say. Waiting-period durations belong to Section 3 and money
limits belong to Section 6; do not report those numbers here. You own the exclusion list, exclusion definitions,
the pre-existing disease definition, and the disclosure, misrepresentation, moratorium-contestability and fraud
clauses.

WHERE IT APPEARS
- Policy wording: a section titled "Exclusions", "What is not covered", "General Exclusions", "Standard
  Exclusions", "Specific Exclusions" or "Permanent Exclusions". Disclosure and fraud are usually under
  "General Terms and Clauses", "Disclosure of Information", "Duty of Disclosure", "Material Facts",
  "Moratorium Period", "Fraud" or "Misrepresentation". The PED definition is in the Definitions section.
- Customer Information Sheet (CIS): summarises exclusions in plain language; prefer the wording's exact clause
  when both exist, and quote the wording.
- Policy schedule or endorsements: may list member-specific permanent exclusions accepted at underwriting
  ("Special conditions", "Endorsement", "Permanent exclusion for <condition> for <member>").

IRDAI STANDARDISED EXCLUSIONS
Many Indian health wordings use standardised exclusion text with codes Excl01 to Excl18 (typical titles: Excl01
Pre-Existing Diseases; Excl02 Specified disease/procedure waiting period; Excl03 30-day waiting period; Excl04
Investigation & Evaluation; Excl05 Rest Cure, rehabilitation and respite care; Excl06 Obesity/Weight Control;
Excl07 Change-of-Gender treatments; Excl08 Cosmetic or plastic Surgery; Excl09 Hazardous or Adventure sports;
Excl10 Breach of law; Excl11 Excluded Providers; Excl12 Alcoholism, drug or substance abuse; Excl13 health
hydros, nature cure clinics, spas; Excl14 Dietary supplements; Excl15 Refractive Error; Excl16 Unproven
Treatments; Excl17 Sterility and Infertility; Excl18 Maternity). This list is only a reading aid. Rules:
- Report a code ONLY if that exact code is printed in this document. Never assign a code to an uncoded
  exclusion, never renumber, and never add an exclusion because "standard policies have it".
- Insurers may print the standard text without codes, use their own numbering, or omit some items. Report what
  is printed. Uncoded or insurer-specific exclusions (war, nuclear, treatment outside India, external durable
  equipment, etc.) go in other_exclusions, not standard_exclusions.
- standard_exclusions items: "<code> <title as printed>" when coded, otherwise the printed title.
- Excl01–Excl03 only point to waiting periods; list them as exclusions but leave the durations to Section 3.

TRAPS
- Exceptions inside an exclusion are part of the answer. Put them in exceptions[]: e.g. cosmetic surgery
  allowed for reconstruction after accident, burns or cancer; bariatric surgery allowed when every listed BMI
  and age condition is met; refractive error excluded only below a dioptre threshold; maternity exclusion
  overridden "to the extent cover is available" under a maternity benefit; excluded providers payable up to
  stabilisation in an emergency. Do not report such an exclusion as absolute.
- Hazardous sports exclusions often apply only to participation "as a professional". Keep that qualifier.
- Do not infer one exclusion from another. A breach-of-law exclusion is not a self-harm or suicide
  exclusion; a substance-abuse exclusion is not a self-harm exclusion. If self-inflicted injury or attempted
  suicide is not named, exclusion_self_harm is found=false.
- PED definition: record the look-back exactly as printed (commonly diagnosed, or advice/treatment
  recommended or received, within 36 or 48 months before commencement). Do not substitute a regulatory number.
- Permanent exclusions: only report conditions the document names as permanently excluded (generic
  permanent-exclusion clauses or member-specific underwriting endorsements). A declared pre-existing condition
  that is subject to a waiting period is NOT a permanent exclusion. A member-specific permanent exclusion is
  protected health information: set memberScope to the member's name exactly as printed.
- Disclosure at renewal: many wordings say new illnesses contracted after inception need NOT be declared at
  renewal, while a change of occupation must be. Report disclosure_at_renewal_required for health conditions,
  and place any non-health renewal disclosure (occupation) in conditions[].
- Non-disclosure consequence: record the stated consequence (policy void, premium forfeited, claim rejected,
  cancellation) and any definition of "material fact". Record any moratorium interaction only as the wording
  states it (e.g. not contestable after N continuous months except for established fraud). Do not decide
  whether the moratorium has been served; that is Section 3 and later analysis.
- Fraud clause: record forfeiture of benefits/premium and any repayment obligation exactly as written.

OUTPUT DISCIPLINE
- Quote verbatim from the page text, with exact spelling, punctuation and spacing. Never paraphrase in a quote.
- Never infer a value from general knowledge, regulation, IRDAI guidelines or another policy. If this document
  is silent, answer found=false with all values null and empty lists.
- Never fill a value from another policy or another member's document.
- Report each distinct value once. If two clauses give different values for the same key, report both as
  separate items with their own quotes; do not merge or choose.
- Use memberScope only when a value applies to a named member alone; otherwise null.
- Describe what the document says. Do not advise, recommend, judge fairness, or suggest how a claim or
  proposal should be handled. Never suggest omitting or reframing any health history.
`.trim();

export default defineSection({
  number: 5,
  id: 'section-05-exclusions',
  title: 'Exclusions and disclosure',
  question: 'What is carved out, and what can unwind cover?',
  kind: 'extraction',
  expertise,
  parameters: [
    {
      key: 'standard_exclusions',
      label: 'Standard exclusions',
      description: 'Every exclusion in the standard/general exclusions list, one item per exclusion, as "<code> <title>" when a code is printed (e.g. "Excl04 Investigation & Evaluation"), else the printed title. Do not add codes that are not printed. Exceptions within an item go in exceptions[].',
      valueType: 'text_list',
      effects: ['exclude'],
      bases: ['per_claim', 'per_policy', 'not_applicable'],
      critical: true,
      visibility: 'cover',
      memberScoped: false,
      extractionHints: ['Standard Exclusions', 'General Exclusions', 'What is not covered', 'Excl01', 'The Company shall not be liable to make any payment'],
      emergencyCard: false,
      estimateInput: false,
      validate: value => (value.items.length > 60 ? 'too_many_exclusions' : null),
    },
    {
      key: 'standard_exclusion_codes',
      label: 'Regulator exclusion codes printed',
      description: 'The exclusion codes exactly as printed in the document (e.g. Excl01). Only codes that literally appear; empty means found=false.',
      valueType: 'text_list',
      effects: ['exclude'],
      bases: ['not_applicable'],
      critical: false,
      visibility: 'cover',
      memberScoped: false,
      extractionHints: ['Excl01', 'Excl18', 'code assigned', 'standardised exclusion'],
      emergencyCard: false,
      estimateInput: false,
      validate: value => (value.items.every(item => EXCLUSION_CODE.test(item)) ? null : 'exclusion_code_must_look_like_ExclNN'),
    },
    {
      key: 'other_exclusions',
      label: 'Other (uncoded / insurer-specific) exclusions',
      description: 'Exclusions printed outside the coded standard list, such as war, nuclear, treatment outside India, external durable equipment. Short title per item.',
      valueType: 'text_list',
      effects: ['exclude'],
      bases: ['per_claim', 'per_policy', 'not_applicable'],
      critical: false,
      visibility: 'cover',
      memberScoped: false,
      extractionHints: ['Specific Exclusions', 'Other Exclusions', 'In addition to the Standard Exclusions', 'war, invasion', 'nuclear'],
      emergencyCard: false,
      estimateInput: false,
    },
    {
      key: 'permanent_exclusions',
      label: 'Permanent exclusions',
      description: 'Conditions the document names as permanently excluded, either generic permanent exclusions or member-specific conditions accepted at underwriting via endorsement. A PED subject to a waiting period is not a permanent exclusion. Use memberScope for member-specific items.',
      valueType: 'text_list',
      effects: ['exclude'],
      bases: ['per_person', 'per_policy', 'not_applicable'],
      critical: false,
      visibility: 'protected',
      memberScoped: true,
      extractionHints: ['Permanent Exclusion', 'Special Conditions', 'Endorsement', 'permanently excluded', 'excluded for the lifetime of the policy'],
      emergencyCard: false,
      estimateInput: false,
    },
    {
      key: 'ped_definition',
      label: 'Pre-existing disease definition',
      description: 'The PED definition as printed: the look-back period in months and the triggers (diagnosed; medical advice or treatment recommended or received). Put the look-back number in valueNumber with unit "months" if stated.',
      valueType: 'rule',
      effects: ['wait_until', 'exclude'],
      bases: ['per_person', 'not_applicable'],
      critical: false,
      visibility: 'cover',
      memberScoped: false,
      extractionHints: ['Pre-Existing Disease means', 'diagnosed by a physician', 'months prior to the date of commencement', 'medical advice or treatment was recommended'],
      emergencyCard: false,
      estimateInput: false,
    },
    {
      key: 'investigation_only_admission_excluded',
      label: 'Investigation-only admission excluded',
      description: 'True when admission primarily for diagnostics/evaluation is excluded (e.g. Excl04).',
      valueType: 'boolean',
      effects: ['exclude'],
      bases: ['per_claim'],
      critical: false,
      visibility: 'cover',
      memberScoped: false,
      extractionHints: ['Investigation & Evaluation', 'primarily for diagnostics and evaluation', 'Excl04'],
      emergencyCard: false,
      estimateInput: false,
    },
    ruleParameter({
      key: 'exclusion_hazardous_sports',
      label: 'Hazardous or adventure sports exclusion',
      description: 'Exact scope of the hazardous/adventure sports exclusion, including qualifiers such as "as a professional" and the listed activities.',
      hints: ['Hazardous or Adventure sports', 'Excl09', 'para-jumping', 'as a professional'],
    }),
    ruleParameter({
      key: 'exclusion_substance_abuse',
      label: 'Alcohol, drug and substance abuse exclusion',
      description: 'Exact wording of the alcoholism / drug / substance abuse / addictive condition exclusion.',
      hints: ['Alcoholism', 'drug or substance abuse', 'addictive condition', 'Excl12'],
    }),
    ruleParameter({
      key: 'exclusion_self_harm',
      label: 'Self-inflicted injury / attempted suicide exclusion',
      description: 'Only when the document explicitly names self-inflicted injury, self-harm or attempted suicide. Never inferred from breach-of-law or substance exclusions.',
      hints: ['self-inflicted', 'intentional self injury', 'attempted suicide', 'self-harm'],
    }),
    ruleParameter({
      key: 'exclusion_breach_of_law',
      label: 'Breach of law exclusion',
      description: 'Exact wording of the breach-of-law / criminal intent exclusion.',
      hints: ['Breach of law', 'criminal intent', 'Excl10'],
    }),
    ruleParameter({
      key: 'exclusion_cosmetic_surgery',
      label: 'Cosmetic or plastic surgery exclusion',
      description: 'Exclusion of cosmetic/plastic surgery, with every printed exception (reconstruction after accident, burns, cancer; medical necessity certification) in exceptions[].',
      hints: ['Cosmetic or plastic Surgery', 'change appearance', 'reconstruction following an Accident', 'Excl08'],
    }),
    ruleParameter({
      key: 'exclusion_unproven_treatment',
      label: 'Unproven / experimental treatment exclusion',
      description: 'Exclusion of unproven or experimental treatments and the printed definition of unproven.',
      hints: ['Unproven Treatments', 'experimental', 'lack significant medical documentation', 'Excl16'],
    }),
    ruleParameter({
      key: 'exclusion_sterility_infertility',
      label: 'Sterility and infertility exclusion',
      description: 'Exclusion of sterility, infertility, contraception, assisted reproduction, surrogacy, reversal of sterilisation, as printed.',
      hints: ['Sterility and Infertility', 'Assisted Reproduction', 'IVF', 'Excl17'],
    }),
    ruleParameter({
      key: 'exclusion_change_of_gender',
      label: 'Change-of-gender treatment exclusion',
      description: 'Exclusion of gender-affirming / change-of-gender treatment as printed, including any exception.',
      hints: ['Change-of-Gender', 'opposite sex', 'gender reassignment', 'Excl07'],
    }),
    ruleParameter({
      key: 'exclusion_obesity_treatment',
      label: 'Obesity / weight control exclusion',
      description: 'Obesity treatment exclusion and the conditions (age, BMI, co-morbidity, doctor advice) under which bariatric surgery is not excluded, as exceptions[].',
      hints: ['Obesity/Weight Control', 'Body Mass Index', 'bariatric', 'Excl06'],
    }),
    ruleParameter({
      key: 'exclusion_maternity',
      label: 'Maternity exclusion',
      description: 'Maternity / childbirth exclusion and any override where a maternity benefit applies. Limits and waiting periods belong to Sections 3 and 6.',
      hints: ['Maternity', 'childbirth', 'caesarean', 'Excl18', 'shall not apply to the extent cover is available'],
    }),
    ruleParameter({
      key: 'exclusion_refractive_error',
      label: 'Refractive error exclusion',
      description: 'Refractive error correction exclusion including the dioptre threshold (valueNumber with unit "dioptres" if printed).',
      hints: ['Refractive Error', 'dioptres', 'correction of eye sight', 'Excl15'],
    }),
    {
      key: 'disclosure_at_proposal_required',
      label: 'Health disclosure required at proposal',
      description: 'True when the proposer must disclose medical conditions/treatments of each proposed person in the proposal form.',
      valueType: 'boolean',
      effects: ['require'],
      bases: ['per_person', 'per_policy'],
      critical: false,
      visibility: 'cover',
      memberScoped: false,
      extractionHints: ['proposal form', 'Duty of Disclosure', 'shall disclose', 'declarations'],
      emergencyCard: false,
      estimateInput: false,
    },
    {
      key: 'disclosure_at_renewal_required',
      label: 'New conditions must be disclosed at renewal',
      description: 'Whether illnesses or conditions arising after inception must be declared at renewal. Non-health renewal disclosures (e.g. occupation change) go in conditions[].',
      valueType: 'boolean',
      effects: ['require', 'inform'],
      bases: ['per_policy', 'per_person'],
      critical: false,
      visibility: 'cover',
      memberScoped: false,
      extractionHints: ['Disclosure at Renewal', 'not required to disclose at renewal', 'change in occupation', 'renewal proposal'],
      emergencyCard: false,
      estimateInput: false,
    },
    ruleParameter({
      key: 'non_disclosure_consequence',
      label: 'Consequence of non-disclosure or misrepresentation',
      description: 'Stated consequence of misrepresentation, mis-description or non-disclosure of material facts (void, premium forfeited, claim rejected, cancellation), plus the printed definition of material facts.',
      hints: ['Disclosure of Information', 'shall be void', 'non-disclosure of any material fact', 'Material facts', 'misrepresentation'],
      effects: ['void', 'exclude'],
      critical: true,
    }),
    ruleParameter({
      key: 'moratorium_contestability_rule',
      label: 'Moratorium protection against non-disclosure',
      description: 'What the moratorium clause says about contesting a policy or claim for non-disclosure/misrepresentation after the period, and its carve-outs (e.g. established fraud, enhanced sum insured). The duration itself is stored by Section 3.',
      hints: ['Moratorium Period', 'shall be contestable', 'except on grounds of established fraud', 'enhanced limits'],
      effects: ['inform', 'void'],
    }),
    ruleParameter({
      key: 'fraud_clause',
      label: 'Fraud clause',
      description: 'Consequence of a fraudulent claim or false statement: forfeiture of benefits/premium, repayment liability, and who is liable.',
      hints: ['Fraud', 'fraudulent', 'false statement', 'shall be forfeited', 'jointly and severally liable'],
      effects: ['void', 'require'],
    }),
  ],
  reviewGuidance: [
    'standard_exclusions: compare item by item against the printed exclusion list; confirm no code was added that the document does not print and no uncoded exclusion was placed in this list; confirm exceptions (accident/burn/cancer reconstruction, bariatric criteria, maternity benefit override, stabilisation in excluded providers) are recorded rather than dropped.',
    'non_disclosure_consequence: confirm the consequence (void, forfeiture, rejection) and the material-fact definition are quoted from this policy, and that any moratorium carve-out is taken from the moratorium clause rather than assumed.',
    'permanent_exclusions: confirm any member-specific item comes from a schedule or endorsement for that member, is scoped to that member, stays protected, and that a PED with a waiting period was not mislabelled as permanent.',
  ].join('\n'),
});
