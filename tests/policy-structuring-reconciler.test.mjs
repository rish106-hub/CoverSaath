import test from 'node:test';
import assert from 'node:assert/strict';
import { POLICY_PARAMETER_REGISTRY_VERSION as registryVersion } from '../src/modules/coverage-analysis/policy-parameter-registry.js';
import { validateExtractedItems } from '../src/modules/policy-structuring/validator.js';
import { decideStates, deterministicConflicts, groupItems, reconcile } from '../src/modules/policy-structuring/reconciler.js';

// Synthetic only: fictional insurer and numbers. Items go through the real validator.
const chunks = [
  { id: 'p1-b0', page: 1, blockIndexes: [0], text: 'PED waiting period: 3 Years. Intimation: within 60 days of discharge.' },
  { id: 'p4-b2', page: 4, blockIndexes: [2], text: 'Pre-existing disease waiting: 36 / 24 / 12 months by plan. Intimation: 30/60 days.' },
  { id: 'p5-b1', page: 5, blockIndexes: [1], text: 'Sum Insured for Member A: Rs. 3,00,000. Sum Insured for Member B: Rs. 5,00,000. Initial wait 30 days.' },
];
const item = (chunk, key, value, quote, subject = 'policy') => ({ chunk_id: chunk.id, registry_key: key, value, evidence_quote: quote, subject, page: chunk.page, block_index: chunk.blockIndexes[0] });
const accepted = [
  [chunks[0], [item(chunks[0], 'f.ped_waiting_period', '3 Years', 'PED waiting period: 3 Years.'), item(chunks[0], 'h.intimation_deadline', '60 days', 'within 60 days of discharge')]],
  [chunks[1], [item(chunks[1], 'f.ped_waiting_period', '36 / 24 / 12 months', '36 / 24 / 12 months by plan'), item(chunks[1], 'h.intimation_deadline', '30/60 days', 'Intimation: 30/60 days.')]],
  [chunks[2], [item(chunks[2], 'd.sum_insured', 'Rs. 3,00,000', 'Member A: Rs. 3,00,000', 'Member A'), item(chunks[2], 'd.sum_insured', 'Rs. 5,00,000', 'Member B: Rs. 5,00,000', 'Member B'),
    item(chunks[2], 'f.initial_waiting_period', '30 days', 'Initial wait 30 days.')]],
].flatMap(([chunk, raw]) => validateExtractedItems(raw, { chunk, registryVersion }).accepted);
const consent = () => { const check = () => { check.count += 1; }; check.count = 0; return check; };
const noCall = async () => { throw new Error('must not be called'); };

test('groups by key and subject and finds deterministic conflicts and per-subject values', () => {
  assert.equal(accepted.length, 7);
  const groups = groupItems(accepted, []);
  assert.deepEqual(groups.map(group => group.groupId), [
    'registry:d.sum_insured|member a', 'registry:d.sum_insured|member b', 'registry:f.initial_waiting_period|policy',
    'registry:f.ped_waiting_period|policy', 'registry:h.intimation_deadline|policy',
  ]);
  const conflicts = deterministicConflicts(groups);
  assert.deepEqual(conflicts.map(conflict => [conflict.groupId, conflict.reasonCode, conflict.sources]), [
    ['registry:f.ped_waiting_period|policy', 'model_observations_conflict', ['deterministic']],
    ['registry:h.intimation_deadline|policy', 'model_observations_conflict', ['deterministic']],
    ['registry:d.sum_insured|*', 'per_subject_values', ['deterministic']],
  ]);
  assert.deepEqual(conflicts[0].itemRefs, [{ chunkId: 'p1-b0', page: 1, blockIndex: 0 }, { chunkId: 'p4-b2', page: 4, blockIndex: 2 }]);
});

test('cross-subject differences involving the policy subject are disagreements; equal values are not conflicts', () => {
  const schedule = { id: 'p6-b2', page: 6, blockIndexes: [2], text: 'Plan Alpha Gold | PED waiting 3 Years | Room 1% of SI' };
  const sheet = { id: 'p16-b1', page: 16, blockIndexes: [1], text: 'PED waiting period 36 months. Room rent 1% of SI.' };
  const items = [
    ...validateExtractedItems([item(schedule, 'f.ped_waiting_period', '3 Years', 'PED waiting 3 Years', 'Plan Alpha Gold'),
      item(schedule, 'd.room_rent_limit', '1% of SI', 'Room 1% of SI', 'Plan Alpha Gold')], { chunk: schedule, registryVersion }).accepted,
    ...validateExtractedItems([item(sheet, 'f.ped_waiting_period', '36 months', 'PED waiting period 36 months'),
      item(sheet, 'd.room_rent_limit', '1% of SI', 'Room rent 1% of SI')], { chunk: sheet, registryVersion }).accepted,
  ];
  const conflicts = deterministicConflicts(groupItems(items, []));
  assert.deepEqual(conflicts.map(conflict => [conflict.groupId, conflict.reasonCode]), [['registry:f.ped_waiting_period|*', 'model_observations_conflict']]);
  const decisions = decideStates({ accepted: items, conflicts });
  assert.deepEqual(decisions.map(decision => [decision.parameterKey, decision.state]), [['d.room_rent_limit', 'extracted_unverified'], ['f.ped_waiting_period', 'conflicting']]);
});

test('decideStates marks conflicting only with two or more observations', () => {
  const { conflicts } = { conflicts: deterministicConflicts(groupItems(accepted, [])) };
  const decisions = decideStates({ accepted, conflicts });
  assert.deepEqual(decisions.map(decision => [decision.parameterKey, decision.state, decision.reasonCode, decision.observations.length]), [
    ['d.sum_insured', 'conflicting', 'per_subject_values', 2],
    ['f.initial_waiting_period', 'extracted_unverified', 'model_extracted_unverified', 1],
    ['f.ped_waiting_period', 'conflicting', 'model_observations_conflict', 2],
    ['h.intimation_deadline', 'conflicting', 'model_observations_conflict', 2],
  ]);
  const single = accepted.filter(entry => entry.parameterKey === 'f.initial_waiting_period');
  const forced = [{ groupId: 'x', target: { kind: 'registry', key: 'f.initial_waiting_period' }, sources: ['reconciler'], reasonCode: 'reconciler_conflict' }];
  assert.equal(decideStates({ accepted: single, conflicts: forced })[0].state, 'extracted_unverified');
  assert.deepEqual(decisions[1].observations[0], { value: single[0].value, page: 5, blockIndex: 1, evidenceQuote: 'Initial wait 30 days.' });
});

test('model conflict is accepted only with grounded quotes; ungrounded and unknown groups are skipped', async () => {
  const agreeing = accepted.filter(entry => entry.parameterKey === 'f.initial_waiting_period');
  const twin = { ...agreeing[0], evidenceQuote: 'Initial wait 30 days', page: 5 };
  const pair = [agreeing[0], twin];
  const consentCheck = consent();
  const requests = [];
  const call = async request => { requests.push(request); return { json: { conflicts: [
    { group_id: 'registry:f.initial_waiting_period|policy', quotes: ['Initial wait 30 days.', 'Initial wait 30 days'] },
  ] }, usage: { inputTokens: 5, outputTokens: 2 } }; };
  const result = await reconcile({ accepted: pair, call, consentCheck });
  assert.equal(consentCheck.count, 1);
  assert.equal(result.calls, 1);
  assert.deepEqual(result.conflicts.map(conflict => [conflict.groupId, conflict.sources, conflict.reasonCode]), [['registry:f.initial_waiting_period|policy', ['reconciler'], 'reconciler_conflict']]);
  assert.equal(decideStates({ accepted: pair, conflicts: result.conflicts })[0].reasonCode, 'reconciler_conflict');
  assert.deepEqual(requests[0].payload.groups[0].readings.map(reading => reading.quote), ['Initial wait 30 days.', 'Initial wait 30 days']);

  const ungrounded = async () => ({ json: { conflicts: [
    { group_id: 'registry:f.initial_waiting_period|policy', quotes: ['Initial wait 30 days.', 'Initial wait 45 days'] },
    { group_id: 'registry:f.initial_waiting_period|policy', quotes: ['Initial wait 30 days.', 'Initial wait 30 days.'] },
    { group_id: 'registry:made.up|policy', quotes: ['a', 'b'] },
    'junk',
  ] }, usage: {} });
  const rejected = await reconcile({ accepted: pair, call: ungrounded, consentCheck: consent() });
  assert.deepEqual(rejected.conflicts, []);
  assert.deepEqual(rejected.skipped, [
    { groupId: 'registry:f.initial_waiting_period|policy', reason: 'ungrounded_conflict' },
    { groupId: 'registry:f.initial_waiting_period|policy', reason: 'ungrounded_conflict' },
    { groupId: null, reason: 'unknown_group' },
    { groupId: null, reason: 'unknown_group' },
  ]);
  assert.equal(decideStates({ accepted: pair, conflicts: rejected.conflicts })[0].state, 'extracted_unverified');
});

test('model confirming a deterministic conflict adds a source, never a winner', async () => {
  const call = async () => ({ json: { conflicts: [{ group_id: 'registry:f.ped_waiting_period|policy', quotes: ['PED waiting period: 3 Years.', '36 / 24 / 12 months by plan'] }] }, usage: {} });
  const result = await reconcile({ accepted, call, consentCheck: consent() });
  const ped = result.conflicts.find(conflict => conflict.groupId === 'registry:f.ped_waiting_period|policy');
  assert.deepEqual(ped.sources, ['deterministic', 'reconciler']);
  assert.ok(!('value' in ped));
});

test('provider error, timeout and malformed output still return deterministic conflicts', async () => {
  const cases = [
    [async () => { throw Object.assign(new Error('x'), { code: 'ADJUDICATOR_PROVIDER' }); }, 'provider_error'],
    [async () => { throw Object.assign(new Error('x'), { name: 'AbortError' }); }, 'timeout'],
    [async () => ({ json: { nope: true }, usage: {} }), 'malformed_response'],
  ];
  for (const [call, reason] of cases) {
    const result = await reconcile({ accepted, call, consentCheck: consent() });
    assert.equal(result.conflicts.length, 3, reason);
    assert.deepEqual(result.skipped, [{ groupId: null, reason }]);
  }
});

test('no call without groups of two; consent failure aborts; group cap is recorded', async () => {
  const single = accepted.filter(entry => entry.parameterKey === 'f.initial_waiting_period');
  const quiet = await reconcile({ accepted: single, call: noCall, consentCheck: consent() });
  assert.equal(quiet.calls, 0);
  const revoked = () => { throw Object.assign(new Error('revoked'), { code: 'CONSENT_REVOKED' }); };
  await assert.rejects(reconcile({ accepted, call: noCall, consentCheck: revoked }), { code: 'CONSENT_REVOKED' });
  const capped = await reconcile({ accepted, call: async () => ({ json: { conflicts: [] }, usage: {} }), consentCheck: consent(), limits: { maxGroups: 1 } });
  assert.deepEqual(capped.skipped, [{ groupId: 'registry:h.intimation_deadline|policy', reason: 'group_cap' }]);
});
