import { normalizeProfileIntake } from '../../agents/profile-agent.js';
import { analyzeGroupHealthCover } from '../../agents/group-health-agent.js';
import { analyzePersonalHealthCover } from '../../agents/personal-health-agent.js';
import { classifyCase } from '../../agents/decision-agent.js';
import { buildHouseholdAction, decomposePolicySection, POLICY_DECOMPOSITION } from './policy-decomposition.js';

const clone = value => structuredClone(value);
const verdict = (status, findings = []) => ({ status, findings });

function profileFacts(profile) {
  return Object.entries(profile.profile).map(([field, fact]) => ({
    id: `profile:${field}`,
    type: 'profile_fact',
    field,
    value: clone(fact.value),
    status: fact.status,
    sources: [{ id: fact.source.id, page: fact.source.location, version: fact.source.version }],
  }));
}

function groupFacts(analyses) {
  return analyses.flatMap(analysis => analysis.coverageGraph.nodes
    .filter(node => node.type === 'coverage_fact')
    .map(node => ({
      id: `${analysis.policyId}:${node.id}`,
      type: 'coverage_fact',
      policyId: analysis.policyId,
      fact: node.fact,
      value: clone(node.value),
      status: node.status,
      sources: node.citations.map(source => ({ id: source.sourceId, page: source.page, version: source.version })),
    })));
}

function personalFacts(analysis) {
  return Object.entries(analysis.dimensions).flatMap(([dimension, section]) => (section.assertions ?? []).map(assertion => ({
    id: `personal:${assertion.id}`,
    type: 'personal_policy_fact',
    dimension,
    policyId: assertion.policyId,
    field: assertion.field,
    value: clone(assertion.value),
    status: assertion.status,
    sources: [{ ...assertion.source }],
  })));
}

function assembleCoverageGraph({ input, upstream }) {
  const profile = upstream.profile;
  const group = upstream.group;
  const personal = upstream.personal;
  const facts = [...profileFacts(profile), ...groupFacts(group), ...personalFacts(personal)];
  const duplicate = facts.find((fact, index) => facts.findIndex(candidate => candidate.id === fact.id) !== index);
  if (duplicate) throw new Error(`Duplicate coverage fact id: ${duplicate.id}.`);
  const profileUnknowns = Object.entries(profile.profile).filter(([, fact]) => fact.status === 'unknown').map(([field]) => `Profile field ${field} is unknown.`);
  const groupUnknowns = group.flatMap(analysis => analysis.unresolved.map(id => `${analysis.policyId}: ${id}.`));
  const personalUnknowns = personal.dimensions.suitability.evidenceGaps.map(gap => gap.reason);
  const continuity = input.continuity ?? {};
  const operator = continuity.operator?.status === 'verified' && continuity.operator?.source
    ? clone(continuity.operator)
    : { status: 'unverified' };
  const confirmedProcedure = facts.some(fact => fact.fact === 'procedure_applicability' && fact.status === 'institution-confirmed');
  return {
    kind: 'source_linked_household_coverage_graph',
    facts,
    unknowns: [...new Set([...profileUnknowns, ...groupUnknowns, ...personalUnknowns])],
    operator,
    institutionalStatus: confirmedProcedure ? 'confirmed_for_case' : 'unresolved',
    boundaries: [
      'Unknown is not false.',
      'Source-linked policy terms are not case-specific claim approval.',
      'Policy limits are not spendable or payable cash.',
    ],
  };
}

function reviewEvidence({ input, upstream }) {
  const allowed = new Set(input.authorizedSourceIds ?? []);
  const facts = [
    ...upstream.coverage.facts,
    ...Object.keys(POLICY_DECOMPOSITION)
      .filter(key => key !== 'householdAction')
      .flatMap(key => upstream[key]?.facts ?? []),
  ];
  const findings = [];
  for (const fact of facts) {
    const unresolved = ['unknown', 'unresolved', 'conflicting'].includes(fact.status)
      || ['Unknown', 'Conflicting'].includes(fact.evidenceState);
    const sources = fact.sources ?? (fact.provenance?.sourceId ? [{ id: fact.provenance.sourceId }] : []);
    if (sources.length === 0 && !unresolved && fact.evidenceState !== 'Calculated') {
      findings.push({ code: 'SOURCE_REQUIRED', factId: fact.id });
    }
    for (const source of sources) if (!allowed.has(source.id)) findings.push({ code: 'SOURCE_NOT_AUTHORIZED', factId: fact.id, sourceId: source.id });
  }
  return verdict(findings.length ? 'blocked' : 'passed', findings);
}

function reviewPrivacy({ input, upstream }) {
  const findings = [];
  if (input.consent !== true) findings.push({ code: 'CONSENT_REQUIRED' });
  if (upstream.coverage.facts.some(fact => fact.sources.some(source => !input.authorizedSourceIds.includes(source.id)))) {
    findings.push({ code: 'UNSCOPED_SOURCE' });
  }
  return verdict(findings.length ? 'blocked' : 'passed', findings);
}

function reviewSafety({ upstream }) {
  const findings = [];
  if (upstream.decision.probabilityOfApproval !== null) findings.push({ code: 'APPROVAL_PROBABILITY_PROHIBITED' });
  if (upstream.coverage.facts.some(fact => fact.confirmedPayable != null)) findings.push({ code: 'PAYABLE_CASH_ASSERTION_PROHIBITED' });
  return verdict(findings.length ? 'blocked' : 'passed', findings);
}

function synthesize({ upstream }) {
  const reviews = ['evidence', 'privacy', 'safety'].map(key => upstream[key]);
  const blockers = reviews.flatMap(review => review.status === 'blocked' ? review.findings : []);
  return {
    status: blockers.length ? 'blocked' : 'ready',
    route: upstream.decision.route,
    unknowns: [...upstream.decision.unknowns],
    blockers,
    questions: clone(upstream.questions.questions),
    householdAction: clone(upstream.householdAction),
    summary: blockers.length
      ? 'Release blocked by deterministic review.'
      : 'Fixture evidence analysis is ready. No purchase, payment, claim or insurer decision is authorised.',
  };
}

function draftQuestions({ upstream }) {
  const unknownFacts = upstream.coverage.facts.filter(fact => ['unknown', 'unresolved', 'conflicting'].includes(fact.status));
  const factQuestions = unknownFacts.flatMap(fact => {
    const citations = [...new Set((fact.sources ?? []).map(source => source.id).filter(Boolean))];
    if (citations.length === 0) return [];
    const label = fact.field ?? fact.fact ?? fact.id;
    return [{
      id: `question:${fact.id}`,
      text: `What does the current authoritative record confirm for ${label}?`,
      authorityOwner: 'insurer',
      citations,
    }];
  });
  const availableSources = [...new Set(upstream.coverage.facts.flatMap(fact => (fact.sources ?? []).map(source => source.id)).filter(Boolean))];
  const decisionQuestions = availableSources.length === 0 ? [] : upstream.decision.unknowns.map((unknown, index) => ({
    id: `question:decision:${index + 1}`,
    text: `Which named authority can confirm this unresolved point: ${unknown.replace(/[.?]+$/, '')}?`,
    authorityOwner: 'insurer',
    citations: availableSources.slice(0, 8),
  }));
  const questions = [...factQuestions, ...decisionQuestions].slice(0, 16);
  return {
    questions,
    unresolvedSourceIds: [...new Set(questions.flatMap(question => question.citations))],
  };
}

export function createFixtureTaskRegistry() {
  const registry = {
    profile: ({ input }) => normalizeProfileIntake(input.profilePacket),
    group: ({ input }) => input.groupPolicies.map(policy => analyzeGroupHealthCover(policy)),
    personal: ({ input }) => analyzePersonalHealthCover(input.personalPacket),
    coverage: assembleCoverageGraph,
    ...Object.fromEntries(Object.keys(POLICY_DECOMPOSITION)
      .filter(key => key !== 'householdAction')
      .map(key => [key, ({ upstream }) => decomposePolicySection(key, upstream.coverage)])),
    decision: ({ input, upstream }) => classifyCase({
      trigger: input.trigger,
      statedEstimate: input.statedEstimate ?? 0,
      coverageGraph: upstream.coverage,
    }),
    evidence: reviewEvidence,
    privacy: reviewPrivacy,
    safety: reviewSafety,
    questions: draftQuestions,
    householdAction: ({ upstream }) => buildHouseholdAction({
      decision: upstream.decision,
      sections: Object.keys(POLICY_DECOMPOSITION)
        .filter(key => key !== 'householdAction')
        .map(key => upstream[key]),
    }),
    primary: synthesize,
    release: ({ upstream }) => upstream.primary.status === 'blocked'
      ? { status: 'blocked', blockers: clone(upstream.primary.blockers), externalActionsAuthorized: false }
      : { status: 'released', blockers: [], externalActionsAuthorized: false },
  };
  return Object.freeze(registry);
}
