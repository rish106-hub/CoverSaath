import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RECORD_TYPES, ageBandForYears, assertMemberDetailRules, captureSchema, completeness, normalizeDay, normalizePhone, parseMemberDetails, parseRecordBody,
} from '../src/contracts/capture-registry.js';
import { containsSensitiveIdentifier } from '../src/contracts/sensitive-identifiers.js';

// Pure contract checks for the capture registry and the never-collect detector (ADR 0026). No database, synthetic values only.

const NOW = new Date('2026-11-03T00:00:00.000Z');

test('the detector catches the never-collect shapes and leaves ordinary numbers alone', () => {
  for (const hit of ['123456789012', '1234 5678 9012', '1234-5678-9012', 'ABCDE1234F', 'abcde1234f', '4111111111111111', '4111 1111 1111 1111', '378282246310005', 'cvv 123', 'CVC2: 999', 'password: abc', 'passcode = 1234', 'OTP is 654321', 'upi pin: 1234', 'mPIN is 4321', 'one-time code: 123456']) {
    assert.equal(containsSensitiveIdentifier(hit), true, hit);
  }
  for (const miss of ['Call 9876543210', 'Pincode 560034', 'Policy HDFC/2024/0001', 'Flat 12, Block 7', 'Paid 25,000 on 03/11/2024', 'forgot my password', 'Open the pin code box', 'Room 1234 5678', '', 'cvv', 'Born 1980-02-03']) {
    assert.equal(containsSensitiveIdentifier(miss), false, miss);
  }
});

test('normalisers: phone to E.164, day to ISO, age bands', () => {
  assert.equal(normalizePhone('098765 43210'), '+919876543210');
  assert.equal(normalizePhone('+91 98765-43210'), '+919876543210');
  assert.equal(normalizePhone('919876543210'), '+919876543210');
  assert.equal(normalizePhone('5876543210'), null);
  assert.equal(normalizePhone('12345'), null);
  assert.equal(normalizePhone('+0123456789'), null);
  assert.equal(normalizePhone(9876543210), null);
  assert.equal(normalizeDay('03/11/2026'), '2026-11-03');
  assert.equal(normalizeDay('3-1-2026'), '2026-01-03');
  assert.equal(normalizeDay('31/02/2026'), null);
  assert.equal(normalizeDay('2026-13-01'), null);
  assert.deepEqual([0, 5, 6, 12, 13, 17, 18, 30, 31, 45, 46, 60, 61, 99].map(ageBandForYears), ['0-5', '0-5', '6-12', '6-12', '13-17', '13-17', '18-30', '18-30', '31-45', '31-45', '46-60', '46-60', '61+', '61+']);
});

test('every record type has complete descriptors and a stable shape', () => {
  const schema = captureSchema();
  assert.equal(Object.keys(schema.recordTypes).length, 7);
  for (const [name, meta] of Object.entries(RECORD_TYPES)) {
    assert.ok(Object.keys(meta.fields).length > 0, name);
    for (const key of meta.requiredForComplete) assert.ok(key in meta.fields, `${name}.${key} is a field`);
    assert.ok(meta.maxSlots >= 1);
    assert.equal(JSON.parse(JSON.stringify(schema.recordTypes[name])).label, meta.label);
  }
  assert.deepEqual(schema.recordTypes.health_context.fields.conditions.item.fields.condition.values.slice(0, 2), ['diabetes', 'hypertension']);
  assert.equal(completeness('member_note', {}), 'empty');
  assert.equal(completeness('member_note', { note: 'a' }), 'complete');
  assert.equal(completeness('advisor', { firm: 'x' }), 'partial');
});

test('record bodies: fresh normalised object, strict keys, bounds', () => {
  const input = { data: { name: '  Asha Synthetic ', mobile: '98765 43210', rank: 2 } };
  const parsed = parseRecordBody('emergency_contact', input, { now: NOW });
  assert.deepEqual(parsed.data, { name: 'Asha Synthetic', mobile: '+919876543210', rank: 2 });
  assert.notEqual(parsed.data, input.data);
  assert.equal(parsed.completeness, 'complete');
  assert.equal(parsed.state, 'user_stated');
  for (const bad of [{ data: { name: 'a', nope: 1 } }, { data: { name: 'a' }, extra: true }, { data: { rank: 6 } }, { data: { rank: 1.5 } }, { data: 'x' }, { data: { name: 5 } }]) {
    assert.throws(() => parseRecordBody('emergency_contact', bad, { now: NOW }), { code: 'INVALID_REQUEST' }, JSON.stringify(bad));
  }
  assert.throws(() => parseRecordBody('emergency_contact', { data: { name: 'x'.repeat(9000) } }, { now: NOW }), { code: 'PAYLOAD_TOO_LARGE' });
  assert.throws(() => parseRecordBody('nope', { data: {} }, { now: NOW }), { code: 'RECORD_TYPE_UNKNOWN' });
  assert.throws(() => parseRecordBody('member_note', { data: { note: 'cvv 123' } }, { now: NOW }), { code: 'SENSITIVE_IDENTIFIER_REJECTED' });
  const health = parseRecordBody('health_context', { data: { surgeries: [{ kind: 'cardiac', year: 2026 }] } }, { now: NOW });
  assert.equal(health.data.surgeries[0].year, 2026);
  assert.throws(() => parseRecordBody('health_context', { data: { surgeries: [{ kind: 'cardiac', year: 2027 }] } }, { now: NOW }), { code: 'INVALID_REQUEST' });
});

test('member rules: under 18 keeps an age band, no date of birth, no contact', () => {
  const rules = (memberKind, input, stored) => assertMemberDetailRules({ memberKind, input, stored, now: NOW });
  assert.doesNotThrow(() => rules('dependent', { ageBand: '6-12' }));
  assert.throws(() => rules('dependent', { dateOfBirth: '2018-05-20' }), { code: 'INVALID_REQUEST' });
  assert.throws(() => rules('dependent', { ageBand: '13-17', mobile: '+919876543210' }), { code: 'INVALID_REQUEST' });
  assert.throws(() => rules('dependent', { email: 'a@example.test' }), { code: 'INVALID_REQUEST' });
  assert.doesNotThrow(() => rules('dependent', { ageBand: '18-30', email: 'a@example.test' }));
  assert.doesNotThrow(() => rules('adult', { dateOfBirth: '1990-01-01', mobile: '+919876543210' }));
  assert.throws(() => rules('adult', { dateOfBirth: '1990-01-01', ageBand: '18-30' }), { code: 'INVALID_REQUEST' });
  assert.throws(() => rules('adult', { mobile: '+919876543210' }, { ageBand: '0-5' }), { code: 'INVALID_REQUEST' });
  assert.deepEqual(parseMemberDetails({ gender: 'female', mobile: null, email: '', livesWithHousehold: false }, { now: NOW }), { gender: 'female', mobile: null, email: null, livesWithHousehold: false });
  assert.deepEqual(parseMemberDetails({ displayName: 'x' }, { now: NOW }), {});
});
