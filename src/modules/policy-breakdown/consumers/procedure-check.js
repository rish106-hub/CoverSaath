import { ageOn, countOf, dateOf, enumOf, fieldView, flagOf, limitStatus, listOf, normalisePersonName, textOf, usable } from './record-values.js';

// Planned-procedure eligibility checklist. Deterministic. Reads only the stored record and the request.
// Each check reports what the record says about one criterion for this member, this treatment, this date
// and this hospital. It never approves or rejects a claim: the strongest outcome is `not_met`, meaning the
// record itself states a blocker, and every outcome cites the parameters it read.
//
// Outcomes: met | not_met | attention (a person must confirm something) | unknown (the record does not
// establish the criterion) | not_applicable.

const DAY_MS = 86_400_000;
const isoDay = value => new Date(`${value}T00:00:00Z`);
const toIso = date => date.toISOString().slice(0, 10);
const addDays = (iso, days) => toIso(new Date(isoDay(iso).getTime() + days * DAY_MS));
function addMonths(iso, months) {
  const date = isoDay(iso);
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(date.getUTCDate(), lastDay));
  return toIso(target);
}
const words = text => String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const nameKey = normalisePersonName;

/** True when a list item and the condition name share a meaningful word (four letters or more). */
function mentions(items, conditionName) {
  const condition = new Set(words(conditionName).split(' ').filter(word => word.length >= 4));
  if (!condition.size) return [];
  return (items ?? []).filter(item => words(item).split(' ').some(word => word.length >= 4 && condition.has(word)));
}

const PROCEDURE_COVER = {
  day_care: ['daycare_covered', 'Day-care treatment'],
  modern_treatment: ['modern_treatments_covered', 'Modern and advanced treatment'],
  ayush: ['ayush_covered', 'AYUSH treatment'],
  domiciliary: ['domiciliary_covered', 'Domiciliary hospitalisation'],
  organ_donor: ['organ_donor_covered', 'Organ donor expenses'],
  mental_illness: ['mental_illness_covered', 'Mental illness treatment'],
  bariatric: ['bariatric_covered', 'Bariatric surgery'],
  maternity_normal: ['maternity_covered', 'Maternity'],
  maternity_csection: ['maternity_covered', 'Maternity'],
};
const PROCEDURE_CONDITIONS = {
  ayush: 'ayush_conditions', domiciliary: 'domiciliary_conditions', mental_illness: 'mental_illness_conditions',
  bariatric: 'bariatric_conditions', maternity_normal: 'maternity_conditions', maternity_csection: 'maternity_conditions',
  modern_treatment: 'modern_treatment_conditions',
};
const PROCEDURE_EXCLUSIONS = {
  bariatric: ['exclusion_obesity_treatment'],
  maternity_normal: ['exclusion_maternity'],
  maternity_csection: ['exclusion_maternity'],
};
// Named exclusion clauses whose wording is matched against the condition name.
const EXCLUSION_CLAUSES = [
  'exclusion_hazardous_sports', 'exclusion_substance_abuse', 'exclusion_self_harm', 'exclusion_breach_of_law',
  'exclusion_cosmetic_surgery', 'exclusion_unproven_treatment', 'exclusion_sterility_infertility',
  'exclusion_change_of_gender', 'exclusion_obesity_treatment', 'exclusion_maternity', 'exclusion_refractive_error',
];
const COVERAGE_CHECKS = new Set([
  'policy_in_force', 'member_insured', 'member_cover_started', 'dependent_child_age',
  'initial_wait', 'ped_wait', 'specified_disease_wait', 'specified_disease_wait_variations', 'maternity_wait', 'disclosure',
  'treatment_covered', 'daycare_list', 'domiciliary_minimum', 'domiciliary_excluded', 'organ_donor_scope',
  'modern_treatment_list', 'maternity_deliveries', 'minimum_stay', 'add_ons_and_endorsements', 'exclusions',
  'geography', 'excluded_hospital',
]);
const OPERATIONAL_CHECKS = new Set(['cashless_route', 'preauth_timing']);
const decisionClass = id => COVERAGE_CHECKS.has(id) || id.startsWith('exclusion:') ? 'coverage' : OPERATIONAL_CHECKS.has(id) ? 'operational' : 'advisory';

export function checkPlannedProcedure({ parameters, request, member = null, asOf }) {
  const checks = [];
  const read = new Set();
  const view = key => { read.add(key); return fieldView(parameters, key); };
  const evidence = keys => keys.filter(key => parameters[key]).map(key => ({ key, evidenceState: parameters[key].evidenceState }));
  const add = (id, label, outcome, message, keys = [], extra = {}) => {
    keys.forEach(key => read.add(key));
    checks.push({ id, label, outcome, message, decisionClass: decisionClass(id), parameterKeys: keys, evidence: evidence(keys), ...extra });
  };
  const ruleText = key => { read.add(key); return textOf(parameters, key); };
  const admission = request.admissionDate ?? asOf;

  // 1. Policy in force on the admission date (sections 3 and 9).
  {
    const start = dateOf(parameters, 'policy_start_date');
    const end = dateOf(parameters, 'policy_end_date');
    const keys = ['policy_start_date', 'policy_end_date'];
    if (!start || !end) add('policy_in_force', 'Policy in force on the admission date', 'unknown', 'The policy period is not established in this record.', keys);
    else if (admission < start) add('policy_in_force', 'Policy in force on the admission date', 'not_met', `The admission date ${admission} is before the policy starts on ${start}.`, keys);
    else if (admission <= end) add('policy_in_force', 'Policy in force on the admission date', 'met', `The admission date ${admission} falls inside the policy period ${start} to ${end}.`, keys);
    else {
      const grace = countOf(parameters, 'grace_period_days');
      const graceCover = enumOf(parameters, 'grace_period_cover');
      const graceKeys = [...keys, 'grace_period_days', 'grace_period_cover', 'lifelong_renewal', 'instalment_lapse_consequence'];
      if (grace != null && admission <= addDays(end, grace)) {
        add('policy_in_force', 'Policy in force on the admission date', graceCover === 'covered' ? 'attention' : 'not_met',
          `The policy period ended on ${end}. The admission falls in the ${grace}-day grace period, ${graceCover === 'covered' ? 'which the wording says is covered once the renewal premium is paid' : graceCover === 'not_covered' ? 'and the wording says there is no cover during the grace period' : 'and the record does not establish whether the grace period is covered'}. Renew before admission.`, graceKeys);
      } else add('policy_in_force', 'Policy in force on the admission date', 'not_met', `The policy period ended on ${end}${grace != null ? ` and the ${grace}-day grace period has passed` : ''}. Renew before relying on this record.`, graceKeys);
    }
  }

  // 2. Member named on the policy, cover started, still eligible (section 2).
  const memberStart = member ? dateOf(parameters, 'member_effective_date') : null;
  if (member) {
    const insured = listOf(parameters, 'insured_members');
    const named = insured ? insured.some(item => nameKey(item) === nameKey(member.displayName)) : null;
    if (named === null) add('member_insured', 'Member named on the policy', 'unknown', 'The insured members list is not established in this record.', ['insured_members']);
    else if (!named) add('member_insured', 'Member named on the policy', 'not_met', `${member.displayName} is not in the insured members list of this record. Check the spelling against the certificate.`, ['insured_members']);
    else add('member_insured', 'Member named on the policy', 'met', `${member.displayName} is named in the insured members list.`, ['insured_members']);
    if (memberStart && admission < memberStart) add('member_cover_started', 'Member cover started', 'not_met', `Cover for ${member.displayName} starts on ${memberStart}, after the admission date.`, ['member_effective_date', 'member_cover_start_dates']);
    else if (memberStart) add('member_cover_started', 'Member cover started', 'met', `Cover for ${member.displayName} started on ${memberStart}.`, ['member_effective_date', 'member_cover_start_dates']);
    const policyBirthDate = dateOf(parameters, 'member_date_of_birth');
    if (policyBirthDate && member.dateOfBirth && policyBirthDate !== member.dateOfBirth) add('member_birth_date', 'Date of birth matches the policy', 'attention', `The policy records a different date of birth for ${member.displayName} than the household profile. A mismatch can delay a claim; correct whichever is wrong.`, ['member_date_of_birth']);
    const age = ageOn(member.dateOfBirth ?? null, admission);
    const childMax = countOf(parameters, 'dependent_child_max_age_years');
    const isChild = /\b(son|daughter|child)\b/i.test(member.relationship ?? '');
    if (isChild && age != null && childMax != null && age > childMax) {
      add('dependent_child_age', 'Dependent child age limit', 'attention', `${member.displayName} is ${age}, above the dependent child limit of ${childMax}. Check whether cover continued under the exit rule.`, ['dependent_child_max_age_years', 'dependent_child_exit_rule', 'dependent_child_conditions']);
    }
  } else {
    add('member_insured', 'Member named on the policy', 'attention', 'No household member was chosen, so member eligibility, member-specific limits and age co-pay were not checked.', ['insured_members']);
  }

  // 3. Waiting periods (section 3). The wait counts from the start basis the wording states; when it is not
  // established, the check uses the latest candidate start (worst case) and says so.
  const firstInception = dateOf(parameters, 'first_inception_date');
  const periodStart = dateOf(parameters, 'policy_start_date');
  const basis = enumOf(parameters, 'waiting_period_start_basis');
  const basisCandidates = basis === 'current_period_start' ? [periodStart]
    : basis === 'policy_first_inception' ? [firstInception ?? periodStart]
      : basis === 'member_first_inception' ? (memberStart ? [memberStart] : [firstInception, periodStart])
        : [memberStart, firstInception, periodStart];
  // A member cannot serve a wait before their own cover exists. Even when the wording counts from a policy-level
  // date, a later Proven/Calculated member effective date is the safe controlling start for that member.
  const candidates = memberStart ? [...basisCandidates, memberStart] : basisCandidates;
  const starts = candidates.filter(Boolean).sort();
  const waitStart = starts.at(-1) ?? null;
  const earliestStart = starts[0] ?? null;
  // The start is inferred when the basis is not stated, or is per member but no member date is known.
  // The wording counts from first inception but that date is not established: this period's start is the latest
  // possible start, and an earlier inception (renewals, portability) can only shorten the wait, so never not_met.
  const inceptionMissing = basis === 'policy_first_inception' && !firstInception;
  const startInferred = !basis || basis === 'not_stated' || (basis === 'member_first_inception' && !memberStart) || inceptionMissing;
  const startKeys = ['waiting_period_start_basis', 'first_inception_date', 'member_effective_date', 'policy_start_date', 'continuity_credit_rule', 'waiting_period_buydown_rule', 'waiting_reset_on_si_enhancement'];
  const startNote = !startInferred ? ''
    : inceptionMissing
      ? ` The wording counts from the first policy inception date, which is not established, so this policy period's start (${waitStart}) was used; if cover began earlier with this insurer, the wait ends sooner.`
      : ` The start ${basis === 'member_first_inception' ? 'is each member\'s own cover date, which is not known here' : 'basis is not stated'}, so the latest possible start (${waitStart}) was used; portability or continuity credit may shorten it.`;
  const waitCheck = ({ id, label, key, unit, applies, appliesQuestion }) => {
    const keys = [key, ...startKeys];
    if (applies === false) { add(id, label, 'not_applicable', `${label} does not apply to this treatment as described.`, [key]); return; }
    const status = limitStatus(parameters, key);
    if (status === 'withheld') { add(id, label, 'unknown', `${label} is withheld by permission.`, keys); return; }
    if (status === 'absent') { add(id, label, applies ? 'met' : 'attention', `${label}: a person confirmed the policy does not state one.`, keys); return; }
    if (status === 'not_stated') {
      add(id, label, applies === true ? 'unknown' : 'attention', `${label}: the uploaded source pack does not state one. Check the controlling policy wording before treating it as absent.`, keys);
      return;
    }
    if (status !== 'value') { add(id, label, 'unknown', `${label} is not established in this record.`, keys); return; }
    const length = countOf(parameters, key);
    if (!waitStart) { add(id, label, 'unknown', `${label} is ${length} ${unit}, but no cover start date is established.`, keys); return; }
    const ends = unit === 'days' ? addDays(waitStart, length) : addMonths(waitStart, length);
    const over = admission >= ends;
    // When the start is inferred and the earliest possible start would end the wait, it is not a stated blocker.
    const overFromEarliest = earliestStart ? admission >= (unit === 'days' ? addDays(earliestStart, length) : addMonths(earliestStart, length)) : over;
    if (applies === true && !over && startInferred && (overFromEarliest || inceptionMissing)) { add(id, label, 'attention', `${label} of ${length} ${unit} may run until ${ends}, depending on when cover is counted from.${startNote}`, keys, { waitEnds: ends }); return; }
    if (applies === null) { add(id, label, over ? 'met' : 'attention', `${label} of ${length} ${unit} ${over ? `ended on ${ends}` : `runs until ${ends}`}. ${appliesQuestion}${startNote}`, keys, { waitEnds: ends }); return; }
    add(id, label, over ? 'met' : 'not_met', `${label} of ${length} ${unit} counted from ${waitStart} ${over ? `ended on ${ends}` : `runs until ${ends}; the admission on ${admission} falls inside it`}.${startNote}`, keys, { waitEnds: ends });
  };
  const accident = request.condition.accident;
  const accidentExempt = flagOf(parameters, 'accident_exempt_from_initial_wait');
  waitCheck({ id: 'initial_wait', label: 'Initial waiting period', key: 'initial_waiting_period_days', unit: 'days',
    applies: accident && accidentExempt === true ? false : accident && accidentExempt === null ? null : true,
    appliesQuestion: 'Whether accidents are exempt is not established.' });
  if (accident) read.add('accident_exempt_from_initial_wait');
  waitCheck({ id: 'ped_wait', label: 'Pre-existing disease waiting period', key: 'ped_waiting_period_months', unit: 'months',
    // A person's "no" is useful Reported context but cannot prove the legal PED definition does not apply.
    applies: request.condition.preExisting === true ? true : null, appliesQuestion: 'Was this condition present, diagnosed, treated, advised on, or symptomatic before cover started? The insurer may verify medical and proposal records.' });
  const specifiedList = listOf(parameters, 'specified_disease_list');
  const listed = request.condition.name ? mentions(specifiedList, request.condition.name) : [];
  const procedureListed = ['cataract', 'joint_replacement'].includes(request.procedure) && specifiedList?.some(item => words(item).includes(request.procedure === 'cataract' ? 'cataract' : 'joint'));
  // A word match against the list is a hint for a person, never proof; only the person's answer or a procedure the
  // list names outright (cataract, joint replacement) makes the wait certain.
  // A user-supplied false cannot clear the policy's specified-disease list; only a positive match can establish applicability.
  const specifiedApplies = request.condition.specifiedDisease === true || procedureListed ? true : null;
  waitCheck({ id: 'specified_disease_wait', label: 'Specified disease waiting period', key: 'specified_disease_waiting_months', unit: 'months',
    applies: specifiedApplies, appliesQuestion: `${listed.length ? `The list mentions: ${listed.join(', ')}. ` : ''}Check whether this condition is in the specified list${specifiedList ? ` (${specifiedList.slice(0, 8).join(', ')}${specifiedList.length > 8 ? ', …' : ''})` : ''}.` });
  read.add('specified_disease_list');
  const variations = ruleText('specified_disease_wait_variations');
  if (variations && specifiedApplies !== false) add('specified_disease_wait_variations', 'Different waits for different conditions', 'attention', `The wording sets different specified-disease waits: "${variations}". Confirm which applies.`, ['specified_disease_wait_variations']);
  const relapse = countOf(parameters, 'relapse_window_days');
  if (relapse != null) add('relapse_window', 'Relapse within the same illness', 'attention', `A readmission within ${relapse} days of discharge is treated as the same illness (shared limits and waits).`, ['relapse_window_days']);
  const maternity = ['maternity_normal', 'maternity_csection'].includes(request.procedure);
  if (maternity) waitCheck({ id: 'maternity_wait', label: 'Maternity waiting period', key: 'maternity_waiting_period_months', unit: 'months', applies: true });
  if (request.condition.preExisting) {
    const moratorium = countOf(parameters, 'moratorium_period_months');
    add('disclosure', 'Disclosure of the pre-existing condition', 'attention', `A pre-existing condition must have been declared at proposal${flagOf(parameters, 'disclosure_at_renewal_required') ? ' and at renewal' : ''}. ${textOf(parameters, 'non_disclosure_consequence') ? `If not: "${textOf(parameters, 'non_disclosure_consequence')}".` : ''}${moratorium != null ? ` After ${moratorium} continuous months the claim is not contestable for non-disclosure except fraud.` : ''}`.trim(),
      ['disclosure_at_proposal_required', 'disclosure_at_renewal_required', 'non_disclosure_consequence', 'moratorium_period_months', 'moratorium_contestability_rule', 'ped_definition', 'declared_conditions', 'member_specific_conditions', 'underwriting_outcome', 'pre_policy_checkup_status', 'fraud_clause']);
  }

  // 4. Treatment covered (section 4).
  {
    const [coverKey, label] = PROCEDURE_COVER[request.procedure] ?? [];
    if (coverKey) {
      const status = limitStatus(parameters, coverKey);
      const flag = flagOf(parameters, coverKey);
      const conditionKey = PROCEDURE_CONDITIONS[request.procedure];
      const conditions = conditionKey ? ruleText(conditionKey) : null;
      const keys = [coverKey, ...(conditionKey ? [conditionKey] : [])];
      if (flag === true) add('treatment_covered', `${label} covered`, conditions ? 'attention' : 'met', `${label} is covered.${conditions ? ` Conditions: "${conditions}".` : ''}`, keys);
      else if (flag === false) add('treatment_covered', `${label} covered`, 'not_met', `The record states ${label.toLowerCase()} is not covered.`, keys);
      else add('treatment_covered', `${label} covered`, status === 'not_stated' || status === 'absent' ? 'attention' : 'unknown', `Whether ${label.toLowerCase()} is covered is not established in this record.`, keys);
    }
    if (request.procedure === 'day_care') {
      const listBasis = enumOf(parameters, 'daycare_list_basis');
      if (listBasis === 'listed') add('daycare_list', 'Day-care procedure on the insurer list', 'attention', `Only listed day-care procedures are covered${countOf(parameters, 'daycare_procedure_count') ? ` (${countOf(parameters, 'daycare_procedure_count')} listed)` : ''}. Confirm this procedure is on the list.`, ['daycare_list_basis', 'daycare_procedure_count']);
    }
    if (request.procedure === 'domiciliary') {
      const minimum = countOf(parameters, 'domiciliary_minimum_days');
      if (minimum != null) add('domiciliary_minimum', 'Domiciliary minimum duration', 'attention', `Domiciliary treatment must last at least ${minimum} days.`, ['domiciliary_minimum_days', 'domiciliary_excluded_conditions']);
      const excluded = mentions(listOf(parameters, 'domiciliary_excluded_conditions'), request.condition.name);
      if (excluded.length) add('domiciliary_excluded', 'Condition excluded from domiciliary cover', 'not_met', `Domiciliary cover excludes: ${excluded.join(', ')}.`, ['domiciliary_excluded_conditions']);
    }
    if (request.procedure === 'organ_donor') {
      const scope = enumOf(parameters, 'organ_donor_scope');
      if (scope) add('organ_donor_scope', 'Organ donor scope', 'attention', `Organ donor cover is ${scope.replaceAll('_', ' ')}.`, ['organ_donor_scope']);
    }
    if (request.procedure === 'modern_treatment') {
      const list = listOf(parameters, 'modern_treatment_list');
      if (list) add('modern_treatment_list', 'Modern treatment on the list', 'attention', `Covered modern treatments: ${list.join(', ')}. Confirm this treatment is one of them.`, ['modern_treatment_list']);
    }
    if (maternity) {
      const limit = countOf(parameters, 'maternity_delivery_count_limit') ?? countOf(parameters, 'maternity_max_deliveries');
      const keys = ['maternity_delivery_count_limit', 'maternity_max_deliveries', 'maternity_complications_covered', 'prenatal_postnatal_rule', 'newborn_treatment_covered', 'newborn_cover'];
      if (limit != null && request.previousDeliveries != null) add('maternity_deliveries', 'Maternity delivery count', request.previousDeliveries >= limit ? 'not_met' : 'met', `${request.previousDeliveries} earlier deliveries claimed; the limit is ${limit}.`, keys);
      else if (limit != null) add('maternity_deliveries', 'Maternity delivery count', 'attention', `Maternity is limited to ${limit} deliveries. Tell us how many were claimed before.`, keys);
    }
    // Minimum stay for in-patient claims (day care is exempt).
    if (!['day_care', 'domiciliary'].includes(request.procedure)) {
      const minimum = countOf(parameters, 'inpatient_minimum_hours');
      const keys = ['inpatient_minimum_hours', 'hospital_definition', 'medical_necessity_rule', 'investigation_only_admission_excluded'];
      if (minimum != null && request.stayHours != null) {
        // A shorter stay is still payable when the procedure is a listed day-care procedure.
        const daycare = flagOf(parameters, 'daycare_covered');
        const outcome = request.stayHours >= minimum ? 'met' : daycare === false ? 'not_met' : 'attention';
        add('minimum_stay', 'Minimum in-patient stay', outcome, outcome === 'met' ? `Planned stay ${request.stayHours} hours meets the ${minimum}-hour minimum.` : `Planned stay ${request.stayHours} hours is under the ${minimum}-hour minimum. It is payable only as ${daycare === false ? 'day care, which this record says is not covered' : 'a day-care procedure on the insurer\'s list; confirm it is listed'}.`, [...keys, 'daycare_covered', 'daycare_list_basis']);
      }
      else if (minimum != null) add('minimum_stay', 'Minimum in-patient stay', 'attention', `In-patient claims need at least ${minimum} hours of admission unless the procedure is a listed day-care procedure. Admission only for investigation is ${flagOf(parameters, 'investigation_only_admission_excluded') ? 'excluded' : 'not addressed in this record'}.`, keys);
    }
    const highCost = mentions(listOf(parameters, 'high_cost_treatments_covered'), request.condition.name);
    if (highCost.length) add('high_cost_treatment', 'Treatment named in the covered list', 'met', `The record names: ${highCost.join(', ')}.`, ['high_cost_treatments_covered']);
    const chronic = ruleText('chronic_condition_care_rule');
    if (chronic && request.condition.preExisting) add('chronic_care', 'Chronic condition programme', 'attention', `The policy has a chronic-condition rule: "${chronic}".`, ['chronic_condition_care_rule']);
  }

  {
    const expenses = listOf(parameters, 'inpatient_covered_expenses');
    if (expenses) add('covered_expense_heads', 'Expense heads the policy pays', 'met', `In-patient cover includes: ${expenses.join(', ')}.`, ['inpatient_covered_expenses']);
    if (flagOf(parameters, 'critical_illness_benefit_covered') && request.condition.name) {
      const conditions = ruleText('critical_illness_conditions');
      if (conditions && mentions([conditions], request.condition.name).length) add('critical_illness_benefit', 'Critical illness lump sum', 'attention', `A separate critical illness benefit may also be payable: "${conditions}".`, ['critical_illness_benefit_covered', 'critical_illness_conditions']);
    }
    const dental = ruleText('dental_vision_rule');
    if (dental && /\b(dental|tooth|teeth|eye|vision|spectacle|lens)\b/i.test(request.condition.name ?? '')) add('dental_vision', 'Dental and vision treatment', 'attention', `"${dental}"`, ['dental_vision_rule']);
    const addOns = listOf(parameters, 'add_on_covers');
    const endorsements = listOf(parameters, 'endorsement_list');
    if (addOns?.length || endorsements?.length) add('add_ons_and_endorsements', 'Add-ons and endorsements', 'attention', `${addOns?.length ? `Add-on covers: ${addOns.join(', ')}. ` : ''}${endorsements?.length ? `Endorsements: ${endorsements.join('; ')}. ` : ''}These can change the terms above; ${textOf(parameters, 'document_precedence') ? `the wording says: "${textOf(parameters, 'document_precedence')}"` : 'check which document takes precedence'}.`, ['add_on_covers', 'add_on_terms', 'endorsement_list', 'document_precedence', 'cis_precedence_statement']);
  }

  // 5. Exclusions (section 5). Matching is by words in the condition name; a match is a flag for a person.
  if (request.condition.name) {
    const keys = ['standard_exclusions', 'other_exclusions', 'permanent_exclusions', 'standard_exclusion_codes'];
    const matches = [
      ...mentions(listOf(parameters, 'standard_exclusions'), request.condition.name),
      ...mentions(listOf(parameters, 'other_exclusions'), request.condition.name),
      ...mentions(listOf(parameters, 'permanent_exclusions'), request.condition.name).map(item => `${item} (permanent exclusion for this member)`),
    ];
    for (const key of EXCLUSION_CLAUSES) {
      const text = ruleText(key);
      if (text && mentions([text], request.condition.name).length) matches.push(text);
    }
    if (matches.length) add('exclusions', 'Exclusions that may apply', 'attention', `The record lists exclusions that mention this condition: ${[...new Set(matches)].join('; ')}.`, [...keys, ...EXCLUSION_CLAUSES]);
    else if (listOf(parameters, 'standard_exclusions')) add('exclusions', 'Exclusions that may apply', 'met', 'No listed exclusion mentions this condition by name. Exclusions can use medical terms, so a person should still read them.', [...keys, ...EXCLUSION_CLAUSES]);
    else add('exclusions', 'Exclusions that may apply', 'unknown', 'The exclusions list is not established in this record.', keys);
  }
  for (const key of PROCEDURE_EXCLUSIONS[request.procedure] ?? []) {
    const text = ruleText(key);
    if (text) add(`exclusion:${key}`, parameters[key]?.label ?? key, 'attention', `"${text}"`, [key]);
  }

  // 6. Where: geography and hospital (sections 4 and 7).
  {
    const scope = enumOf(parameters, 'geographic_scope');
    if (request.abroad) {
      const abroadCovered = flagOf(parameters, 'treatment_abroad_covered');
      const conditions = ruleText('treatment_abroad_conditions');
      const keys = ['geographic_scope', 'treatment_abroad_covered', 'treatment_abroad_conditions'];
      if (scope === 'india_only' || abroadCovered === false) add('geography', 'Treatment outside India', 'not_met', 'The record limits cover to treatment in India.', keys);
      else if (abroadCovered === true || ['worldwide', 'worldwide_excluding_us_canada', 'worldwide_emergency_only', 'india_and_named_countries'].includes(scope)) add('geography', 'Treatment outside India', 'attention', `Treatment abroad is covered${scope ? ` (${scope.replaceAll('_', ' ')})` : ''}.${conditions ? ` Conditions: "${conditions}".` : ''}`, keys);
      else add('geography', 'Treatment outside India', 'unknown', 'Whether treatment abroad is covered is not established.', keys);
    } else if (scope) read.add('geographic_scope');

    const network = request.hospital.networkStatus;
    const keys = ['cashless_network_available', 'cashless_non_network_available', 'network_list_reference', 'network_hospital_locator', 'preferred_provider_rule', 'package_rate_rule'];
    if (network === 'network') {
      const networkCashless = flagOf(parameters, 'cashless_network_available');
      if (networkCashless === true) add('cashless_route', 'Cashless at this hospital', 'met', 'Cashless is available at network hospitals. Network status is Dynamic: confirm it with the hospital desk on the day.', keys);
      else if (networkCashless === false) add('cashless_route', 'Cashless at this hospital', 'not_met', 'The record states cashless is not available through the network route; plan for reimbursement and confirm with the insurer.', keys);
      else add('cashless_route', 'Cashless at this hospital', 'unknown', 'Whether cashless is available at network hospitals is not established.', keys);
    }
    else if (network === 'non_network') {
      const nonNetwork = flagOf(parameters, 'cashless_non_network_available');
      const notice = countOf(parameters, 'non_network_cashless_notice_hours');
      if (nonNetwork === true) add('cashless_route', 'Cashless at this hospital', 'attention', `Cashless at a non-network hospital is possible${notice != null ? ` with at least ${notice} hours' notice` : ''}.`, [...keys, 'non_network_cashless_notice_hours']);
      else if (nonNetwork === false) add('cashless_route', 'Cashless at this hospital', 'not_met', 'Cashless is not available at non-network hospitals; plan for reimbursement.', [...keys, 'non_network_cashless_notice_hours']);
      else add('cashless_route', 'Cashless at this hospital', 'unknown', 'Whether cashless is available at this non-network hospital is not established; plan for reimbursement unless the insurer confirms otherwise.', [...keys, 'non_network_cashless_notice_hours']);
    } else add('cashless_route', 'Cashless at this hospital', 'attention', `Network status of the hospital was not supplied.${textOf(parameters, 'network_hospital_locator') ? ` Check it: ${textOf(parameters, 'network_hospital_locator')}.` : ''}`, keys);
    const preferred = ruleText('preferred_provider_rule');
    if (preferred) add('preferred_provider', 'Preferred provider network', 'attention', `"${preferred}"`, ['preferred_provider_rule']);
    const excludedRule = ruleText('excluded_hospitals_rule');
    const excludedKeys = ['excluded_hospitals_rule', 'excluded_hospitals_list_reference'];
    if (request.hospital.excluded === true) add('excluded_hospital', 'Hospital on the excluded list', 'not_met', `The hospital is on the insurer's excluded list.${excludedRule ? ` "${excludedRule}"` : ''}`, excludedKeys);
    else if (excludedRule && request.hospital.excluded == null) add('excluded_hospital', 'Hospital on the excluded list', 'attention', `The policy excludes some hospitals: "${excludedRule}". Check the list${textOf(parameters, 'excluded_hospitals_list_reference') ? ` (${textOf(parameters, 'excluded_hospitals_list_reference')})` : ''}.`, excludedKeys);
    else if (request.hospital.excluded === false) add('excluded_hospital', 'Hospital on the excluded list', 'met', 'The hospital is not on the excluded list (as supplied).', excludedKeys);
  }

  // 7. Steps and deadlines (sections 4, 7 and 8). Computed from the admission date; informational.
  const steps = [];
  const step = (id, label, text, keys, extra = {}) => { keys.forEach(key => read.add(key)); steps.push({ id, label, text, parameterKeys: keys, evidence: evidence(keys), ...extra }); };
  {
    const notice = countOf(parameters, 'planned_preauth_notice_hours');
    if (request.hospital.networkStatus !== 'non_network') {
      const by = notice != null ? toIso(new Date(isoDay(admission).getTime() - notice * 3_600_000)) : null;
      step('preauthorisation', 'Pre-authorisation for cashless', notice != null ? `Send the pre-authorisation request at least ${notice} hours before admission (by ${by}).` : 'The pre-authorisation notice period is not established; ask the hospital desk.', ['planned_preauth_notice_hours', 'preauth_submitted_by', 'preauth_form_and_channel', 'preauth_documents', 'tpa_cashless_email', 'tpa_helpline'], { dueBy: by });
      if (notice != null && asOf > by) add('preauth_timing', 'Time left for pre-authorisation', 'attention', `The ${notice}-hour notice window for an admission on ${admission} has started or passed; send the request now.`, ['planned_preauth_notice_hours']);
      step('room_and_deposit', 'Room category and deposit', [ruleText('preauth_room_category_rule'), ruleText('deposit_and_estimate_rule')].filter(Boolean).join(' ') || 'Room category and deposit rules are not stated in this record.', ['preauth_room_category_rule', 'deposit_and_estimate_rule']);
      step('cashless_decision', 'Cashless decision and enhancement', [countOf(parameters, 'cashless_decision_hours') != null ? `Decision expected within ${countOf(parameters, 'cashless_decision_hours')} hours.` : null, ruleText('enhancement_request_rule'), ruleText('cashless_denial_rule') ? `If denied: ${ruleText('cashless_denial_rule')}` : null].filter(Boolean).join(' ') || 'Decision timelines are not stated in this record.', ['cashless_decision_hours', 'enhancement_request_rule', 'cashless_denial_rule', 'cashless_process']);
      step('discharge', 'Discharge authorisation', countOf(parameters, 'discharge_authorisation_hours') != null ? `Final authorisation within ${countOf(parameters, 'discharge_authorisation_hours')} hours of the hospital's request.${ruleText('authorisation_delay_consequence') ? ` ${ruleText('authorisation_delay_consequence')}` : ''}` : 'The discharge authorisation timeline is not stated in this record.', ['discharge_authorisation_hours', 'authorisation_delay_consequence']);
    }
    const intimation = countOf(parameters, 'reimbursement_intimation_planned_hours');
    const submission = countOf(parameters, 'reimbursement_submission_days');
    const discharge = request.dischargeDate;
    step('reimbursement', 'If you pay first and claim later', [
      intimation != null ? `Tell the insurer or TPA at least ${intimation} hours before a planned admission.` : 'The intimation period for planned reimbursement is not established.',
      submission != null ? `Submit the claim within ${submission} days of discharge${discharge ? ` (by ${addDays(discharge, submission)})` : ''}.` : 'The claim submission deadline is not established.',
      ruleText('delay_condonation_rule'),
    ].filter(Boolean).join(' '), ['reimbursement_intimation_planned_hours', 'reimbursement_submission_days', 'delay_condonation_rule', 'reimbursement_documents', 'claim_kyc_requirement', 'records_collection_rule'], { documents: listOf(parameters, 'reimbursement_documents') ?? [] });
    const pre = countOf(parameters, 'pre_hospitalisation_days');
    const post = countOf(parameters, 'post_hospitalisation_days');
    step('pre_post', 'Bills before and after the stay', [
      pre != null ? `Medical bills from ${addDays(admission, -pre)} (${pre} days before admission) count.` : 'Pre-hospitalisation cover is not established.',
      post != null ? `Bills up to ${post} days after discharge${discharge ? ` (until ${addDays(discharge, post)})` : ''} count${countOf(parameters, 'post_hospitalisation_claim_submission_days') != null ? `; submit them within ${countOf(parameters, 'post_hospitalisation_claim_submission_days')} days after that period` : ''}.` : 'Post-hospitalisation cover is not established.',
      flagOf(parameters, 'pre_post_linked_to_admitted_claim') ? 'They are paid only if the hospital claim itself is admitted.' : null,
    ].filter(Boolean).join(' '), ['pre_hospitalisation_days', 'post_hospitalisation_days', 'pre_post_linked_to_admitted_claim', 'post_hospitalisation_claim_submission_days']);
    const afterCare = [
      flagOf(parameters, 'second_opinion_covered') ? 'A second medical opinion is covered before planned surgery.' : null,
      flagOf(parameters, 'home_care_covered') ? `Treatment at home is covered${ruleText('home_care_conditions') ? `: ${ruleText('home_care_conditions')}` : ''}.` : null,
      flagOf(parameters, 'rehabilitation_covered') ? 'Rehabilitation after the stay is covered.' : null,
    ].filter(Boolean);
    read.add('second_opinion_covered'); read.add('home_care_covered'); read.add('rehabilitation_covered');
    if (afterCare.length) step('around_the_stay', 'Help before and after the stay', afterCare.join(' '), ['second_opinion_covered', 'home_care_covered', 'home_care_conditions', 'rehabilitation_covered']);
    step('after_the_claim', 'Tracking, settlement and complaints', [
      ruleText('claim_status_tracking'),
      countOf(parameters, 'claim_settlement_days') != null ? `Settlement within ${countOf(parameters, 'claim_settlement_days')} days of the last document${countOf(parameters, 'claim_investigation_settlement_days') != null ? ` (${countOf(parameters, 'claim_investigation_settlement_days')} days if investigated)` : ''}.` : null,
      ruleText('interest_on_delayed_settlement'),
      ruleText('partial_settlement_explanation'),
      ruleText('claim_rejection_process'),
      flagOf(parameters, 'rejection_review_committee_required') ? 'A rejection must be reviewed by the insurer\'s claims review committee.' : null,
      listOf(parameters, 'grievance_escalation_path') ? `Complaints: ${listOf(parameters, 'grievance_escalation_path').join(' → ')}${countOf(parameters, 'grievance_resolution_days') != null ? ` (insurer resolves within ${countOf(parameters, 'grievance_resolution_days')} days)` : ''}.` : null,
      flagOf(parameters, 'ombudsman_available') ? `Insurance Ombudsman available${usable(parameters, 'ombudsman_value_limit') ? ` for claims up to ₹${(usable(parameters, 'ombudsman_value_limit').value.amountMinor / 100).toLocaleString('en-IN')}` : ''}${countOf(parameters, 'ombudsman_complaint_window_days') != null ? `, within ${countOf(parameters, 'ombudsman_complaint_window_days')} days of the insurer's reply` : ''}.` : null,
    ].filter(Boolean).join(' ') || 'Settlement and grievance terms are not stated in this record.', ['claim_status_tracking', 'claim_settlement_days', 'claim_investigation_settlement_days', 'interest_on_delayed_settlement', 'partial_settlement_explanation', 'claim_rejection_process', 'rejection_review_committee_required', 'grievance_officer_contact', 'grievance_resolution_days', 'grievance_escalation_path', 'ombudsman_available', 'ombudsman_value_limit', 'ombudsman_complaint_window_days', 'consumer_forum_named']);
  }

  // 8. Regulation may override the wording (section 12). Shown for a person; never applied automatically.
  {
    const deviations = usable(parameters, 'regulatory_deviations');
    read.add('regulatory_deviations');
    const items = deviations?.value?.items ?? [];
    if (items.length) add('regulatory_floor', 'Where regulation may differ from the wording', 'attention', `${items.join(' ')} A qualified person should verify this against the current regulation before relying on it.`, ['regulatory_deviations', 'regulatory_floor_version']);
  }

  const outcomes = checks.map(check => check.outcome);
  return {
    verdict: outcomes.includes('not_met') ? 'blocker_found' : outcomes.some(outcome => ['attention', 'unknown'].includes(outcome)) ? 'needs_confirmation' : 'no_blocker_found',
    verdictNote: 'This checklist reads the policy record only. It is not a claim decision; the insurer decides admissibility.',
    admissionDate: admission,
    checks,
    steps,
    parametersRead: [...read].filter(key => parameters[key]).sort(),
  };
}
