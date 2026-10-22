// Output contract check for household-coverage-preview/v1. A consumer or a test calls it; the builder calls it before
// returning, so a bug that would upgrade authority, sum limits or leak a forbidden field fails closed instead of shipping.
import {
  ACTION_TYPES, ASSESSMENT_STATES, ASSOCIATION_STATES, GAP_PRIORITIES, ITEM_STATES, LIMITS, MEMBER_APPLICABILITY, PREVIEW_VERSION, PROVENANCE, RESOLVERS, isRecord,
} from './contracts.js';

const TOP_LEVEL = ['contractVersion', 'scenario', 'sourceSummary', 'policies', 'comparisons', 'contextGaps', 'nextQuestions', 'externalChecks', 'nextActions', 'assessmentState', 'completeness', 'limitations'];
const FORBIDDEN_KEY = /^(spendableCash|combinedPayableAmount|combinedConfirmedCover|aggregateCover|totalCover|totalSumInsured|expectedReimbursement|outOfPocket|candidateValue|policyNumber|rawText|quote|sessionToken|token|claimApproved|approvalLikelihood|memberName|insuredName|patientName|fullName|email|emailAddress|phone|phoneNumber|mobile|mobileNumber|dateOfBirth|dob|birthDate|address|aadhaar|aadhar|passport|ssn)$/i;
const PROHIBITED_CLAIM = /\b(will be approved|claim (?:is|will be) (?:approved|paid)|cashless (?:is|will be) available|you will receive|guaranteed|is in the (?:insurer|tpa)'s network)\b/i;
const DECISIVE_STATES = ['known', 'not_permitted', 'not_selected', 'available_not_selected'];

export function assertHouseholdPreviewContract(preview) {
  const fail = message => { throw new Error(`Household preview contract: ${message}`); };
  if (!isRecord(preview) || preview.contractVersion !== PREVIEW_VERSION) fail('version');
  if (Object.keys(preview).sort().join() !== [...TOP_LEVEL].sort().join()) fail('top-level shape');
  if (!ASSESSMENT_STATES.includes(preview.assessmentState)) fail(`assessment state ${preview.assessmentState}`);

  // Claim wording is checked on the engine's own sentences only. Echoed user input, quoted contract text and the topic labels
  // that document readings supply are data and are never scanned (they may legitimately contain such words).
  const OWN_TEXT = /^preview\.(?:nextQuestions\.\d+\.text|nextActions\.\d+\.text|limitations\.\d+|policies\.\d+\.limitations\.\d+|externalChecks\.\d+\.(?:note|requires)|comparisons\.(?:unresolvedCoordination\.\d+\.text|possibleOverlap\.\d+\.note)|contextGaps\.\d+\.reason)$/;
  const walk = (value, path) => {
    if (typeof value === 'string' && OWN_TEXT.test(path) && PROHIBITED_CLAIM.test(value)) fail(`prohibited claim wording at ${path}`);
    if (Array.isArray(value)) value.forEach((inner, i) => walk(inner, `${path}.${i}`));
    else if (isRecord(value)) for (const [key, inner] of Object.entries(value)) {
      if (FORBIDDEN_KEY.test(key)) fail(`forbidden field ${key} at ${path}`);
      walk(inner, `${path}.${key}`);
    }
  };
  walk(preview, 'preview');

  if (!Array.isArray(preview.policies) || preview.policies.length > LIMITS.policies) fail('policies');
  const ids = new Set();
  for (const policy of preview.policies) {
    if (!/^pol-[0-9a-f]{16}$/.test(policy.policyId) || ids.has(policy.policyId)) fail('policy id');
    ids.add(policy.policyId);
    if (!ASSOCIATION_STATES.includes(policy.associationState)) fail('association state');
    if (!MEMBER_APPLICABILITY.includes(policy.memberApplicability?.state)) fail('member applicability');
    if (policy.memberApplicability.state === 'established' && (!policy.memberApplicability.citations.length || policy.associationState !== 'verified')) fail('established applicability needs citations and a verified association');
    if (policy.associationState !== 'verified' && (policy.documentedTerms.length || policy.documentedRestrictions.length)) fail('documented entries need a verified policy association');
    for (const term of [...policy.documentedTerms, ...policy.documentedRestrictions]) {
      if (!ITEM_STATES.includes(term.state) || !DECISIVE_STATES.includes(term.state)) fail(`documented entry state ${term.state}`);
      if (!term.citations?.length) fail(`documented entry without citations (${term.rule})`);
      if (term.provenance !== 'reviewed_contractual_evidence') fail(`documented entry provenance (${term.rule})`);
      if ((term.state === 'known') !== (term.value !== null && term.value !== undefined)) fail(`value only when known (${term.rule})`);
    }
    for (const entry of policy.uncertainties) {
      if ('value' in entry) fail('uncertainty carries a value');
      if (!PROVENANCE.includes(entry.provenance)) fail('uncertainty provenance');
    }
    for (const check of policy.dynamicChecks) if (check.status !== 'not_performed') fail('dynamic check reported as performed');
  }
  const refs = [...(preview.comparisons?.possibleOverlap ?? [])];
  for (const overlap of refs) {
    if (overlap.state !== 'possible_overlap' || new Set(overlap.policies.map(p => p.policyId)).size < 2) fail('overlap needs two distinct policies');
    if (!overlap.policies.every(p => ids.has(p.policyId) && p.citations.length)) fail('overlap entries need known policies and citations');
  }
  for (const restriction of preview.comparisons?.documentedRestrictions ?? []) if (!restriction.citations.length || restriction.scope !== 'this_policy_only') fail('comparison restriction');
  for (const g of preview.contextGaps) {
    if (!RESOLVERS.includes(g.expectedResolver) || !GAP_PRIORITIES.includes(g.priority) || typeof g.blocking !== 'boolean') fail(`gap ${g.gapKey}`);
  }
  if (!Array.isArray(preview.nextQuestions) || preview.nextQuestions.length > LIMITS.questionsPerTurn) fail('too many questions');
  if (new Set(preview.nextQuestions.map(question => question.questionId)).size !== preview.nextQuestions.length) fail('duplicate question');
  if (preview.nextQuestions.some(question => question.alreadyAnswered !== false || !RESOLVERS.includes(question.resolver))) fail('question shape');
  for (const action of preview.nextActions) {
    if (!ACTION_TYPES.includes(action.actionType) || !action.reasonCode || action.status === 'completed') fail('next action');
  }
  for (const check of preview.externalChecks) if (check.status !== 'not_performed') fail('external check reported as performed');
  if (preview.sourceSummary.retrievalComplete !== false || preview.completeness.retrievalComplete !== false) fail('retrieval completeness may not be claimed');
  return true;
}
