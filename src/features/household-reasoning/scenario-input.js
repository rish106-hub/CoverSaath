// Strict validation of a household-scenario/v1 request body. Everything the client sends here is untrusted, reported
// context: it can describe a situation and name server-side sources, and nothing else. An unexpected field is refused,
// and a field that looks like authority (verified, citations, handoff, amounts) is refused with its own code.
import {
  ANSWER_KEYS, HouseholdReasoningError, LIMITS, NOT_KNOWN, RELATIONS, REPORTED_POLICY_TYPES, SCENARIO_TYPES, SCENARIO_VERSION, SENTINELS, SKIPPED,
  deepFreeze, hasForbiddenCharacters, isIsoDate, isIsoMonth, isRecord,
} from './contracts.js';
import { isSpecificProcedure } from './relevance.js';

const fail = (code, message) => { throw new HouseholdReasoningError(code, message, 400); };
const AUTHORITY_KEY = /^(handoffs?|verified|isVerified|known|citations?|coverage|association|associationVerified|membership|enrolled|enrolment|enrollment|reviewer|reviewerRole|role|authority|trust|trustState|state|status|amount|amountMinor|sumInsured|payable|combinedPayableAmount|spendableCash|limit|policy|policies|policyId|policyNumber|financial|calculation|calculate|provenance|origin)$/i;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// C0/C1 controls, line and paragraph separators, zero-width and bidi override characters, byte-order mark.
const FORBIDDEN_CHARS = { test: hasForbiddenCharacters };

function exactKeys(value, allowed, path) {
  if (!isRecord(value)) fail('HOUSEHOLD_SCENARIO_INVALID', `${path} must be an object.`);
  for (const key of Object.keys(value)) {
    if (allowed.includes(key)) continue;
    if (AUTHORITY_KEY.test(key)) fail('HOUSEHOLD_SCENARIO_FORBIDDEN_FIELD', `${path} may not carry authority or financial fields.`);
    fail('HOUSEHOLD_SCENARIO_UNKNOWN_FIELD', `${path} has an unsupported field.`);
  }
}

function cleanText(value, max, path) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !value.isWellFormed()) fail('HOUSEHOLD_SCENARIO_INVALID', `${path} must be well-formed text.`);
  if (FORBIDDEN_CHARS.test(value)) fail('HOUSEHOLD_SCENARIO_INVALID', `${path} contains control characters.`); // before trim: trim() would hide a leading BOM
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) fail('HOUSEHOLD_SCENARIO_INVALID', `${path} must be 1 to ${max} characters.`);
  return trimmed;
}

function identifier(value, path, { optional = false } = {}) {
  if (value === undefined || value === null) { if (optional) return null; fail('HOUSEHOLD_SCENARIO_INVALID', `${path} is required.`); }
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) fail('HOUSEHOLD_SCENARIO_INVALID', `${path} is malformed.`);
  return value;
}

function oneOf(value, list, path, { optional = true } = {}) {
  if (value === undefined || value === null) { if (optional) return null; fail('HOUSEHOLD_SCENARIO_INVALID', `${path} is required.`); }
  if (!list.includes(value)) fail('HOUSEHOLD_SCENARIO_INVALID', `${path} is not a supported value.`);
  return value;
}

function validateAnswers(raw) {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) fail('HOUSEHOLD_SCENARIO_INVALID', 'scenario.answers must be an object.');
  const keys = Object.keys(raw);
  if (keys.length > LIMITS.answers) fail('HOUSEHOLD_SCENARIO_TOO_LARGE', `scenario.answers is limited to ${LIMITS.answers} entries.`);
  const out = {};
  for (const key of keys.sort()) {
    const spec = ANSWER_KEYS[key];
    if (!Object.hasOwn(ANSWER_KEYS, key)) fail(AUTHORITY_KEY.test(key) ? 'HOUSEHOLD_SCENARIO_FORBIDDEN_FIELD' : 'HOUSEHOLD_SCENARIO_UNKNOWN_FIELD', 'scenario.answers has an unsupported key.');
    const value = raw[key];
    if (typeof value === 'string' && SENTINELS.includes(value)) { out[key] = { state: value === SKIPPED ? 'skipped' : 'unknown', value: null }; continue; }
    if (spec.type === 'member_id') out[key] = { state: 'answered', value: identifier(value, `scenario.answers.${key}`) };
    else if (spec.type === 'date') {
      if (typeof value !== 'string' || !isIsoDate(value)) fail('HOUSEHOLD_SCENARIO_INVALID', `scenario.answers.${key} must be a valid YYYY-MM-DD date.`);
      out[key] = { state: 'answered', value };
    } else if (spec.type === 'yes_no') {
      if (value !== 'YES' && value !== 'NO') fail('HOUSEHOLD_SCENARIO_INVALID', `scenario.answers.${key} must be YES, NO, ${NOT_KNOWN} or ${SKIPPED}.`);
      out[key] = { state: 'answered', value };
    } else out[key] = { state: 'answered', value: cleanText(value, LIMITS.answerText, `scenario.answers.${key}`) ?? fail('HOUSEHOLD_SCENARIO_INVALID', `scenario.answers.${key} is required.`) };
  }
  return out;
}

const sameText = (a, b) => a.normalize('NFKC').toLowerCase() === b.normalize('NFKC').toLowerCase();

/**
 * @returns a frozen, normalised request: { contractVersion, sources, scenario }. `scenario.answers` carries explicit
 * answer states; `scenario.effective` merges direct fields with accepted answers and refuses contradictions.
 */
export function validateScenarioInput(body) {
  exactKeys(body, ['contractVersion', 'sources', 'scenario'], 'request');
  if (body.contractVersion !== SCENARIO_VERSION) fail('HOUSEHOLD_SCENARIO_VERSION_UNSUPPORTED', `contractVersion must be ${SCENARIO_VERSION}.`);
  if (!Array.isArray(body.sources) || body.sources.length < 1 || body.sources.length > LIMITS.sources) {
    fail('HOUSEHOLD_SCENARIO_INVALID', `sources must contain 1 to ${LIMITS.sources} entries.`);
  }
  const seen = new Set();
  const sources = body.sources.map((source, index) => {
    exactKeys(source, ['caseId', 'answerId'], `sources[${index}]`);
    const entry = { caseId: identifier(source.caseId, `sources[${index}].caseId`), answerId: identifier(source.answerId, `sources[${index}].answerId`) };
    const key = `${entry.caseId}\u0000${entry.answerId}`;
    if (seen.has(key)) fail('HOUSEHOLD_SCENARIO_DUPLICATE_SOURCE', 'Each source reference may appear once.');
    seen.add(key);
    return entry;
  });

  const s = body.scenario;
  exactKeys(s, ['scenarioType', 'reportedMemberRelation', 'memberId', 'procedureText', 'topic', 'plannedMonth', 'plannedDate', 'reportedPolicyType', 'hospital', 'answers'], 'scenario');
  const hospitalIn = s.hospital ?? {};
  exactKeys(hospitalIn, ['name', 'city', 'branch'], 'scenario.hospital');
  const scenario = {
    scenarioType: oneOf(s.scenarioType, SCENARIO_TYPES, 'scenario.scenarioType', { optional: false }),
    reportedMemberRelation: oneOf(s.reportedMemberRelation, RELATIONS, 'scenario.reportedMemberRelation'),
    memberId: identifier(s.memberId, 'scenario.memberId', { optional: true }),
    procedureText: cleanText(s.procedureText, LIMITS.procedureText, 'scenario.procedureText'),
    topic: cleanText(s.topic, LIMITS.topic, 'scenario.topic'),
    plannedMonth: s.plannedMonth == null ? null : (isIsoMonth(s.plannedMonth) ? s.plannedMonth : fail('HOUSEHOLD_SCENARIO_INVALID', 'scenario.plannedMonth must be a valid YYYY-MM month.')),
    plannedDate: s.plannedDate == null ? null : (isIsoDate(s.plannedDate) ? s.plannedDate : fail('HOUSEHOLD_SCENARIO_INVALID', 'scenario.plannedDate must be a valid YYYY-MM-DD date.')),
    reportedPolicyType: oneOf(s.reportedPolicyType, REPORTED_POLICY_TYPES, 'scenario.reportedPolicyType'),
    hospital: {
      name: cleanText(hospitalIn.name, LIMITS.hospitalField, 'scenario.hospital.name'),
      city: cleanText(hospitalIn.city, LIMITS.hospitalField, 'scenario.hospital.city'),
      branch: cleanText(hospitalIn.branch, LIMITS.hospitalField, 'scenario.hospital.branch'),
    },
    answers: validateAnswers(s.answers),
  };
  if (scenario.plannedMonth && scenario.plannedDate && !scenario.plannedDate.startsWith(`${scenario.plannedMonth}-`)) {
    fail('HOUSEHOLD_SCENARIO_CONTRADICTORY', 'plannedDate is not in plannedMonth.');
  }

  // Direct fields and accepted answers describe the same facts. They may repeat each other; they may not disagree.
  const merge = (direct, key, same = (a, b) => a === b) => {
    const answer = scenario.answers[key];
    const given = answer?.state === 'answered' ? answer.value : null;
    if (direct !== null && given !== null && !same(direct, given)) fail('HOUSEHOLD_SCENARIO_CONTRADICTORY', `scenario.answers.${key} contradicts the scenario field.`);
    return direct ?? given;
  };
  const effective = {
    memberId: merge(scenario.memberId, 'member_id'),
    plannedDate: merge(scenario.plannedDate, 'exact_date'),
    hospitalName: merge(scenario.hospital.name, 'hospital_name', sameText),
    hospitalCity: merge(scenario.hospital.city, 'hospital_city', sameText),
    hospitalBranch: merge(scenario.hospital.branch, 'hospital_branch', sameText),
    // A specific direct procedure may be repeated but not contradicted; a nonspecific one ("surgery") is what the
    // procedure question refines, so the answer then replaces it for matching.
    procedureDetail: merge(scenario.procedureText && isSpecificProcedure(scenario.procedureText) ? scenario.procedureText : null, 'procedure_detail', sameText),
    topicDetail: merge(scenario.topic, 'topic_detail', sameText),
  };
  if (effective.plannedDate && scenario.plannedMonth && !effective.plannedDate.startsWith(`${scenario.plannedMonth}-`)) {
    fail('HOUSEHOLD_SCENARIO_CONTRADICTORY', 'The exact date is not in plannedMonth.');
  }
  return deepFreeze({ contractVersion: SCENARIO_VERSION, sources, scenario: { ...scenario, effective } });
}
