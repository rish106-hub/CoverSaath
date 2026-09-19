import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCoverageGraph } from '../src/agents/coverage-orchestrator.js';

const profilePacket = {
  subjectId: 'adult-1',
  source: { type: 'manual', id: 'profile-1', reporterId: 'adult-1', version: 'demo-v1', location: 'intake' },
  requestedFields: ['displayName', 'currentlyEmployed'],
  consent: { id: 'c1', subjectId: 'adult-1', status: 'granted', purpose: 'profile_intake', sources: ['manual'], fields: ['displayName', 'currentlyEmployed'] },
  data: { displayName: 'Synthetic adult' },
};
const groupPolicies = [{ policyId: 'DEMO-GROUP', evidence: [{ fact: 'room_rent_limit', value: 5000, sourceId: 'group-wording', page: 3, version: 'demo-v1', evidenceStatus: 'document-backed' }] }];
const personalPacket = { synthetic: true, consent: true, evidence: [{ id: 'copay', policyId: 'DEMO-PERSONAL', dimension: 'constraints', field: 'copay', value: '10% of eligible expenses', status: 'document_backed', source: { id: 'personal-wording', page: 5, version: 'demo-v1' } }] };

test('joins three specialist outputs without converting unknowns to false', () => {
  const graph = buildCoverageGraph({ profilePacket, groupPolicies, personalPacket });
  assert.equal(graph.generatedFrom.groupAgent, 'group-health-cover-agent');
  assert.ok(graph.facts.some(fact => fact.type === 'profile_fact'));
  assert.ok(graph.facts.some(fact => fact.type === 'coverage_fact'));
  assert.ok(graph.facts.some(fact => fact.type === 'personal_policy_fact'));
  assert.equal(graph.institutionalStatus, 'unresolved');
  assert.equal(graph.operator.status, 'unverified');
  assert.ok(graph.unknowns.some(value => /currentlyEmployed/.test(value)));
});

test('continuity status needs a cited verification event', () => {
  const withoutSources = buildCoverageGraph({ profilePacket, groupPolicies, personalPacket, continuity: { operator: { status: 'verified' }, readinessDrill: { status: 'passed' } } });
  assert.equal(withoutSources.operator.status, 'unverified');
  assert.equal(withoutSources.readinessDrill.status, 'not_run_or_unverified');
  const withSources = buildCoverageGraph({ profilePacket, groupPolicies, personalPacket, continuity: { operator: { status: 'verified', source: { id: 'operator-call' } }, readinessDrill: { status: 'passed', source: { id: 'drill-log' } } } });
  assert.equal(withSources.operator.status, 'verified');
  assert.equal(withSources.readinessDrill.status, 'passed');
});

test('case-specific procedure status requires authorised institutional evidence', () => {
  const confirmedGroup = [{ policyId: 'DEMO-GROUP', evidence: [{ fact: 'procedure_applicability', value: 'applicable', sourceId: 'tpa-reply', page: 'reply-1', version: 'demo-v1', evidenceStatus: 'institution-confirmed', caseSpecific: true, authority: 'tpa' }] }];
  const graph = buildCoverageGraph({ profilePacket, groupPolicies: confirmedGroup, personalPacket });
  assert.equal(graph.institutionalStatus, 'confirmed_for_case');
  assert.ok(graph.boundaries.some(value => /not case-specific claim approval/.test(value)));
});
