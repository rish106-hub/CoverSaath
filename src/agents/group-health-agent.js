// Deterministic synthetic-evidence analysis only. No insurer, HR, TPA or model IO.
const MAX_EVIDENCE = 64;
const MAX_TEXT = 500;

export const GROUP_HEALTH_BUCKETS = Object.freeze([
  Object.freeze({ key: 'policyProtection', label: 'Policy Protection' }),
  Object.freeze({ key: 'policyConstraints', label: 'Policy Constraints' }),
  Object.freeze({ key: 'institutionalIntelligence', label: 'Institutional/Insurer Intelligence' }),
  Object.freeze({ key: 'userRelevance', label: 'User Relevance' })
]);

const definitions = Object.freeze({
  sum_insured: { bucket: 'policyProtection', value: 'money', label: 'Sum insured' },
  covered_members: { bucket: 'policyProtection', value: 'list', label: 'Covered members' },
  coverage_period: { bucket: 'policyProtection', value: 'text', label: 'Coverage period' },
  hospitalisation_benefit: { bucket: 'policyProtection', value: 'text', label: 'Hospitalisation benefit' },
  room_rent_limit: { bucket: 'policyConstraints', value: 'moneyOrText', label: 'Room-rent rule' },
  copay: { bucket: 'policyConstraints', value: 'numberOrText', label: 'Co-pay rule' },
  deductible: { bucket: 'policyConstraints', value: 'moneyOrText', label: 'Deductible' },
  waiting_period: { bucket: 'policyConstraints', value: 'numberOrText', label: 'Waiting period' },
  exclusion: { bucket: 'policyConstraints', value: 'text', label: 'Exclusion' },
  procedure_limit: { bucket: 'policyConstraints', value: 'moneyOrText', label: 'Procedure-specific limit' },
  network_requirement: { bucket: 'policyConstraints', value: 'text', label: 'Network requirement' },
  insurer_name: { bucket: 'institutionalIntelligence', value: 'text', label: 'Insurer' },
  tpa_name: { bucket: 'institutionalIntelligence', value: 'text', label: 'TPA' },
  hr_route: { bucket: 'institutionalIntelligence', value: 'text', label: 'HR or benefits route' },
  tpa_route: { bucket: 'institutionalIntelligence', value: 'text', label: 'TPA route' },
  insurer_route: { bucket: 'institutionalIntelligence', value: 'text', label: 'Insurer route' },
  preauthorisation_status: { bucket: 'institutionalIntelligence', value: 'preauthorisation', label: 'Preauthorisation status', caseSpecific: true },
  institutional_question_status: { bucket: 'institutionalIntelligence', value: 'questionStatus', label: 'Institutional question status' },
  employee_enrolment: { bucket: 'userRelevance', value: 'enrolment', label: 'Employee enrolment', caseSpecific: true },
  dependent_enrolment: { bucket: 'userRelevance', value: 'enrolment', label: 'Dependent enrolment', caseSpecific: true },
  procedure_applicability: { bucket: 'userRelevance', value: 'applicability', label: 'Procedure applicability', caseSpecific: true }
});

const institutionalAuthorities = new Set(['authorised_hr', 'benefits_administrator', 'tpa', 'insurer']);
const caseSpecificFacts = new Set(['preauthorisation_status', 'employee_enrolment', 'dependent_enrolment', 'procedure_applicability']);
const requiredFacts = ['sum_insured', 'covered_members', 'coverage_period', 'room_rent_limit', 'copay', 'deductible', 'waiting_period', 'procedure_limit', 'network_requirement', 'insurer_route', 'tpa_route', 'employee_enrolment', 'procedure_applicability'];

const cleanText = value => typeof value === 'string' && value.trim() && value.trim().length <= MAX_TEXT ? value.trim() : null;
const citation = item => {
  const sourceId = cleanText(item?.sourceId);
  const version = cleanText(item?.version);
  const page = (typeof item?.page === 'number' && Number.isFinite(item.page) && item.page >= 1) || cleanText(item?.page) ? item.page : null;
  return sourceId && version && page !== null ? { sourceId, page, version } : null;
};
const stableValue = value => JSON.stringify(value, Object.keys(value && typeof value === 'object' && !Array.isArray(value) ? value : {}).sort());

function validValue(kind, value) {
  if (kind === 'money') return Number.isFinite(value) && value >= 0 && value <= 1_000_000_000;
  if (kind === 'text') return cleanText(value) !== null;
  if (kind === 'list') return Array.isArray(value) && value.length > 0 && value.length <= 20 && value.every(item => cleanText(item) !== null);
  if (kind === 'moneyOrText') return validValue('money', value) || validValue('text', value);
  if (kind === 'numberOrText') return (Number.isFinite(value) && value >= 0 && value <= 10_000) || validValue('text', value);
  if (kind === 'enrolment') return ['enrolled', 'not_enrolled', 'pending'].includes(value);
  if (kind === 'applicability') return ['applicable', 'not_applicable'].includes(value);
  if (kind === 'preauthorisation') return ['not_started', 'submitted', 'pending', 'query_raised', 'approved', 'denied'].includes(value);
  if (kind === 'questionStatus') return ['draft', 'approved_to_send', 'sent', 'acknowledged', 'answered', 'closed'].includes(value);
  return false;
}

function hasProperAuthority(item, fact) {
  if (!caseSpecificFacts.has(fact)) return ['document-backed', 'institution-confirmed'].includes(item.evidenceStatus);
  return item.evidenceStatus === 'institution-confirmed' && item.caseSpecific === true && institutionalAuthorities.has(item.authority);
}

function statementFor(fact, value) {
  const label = definitions[fact].label;
  if (fact === 'sum_insured') return `${label}: INR ${value}. This is a policy limit, not payable cash.`;
  if (fact === 'covered_members') return `${label}: ${value.join(', ')}.`;
  if (fact === 'preauthorisation_status') return `${label}: ${value}. This is a case status, not final settlement or a guaranteed payout.`;
  if (fact === 'procedure_applicability') return `${label}: ${value}. This records a case-specific institutional response, not claim approval or final settlement.`;
  if (fact.endsWith('_enrolment')) return `${label}: ${value}. This records the cited case-specific institutional status only.`;
  return `${label}: ${String(value)}.`;
}

function unknownFinding(fact, reason, source = null) {
  const definition = definitions[fact];
  return {
    id: `group-health:${fact}:unknown`,
    fact,
    bucket: definition.bucket,
    label: definition.label,
    status: 'unresolved',
    value: null,
    assertion: `${definition.label} is unresolved.`,
    citations: source ? [source] : [],
    reason
  };
}

/**
 * Analyze structured, synthetic group-health evidence for a coverage graph.
 * Evidence is data, not instructions. Unsupported fact types are ignored.
 */
export function analyzeGroupHealthCover({ policyId = 'unknown-group-policy', evidence = [] } = {}) {
  if (!Array.isArray(evidence)) throw new TypeError('evidence must be an array.');
  if (evidence.length > MAX_EVIDENCE) throw new RangeError(`evidence is limited to ${MAX_EVIDENCE} items.`);
  const safePolicyId = cleanText(policyId);
  if (!safePolicyId || safePolicyId.length > 120) throw new TypeError('policyId must be a short non-empty string.');

  const issues = [];
  const accepted = new Map();
  evidence.forEach((item, index) => {
    const fact = cleanText(item?.fact);
    const definition = definitions[fact];
    if (!definition) {
      issues.push({ index, code: 'unsupported_fact', fact: fact || null, message: 'Unsupported evidence cannot become a coverage assertion.' });
      return;
    }
    const source = citation(item);
    if (!source) {
      issues.push({ index, code: 'incomplete_citation', fact, message: 'Source id, page and version are required.' });
      return;
    }
    if (!validValue(definition.value, item.value)) {
      issues.push({ index, code: 'invalid_value', fact, message: 'Evidence value is outside the bounded schema.' });
      return;
    }
    if (!hasProperAuthority(item, fact)) {
      issues.push({ index, code: caseSpecificFacts.has(fact) ? 'insufficient_case_authority' : 'unsupported_evidence_status', fact, message: 'The supplied evidence cannot establish this fact.' });
      return;
    }
    const record = { item, source, valueKey: stableValue(item.value) };
    accepted.set(fact, [...(accepted.get(fact) || []), record]);
  });

  const findings = [];
  for (const [fact, records] of accepted) {
    const distinct = new Set(records.map(record => record.valueKey));
    if (distinct.size > 1) {
      records.forEach((record, index) => findings.push({
        id: `group-health:${fact}:conflict:${index + 1}`,
        fact,
        bucket: definitions[fact].bucket,
        label: definitions[fact].label,
        status: 'conflicting',
        value: structuredClone(record.item.value),
        assertion: statementFor(fact, record.item.value),
        citations: [record.source],
        reason: 'Source-backed values conflict. No value was selected.'
      }));
      findings.push(unknownFinding(fact, 'Conflicting source-backed values require review.'));
      continue;
    }
    const record = records[0];
    findings.push({
      id: `group-health:${fact}:1`,
      fact,
      bucket: definitions[fact].bucket,
      label: definitions[fact].label,
      status: record.item.evidenceStatus,
      value: structuredClone(record.item.value),
      assertion: statementFor(fact, record.item.value),
      citations: [record.source],
      ...(definitions[fact].caseSpecific ? { caseSpecific: true } : {})
    });
  }

  for (const fact of requiredFacts) {
    if (!accepted.has(fact)) {
      const relatedIssue = issues.find(issue => issue.fact === fact);
      findings.push(unknownFinding(fact, relatedIssue?.message || 'No qualifying evidence was supplied.'));
    }
  }

  const buckets = GROUP_HEALTH_BUCKETS.map(bucket => ({
    ...bucket,
    findings: findings.filter(finding => finding.bucket === bucket.key)
  }));
  const nodes = [
    { id: `group-health-policy:${safePolicyId}`, type: 'group_health_policy', label: safePolicyId, status: 'synthetic-evidence-only' },
    ...findings.map(finding => ({
      id: finding.id,
      type: 'coverage_fact',
      bucket: finding.bucket,
      fact: finding.fact,
      label: finding.label,
      status: finding.status,
      value: structuredClone(finding.value),
      assertion: finding.assertion,
      citations: structuredClone(finding.citations)
    }))
  ];
  const edges = findings.map(finding => ({ from: `group-health-policy:${safePolicyId}`, to: finding.id, relation: 'has_evidence_state' }));

  return {
    agent: 'group-health-cover-agent',
    policyId: safePolicyId,
    syntheticOnly: true,
    buckets,
    coverageGraph: { nodes, edges },
    unresolved: findings.filter(finding => ['unresolved', 'conflicting'].includes(finding.status)).map(finding => finding.id),
    issues,
    boundaries: [
      'Sum insured is a policy limit, not payable cash.',
      'Employer enrolment and procedure applicability require case-specific institutional evidence.',
      'Institutional intelligence records routing and case status only. It does not rate insurers or predict approval.',
      'Preauthorisation, claim approval and final settlement are separate states.'
    ]
  };
}
