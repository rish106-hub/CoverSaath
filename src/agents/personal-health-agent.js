// Deterministic analysis for synthetic evidence only. This module does not make
// a product recommendation, determine eligibility, or interpret claim approval.

export const PERSONAL_HEALTH_AGENT_VERSION = 'personal-health-agent-v1';

const DIMENSIONS = new Set(['protection', 'constraints', 'economics', 'suitability']);
const STATUSES = new Set([
  'document_backed',
  'institution_confirmed',
  'user_stated',
  'proxy_reported',
  'unresolved'
]);
const CRITICAL_UNKNOWNS = [
  ['medical_history', 'Confirm the relevant medical history with the named adult and permitted records.'],
  ['continuity', 'Which issued schedules, renewals or insurer records establish continuity?'],
  ['disclosures', 'Which declarations were submitted, corrected or left unresolved?'],
  ['eligibility', 'Which authorised institution can confirm case-specific eligibility?'],
  ['claim_approval', 'What is the current written status from the insurer or TPA?']
];
const CRITICAL_FIELDS = new Set(CRITICAL_UNKNOWNS.map(([field]) => field));
const MAX_EVIDENCE_ITEMS = 200;
const MAX_TEXT_LENGTH = 2_000;

function fail(message) {
  const error = new Error(message);
  error.code = 'INVALID_PERSONAL_HEALTH_EVIDENCE';
  return error;
}

function boundedText(value, label, { optional = false } = {}) {
  if (value == null && optional) return null;
  if (typeof value !== 'string' || value.trim().length === 0) throw fail(`${label} is required.`);
  if (value.length > MAX_TEXT_LENGTH) throw fail(`${label} is too long.`);
  return value;
}

function citation(source, index) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw fail(`Evidence ${index} needs a source.`);
  }
  const id = boundedText(source.id, `Evidence ${index} source id`);
  const version = boundedText(source.version, `Evidence ${index} source version`);
  const page = source.page;
  if (!((typeof page === 'string' && page.trim()) || (Number.isInteger(page) && page >= 0))) {
    throw fail(`Evidence ${index} source page is required.`);
  }
  return Object.freeze({ id, page, version });
}

function normaliseEvidence(item, index) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw fail(`Evidence ${index} is invalid.`);
  if (!DIMENSIONS.has(item.dimension)) throw fail(`Evidence ${index} has an unsupported dimension.`);
  if (!STATUSES.has(item.status)) throw fail(`Evidence ${index} has an unsupported status.`);
  const field = boundedText(item.field, `Evidence ${index} field`);
  const id = boundedText(item.id, `Evidence ${index} id`);
  if (item.value === undefined) throw fail(`Evidence ${index} value is required.`);
  if (typeof item.value === 'number' && !Number.isFinite(item.value)) throw fail(`Evidence ${index} value must be finite.`);
  if (typeof item.value === 'string' && item.value.length > MAX_TEXT_LENGTH) throw fail(`Evidence ${index} value is too long.`);
  if (!['string', 'number', 'boolean'].includes(typeof item.value) && item.value !== null) {
    throw fail(`Evidence ${index} value must be a scalar.`);
  }
  const subjectIds = item.subjectIds == null ? [] : item.subjectIds;
  if (!Array.isArray(subjectIds) || subjectIds.length > 25 || subjectIds.some(value => typeof value !== 'string' || !value.trim())) {
    throw fail(`Evidence ${index} subjectIds are invalid.`);
  }
  return Object.freeze({
    id,
    policyId: boundedText(item.policyId, `Evidence ${index} policyId`, { optional: true }),
    subjectIds: Object.freeze([...subjectIds]),
    dimension: item.dimension,
    field,
    value: item.value,
    status: item.status,
    source: citation(item.source, index)
  });
}

function gap(field, question, reason = 'No source-backed assertion was supplied for this analysis.') {
  return Object.freeze({ field, status: 'unknown', reason, question });
}

function hasField(evidence, ...fields) {
  return evidence.some(item => fields.includes(item.field) && item.status !== 'unresolved');
}

function sourceAssertion(item) {
  return Object.freeze({
    id: item.id,
    policyId: item.policyId,
    subjectIds: item.subjectIds,
    field: item.field,
    value: item.value,
    status: item.status,
    source: item.source
  });
}

/**
 * Analyse a bounded set of synthetic policy evidence.
 *
 * Input:
 *   { synthetic: true, consent: true, evidence: EvidenceItem[] }
 *
 * Each EvidenceItem must contain id, dimension, field, scalar value, status and
 * source { id, page, version }. Optional policyId and subjectIds are preserved.
 */
export function analyzePersonalHealthCover(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('Input is required.');
  if (input.synthetic !== true) throw fail('Only explicitly synthetic evidence is accepted.');
  if (input.consent !== true) throw fail('Recorded demo consent is required.');
  if (!Array.isArray(input.evidence) || input.evidence.length === 0) throw fail('Evidence is required.');
  if (input.evidence.length > MAX_EVIDENCE_ITEMS) throw fail(`Evidence is limited to ${MAX_EVIDENCE_ITEMS} items.`);

  const seen = new Set();
  const evidence = input.evidence.map((item, index) => {
    const normalised = normaliseEvidence(item, index);
    if (seen.has(normalised.id)) throw fail(`Duplicate evidence id: ${normalised.id}.`);
    seen.add(normalised.id);
    return normalised;
  });

  // These fields remain unknown in this bounded analysis even if a caller tries
  // to supply a confident value. Case-specific authority sits elsewhere.
  const assertable = evidence.filter(item => !CRITICAL_FIELDS.has(item.field));
  const assertions = dimension => assertable
    .filter(item => item.dimension === dimension)
    .map(sourceAssertion);

  const evidenceGaps = CRITICAL_UNKNOWNS.map(([field, question]) => gap(
    field,
    question,
    'This agent does not resolve this field from synthetic policy evidence.'
  ));

  if (!hasField(assertable, 'insured_member', 'insured_members')) {
    evidenceGaps.push(gap('insured_members', 'Which people are named on each issued schedule?'));
  }
  if (!hasField(assertable, 'sum_insured', 'benefit_limit', 'sublimit')) {
    evidenceGaps.push(gap('benefit_limits', 'What limits and internal sublimits appear in the current issued wording?'));
  }
  if (!hasField(assertable, 'policy_period', 'effective_date', 'expiry_date')) {
    evidenceGaps.push(gap('policy_period', 'What are the effective and expiry dates on the current issued schedule?'));
  }
  if (!hasField(assertable, 'copay')) {
    evidenceGaps.push(gap('copay', 'Does the current issued wording apply a co-pay, and on what base?'));
  }
  if (!hasField(assertable, 'deductible')) {
    evidenceGaps.push(gap('deductible', 'Does a deductible apply, and how is it defined in the issued wording?'));
  }
  if (!hasField(assertable, 'premium')) {
    evidenceGaps.push(gap('premium', 'What is the current premium and payment frequency?'));
  }

  const dependentMentioned = assertable.some(item =>
    ['relationship', 'member_relationship'].includes(item.field)
      && typeof item.value === 'string'
      && /\b(?:dependent|child|son|daughter)\b/i.test(item.value)
  );
  if (dependentMentioned && !hasField(assertable, 'dependent_age_rule')) {
    evidenceGaps.push(gap(
      'dependent_age_rule',
      'What does the current issued wording say about dependent eligibility and age limits?',
      'No dependent-age rule was supplied. No age rule is inferred.'
    ));
  }

  const questions = [...new Set(evidenceGaps.map(item => item.question))];
  const ignoredCriticalEvidence = evidence
    .filter(item => CRITICAL_FIELDS.has(item.field))
    .map(item => Object.freeze({
      evidenceId: item.id,
      field: item.field,
      source: item.source,
      handling: 'kept_unknown'
    }));

  return Object.freeze({
    agent: 'personal-health-cover-agent',
    version: PERSONAL_HEALTH_AGENT_VERSION,
    scope: 'synthetic evidence analysis',
    dimensions: Object.freeze({
      protection: Object.freeze({ assertions: Object.freeze(assertions('protection')) }),
      constraints: Object.freeze({ assertions: Object.freeze(assertions('constraints')) }),
      economics: Object.freeze({
        assertions: Object.freeze(assertions('economics')),
        affordabilityConclusion: null
      }),
      suitability: Object.freeze({
        classification: 'evidence_gaps_and_questions',
        assertions: Object.freeze(assertions('suitability')),
        evidenceGaps: Object.freeze(evidenceGaps),
        questions: Object.freeze(questions),
        ignoredCriticalEvidence: Object.freeze(ignoredCriticalEvidence),
        regulatedProductRecommendation: null
      })
    }),
    boundaries: Object.freeze([
      'No product recommendation is issued.',
      'Policy limits are not treated as payable cash.',
      'Medical history, continuity, disclosures, eligibility and claim approval remain unknown.',
      'No borrowing, asset sale, treatment choice or delay-of-care advice is produced.'
    ])
  });
}

