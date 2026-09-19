import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeGroupHealthCover, GROUP_HEALTH_BUCKETS } from '../src/agents/group-health-agent.js';

const source = (fact, value, overrides = {}) => ({
  fact,
  value,
  sourceId: `group-booklet:${fact}`,
  page: 4,
  version: 'synthetic-v1',
  evidenceStatus: 'document-backed',
  ...overrides
});

test('returns the four bounded buckets and source-linked coverage graph nodes', () => {
  const result = analyzeGroupHealthCover({ policyId: 'DEMO-GROUP', evidence: [
    source('sum_insured', 500000),
    source('covered_members', ['Synthetic employee', 'Synthetic parent']),
    source('coverage_period', '01 Jan to 31 Dec 2026'),
    source('room_rent_limit', 5000),
    source('insurer_route', 'Synthetic insurer service desk')
  ] });
  assert.deepEqual(result.buckets.map(bucket => bucket.label), GROUP_HEALTH_BUCKETS.map(bucket => bucket.label));
  const confirmed = result.coverageGraph.nodes.filter(node => node.type === 'coverage_fact' && node.status === 'document-backed');
  assert.ok(confirmed.every(node => node.citations.length === 1));
  assert.ok(confirmed.every(node => ['sourceId', 'page', 'version'].every(key => node.citations[0][key])));
  assert.equal(result.coverageGraph.edges.length, result.coverageGraph.nodes.length - 1);
});

test('sum insured is never represented as payable cash', () => {
  const result = analyzeGroupHealthCover({ evidence: [source('sum_insured', 500000)] });
  const finding = result.buckets.find(bucket => bucket.key === 'policyProtection').findings.find(item => item.fact === 'sum_insured');
  assert.match(finding.assertion, /not payable cash/i);
  assert.equal(result.coverageGraph.nodes.some(node => node.confirmedPayable != null), false);
});

test('missing source location fails closed as unknown', () => {
  const result = analyzeGroupHealthCover({ evidence: [source('sum_insured', 500000, { page: null })] });
  const finding = result.buckets.find(bucket => bucket.key === 'policyProtection').findings.find(item => item.fact === 'sum_insured');
  assert.equal(finding.status, 'unresolved');
  assert.equal(finding.value, null);
  assert.deepEqual(finding.citations, []);
  assert.equal(result.issues[0].code, 'incomplete_citation');
});

test('booklet text cannot establish enrolment or procedure applicability', () => {
  const result = analyzeGroupHealthCover({ evidence: [
    source('employee_enrolment', 'enrolled'),
    source('procedure_applicability', 'applicable')
  ] });
  const relevance = result.buckets.find(bucket => bucket.key === 'userRelevance').findings;
  assert.ok(relevance.filter(item => ['employee_enrolment', 'procedure_applicability'].includes(item.fact)).every(item => item.status === 'unresolved'));
  assert.ok(result.issues.every(issue => issue.code === 'insufficient_case_authority'));
});

test('case-specific institutional evidence records status without predicting settlement', () => {
  const authority = { evidenceStatus: 'institution-confirmed', caseSpecific: true, authority: 'tpa' };
  const result = analyzeGroupHealthCover({ evidence: [
    source('employee_enrolment', 'enrolled', authority),
    source('procedure_applicability', 'applicable', authority),
    source('preauthorisation_status', 'approved', authority)
  ] });
  const confirmed = result.coverageGraph.nodes.filter(node => node.status === 'institution-confirmed');
  assert.equal(confirmed.length, 3);
  assert.match(confirmed.find(node => node.fact === 'procedure_applicability').assertion, /not claim approval/i);
  assert.match(confirmed.find(node => node.fact === 'preauthorisation_status').assertion, /not final settlement/i);
});

test('insurer ratings and predicted approval are rejected as unsupported facts', () => {
  const result = analyzeGroupHealthCover({ evidence: [
    source('insurer_rating', 'best'),
    source('predicted_claim_approval', 'likely')
  ] });
  assert.deepEqual(result.issues.map(issue => issue.code), ['unsupported_fact', 'unsupported_fact']);
  assert.equal(result.coverageGraph.nodes.some(node => ['insurer_rating', 'predicted_claim_approval'].includes(node.fact)), false);
  assert.match(result.boundaries.join(' '), /does not rate insurers or predict approval/i);
});

test('conflicting versions remain visible and unresolved', () => {
  const result = analyzeGroupHealthCover({ evidence: [
    source('room_rent_limit', 5000, { sourceId: 'booklet-v1', version: 'v1' }),
    source('room_rent_limit', 8000, { sourceId: 'endorsement-v2', version: 'v2', page: 1 })
  ] });
  const room = result.buckets.find(bucket => bucket.key === 'policyConstraints').findings.filter(item => item.fact === 'room_rent_limit');
  assert.equal(room.filter(item => item.status === 'conflicting').length, 2);
  assert.equal(room.at(-1).status, 'unresolved');
  assert.ok(room.slice(0, 2).every(item => item.citations.length === 1));
});

test('analysis is deterministic, does not mutate input and enforces evidence bound', () => {
  const evidence = [source('tpa_route', 'Synthetic TPA desk')];
  const before = structuredClone(evidence);
  assert.deepEqual(analyzeGroupHealthCover({ evidence }), analyzeGroupHealthCover({ evidence }));
  assert.deepEqual(evidence, before);
  assert.throws(() => analyzeGroupHealthCover({ evidence: Array.from({ length: 65 }, () => source('tpa_route', 'Desk')) }), /limited to 64/);
  assert.throws(() => analyzeGroupHealthCover({ evidence: {} }), /array/);
});
