export const POLICY_DECOMPOSITION = Object.freeze({
  documentIdentity: Object.freeze({ section: 'A', responsibility: 'Document identity and authority', patterns: ['policy', 'member', 'document', 'insurer', 'tpa', 'certificate'] }),
  continuity: Object.freeze({ section: 'B', responsibility: 'Policy lifecycle and continuity', patterns: ['effective', 'expiry', 'renewal', 'grace', 'continuity', 'portability', 'lapse', 'dependent'] }),
  enrolment: Object.freeze({ section: 'C', responsibility: 'People, eligibility and enrolment', patterns: ['profile', 'person', 'member', 'enrol', 'eligib', 'dependent', 'relationship'] }),
  financialRules: Object.freeze({ section: 'D', responsibility: 'Coverage structure and financial limits', patterns: ['sum', 'deduct', 'copay', 'co-pay', 'room_rent', 'limit', 'premium', 'cash'] }),
  benefits: Object.freeze({ section: 'E', responsibility: 'Medical benefits and treatment rules', patterns: ['benefit', 'procedure', 'treatment', 'maternity', 'ambulance', 'care'] }),
  exclusions: Object.freeze({ section: 'F', responsibility: 'Exclusions, waiting periods and disclosures', patterns: ['exclusion', 'waiting', 'disclosure', 'pre_existing', 'non_disclosure'] }),
  hospitalAccess: Object.freeze({ section: 'G', responsibility: 'Hospital access and cashless process', patterns: ['hospital', 'network', 'cashless', 'room', 'deposit', 'estimate'] }),
  claimsProcess: Object.freeze({ section: 'H', responsibility: 'Claim, pre-authorisation and reimbursement process', patterns: ['claim', 'preauthor', 'pre_author', 'reimburse', 'intimation'] }),
  renewalChange: Object.freeze({ section: 'I', responsibility: 'Renewal, portability and change control', patterns: ['renewal', 'portability', 'migration', 'version', 'premium', 'aged'] }),
  serviceResearch: Object.freeze({ section: 'J', responsibility: 'Service quality and external research', patterns: ['service', 'complaint', 'research', 'grievance', 'settlement'] }),
  householdAction: Object.freeze({ section: 'K', responsibility: 'Household recommendation and action plan', patterns: [] }),
});

const clone = value => structuredClone(value);
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function sourceReference(source = null) {
  return {
    sourceId: source?.id ?? source?.sourceId ?? null,
    document: source?.document ?? source?.id ?? source?.sourceId ?? null,
    version: source?.version ?? null,
    page: source?.page ?? source?.location ?? null,
    clause: source?.clause ?? null,
    confidence: Number.isFinite(source?.confidence) ? source.confidence : null,
    effectiveDate: source?.effectiveDate ?? null,
    humanCorrected: source?.humanCorrected === true,
  };
}

function evidenceState(status) {
  const value = String(status ?? '').toLowerCase();
  if (value.includes('conflict')) return 'Conflicting';
  if (/unknown|unresolved|unverified|missing|withheld|not.permitted/.test(value)) return 'Unknown';
  if (/institution|dynamic|dated/.test(value)) return 'Dynamic';
  if (/reported|user.stated|proxy|manual/.test(value)) return 'Reported';
  if (/calculated|derived/.test(value)) return 'Calculated';
  return 'Proven';
}

function searchable(fact) {
  return [fact.id, fact.type, fact.field, fact.fact, fact.dimension].filter(Boolean).join(' ').toLowerCase();
}

function normalizeFact(section, fact, index) {
  const source = fact.sources?.[0] ?? fact.source ?? null;
  return {
    id: `${section.toLowerCase()}:${fact.id ?? index + 1}`,
    field: fact.field ?? fact.fact ?? fact.type ?? 'unclassified',
    value: hasOwn(fact, 'value') ? clone(fact.value) : null,
    evidenceState: evidenceState(fact.status),
    provenance: sourceReference(source),
  };
}

export function decomposePolicySection(key, coverage) {
  const definition = POLICY_DECOMPOSITION[key];
  if (!definition || key === 'householdAction') throw new TypeError(`Unsupported policy decomposition worker: ${key}.`);
  const matched = coverage.facts.filter(fact => definition.patterns.some(pattern => searchable(fact).includes(pattern)));
  const facts = matched.map((fact, index) => normalizeFact(definition.section, fact, index));
  if (facts.length === 0) facts.push({
    id: `${definition.section.toLowerCase()}:evidence-gap`,
    field: 'required_evidence',
    value: null,
    evidenceState: 'Unknown',
    provenance: sourceReference(),
  });
  return {
    section: definition.section,
    responsibility: definition.responsibility,
    facts,
    boundaries: ['This worker structures evidence only. It does not decide payment, approval, treatment or purchase.'],
  };
}

export function buildHouseholdAction({ decision, sections }) {
  const unresolved = sections.flatMap(section => section.facts
    .filter(fact => ['Unknown', 'Conflicting', 'Dynamic'].includes(fact.evidenceState))
    .map(fact => `${section.section}.${fact.field}`));
  return {
    section: POLICY_DECOMPOSITION.householdAction.section,
    responsibility: POLICY_DECOMPOSITION.householdAction.responsibility,
    facts: [{
      id: 'k:bounded-action-route',
      field: 'candidate_route',
      value: { route: decision.route, humanApprovalRequired: true },
      evidenceState: 'Calculated',
      provenance: sourceReference(),
    }],
    recommendation: {
      authority: 'human_household_decision_required',
      route: decision.route,
      unresolved,
      externalActionsAuthorized: false,
    },
    boundaries: ['No purchase, renewal, port, payment or claim action is authorised by this output.'],
  };
}
