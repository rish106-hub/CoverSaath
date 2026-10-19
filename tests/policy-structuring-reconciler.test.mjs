import test from 'node:test';
import assert from 'node:assert/strict';
import { POLICY_PARAMETER_REGISTRY_VERSION as registryVersion } from '../src/features/coverage-analysis/policy-parameter-registry.js';
import { validateExtractedItems } from '../src/features/policy-structuring/validator.js';
import { decideStates, deterministicConflicts, groupItems, isConflict, reconcile } from '../src/features/policy-structuring/reconciler.js';

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
  // A plan label is not an insured member, so its readings group under the key with the policy readings.
  assert.deepEqual(conflicts.map(conflict => [conflict.groupId, conflict.reasonCode]), [['registry:f.ped_waiting_period|policy', 'model_observations_conflict']]);
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

test('a clause-length description beside a schedule value is context, not a conflict', () => {
  const schedule = { id: 'p6-b3', page: 6, blockIndexes: [3], text: 'Organ Donor Expenses | Covered upto sum insured' };
  const wording = { id: 'p11-b3', page: 11, blockIndexes: [3], text: "Organ Donor Expenses | Cost of the organ donor's hospitalisation for harvesting the donated organ where an Insured Person is the recipient" };
  const items = [
    ...validateExtractedItems([item(schedule, 'e.organ_donor', 'Covered upto sum insured', 'Covered upto sum insured', 'Organ Donor Expenses')], { chunk: schedule, registryVersion }).accepted,
    ...validateExtractedItems([item(wording, 'e.organ_donor', "Cost of the organ donor's hospitalisation for harvesting the donated organ where an Insured Person is the recipient",
      "Cost of the organ donor's hospitalisation for harvesting the donated organ where an Insured Person is the recipient", 'Organ Donor Expenses')], { chunk: wording, registryVersion }).accepted,
  ];
  assert.equal(items.length, 2);
  const conflicts = deterministicConflicts(groupItems(items, []));
  assert.deepEqual(conflicts.map(conflict => [conflict.kind, conflict.reasonCode]), [['context', 'context_differs']]);
  assert.equal(conflicts.filter(isConflict).length, 0, 'context is not reported as a contradiction');
  // Differing readings are never silently resolved: without a selection the key stays conflicting.
  assert.deepEqual(decideStates({ accepted: items, conflicts }).map(decision => [decision.state, decision.reasonCode]), [['conflicting', 'context_differs']]);
});

test('a grounded Gemini selection resolves a conflict as unverified; ungrounded or variation selections do not', async () => {
  const ped = accepted.filter(entry => entry.parameterKey === 'f.ped_waiting_period');
  const pick = selected_quote => async () => ({ json: { conflicts: [{ group_id: 'registry:f.ped_waiting_period|policy', quotes: ['PED waiting period: 3 Years.', '36 / 24 / 12 months by plan'], selected_quote }] }, usage: {} });
  const chosen = await reconcile({ accepted: ped, call: pick('PED waiting period: 3 Years.'), consentCheck: consent() });
  const [decision] = decideStates({ accepted: ped, conflicts: chosen.conflicts });
  assert.deepEqual([decision.state, decision.reasonCode, decision.selectedQuote, decision.observations.length],
    ['extracted_unverified', 'model_selected_from_conflict', 'PED waiting period: 3 Years.', 2], 'every reading is kept beside the selection');

  const invented = await reconcile({ accepted: ped, call: pick('PED waiting period: 1 Year.'), consentCheck: consent() });
  assert.deepEqual(invented.skipped, [{ groupId: 'registry:f.ped_waiting_period|policy', reason: 'ungrounded_selection' }]);
  assert.equal(decideStates({ accepted: ped, conflicts: invented.conflicts })[0].state, 'conflicting');

  const members = accepted.filter(entry => entry.parameterKey === 'd.sum_insured');
  const variation = deterministicConflicts(groupItems(members, [])).map(conflict => ({ ...conflict, selectedQuote: 'Member A: Rs. 3,00,000' }));
  assert.deepEqual(decideStates({ accepted: members, conflicts: variation }).map(entry => [entry.state, entry.reasonCode]), [['conflicting', 'per_subject_values']], 'a per-member variation is never resolved to one value');
});

test('a subject the model invents is not a printed subject, so a contradiction is not hidden as a variation', () => {
  const left = { id: 'p6-b1', page: 6, blockIndexes: [1], text: 'PED waiting 36 months' };
  const right = { id: 'p16-b1', page: 16, blockIndexes: [1], text: 'PED waiting 48 months' };
  const items = [
    ...validateExtractedItems([item(left, 'f.ped_waiting_period', '36 months', 'PED waiting 36 months', 'Schedule')], { chunk: left, registryVersion }).accepted,
    ...validateExtractedItems([item(right, 'f.ped_waiting_period', '48 months', 'PED waiting 48 months', 'Policy wording')], { chunk: right, registryVersion }).accepted,
  ];
  const conflicts = deterministicConflicts(groupItems(items, []));
  assert.deepEqual(conflicts.map(conflict => [conflict.kind, conflict.reasonCode]), [['conflict', 'model_observations_conflict']]);
});

test('per-subject variation is reported as a variation and never counted as a conflict', async () => {
  const { buildCoverageReport, scoreStructuring } = await import('../src/features/policy-structuring/coverage-report.js');
  const conflicts = deterministicConflicts(groupItems(accepted, []));
  const report = buildCoverageReport({ sectioned: { chunks: [] }, extraction: {}, reconciliation: { conflicts } });
  assert.deepEqual([report.conflicts.total, report.variations.perSubject], [2, 1]);
  const golden = { structuring: { expectedConflicts: [{ id: 'X', key: 'd.sum_insured' }, { id: 'C1', key: 'f.ped_waiting_period' }] } };
  assert.deepEqual(scoreStructuring(golden, { reconciliation: { conflicts } }).foundConflicts, ['C1'], 'a variation does not satisfy an expected conflict');
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
