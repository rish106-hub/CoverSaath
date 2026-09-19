import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzePersonalHealthCover } from '../src/agents/personal-health-agent.js';

const source = (id, page) => ({ id, page, version: 'synthetic-v1' });

const input = () => ({
  synthetic: true,
  consent: true,
  evidence: [
    { id: 'p1-member', policyId: 'p1', subjectIds: ['adult-1'], dimension: 'protection', field: 'insured_member', value: 'Demo Adult', status: 'document_backed', source: source('schedule-p1', 1) },
    { id: 'p1-limit', policyId: 'p1', subjectIds: ['adult-1'], dimension: 'protection', field: 'sum_insured', value: 700000, status: 'document_backed', source: source('schedule-p1', 2) },
    { id: 'p1-period', policyId: 'p1', subjectIds: ['adult-1'], dimension: 'protection', field: 'policy_period', value: '2026-01-01 to 2026-12-31', status: 'document_backed', source: source('schedule-p1', 1) },
    { id: 'p1-copay', policyId: 'p1', dimension: 'constraints', field: 'copay', value: '10% of eligible expenses', status: 'document_backed', source: source('wording-p1', 14) },
    { id: 'p1-deductible', policyId: 'p1', dimension: 'constraints', field: 'deductible', value: 0, status: 'document_backed', source: source('wording-p1', 15) },
    { id: 'p1-premium', policyId: 'p1', dimension: 'economics', field: 'premium', value: 24000, status: 'document_backed', source: source('schedule-p1', 2) },
    { id: 'need', subjectIds: ['adult-1'], dimension: 'suitability', field: 'stated_need', value: 'Understand existing family protection before renewal', status: 'user_stated', source: source('demo-intake', 'answer-3') }
  ]
});

test('groups only source-linked assertions across all four dimensions', () => {
  const result = analyzePersonalHealthCover(input());
  assert.equal(result.dimensions.protection.assertions.length, 3);
  assert.equal(result.dimensions.constraints.assertions.length, 2);
  assert.equal(result.dimensions.economics.assertions.length, 1);
  assert.equal(result.dimensions.suitability.assertions.length, 1);
  for (const dimension of Object.values(result.dimensions)) {
    for (const assertion of dimension.assertions) {
      assert.ok(assertion.source.id);
      assert.notEqual(assertion.source.page, undefined);
      assert.equal(assertion.source.version, 'synthetic-v1');
    }
  }
  assert.equal(result.dimensions.economics.affordabilityConclusion, null);
  assert.equal(result.dimensions.suitability.regulatedProductRecommendation, null);
});

test('keeps high-impact fields unknown even when confident synthetic values are supplied', () => {
  const caseInput = input();
  caseInput.evidence.push(
    { id: 'claimed-approval', policyId: 'p1', dimension: 'suitability', field: 'claim_approval', value: 'approved', status: 'institution_confirmed', source: source('synthetic-reply', 1) },
    { id: 'claimed-history', policyId: 'p1', dimension: 'suitability', field: 'medical_history', value: 'complete', status: 'document_backed', source: source('synthetic-history', 2) }
  );
  const result = analyzePersonalHealthCover(caseInput);
  assert.deepEqual(result.dimensions.suitability.assertions.map(item => item.field), ['stated_need']);
  assert.deepEqual(result.dimensions.suitability.ignoredCriticalEvidence.map(item => item.field), ['claim_approval', 'medical_history']);
  for (const field of ['medical_history', 'continuity', 'disclosures', 'eligibility', 'claim_approval']) {
    assert.equal(result.dimensions.suitability.evidenceGaps.find(item => item.field === field)?.status, 'unknown');
  }
});

test('asks for the issued dependent-age rule instead of inventing one', () => {
  const caseInput = input();
  caseInput.evidence.push({ id: 'relationship', policyId: 'p1', subjectIds: ['child-1'], dimension: 'protection', field: 'relationship', value: 'dependent child', status: 'document_backed', source: source('schedule-p1', 1) });
  const result = analyzePersonalHealthCover(caseInput);
  const ageGap = result.dimensions.suitability.evidenceGaps.find(item => item.field === 'dependent_age_rule');
  assert.equal(ageGap.status, 'unknown');
  assert.match(ageGap.reason, /No age rule is inferred/);
  assert.doesNotMatch(JSON.stringify(result), /\b(?:18|21|25|30)\s*(?:years?|yrs?)\b/i);
});

test('fails closed without synthetic scope, consent, or complete source provenance', () => {
  assert.throws(() => analyzePersonalHealthCover({ ...input(), synthetic: false }), /explicitly synthetic/);
  assert.throws(() => analyzePersonalHealthCover({ ...input(), consent: false }), /consent/);
  const missingPage = input();
  missingPage.evidence[0] = { ...missingPage.evidence[0], source: { id: 'schedule-p1', version: 'synthetic-v1' } };
  assert.throws(() => analyzePersonalHealthCover(missingPage), /source page/);
});

test('does not mutate input or produce financial, treatment, or delay advice', () => {
  const caseInput = input();
  const before = structuredClone(caseInput);
  const result = analyzePersonalHealthCover(caseInput);
  assert.deepEqual(caseInput, before);
  const output = JSON.stringify(result);
  assert.doesNotMatch(output, /(?:should|must|recommend(?:ed)?)\s+(?:borrow|sell|liquidate|choose|delay)/i);
  assert.equal(result.dimensions.suitability.classification, 'evidence_gaps_and_questions');
});

