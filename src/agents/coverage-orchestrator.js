import { normalizeProfileIntake } from './profile-agent.js';
import { analyzeGroupHealthCover } from './group-health-agent.js';
import { analyzePersonalHealthCover } from './personal-health-agent.js';

const clone = value => structuredClone(value);

function personalAssertions(analysis) {
  return Object.entries(analysis.dimensions).flatMap(([dimension, section]) =>
    (section.assertions || []).map(assertion => ({
      id: `personal:${assertion.id}`,
      type: 'personal_policy_fact',
      dimension,
      field: assertion.field,
      value: clone(assertion.value),
      status: assertion.status,
      sources: [{ ...assertion.source }],
    })),
  );
}

function profileFacts(profile) {
  return Object.entries(profile.profile).map(([field, fact]) => ({
    id: `profile:${field}`,
    type: 'profile_fact',
    field,
    value: clone(fact.value),
    status: fact.status,
    verificationStatus: fact.verificationStatus,
    sources: [{
      id: fact.source.id,
      page: fact.source.location,
      version: fact.source.version,
      sourceType: fact.source.type,
    }],
  }));
}

function groupFacts(analyses) {
  return analyses.flatMap(analysis => analysis.coverageGraph.nodes
    .filter(node => node.type === 'coverage_fact')
    .map(node => ({
      ...clone(node),
      id: `${analysis.policyId}:${node.id}`,
      policyId: analysis.policyId,
      sources: node.citations.map(citation => ({
        id: citation.sourceId,
        page: citation.page,
        version: citation.version,
      })),
    })));
}

export function buildCoverageGraph({ profilePacket, groupPolicies = [], personalPacket, continuity = {} } = {}) {
  if (!profilePacket || !personalPacket || !Array.isArray(groupPolicies) || groupPolicies.length === 0) {
    throw new Error('Profile, group policy and personal policy packets are required.');
  }

  const profile = normalizeProfileIntake(profilePacket);
  const group = groupPolicies.map(policy => analyzeGroupHealthCover(policy));
  const personal = analyzePersonalHealthCover(personalPacket);
  const facts = [...profileFacts(profile), ...groupFacts(group), ...personalAssertions(personal)];
  const duplicate = facts.find((fact, index) => facts.findIndex(candidate => candidate.id === fact.id) !== index);
  if (duplicate) throw new Error(`Duplicate coverage fact id: ${duplicate.id}.`);

  const profileUnknowns = Object.entries(profile.profile)
    .filter(([, fact]) => fact.status === 'unknown')
    .map(([field]) => `Profile field ${field} is unknown.`);
  const groupUnknowns = group.flatMap(analysis => analysis.unresolved.map(id => `${analysis.policyId}: ${id}.`));
  const personalUnknowns = personal.dimensions.suitability.evidenceGaps.map(gap => gap.reason);
  const unknowns = [...new Set([...profileUnknowns, ...groupUnknowns, ...personalUnknowns])];
  const confirmedProcedure = facts.some(fact =>
    fact.type === 'coverage_fact' && fact.fact === 'procedure_applicability' && fact.status === 'institution-confirmed',
  );

  const operator = continuity.operator?.status === 'verified' && continuity.operator?.source
    ? { status: 'verified', source: clone(continuity.operator.source) }
    : { status: 'unverified' };
  const readinessDrill = continuity.readinessDrill?.status === 'passed' && continuity.readinessDrill?.source
    ? { status: 'passed', source: clone(continuity.readinessDrill.source) }
    : { status: 'not_run_or_unverified' };

  return {
    kind: 'source_linked_household_coverage_graph',
    generatedFrom: {
      profileAgent: 'profile-and-hrms-intake-agent',
      groupAgent: 'group-health-cover-agent',
      personalAgent: 'personal-health-cover-agent',
    },
    facts,
    unknowns,
    operator,
    readinessDrill,
    institutionalStatus: confirmedProcedure ? 'confirmed_for_case' : 'unresolved',
    analyses: { profile, group, personal },
    boundaries: [
      'Unknown is not false.',
      'Source-linked policy terms are not case-specific claim approval.',
      'The graph does not add policy limits into spendable or payable cash.',
      'A human or authorised institution resolves high-impact uncertainty.',
    ],
  };
}
