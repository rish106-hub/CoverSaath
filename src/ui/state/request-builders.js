// Pure builders that turn form values into API request bodies. Rupee inputs become integer paise here.

export const DOCUMENT_KINDS = Object.freeze([
  ['policy_wording', 'Policy wording (the long terms and conditions)'],
  ['policy_schedule', 'Policy schedule (the 1 to 2 page summary)'],
  ['endorsement', 'Endorsement or add-on'],
  ['member_card', 'Member or health card'],
  ['other', 'Something else about the policy'],
]);
export const PROCEDURES = Object.freeze([
  'general_inpatient', 'day_care', 'cataract', 'maternity_normal', 'maternity_csection', 'joint_replacement',
  'modern_treatment', 'ayush', 'domiciliary', 'organ_donor', 'mental_illness', 'bariatric', 'other',
]);
export const BILL_HEADS = Object.freeze([
  'nursing', 'doctor_fees', 'surgeon_fees', 'anaesthetist_fees', 'ot_charges', 'medicines_pharmacy', 'consumables',
  'implants_devices', 'diagnostics', 'ambulance', 'air_ambulance', 'non_payable_misc', 'other',
]);
export const REPORTED_ANSWER_OPTIONS = Object.freeze([
  ['', 'Choose an answer'],
  ['yes', 'Yes'],
  ['no', 'No'],
  ['not_sure', 'Not sure'],
  ['prefer_not_to_answer', 'Prefer not to answer'],
]);
export const MAX_FILE_BYTES = 15 * 1024 * 1024;

export const documentConsentScopes = () => [{ resourceType: 'document', action: 'collect', dataCategory: 'insurance_document' }];
export const reconstructionConsentScopes = () => [
  { resourceType: 'policy', action: 'derive', dataCategory: 'insurance_document' },
  { resourceType: 'document', action: 'share', dataCategory: 'insurance_document' },
];

export function rupeesToPaise(value) {
  if (value === '' || value === null || value === undefined) return null;
  const rupees = Number(value);
  if (!Number.isFinite(rupees) || rupees < 0) return Number.NaN;
  return Math.round(rupees * 100);
}

export function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

export function validateMemberForm({ displayName, relationship, dateOfBirth }) {
  const name = String(displayName ?? '').trim();
  if (!name) return { error: 'Enter the name as it appears on the policy.' };
  if (name.length > 120) return { error: 'The name must be 120 characters or fewer.' };
  if (!String(relationship ?? '').trim()) return { error: 'Choose how this person is related to you.' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateOfBirth ?? ''))) return { error: 'Enter a date of birth.' };
  if (dateOfBirth > new Date().toISOString().slice(0, 10)) return { error: 'The date of birth cannot be in the future.' };
  return { body: { displayName: name, relationship: String(relationship).trim(), dateOfBirth } };
}

/** Review body for POST /parameters/{key}/review. Returns { body } or { error }. */
export function buildReviewBody({ action, valueType, form = {} }) {
  const note = String(form.note ?? '').trim() || undefined;
  if (action === 'confirm') return { body: { action } };
  if (action === 'mark_absent') return { body: { action, ...(note ? { note } : {}) } };
  if (action !== 'correct') return { error: 'Unknown review action.' };
  const value = {};
  const raw = String(form.value ?? '').trim();
  switch (valueType) {
    case 'money': case 'percent': case 'days': case 'months': case 'years': case 'count': {
      const number = Number(raw);
      if (!raw || !Number.isFinite(number) || number < 0) return { error: 'Enter a number that is zero or more.' };
      if (['days', 'months', 'years', 'count'].includes(valueType) && !Number.isInteger(number)) return { error: 'Enter a whole number.' };
      if (valueType === 'percent' && number > 100) return { error: 'A percentage cannot be more than 100.' };
      value.valueNumber = number; // rupees for money; the API converts to paise
      break;
    }
    case 'boolean':
      if (form.value !== 'yes' && form.value !== 'no') return { error: 'Choose Yes or No.' };
      value.valueBoolean = form.value === 'yes';
      break;
    case 'text_list': {
      const items = String(form.value ?? '').split('\n').map(item => item.trim()).filter(Boolean);
      if (!items.length) return { error: 'Enter at least one item, one per line.' };
      value.valueList = items;
      break;
    }
    default:
      if (!raw) return { error: 'Enter the correct value.' };
      value.valueText = raw;
  }
  const body = { action, value, ...(note ? { note } : {}) };
  const quote = String(form.quote ?? '').trim();
  if (quote) {
    const pageNumber = Number(form.pageNumber);
    if (!form.documentId) return { error: 'Choose which document the quote is from.' };
    if (!Number.isInteger(pageNumber) || pageNumber < 1) return { error: 'Enter the page number of the quote.' };
    body.citation = { documentId: form.documentId, pageNumber, quote };
  }
  return { body };
}

/** Shared by the estimate and procedure-check forms. billLines amounts arrive in rupees. */
export function buildProcedureBody(form, { includeBill = false } = {}) {
  const body = { procedure: form.procedure || 'general_inpatient' };
  if (form.memberId) body.memberId = form.memberId;
  if (form.admissionDate) body.admissionDate = form.admissionDate;
  if (form.dischargeDate) body.dischargeDate = form.dischargeDate;
  if (form.admissionDate && form.dischargeDate && form.dischargeDate < form.admissionDate) return { error: 'The discharge date cannot be before the admission date.' };
  if (form.networkStatus) body.hospital = {
    networkStatus: ['network', 'non_network', 'unknown'].includes(form.networkStatus) ? form.networkStatus : 'unknown',
  };

  const diagnosisText = String(form.diagnosisText ?? '').trim();
  const procedureWording = String(form.procedureWording ?? '').trim();
  const hospitalBranch = String(form.hospitalBranch ?? '').trim();
  const hospitalAddress = String(form.hospitalAddress ?? '').trim();
  const hospitalPin = String(form.hospitalPin ?? '').trim();
  if (diagnosisText.length > 120) return { error: 'The diagnosis wording must be 120 characters or fewer.' };
  if (procedureWording.length > 200) return { error: 'The procedure wording must be 200 characters or fewer.' };
  if (hospitalBranch.length > 120) return { error: 'The hospital branch must be 120 characters or fewer.' };
  if (hospitalAddress.length > 300) return { error: 'The hospital address must be 300 characters or fewer.' };
  if (hospitalPin && !/^[1-9]\d{5}$/.test(hospitalPin)) return { error: 'Enter a valid 6-digit hospital PIN code.' };

  const condition = {};
  if (diagnosisText) condition.name = diagnosisText;
  if (form.admissionType === 'accident') condition.accident = true;
  if (form.admissionType === 'planned') condition.accident = false;
  if (Object.keys(condition).length) body.condition = condition;

  const priorFloaterUseMinor = rupeesToPaise(form.priorFloaterUseAmount);
  const otherPolicyPaysMinor = rupeesToPaise(form.otherPolicyContributionAmount);
  if (Number.isNaN(priorFloaterUseMinor)) return { error: 'Enter prior floater use as a rupee amount, or leave it empty.' };
  if (Number.isNaN(otherPolicyPaysMinor)) return { error: 'Enter the other policy contribution as a rupee amount, or leave it empty.' };
  if (form.priorFloaterUse === 'no' && priorFloaterUseMinor > 0) return { error: 'Prior floater use cannot be No when an amount is entered.' };
  if (form.otherPolicyContribution === 'no' && otherPolicyPaysMinor > 0) return { error: 'Other policy contribution cannot be No when an amount is entered.' };
  if (form.priorFloaterUse === 'no') body.sumInsuredAlreadyUsedMinor = 0;
  else if (form.priorFloaterUse === 'yes' && priorFloaterUseMinor !== null) body.sumInsuredAlreadyUsedMinor = priorFloaterUseMinor;
  if (form.otherPolicyContribution === 'no') body.otherPolicyPaysMinor = 0;
  else if (form.otherPolicyContribution === 'yes' && otherPolicyPaysMinor !== null) body.otherPolicyPaysMinor = otherPolicyPaysMinor;

  const answerKeys = [
    'admissionType', 'preExisting', 'priorDiagnosis', 'priorTreatment', 'priorAdvice', 'priorSymptoms', 'declaredStatus',
    'coverContinuity', 'preauthorisationStatus', 'priorFloaterUse', 'otherPolicyContribution',
  ];
  const answers = Object.fromEntries(answerKeys
    .map(key => [key, String(form[key] ?? '').trim()])
    .filter(([, value]) => value));
  const reportedText = {
    ...(diagnosisText ? { diagnosisText } : {}),
    ...(procedureWording ? { procedureWording } : {}),
    ...(hospitalBranch ? { hospitalBranch } : {}),
    ...(hospitalAddress ? { hospitalAddress } : {}),
    ...(hospitalPin ? { hospitalPin } : {}),
  };
  body.scenarioReporting = {
    evidenceState: 'Reported',
    source: 'person',
    answers,
    ...reportedText,
    ...(priorFloaterUseMinor !== null ? { priorFloaterUseAmountMinor: priorFloaterUseMinor } : {}),
    ...(otherPolicyPaysMinor !== null ? { otherPolicyContributionAmountMinor: otherPolicyPaysMinor } : {}),
  };
  if (!includeBill) return { body };
  const roomRate = rupeesToPaise(form.roomRate);
  const roomDays = form.roomDays === '' || form.roomDays === undefined ? 0 : Number(form.roomDays);
  if (Number.isNaN(roomRate)) return { error: 'Enter the room rent as a rupee amount, or leave it empty.' };
  if (!Number.isInteger(roomDays) || roomDays < 0) return { error: 'Enter whole days of stay, or leave it empty.' };
  if (roomDays > 0 && roomRate === null) return { error: 'Enter the room rent per day.' };
  if (roomDays > 0) body.room = { ratePerDayMinor: roomRate, days: roomDays };
  const billLines = [];
  for (const line of form.billLines ?? []) {
    if (!line.head && line.amount === '') continue;
    const amountMinor = rupeesToPaise(line.amount);
    if (amountMinor === null || Number.isNaN(amountMinor)) return { error: 'Every bill line needs a rupee amount.' };
    billLines.push({ head: line.head || 'other', amountMinor });
  }
  if (billLines.length) body.billLines = billLines;
  if (!billLines.length && roomDays === 0) return { error: 'Add at least one bill line, or the room rent and days.' };
  return { body };
}
