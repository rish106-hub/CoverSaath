import test from 'node:test';
import assert from 'node:assert/strict';
import {
  POLICY_PARAMETER_REGISTRY,
  POLICY_PARAMETER_REGISTRY_VERSION,
  getPolicyParameterDefinition,
  getPolicyParameterRegistry,
  validatePolicyParameterRegistry,
} from '../src/features/coverage-analysis/policy-parameter-registry.js';
import {
  PARAMETER_ACQUISITION_STATES,
  PARAMETER_RESOLUTION_STATES,
  assertAcquisitionTransition,
  assertResolutionTransition,
  createParameterRecord,
  transitionParameterRecord,
  validateParameterRecord,
} from '../src/features/coverage-analysis/parameter-records.js';

const now = '2026-10-09T10:00:00.000Z';
const observation = (id, value) => ({
  id,
  value,
  sourceId: `source-${id}`,
  documentId: `document-${id}`,
  version: 'v1',
  page: 3,
  extractionMethod: 'document_extraction',
  reviewStatus: 'not_reviewed',
});

test('canonical registry covers every catalogue row and is deeply immutable', () => {
  assert.equal(POLICY_PARAMETER_REGISTRY.version, POLICY_PARAMETER_REGISTRY_VERSION);
  assert.equal(POLICY_PARAMETER_REGISTRY.parameters.length, 138);
  assert.deepEqual([...new Set(POLICY_PARAMETER_REGISTRY.parameters.map(entry => entry.section))], ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K']);
  assert.equal(new Set(POLICY_PARAMETER_REGISTRY.parameters.map(entry => entry.key)).size, 138);
  assert.ok(POLICY_PARAMETER_REGISTRY.parameters.every(entry => Object.isFrozen(entry) && Object.isFrozen(entry.expectedSources) && Object.isFrozen(entry.modelExtraction)));
  assert.throws(() => { POLICY_PARAMETER_REGISTRY.parameters[0].label = 'changed'; }, TypeError);
  assert.equal(getPolicyParameterDefinition(POLICY_PARAMETER_REGISTRY_VERSION, 'd.room_rent_limit').section, 'D');
});

test('registry validation rejects unknown versions, duplicate keys, and invalid entries', () => {
  assert.throws(() => getPolicyParameterRegistry('policy-parameters/missing'), /Unknown policy parameter registry version/);
  const duplicate = structuredClone(POLICY_PARAMETER_REGISTRY);
  duplicate.parameters.push(structuredClone(duplicate.parameters[0]));
  assert.throws(() => validatePolicyParameterRegistry(duplicate), /Duplicate policy parameter key/);
  const invalid = structuredClone(POLICY_PARAMETER_REGISTRY);
  invalid.parameters[0].dataClass = 'SECRET';
  assert.throws(() => validatePolicyParameterRegistry(invalid), /Invalid data class/);
});

test('acquisition and resolution states are separate and transitions fail closed', () => {
  assert.deepEqual(PARAMETER_ACQUISITION_STATES, ['not_requested', 'requested', 'received', 'rejected', 'not_permitted']);
  assert.deepEqual(PARAMETER_RESOLUTION_STATES, ['unknown', 'reported', 'extracted_unverified', 'proven', 'calculated', 'dynamic', 'conflicting', 'not_permitted']);
  assert.equal(assertAcquisitionTransition('not_requested', 'requested'), 'requested');
  assert.throws(() => assertAcquisitionTransition('not_requested', 'received'), /Invalid acquisition transition/);
  assert.equal(assertResolutionTransition('unknown', 'proven'), 'proven');
  for (const state of ['reported', 'proven', 'calculated', 'dynamic', 'not_permitted']) {
    assert.throws(() => assertResolutionTransition('unknown', state, { authority: 'model' }), /Model authority cannot create resolution state/);
  }
  assert.equal(assertResolutionTransition('unknown', 'extracted_unverified', { authority: 'model' }), 'extracted_unverified');
  assert.equal(assertResolutionTransition('unknown', 'conflicting', { authority: 'model' }), 'conflicting');
  assert.throws(() => assertResolutionTransition('unknown', 'proven', { authority: 'untrusted' }), /Unsupported parameter transition authority/);
});

test('resolved observations require complete provenance and conflicts preserve all observations', () => {
  const base = createParameterRecord({
    registryVersion: POLICY_PARAMETER_REGISTRY_VERSION,
    parameterKey: 'd.room_rent_limit',
    subjectId: 'subject-1',
    policyId: 'policy-1',
    updatedAt: now,
  });
  assert.equal(base.acquisitionState, 'not_requested');
  assert.equal(base.resolutionState, 'unknown');
  const requested = transitionParameterRecord(base, { acquisitionState: 'requested', updatedAt: now });
  const received = transitionParameterRecord(requested, {
    acquisitionState: 'received',
    resolutionState: 'extracted_unverified',
    observations: [observation('one', 'single private room')],
    resolvedValue: 'single private room',
    updatedAt: now,
  }, { authority: 'model' });
  assert.equal(received.observations[0].version, 'v1');

  const conflicting = transitionParameterRecord(received, {
    resolutionState: 'conflicting',
    observations: [observation('one', 'single private room'), observation('two', '₹5,000 per day')],
    resolvedValue: ['single private room', '₹5,000 per day'],
    updatedAt: now,
  });
  assert.equal(conflicting.observations.length, 2);

  const missingProvenance = structuredClone(received);
  delete missingProvenance.observations[0].documentId;
  assert.throws(() => validateParameterRecord(missingProvenance), /documentId is required/);
});

test('unknown never means false and permission denial remains explicit', () => {
  const base = createParameterRecord({
    registryVersion: POLICY_PARAMETER_REGISTRY_VERSION,
    parameterKey: 'c.proposal_form_declarations',
    subjectId: 'subject-1',
    policyId: 'policy-1',
    updatedAt: now,
  });
  assert.equal(base.resolvedValue, null);
  assert.throws(() => validateParameterRecord({ ...base, resolvedValue: false }), /Resolved value must be null/);
  const denied = transitionParameterRecord(base, {
    acquisitionState: 'not_permitted',
    resolutionState: 'not_permitted',
    reasonCode: 'CONSENT_NOT_GRANTED',
    updatedAt: now,
  });
  assert.equal(denied.acquisitionState, 'not_permitted');
  assert.equal(denied.resolutionState, 'not_permitted');
  const requested = transitionParameterRecord(base, { acquisitionState: 'requested', updatedAt: now });
  assert.throws(() => transitionParameterRecord(requested, {
    acquisitionState: 'received',
    resolutionState: 'extracted_unverified',
    observations: [observation('restricted', 'declaration text')],
    resolvedValue: 'declaration text',
    updatedAt: now,
  }, { authority: 'model' }), /Model extraction is not permitted/);
});
