import { el, field, hint, button, formValues } from './dom.js';
import { formatDate, formatPaise, humanize } from './format.js';
import { evidenceTag, fieldList, textOf } from './evidence-ui.js';
import { BILL_HEADS, PROCEDURES, REPORTED_ANSWER_OPTIONS } from '../state/request-builders.js';

const loading = label => el('p', { class: 'loading', role: 'status', 'data-testid': 'tool-loading' }, label);
const stateBadge = text => el('span', { class: `tag status-${text}` }, humanize(text));

function unconfirmedBanner(view, card) {
  const text = card?.banner ?? (view.recordStatus !== 'ready' ? 'This is built from a breakdown you have not confirmed yet. Every value shows how sure Knowvia is.' : null);
  return text ? el('div', { class: 'warning', role: 'status', 'data-testid': 'unconfirmed-banner' }, text) : null;
}

export function emergencyView({ view, controller }) {
  const card = view.emergencyCard;
  if (!card) return loading('Loading the emergency card.');
  const group = (title, fields, testid) => fields?.length ? el('section', { class: 'card-group', 'aria-label': title }, el('h3', {}, title), fieldList(fields, testid)) : null;
  return el('div', { 'data-testid': 'emergency-card' },
    unconfirmedBanner(view, card),
    el('section', { class: 'emergency', 'aria-labelledby': 'emergency-first' },
      el('h3', { id: 'emergency-first', 'data-testid': 'emergency-first' }, card.instruction?.first),
      el('p', {}, card.instruction?.route),
      el('p', { class: 'hint' }, card.instruction?.scope),
      el('div', { class: 'actions' }, el('a', { class: 'button emergency-button', href: 'tel:112', 'data-testid': 'call-112' }, 'Call 112'))),
    el('section', { class: 'card-group' }, el('h3', {}, 'Is the policy active?'),
      el('p', { 'data-testid': 'policy-state' }, stateBadge(card.policyStatus?.state ?? 'unknown'), ' ', card.policyStatus?.message)),
    group('Policy', card.policy, 'card-policy'), group('Cover', card.cover, 'card-cover'),
    group('Cashless admission', card.cashlessProcess, 'card-cashless'), group('If you pay first', card.ifPaidFirst, 'card-paid-first'),
    group('Waiting periods', card.waiting, 'card-waiting'), group('Household rules', card.household, 'card-household'),
    card.members?.length ? el('section', { class: 'card-group', 'data-testid': 'card-members' }, el('h3', {}, 'Each person'),
      el('ul', { class: 'plain-list' }, card.members.map(member => el('li', {},
        el('strong', {}, member.displayName), member.relationship ? ` (${member.relationship})` : '', ': ',
        member.namedOnPolicy === null ? 'Whether they are named on the policy is Unknown. ' : member.namedOnPolicy ? 'Named on the policy. ' : 'Not found in the named members. ',
        member.ageCopayLikely ? `An age-based co-pay of ${member.ageCopayPercent}% is likely. ` : '', member.note ?? '',
        member.memberSpecific?.length ? fieldList(member.memberSpecific, 'member-specific') : null)))) : null,
    card.unknowns?.length ? el('section', { class: 'card-group', 'data-testid': 'card-unknowns' }, el('h3', {}, 'Still unknown. Ask the hospital desk or insurer'),
      el('ul', { class: 'plain-list' }, card.unknowns.map(item => el('li', {}, item.label, ' ', evidenceTag(item.evidenceState))))) : null,
    card.protectedFieldsWithheld ? hint(`${card.protectedFieldsWithheld} protected value${card.protectedFieldsWithheld === 1 ? ' is' : 's are'} withheld from this view.`) : null,
    card.networkNote ? hint(card.networkNote) : null,
    button('Refresh', { variant: 'secondary', testid: 'refresh-card', onClick: () => controller.loadEmergencyCard() }));
}

export function statusView({ view, controller }) {
  const status = view.policyStatus;
  if (!status) return loading('Loading the policy status.');
  return el('div', { 'data-testid': 'policy-status' },
    unconfirmedBanner(view, null),
    el('section', { class: 'card-group' }, el('h3', {}, 'Where the policy stands'),
      el('p', { 'data-testid': 'policy-state' }, stateBadge(status.state), ' ', status.message), status.policyEndDate ? hint(`Policy ends ${formatDate(status.policyEndDate)}.`) : null),
    status.reminders?.length ? el('section', { class: 'card-group', 'data-testid': 'reminders' }, el('h3', {}, 'Dates to remember'),
      el('ul', { class: 'plain-list' }, status.reminders.map(item => el('li', {}, item.dueBy ? el('strong', {}, `${formatDate(item.dueBy)}: `) : null, item.text)))) : el('p', { class: 'empty-note' }, 'No dates to remember were found in your policy.'),
    Object.entries(status.groups ?? {}).filter(([, fields]) => fields.length).map(([name, fields]) =>
      el('section', { class: 'card-group' }, el('h3', {}, humanize(name)[0].toUpperCase() + humanize(name).slice(1)), fieldList(fields, `status-${name}`))),
    status.boundary ? hint(status.boundary) : null,
    button('Refresh', { variant: 'secondary', testid: 'refresh-status', onClick: () => controller.loadPolicyStatus() }));
}

function procedureForm({ view, ui, onSubmit, withBill, testid }) {
  const saved = ui.forms[testid] ?? {};
  const memberOptions = [['', 'Not chosen'], ...view.members.map(member => [member.id, member.displayName])];
  const lines = ui.billLines;
  const unknownOptions = [
    ['', 'Choose an answer'],
    ['not_sure', 'Not sure'],
    ['prefer_not_to_answer', 'Prefer not to answer'],
  ];
  const form = el('form', {
    class: 'panel', 'data-testid': testid, onInput: event => { ui.forms[testid] = { ...formValues(event.currentTarget) }; },
    onSubmit: event => { event.preventDefault(); onSubmit({ ...formValues(event.currentTarget), billLines: withBill ? ui.billLines.map(line => ({ ...line })) : [] }); },
  },
  el('fieldset', { class: 'bill-fieldset' }, el('legend', {}, 'Patient and treatment'),
    field({ label: 'Who is the patient?', name: 'memberId', type: 'select', options: memberOptions, value: saved.memberId, testid: `${testid}-member` }),
    field({ label: 'Treatment category', name: 'procedure', type: 'select', value: saved.procedure ?? 'general_inpatient', options: PROCEDURES.map(item => [item, humanize(item)]), testid: `${testid}-procedure` }),
    field({ label: 'Diagnosis as written by the doctor', name: 'diagnosisText', type: 'textarea', maxlength: 120, value: saved.diagnosisText, testid: `${testid}-diagnosis`, help: 'Use the doctor\'s wording if you have it. Do not guess.' }),
    field({ label: 'Procedure as written by the doctor', name: 'procedureWording', type: 'textarea', maxlength: 200, value: saved.procedureWording, testid: `${testid}-procedure-wording`, help: 'For example, the wording on the admission advice or estimate.' }),
    field({ label: 'Admission type', name: 'admissionType', type: 'select', value: saved.admissionType ?? '', testid: `${testid}-admission-type`,
      options: [...unknownOptions, ['planned', 'Planned'], ['emergency', 'Emergency'], ['accident', 'Accident']] }),
    field({ label: 'Admission date', name: 'admissionDate', type: 'date', value: saved.admissionDate, testid: `${testid}-admission` }),
    field({ label: 'Discharge date', name: 'dischargeDate', type: 'date', value: saved.dischargeDate, testid: `${testid}-discharge` })),
  el('fieldset', { class: 'bill-fieldset' }, el('legend', {}, 'Medical history reported by you'),
    hint('These answers are recorded as Reported. They are not treated as facts proven by the policy.'),
    field({ label: 'Is the condition pre-existing?', name: 'preExisting', type: 'select', value: saved.preExisting ?? '', testid: `${testid}-preexisting`, options: REPORTED_ANSWER_OPTIONS }),
    field({ label: 'Was it diagnosed before this cover began?', name: 'priorDiagnosis', type: 'select', value: saved.priorDiagnosis ?? '', testid: `${testid}-prior-diagnosis`, options: REPORTED_ANSWER_OPTIONS }),
    field({ label: 'Was treatment received before this cover began?', name: 'priorTreatment', type: 'select', value: saved.priorTreatment ?? '', testid: `${testid}-prior-treatment`, options: REPORTED_ANSWER_OPTIONS }),
    field({ label: 'Was medical advice given before this cover began?', name: 'priorAdvice', type: 'select', value: saved.priorAdvice ?? '', testid: `${testid}-prior-advice`, options: REPORTED_ANSWER_OPTIONS }),
    field({ label: 'Were symptoms present before this cover began?', name: 'priorSymptoms', type: 'select', value: saved.priorSymptoms ?? '', testid: `${testid}-prior-symptoms`, options: REPORTED_ANSWER_OPTIONS }),
    field({ label: 'Was the condition declared to the insurer?', name: 'declaredStatus', type: 'select', value: saved.declaredStatus ?? '', testid: `${testid}-declared`, options: REPORTED_ANSWER_OPTIONS }),
    field({ label: 'How did this cover continue from the previous policy?', name: 'coverContinuity', type: 'select', value: saved.coverContinuity ?? '', testid: `${testid}-continuity`,
      options: [...unknownOptions, ['continuous', 'Continuous renewal'], ['ported', 'Ported from another insurer'], ['migrated', 'Migrated within the insurer'], ['break_in_cover', 'There was a break in cover'], ['no_previous_cover', 'No previous cover']] })),
  el('fieldset', { class: 'bill-fieldset' }, el('legend', {}, 'Hospital and cashless status'),
    field({ label: 'Is the hospital in the insurer network?', name: 'networkStatus', type: 'select', value: saved.networkStatus ?? 'unknown', testid: `${testid}-network`,
      options: [['unknown', 'Not sure'], ['network', 'Yes, network'], ['non_network', 'No, not in network'], ['prefer_not_to_answer', 'Prefer not to answer']] }),
    field({ label: 'Hospital branch', name: 'hospitalBranch', maxlength: 120, value: saved.hospitalBranch, testid: `${testid}-hospital-branch`, help: 'Enter the exact branch name, not only the hospital group.' }),
    field({ label: 'Hospital address', name: 'hospitalAddress', type: 'textarea', maxlength: 300, value: saved.hospitalAddress, testid: `${testid}-hospital-address` }),
    field({ label: 'Hospital PIN code', name: 'hospitalPin', inputmode: 'numeric', pattern: '[1-9][0-9]{5}', maxlength: 6, value: saved.hospitalPin, testid: `${testid}-hospital-pin` }),
    field({ label: 'What is the pre-authorisation status?', name: 'preauthorisationStatus', type: 'select', value: saved.preauthorisationStatus ?? '', testid: `${testid}-preauthorisation`,
      options: [...unknownOptions, ['not_submitted', 'Not submitted'], ['submitted', 'Submitted, awaiting response'], ['confirmed', 'Confirmed'], ['denied', 'Denied']] })),
  el('fieldset', { class: 'bill-fieldset' }, el('legend', {}, 'Cover already used'),
    field({ label: 'Has any floater sum insured been used this policy year?', name: 'priorFloaterUse', type: 'select', value: saved.priorFloaterUse ?? '', testid: `${testid}-floater-used`, options: REPORTED_ANSWER_OPTIONS }),
    field({ label: 'Floater amount already used (rupees)', name: 'priorFloaterUseAmount', type: 'number', min: 0, step: 'any', value: saved.priorFloaterUseAmount, testid: `${testid}-floater-amount`, help: 'Leave this empty if the amount is not known.' }),
    field({ label: 'Will another policy contribute to this admission?', name: 'otherPolicyContribution', type: 'select', value: saved.otherPolicyContribution ?? '', testid: `${testid}-other-policy`, options: REPORTED_ANSWER_OPTIONS }),
    field({ label: 'Expected contribution from the other policy (rupees)', name: 'otherPolicyContributionAmount', type: 'number', min: 0, step: 'any', value: saved.otherPolicyContributionAmount, testid: `${testid}-other-policy-amount`, help: 'Leave this empty if the amount is not known.' })),
  withBill ? el('fieldset', { class: 'bill-fieldset' }, el('legend', {}, 'Hospital estimate (rupees)'),
    field({ label: 'Room rent per day', name: 'roomRate', type: 'number', min: 0, step: 'any', value: saved.roomRate, testid: 'estimate-room-rate' }),
    field({ label: 'Days in a room', name: 'roomDays', type: 'number', min: 0, step: 1, value: saved.roomDays, testid: 'estimate-room-days' }),
    lines.map((line, index) => el('div', { class: 'bill-line', 'data-testid': 'bill-line' },
      field({ label: `Bill item ${index + 1}`, name: `line-head-${index}`, type: 'select', value: line.head, options: BILL_HEADS.map(item => [item, humanize(item)]), testid: `bill-head-${index}`,
        onChange: event => { line.head = event.currentTarget.value; } }),
      field({ label: `Amount ${index + 1}`, name: `line-amount-${index}`, type: 'number', min: 0, step: 'any', value: line.amount, testid: `bill-amount-${index}`,
        onInput: event => { line.amount = event.currentTarget.value; event.stopPropagation(); } }),
      lines.length > 1 ? button('Remove', { variant: 'small secondary', testid: `bill-remove-${index}`, onClick: () => { ui.billLines.splice(index, 1); ui.rerender(); } }) : null)),
    button('Add another bill item', { variant: 'secondary small', testid: 'bill-add', onClick: () => { ui.billLines.push({ head: 'surgeon_fees', amount: '' }); ui.rerender(); } })) : null,
  el('button', { class: 'button', type: 'submit', disabled: Boolean(view.busy), 'data-testid': `${testid}-submit` }, withBill ? 'Estimate my cost' : 'Check this procedure'));
  return form;
}

const OUTCOME_ORDER = { not_met: 0, attention: 1, unknown: 2, met: 3, not_applicable: 4 };
const OUTCOME_WORDS = { met: 'Met', not_met: 'Not met', attention: 'Needs attention', unknown: 'Unknown', not_applicable: 'Not applicable' };

function eligibilityBlock(result, testid) {
  const checks = [...(result.checks ?? [])].sort((a, b) => (OUTCOME_ORDER[a.outcome] ?? 9) - (OUTCOME_ORDER[b.outcome] ?? 9));
  return [
    el('div', { class: `verdict verdict-${result.verdict}`, role: 'status', 'data-testid': `${testid}-verdict` },
      el('strong', {}, ({ no_blocker_found: 'No blocker found', needs_confirmation: 'Some things need confirming', blocker_found: 'A blocker was found' })[result.verdict] ?? humanize(result.verdict)),
      el('p', {}, result.verdictNote)),
    el('ul', { class: 'check-list', 'data-testid': `${testid}-checks` }, checks.map(check => el('li', { class: `check-item ${check.outcome}`, 'data-testid': `check-${check.id}`, 'data-outcome': check.outcome },
      el('div', {}, el('strong', {}, check.label), el('p', { class: 'hint' }, check.message)), el('span', { class: `tag outcome-${check.outcome}` }, OUTCOME_WORDS[check.outcome] ?? check.outcome)))),
    result.steps?.length ? el('section', { class: 'card-group' }, el('h3', {}, 'What to do, in order'),
      el('ol', { class: 'plain-list', 'data-testid': `${testid}-steps` }, result.steps.map(step => el('li', {}, el('strong', {}, step.label), ': ', step.text,
        step.dueBy ? ` Due by ${formatDate(step.dueBy)}.` : '', step.documents?.length ? ` Documents: ${step.documents.join(', ')}.` : '')))) : null,
  ];
}

export function procedureView({ view, controller, ui }) {
  const result = view.procedureCheck;
  return el('div', { 'data-testid': 'procedure-view' }, unconfirmedBanner(view, null),
    el('p', { class: 'lede' }, 'Planning an admission? See what could block cashless cover before you book. No hospital bill is needed.'),
    procedureForm({ view, ui, withBill: false, testid: 'procedure-form', onSubmit: form => controller.runProcedureCheck(form) }),
    view.busy ? loading(`${view.busy}.`) : null,
    result ? el('div', { 'data-testid': 'procedure-result' }, eligibilityBlock(result, 'procedure'), hint('This is a checklist from your policy record. It is not a claim decision.')) : null);
}

export function estimateView({ view, controller, ui }) {
  const result = view.estimate;
  const range = (low, high) => `${formatPaise(low)} to ${formatPaise(high)}`;
  return el('div', { 'data-testid': 'estimate-view' }, unconfirmedBanner(view, null),
    el('p', { class: 'lede' }, 'Enter the hospital estimate to see a range of what the insurer may pay and what you may pay.'),
    procedureForm({ view, ui, withBill: true, testid: 'estimate-form', onSubmit: form => controller.runEstimate(form) }),
    view.busy ? loading(`${view.busy}.`) : null,
    result ? el('div', { 'data-testid': 'estimate-result' },
      el('section', { class: 'estimate-summary' },
        el('p', { class: 'hint', 'data-testid': 'estimate-headline' }, result.display?.headline ?? ({ estimate: 'Planning estimate', conditional: 'Conditional estimate: some answers are unknown', insufficient_evidence: 'Not enough evidence for a firm range', coverage_blocked: 'Coverage blocker found', coverage_not_established: 'Coverage not established' })[result.status] ?? humanize(result.status)),
        el('p', { class: 'amount', 'data-testid': 'estimate-household-pays' }, result.display?.householdPays ?? range(result.householdPaysMinor.low, result.householdPaysMinor.high)),
        el('p', { class: 'hint' }, ['coverage_blocked', 'coverage_not_established'].includes(result.status) ? 'Household exposure in the primary scenario' : 'You may pay'),
        el('p', { class: 'amount small', 'data-testid': 'estimate-insurer-pays' }, result.display?.insurerPays ?? range(result.insurerPaysMinor.low, result.insurerPaysMinor.high)),
        el('p', { class: 'hint' }, ['coverage_blocked', 'coverage_not_established'].includes(result.status) ? 'Insurer payment in the primary scenario' : 'The insurer may pay'),
        result.insurerPaysIfEligibleMinor && result.insurerPaysIfEligibleMinor.low !== result.insurerPaysMinor.low
          ? hint(`If every waiting period and condition is met, the insurer may pay ${result.display?.insurerPaysIfEligible ?? range(result.insurerPaysIfEligibleMinor.low, result.insurerPaysIfEligibleMinor.high)}.`, { 'data-testid': 'estimate-if-eligible' })
          : null,
        result.otherPolicyPaysMinor ? hint(`Another policy pays ${formatPaise(result.otherPolicyPaysMinor)}.`) : null),
      result.blockingUnknowns?.length ? el('section', { class: 'card-group', 'data-testid': 'estimate-unknowns' }, el('h3', {}, 'Unknowns that widen the range'),
        el('ul', { class: 'plain-list' }, result.blockingUnknowns.map(item => el('li', {}, textOf(item), item.evidenceState ? [' ', evidenceTag(item.evidenceState)] : null)))) : null,
      ...(result.eligibility ? eligibilityBlock(result.eligibility, 'estimate-eligibility') : []),
      result.steps?.length ? el('section', { class: 'card-group' }, el('h3', {}, 'How we got there'), el('ol', { class: 'plain-list' }, result.steps.map(step => el('li', {}, textOf(step))))) : null,
      result.assumptions?.length ? el('section', { class: 'card-group' }, el('h3', {}, 'What we assumed'), el('ul', { class: 'plain-list' }, result.assumptions.map(item => el('li', {}, textOf(item))))) : null,
      result.additionalBenefits?.length ? el('section', { class: 'card-group' }, el('h3', {}, 'Extra benefits that may apply'), el('ul', { class: 'plain-list' }, result.additionalBenefits.map(item => el('li', {}, textOf(item))))) : null,
      result.clausesToRead?.length ? el('section', { class: 'card-group' }, el('h3', {}, 'Clauses worth reading'), el('ul', { class: 'plain-list' }, result.clausesToRead.map(item => el('li', {}, textOf(item))))) : null,
      result.boundaries?.map(item => hint(item))) : null);
}
