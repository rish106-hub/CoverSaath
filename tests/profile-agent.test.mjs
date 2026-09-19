import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProfileIntake, ProfileIntakeError, UNKNOWN } from '../src/agents/profile-agent.js';

const now = new Date('2026-09-17T10:00:00.000Z');
const consent = (overrides = {}) => ({
  id: 'consent-1',
  subjectId: 'adult-1',
  status: 'granted',
  purposes: ['profile_intake'],
  sources: ['hrms'],
  fields: ['displayName', 'currentlyEmployed', 'employmentEndDate', 'employerBenefitEnrolled'],
  grantedAt: '2026-09-17T09:00:00.000Z',
  expiresAt: '2026-10-17T09:00:00.000Z',
  ...overrides
});

const packet = (overrides = {}) => ({
  subjectId: 'adult-1',
  source: { type: 'hrms', id: 'hrms-row-4', version: '2026-09', location: 'benefits/profile', retrievedAt: '2026-09-17T09:30:00.000Z' },
  requestedFields: ['displayName', 'currentlyEmployed', 'employmentEndDate', 'employerBenefitEnrolled'],
  consent: consent(),
  data: { displayName: '  Asha   Rao ', currentlyEmployed: false, employerBenefitEnrolled: false },
  ...overrides
});

test('normalises only requested, consented fields and preserves false separately from UNKNOWN', () => {
  const result = normalizeProfileIntake(packet({ data: { ...packet().data, unrequestedSecret: 'drop me' } }), { now });
  assert.equal(result.profile.displayName.value, 'Asha Rao');
  assert.equal(result.profile.currentlyEmployed.value, false);
  assert.equal(result.profile.employerBenefitEnrolled.value, false);
  assert.equal(result.profile.employmentEndDate.value, UNKNOWN);
  assert.equal(result.profile.employmentEndDate.status, 'unknown');
  assert.equal(result.profile.displayName.verificationStatus, 'hrms_recorded_unverified');
  assert.deepEqual(result.profile.displayName.source, result.provenance.profileSource);
  assert.ok(!JSON.stringify(result).includes('drop me'));
  assert.deepEqual(result.rejectedFields, [{ field: 'unrequestedSecret', reason: 'not_requested_or_not_consent_scoped' }]);
});

test('refuses missing, mismatched, revoked and expired scoped consent', () => {
  const cases = [
    packet({ consent: undefined }),
    packet({ consent: consent({ subjectId: 'adult-2' }) }),
    packet({ consent: consent({ revokedAt: '2026-09-17T09:30:00.000Z' }) }),
    packet({ consent: consent({ expiresAt: '2026-09-17T09:59:59.000Z' }) }),
    packet({ consent: consent({ fields: ['displayName'] }) })
  ];
  for (const input of cases) {
    assert.throws(() => normalizeProfileIntake(input, { now }), error => error instanceof ProfileIntakeError && error.code === 'CONSENT_REQUIRED');
  }
});

test('Form 16 and payroll never establish policy terms or medical facts', () => {
  const input = packet({
    source: { type: 'form16', id: 'form16-2026', retrievedAt: '2026-09-17T09:30:00.000Z' },
    requestedFields: ['employerName', 'sumInsured', 'waitingPeriod', 'diagnosis'],
    consent: consent({ sources: ['form16'], fields: ['employerName'] }),
    data: { employerName: 'Example Ltd', sumInsured: 900000, waitingPeriod: 0, diagnosis: 'Never retain this' }
  });
  const result = normalizeProfileIntake(input, { now });
  assert.deepEqual(Object.keys(result.profile), ['employerName']);
  assert.equal(result.profile.employerName.verificationStatus, 'document_recorded_profile_only');
  assert.equal(result.boundaries.policyTermsVerified, false);
  assert.equal(result.boundaries.medicalFactsInferred, false);
  assert.ok(result.rejectedFields.some(item => item.field === 'sumInsured' && item.reason.includes('policy_terms')));
  assert.ok(result.rejectedFields.some(item => item.field === 'diagnosis' && item.reason.includes('medical_data')));
  assert.ok(!JSON.stringify(result).includes('Never retain this'));
});

test('manual proxy facts stay proxy-reported and unconfirmed', () => {
  const input = packet({
    source: { type: 'manual', id: 'manual-1', reporterId: 'relative-2', retrievedAt: '2026-09-17T09:30:00.000Z' },
    requestedFields: ['householdRole'],
    consent: consent({ sources: ['manual'], fields: ['householdRole'] }),
    data: { householdRole: 'Policy operator' }
  });
  const result = normalizeProfileIntake(input, { now });
  assert.equal(result.profile.householdRole.verificationStatus, 'proxy_reported_unconfirmed');
});

test('affordability stays voluntary and separate with its own scoped consent', () => {
  const input = packet({
    affordability: {
      source: { type: 'manual', id: 'affordability-1', reporterId: 'adult-1', retrievedAt: '2026-09-17T09:40:00.000Z' },
      requestedFields: ['monthlyIncome', 'fixedCommitments', 'emergencySavings'],
      consent: {
        id: 'consent-affordability', subjectId: 'adult-1', status: 'granted', purposes: ['affordability_planning'], sources: ['manual'],
        fields: ['monthlyIncome', 'fixedCommitments', 'emergencySavings'], grantedAt: '2026-09-17T09:35:00.000Z'
      },
      data: { monthlyIncome: '80,000', fixedCommitments: 0 }
    }
  });
  const result = normalizeProfileIntake(input, { now });
  assert.equal(result.affordability.voluntary, true);
  assert.equal(result.affordability.facts.monthlyIncome.value, 80000);
  assert.equal(result.affordability.facts.fixedCommitments.value, 0);
  assert.equal(result.affordability.facts.emergencySavings.value, UNKNOWN);
  assert.equal(result.boundaries.affordabilityAffectsCoverageTruth, false);
  assert.ok(!Object.hasOwn(result.profile, 'monthlyIncome'));
});

test('affordability data is refused without separate consent', () => {
  const input = packet({ affordability: { source: { type: 'manual', id: 'aff-2' }, requestedFields: ['monthlyIncome'], data: { monthlyIncome: 100000 } } });
  assert.throws(() => normalizeProfileIntake(input, { now }), error => error.code === 'CONSENT_REQUIRED');
});
