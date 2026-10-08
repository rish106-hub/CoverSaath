import { EstimateInputError } from './estimate.js';

const ANSWER_VALUES = Object.freeze(['yes', 'no', 'not_sure', 'prefer_not_to_answer']);
const ANSWER_ENUMS = Object.freeze({
  admissionType: ['planned', 'emergency', 'accident', 'not_sure', 'prefer_not_to_answer'],
  preExisting: ANSWER_VALUES,
  priorDiagnosis: ANSWER_VALUES,
  priorTreatment: ANSWER_VALUES,
  priorAdvice: ANSWER_VALUES,
  priorSymptoms: ANSWER_VALUES,
  declaredStatus: ANSWER_VALUES,
  coverContinuity: ['continuous', 'ported', 'migrated', 'break_in_cover', 'no_previous_cover', 'not_sure', 'prefer_not_to_answer'],
  preauthorisationStatus: ['not_submitted', 'submitted', 'confirmed', 'denied', 'not_sure', 'prefer_not_to_answer'],
  priorFloaterUse: ANSWER_VALUES,
  otherPolicyContribution: ANSWER_VALUES,
});
const TEXT_LIMITS = Object.freeze({ diagnosisText: 120, procedureWording: 200, hospitalBranch: 120, hospitalAddress: 300 });
const AMOUNT_KEYS = Object.freeze(['priorFloaterUseAmountMinor', 'otherPolicyContributionAmountMinor']);

const invalid = message => { throw new EstimateInputError(`scenarioReporting.${message}`); };
const exactKeys = (value, allowed, at) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${at} must be an object.`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) invalid(`${at}.${key} is not allowed.`);
};

/** Validate user-reported scenario facts without upgrading them to policy evidence. */
export function validateScenarioReporting(raw) {
  if (raw === undefined || raw === null) return null;
  const allowed = ['evidenceState', 'source', 'answers', ...Object.keys(TEXT_LIMITS), 'hospitalPin', ...AMOUNT_KEYS];
  exactKeys(raw, allowed, 'value');
  if (raw.evidenceState !== 'Reported' || raw.source !== 'person') invalid('must identify evidenceState Reported and source person.');
  exactKeys(raw.answers ?? {}, Object.keys(ANSWER_ENUMS), 'answers');
  const answers = {};
  for (const [key, value] of Object.entries(raw.answers ?? {})) {
    if (!ANSWER_ENUMS[key].includes(value)) invalid(`answers.${key} is invalid.`);
    answers[key] = value;
  }
  const result = { evidenceState: 'Reported', source: 'person', answers };
  for (const [key, limit] of Object.entries(TEXT_LIMITS)) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== 'string' || !raw[key].trim() || raw[key].length > limit) invalid(`${key} must be non-empty text of at most ${limit} characters.`);
    result[key] = raw[key].trim();
  }
  if (raw.hospitalPin !== undefined) {
    if (typeof raw.hospitalPin !== 'string' || !/^[1-9]\d{5}$/.test(raw.hospitalPin)) invalid('hospitalPin must be a valid 6-digit PIN code.');
    result.hospitalPin = raw.hospitalPin;
  }
  for (const key of AMOUNT_KEYS) {
    if (raw[key] === undefined) continue;
    if (!Number.isSafeInteger(raw[key]) || raw[key] < 0 || raw[key] > 10_000_000_000) invalid(`${key} must be a non-negative integer amount in paise.`);
    result[key] = raw[key];
  }
  return Object.freeze({ ...result, answers: Object.freeze(answers) });
}

/** Refuse two representations of the same reported fact when they disagree. */
export function assertScenarioConsistency(reporting, request) {
  if (!reporting) return;
  const reportedPed = reporting.answers.preExisting;
  if (['yes', 'no'].includes(reportedPed) && request.condition?.preExisting != null && request.condition.preExisting !== (reportedPed === 'yes')) {
    invalid('answers.preExisting conflicts with condition.preExisting.');
  }
  const admissionType = reporting.answers.admissionType;
  if (['accident', 'planned'].includes(admissionType) && request.condition?.accident != null && request.condition.accident !== (admissionType === 'accident')) {
    invalid('answers.admissionType conflicts with condition.accident.');
  }
}

/** Advisory checks from Reported answers. They may request confirmation, never establish eligibility. */
export function scenarioReportingChecks(reporting) {
  if (!reporting) return [];
  const answers = reporting.answers;
  const checks = [];
  const add = (id, label, message) => checks.push({ id, label, outcome: 'attention', decisionClass: 'advisory', message, parameterKeys: [], evidence: [{ key: `scenarioReporting.answers.${id}`, evidenceState: 'Reported' }] });
  const earlierHistory = ['priorDiagnosis', 'priorTreatment', 'priorAdvice', 'priorSymptoms'].filter(key => answers[key] === 'yes');
  if (earlierHistory.length) add('reported_medical_history', 'Medical history before this cover', 'You reported diagnosis, treatment, advice, or symptoms before this cover began. The insurer may compare this with the policy definition, proposal disclosures, and medical records; this answer does not by itself decide whether the condition is pre-existing.');
  if (answers.declaredStatus === 'no' && (answers.preExisting === 'yes' || earlierHistory.length)) add('reported_disclosure', 'Disclosure to the insurer', 'You reported earlier medical history and that it was not declared. Check the proposal form and underwriting records before relying on cover.');
  if (['ported', 'migrated', 'continuous'].includes(answers.coverContinuity)) add('reported_continuity', 'Continuity credit', 'You reported prior continuous cover. Waiting-period credit needs the previous policies and the insurer\'s accepted portability or migration record.');
  if (answers.coverContinuity === 'break_in_cover') add('reported_continuity_break', 'Break in cover', 'You reported a break in cover. A person must verify whether continuity and waiting-period credit survived that break.');
  if (answers.preauthorisationStatus === 'denied') add('reported_preauthorisation', 'Pre-authorisation status', 'You reported that pre-authorisation was denied. Obtain the written reason; cashless denial is not necessarily a final denial of reimbursement coverage.');
  return Object.freeze(checks.map(Object.freeze));
}

export function mergeScenarioChecks(result, reporting) {
  const extra = scenarioReportingChecks(reporting);
  const verdictNote = reporting
    ? 'This checklist combines issued-policy evidence with answers reported by the person. Reported answers are not proof and this is not a claim decision; the insurer decides admissibility.'
    : result.verdictNote;
  if (!extra.length) return { ...result, verdictNote, reportedScenario: reporting };
  const checks = [...result.checks, ...extra];
  return {
    ...result,
    verdict: result.verdict === 'blocker_found' ? result.verdict : 'needs_confirmation',
    verdictNote,
    checks,
    reportedScenario: reporting,
  };
}
