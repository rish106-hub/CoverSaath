import { normalizeProfileIntake } from '../../agents/profile-agent.js';
import { analyzeGroupHealthCover } from '../../agents/group-health-agent.js';
import { analyzePersonalHealthCover } from '../../agents/personal-health-agent.js';
import { classifyCase } from '../../agents/decision-agent.js';
import { sanitizeEvidenceForModel } from '../ai-analysis/privacy-evidence-gate.js';
import { MODEL_EXTRACTED_UNVERIFIED } from './agent-contracts.js';
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
    sources: (fact.sources ?? [fact.source]).filter(Boolean)
      .map(source => ({ id: source.id, page: source.location ?? source.page, version: source.version })),
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
    sources: (assertion.sources ?? [assertion.source]).filter(Boolean).map(source => ({ ...source })),
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
  // A model-extracted value is a candidate, not an established fact: it stays an
  // explicit unknown until deterministic code or a human reviewer resolves it.
  const unverifiedUnknowns = [...new Set(facts
    .filter(fact => fact.status === MODEL_EXTRACTED_UNVERIFIED)
    .map(fact => `${fact.field ?? fact.fact} is model-extracted and awaits review.`))];
  const continuity = input.continuity ?? {};
  const operator = continuity.operator?.status === 'verified' && continuity.operator?.source
    ? clone(continuity.operator)
    : { status: 'unverified' };
  const confirmedProcedure = facts.some(fact => fact.fact === 'procedure_applicability' && fact.status === 'institution-confirmed');
  return {
    kind: 'source_linked_household_coverage_graph',
    facts,
    unknowns: [...new Set([...profileUnknowns, ...groupUnknowns, ...personalUnknowns, ...unverifiedUnknowns])],
    operator,
    institutionalStatus: confirmedProcedure ? 'confirmed_for_case' : 'unresolved',
    boundaries: [
      'Unknown is not false.',
      'Source-linked policy terms are not case-specific claim approval.',
      'Policy limits are not spendable or payable cash.',
    ],
  };
}

// The privacy gate replaces raw source ids with opaque ids before model dispatch,
// so live citations come back as `source_<digest>`. Deterministic review maps them
// back through the run's persisted authorised raw source ids using the gate's own
// derivation, never through anything the model returned. An id that is neither an
// authorised raw id nor the exact opaque id of one stays unauthorised (fail closed).
function opaqueSourceIdFor(rawId) {
  try {
    const { input } = sanitizeEvidenceForModel({
      context: { caseId: 'review', subjectId: 'review', purpose: 'Derive opaque source id.', requestedFields: [] },
      sources: [{ id: rawId, version: 'review', page: null, text: 'review', status: 'known' }],
      upstream: [],
    }, { task: 'source_id_mapping' });
    return input.sources[0].id;
  } catch {
    return null;
  }
}

function authorizedCitationIds(input) {
  const rawIds = Array.isArray(input.authorizedSourceIds) ? input.authorizedSourceIds.filter(id => typeof id === 'string' && id !== '') : [];
  const pairedIds = Array.isArray(input.authorizedSources)
    ? new Set(input.authorizedSources.map(source => source?.sourceId))
    : null;
  const allowed = new Set(rawIds);
  // Opaque ids only exist for live runs, which persist authorizedSources (source-input.js).
  // Where present it must agree with authorizedSourceIds for the mapping to apply.
  if (pairedIds) {
    for (const rawId of rawIds) {
      if (!pairedIds.has(rawId)) continue;
      const opaque = opaqueSourceIdFor(rawId);
      if (opaque) allowed.add(opaque);
    }
  }
  return allowed;
}

function reviewEvidence({ input, upstream }) {
  const allowed = authorizedCitationIds(input);
  const facts = [
    ...upstream.coverage.facts,
    ...Object.keys(POLICY_DECOMPOSITION)
      .filter(key => key !== 'householdAction')
      .flatMap(key => upstream[key]?.facts ?? []),
  ];
  const findings = [];
  // Sources the intake excluded or could not send are reported, never silently dropped.
  for (const blocker of Array.isArray(input.sourceBlockers) ? input.sourceBlockers : []) {
    findings.push({ code: blocker.code, reasonCode: blocker.reasonCode, documentId: blocker.documentId });
  }
  for (const fact of upstream.coverage.facts) {
    // Criteria 6 and 11: model output is unverified evidence. It blocks release
    // as review-required until deterministic code or a human resolves it.
    if (fact.status === MODEL_EXTRACTED_UNVERIFIED) findings.push({ code: 'HUMAN_REVIEW_REQUIRED', reasonCode: MODEL_EXTRACTED_UNVERIFIED, factId: fact.id });
  }
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
  const allowed = authorizedCitationIds(input);
  if (upstream.coverage.facts.some(fact => fact.sources.some(source => !allowed.has(source.id)))) {
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
  const unknownFacts = upstream.coverage.facts.filter(fact => ['unknown', 'unresolved', 'conflicting', MODEL_EXTRACTED_UNVERIFIED].includes(fact.status));
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
