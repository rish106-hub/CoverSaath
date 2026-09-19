import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCase } from '../src/agents/decision-agent.js';

test('emergency classification routes to care without predicting approval', () => {
  const result = classifyCase({ trigger: 'emergency', statedEstimate: 500000 });
  assert.equal(result.route, 'admit_first_human_handoff');
  assert.equal(result.score, null);
  assert.equal(result.probabilityOfApproval, null);
  assert.equal(result.dimensions.financialExposure.confirmedPayable, null);
});

test('unknown is not converted to false or a numeric risk score', () => {
  const result = classifyCase({
    trigger: 'planned_care',
    coverageGraph: {
      facts: [{ id: 'room', sources: [{ id: 'policy:room' }] }],
      unknowns: ['Therapy applicability is unresolved.'],
      operator: { status: 'unverified' },
      readinessDrill: { status: 'not_run' },
    },
  });
  assert.equal(result.dimensions.coverageDeficiency.class, 'unknown');
  assert.equal(result.dimensions.continuityRisk.class, 'unresolved');
  assert.equal(result.route, 'collect_evidence_and_human_review');
  assert.ok(result.unknowns.includes('Therapy applicability is unresolved.'));
});

test('fully confirmed inputs still require rules and household decision', () => {
  const result = classifyCase({
    trigger: 'renewal',
    coverageGraph: {
      facts: [{ id: 'term', sources: [{ id: 'policy:term' }] }],
      operator: { status: 'verified' },
      readinessDrill: { status: 'passed' },
      institutionalStatus: 'confirmed_for_case',
    },
  });
  assert.equal(result.route, 'rules_review_then_household_decision');
  assert.equal(result.dimensions.evidenceConfidence.class, 'source_linked_but_not_authoritative');
});

test('invalid trigger and estimate fail closed', () => {
  assert.throws(() => classifyCase({ trigger: 'claim_prediction' }), /supported trigger/);
  assert.throws(() => classifyCase({ trigger: 'renewal', statedEstimate: -1 }), /non-negative/);
});
