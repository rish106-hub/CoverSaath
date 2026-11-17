import test from 'node:test';
import assert from 'node:assert/strict';
import { createNetworkHospitalService } from '../src/backend/services/network-hospital-service.js';
import { signatureFor } from '../src/backend/services/reference-data-port.js';
import { sanitizeAnalyticsEvent } from '../src/contracts/analytics-events.js';

// hospital_search analytics (ADR 0033): the hospital lookup reports the result count only, after ownership passes. Synthetic stubs; no database.

const ENV = { HOLDINGS_ENABLED: 'true' };
const registry = { products: [{ insurerId: 'ins-a', uinRaw: 'SYN-A-0001' }] };

function service({ uin = 'SYNA0001', owner = true, rows = [{ id: 'h1' }, { id: 'h2' }] } = {}) {
  const events = [];
  const svc = createNetworkHospitalService({
    env: ENV,
    repository: { byPincode: async () => rows },
    holdingRepository: {
      get: async id => (id === 'holding-1' ? { id, householdId: 'household-1', policyProfileId: 'profile-1' } : null),
      confirmedProfileUin: async () => uin,
    },
    policyHoldings: { get: async () => { if (!owner) throw Object.assign(new Error('denied'), { code: 'HOUSEHOLD_ACCESS_DENIED', statusCode: 403 }); return {}; } },
    referenceCache: { get: async () => ({ body: registry, signature: signatureFor(registry) }) },
    analytics: { track: async event => { events.push(event); return true; } },
  });
  return { svc, events };
}

test('a hospital search reports only the result count', async () => {
  const { svc, events } = service();
  const result = await svc.list({ holdingId: 'holding-1', adultId: 'adult-1', pincode: '990001' });
  assert.equal(result.hospitals.length, 2);
  assert.deepEqual(events, [{ householdId: 'household-1', event: 'hospital_search', properties: { results: 2 } }]);
  // The event passes the allowlist, and carries no pincode, insurer or hospital.
  assert.deepEqual(sanitizeAnalyticsEvent(events[0].event, events[0].properties).properties, { results: 2 });
  assert.doesNotMatch(JSON.stringify(events), /990001|ins-a|h1|SYN/);
});

test('an unknown insurer reports zero results', async () => {
  const { svc, events } = service({ uin: null });
  assert.equal((await svc.list({ holdingId: 'holding-1', adultId: 'adult-1', pincode: '990001' })).reason, 'insurer_unknown');
  assert.deepEqual(events.map(event => event.properties), [{ results: 0 }]);
});

test('a denied, missing or invalid search reports nothing', async () => {
  const denied = service({ owner: false });
  await assert.rejects(denied.svc.list({ holdingId: 'holding-1', adultId: 'adult-2', pincode: '990001' }), { code: 'HOLDING_NOT_FOUND' });
  await assert.rejects(denied.svc.list({ holdingId: 'missing', adultId: 'adult-1', pincode: '990001' }), { code: 'HOLDING_NOT_FOUND' });
  await assert.rejects(denied.svc.list({ holdingId: 'holding-1', adultId: 'adult-1', pincode: '12' }), { code: 'HOSPITAL_PINCODE_INVALID' });
  assert.equal(denied.events.length, 0);
});

test('no analytics service still answers', async () => {
  const bare = createNetworkHospitalService({
    env: ENV,
    repository: { byPincode: async () => [] },
    holdingRepository: { get: async id => ({ id, householdId: 'household-1', policyProfileId: null }), confirmedProfileUin: async () => null },
    policyHoldings: { get: async () => ({}) },
    referenceCache: { get: async () => null } });
  assert.deepEqual(await bare.list({ holdingId: 'holding-1', adultId: 'adult-1', pincode: '990001' }), { hospitals: [], reason: 'insurer_unknown' });
});
