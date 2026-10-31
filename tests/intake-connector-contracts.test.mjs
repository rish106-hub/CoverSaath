import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INTAKE_CHANNELS, INTAKE_CONNECTORS, CONNECTOR_AVAILABILITY, validateIntakeConnector,
  VOICE_INTAKE_CONTRACT_VERSION, validateVoicePrefill, INSIGHT_STATES, insightStateFromHandoff,
} from '../src/contracts/index.js';

test('registry lists 10 frozen connectors in channel order with the expected availability', () => {
  assert.equal(INTAKE_CONNECTORS.length, 10);
  assert.deepEqual(INTAKE_CONNECTORS.map(c => c.id), [...INTAKE_CHANNELS]);
  assert.ok(Object.isFrozen(INTAKE_CONNECTORS));
  for (const connector of INTAKE_CONNECTORS) {
    assert.ok(Object.isFrozen(connector) && Object.isFrozen(connector.scopesRequested) && Object.isFrozen(connector.dataReturned));
    assert.equal(connector.intakeChannel, connector.id);
    assert.match(connector.noticeKey, /-draft-legal-review$/);
    assert.equal(connector.consentPurpose, connector.id === 'voice' ? 'voice_intake' : 'document_processing');
    assert.deepEqual(validateIntakeConnector(connector), { valid: true, errors: [] });
  }
  const availability = Object.fromEntries(INTAKE_CONNECTORS.map(c => [c.id, c.availability]));
  assert.equal(availability.upload, 'available');
  for (const id of ['camera', 'email_forward', 'voice']) assert.equal(availability[id], 'stub');
  for (const id of ['gmail', 'outlook', 'insurer_portal', 'hr_portal', 'digilocker', 'whatsapp']) assert.equal(availability[id], 'later');
  assert.deepEqual([...CONNECTOR_AVAILABILITY], ['available', 'stub', 'later']);
});

test('availability "live" is invalid', () => {
  const result = validateIntakeConnector({ ...INTAKE_CONNECTORS[0], availability: 'live' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.length > 0);
});

test('voice prefill accepts one valid item and rejects verified, unknown fields, 11 items and long values', () => {
  assert.equal(VOICE_INTAKE_CONTRACT_VERSION, 'voice-intake/v0');
  assert.equal(validateVoicePrefill([{ field: 'hospital_city', value: 'Pune', state: 'extracted_unverified' }]).valid, true);
  assert.equal(validateVoicePrefill([{ field: 'hospital_city', value: 'Pune', state: 'verified' }]).valid, false);
  assert.equal(validateVoicePrefill([{ field: 'policy_number', value: 'x', state: 'unknown' }]).valid, false);
  const item = { field: 'member_name', value: 'A', state: 'unknown' };
  assert.equal(validateVoicePrefill(Array.from({ length: 11 }, () => item)).valid, false);
  assert.equal(validateVoicePrefill([{ ...item, value: 'a'.repeat(201) }]).valid, false);
  assert.equal(validateVoicePrefill([{ ...item, value: 'a'.repeat(200) }]).valid, true);
});

test('handoff status maps to insight state', () => {
  assert.deepEqual([...INSIGHT_STATES], ['verified', 'extracted_unverified', 'conflicting', 'unknown']);
  assert.equal(insightStateFromHandoff('known'), 'verified');
  assert.equal(insightStateFromHandoff('unverified'), 'extracted_unverified');
  assert.equal(insightStateFromHandoff('conflicting'), 'conflicting');
  for (const value of ['missing', undefined, 'KNOWN', null, '__proto__', 'constructor']) assert.equal(insightStateFromHandoff(value), 'unknown');
});
