import test from 'node:test';
import assert from 'node:assert/strict';
import { POLICY_PARAMETER_REGISTRY_VERSION as registryVersion } from '../src/modules/coverage-analysis/policy-parameter-registry.js';
import { validateExtractedItems } from '../src/modules/policy-structuring/validator.js';
import { decideStates, deterministicConflicts, groupItems, isConflict, reconcile } from '../src/modules/policy-structuring/reconciler.js';

// W2 close-out: auto-selection (model_selected_from_conflict) only for a deterministic contradiction of
// comparable readings of the same subject; per-subject variation only for insured members. Synthetic only.
const item = (chunk, key, value, quote, subject = 'policy') => ({ chunk_id: chunk.id, registry_key: key, value, evidence_quote: quote, subject, page: chunk.page, block_index: chunk.blockIndexes[0] });
const valid = (chunk, raw) => validateExtractedItems(raw, { chunk, registryVersion }).accepted;
const consent = () => () => {};
const pickFor = (group_id, quotes, selected_quote) => async () => ({ json: { conflicts: [{ group_id, quotes, selected_quote }] }, usage: {} });
const decide = (items, conflicts) => decideStates({ accepted: items, conflicts }).map(entry => [entry.parameterKey, entry.state, entry.reasonCode, entry.observations.length]);

test('a normal contradiction selection is extracted_unverified and keeps every reading', async () => {
  const left = { id: 'p1-b0', page: 1, blockIndexes: [0], text: 'PED waiting period: 3 Years.' };
  const right = { id: 'p4-b2', page: 4, blockIndexes: [2], text: 'Pre-existing disease waiting: 36 / 24 / 12 months by plan.' };
  const items = [
    ...valid(left, [item(left, 'f.ped_waiting_period', '3 Years', 'PED waiting period: 3 Years.')]),
    ...valid(right, [item(right, 'f.ped_waiting_period', '36 / 24 / 12 months', '36 / 24 / 12 months by plan')]),
  ];
  const result = await reconcile({ accepted: items, consentCheck: consent(),
    call: pickFor('registry:f.ped_waiting_period|policy', ['PED waiting period: 3 Years.', '36 / 24 / 12 months by plan'], 'PED waiting period: 3 Years.') });
  const [decision] = decideStates({ accepted: items, conflicts: result.conflicts });
  assert.deepEqual([decision.state, decision.reasonCode, decision.selectedQuote, decision.observations.map(entry => entry.evidenceQuote)],
    ['extracted_unverified', 'model_selected_from_conflict', 'PED waiting period: 3 Years.', ['PED waiting period: 3 Years.', '36 / 24 / 12 months by plan']]);
});

test('a model selection inside a context_differs group is rejected and the key stays conflicting', async () => {
  const schedule = { id: 'p6-b3', page: 6, blockIndexes: [3], text: 'Organ Donor Expenses | Covered upto sum insured' };
  const clause = "Cost of the organ donor's hospitalisation for harvesting the donated organ where an Insured Person is the recipient";
  const wording = { id: 'p11-b3', page: 11, blockIndexes: [3], text: `Organ Donor Expenses | ${clause}` };
  const items = [
    ...valid(schedule, [item(schedule, 'e.organ_donor', 'Covered upto sum insured', 'Covered upto sum insured')]),
    ...valid(wording, [item(wording, 'e.organ_donor', clause, clause)]),
  ];
  const result = await reconcile({ accepted: items, consentCheck: consent(),
    call: pickFor('registry:e.organ_donor|policy', ['Covered upto sum insured', clause], 'Covered upto sum insured') });
  assert.deepEqual(result.skipped, [{ groupId: 'registry:e.organ_donor|policy', reason: 'selection_not_contradiction' }]);
  assert.equal(result.conflicts[0].selectedQuote, undefined);
  assert.deepEqual(decide(items, result.conflicts), [['e.organ_donor', 'conflicting', 'context_differs', 2]]);
  // Defence in depth: a context entry that carries a selection is still never resolved.
  const forged = deterministicConflicts(groupItems(items, [])).map(entry => ({ ...entry, selectedQuote: 'Covered upto sum insured' }));
  assert.deepEqual(decide(items, forged), [['e.organ_donor', 'conflicting', 'context_differs', 2]]);
});

test('a model selection inside a per-subject variation is rejected; the key is never collapsed to one value', async () => {
  const sheet = { id: 'p5-b1', page: 5, blockIndexes: [1], text: 'Sum Insured Member A: Rs. 3,00,000 and Member A: Rs. 4,00,000. Sum Insured Member B: Rs. 5,00,000.' };
  const items = valid(sheet, [
    item(sheet, 'd.sum_insured', 'Rs. 3,00,000', 'Member A: Rs. 3,00,000', 'Member A'),
    item(sheet, 'd.sum_insured', 'Rs. 4,00,000', 'Member A: Rs. 4,00,000', 'Member A'),
    item(sheet, 'd.sum_insured', 'Rs. 5,00,000', 'Member B: Rs. 5,00,000', 'Member B'),
  ]);
  const result = await reconcile({ accepted: items, consentCheck: consent(),
    call: pickFor('registry:d.sum_insured|member a', ['Member A: Rs. 3,00,000', 'Member A: Rs. 4,00,000'], 'Member A: Rs. 3,00,000') });
  assert.deepEqual(result.conflicts.map(entry => [entry.groupId, entry.kind]), [['registry:d.sum_insured|member a', 'conflict'], ['registry:d.sum_insured|*', 'variation']]);
  assert.deepEqual(decide(items, result.conflicts), [['d.sum_insured', 'conflicting', 'model_observations_conflict', 3]], 'the variation keeps every member value');
  const forged = deterministicConflicts(groupItems(items, [])).map(entry => ({ ...entry, selectedQuote: 'Member B: Rs. 5,00,000' }));
  assert.deepEqual(decide(items, forged.filter(entry => entry.kind === 'variation')), [['d.sum_insured', 'conflicting', 'per_subject_values', 3]]);

  // Equal readings for one member beside another member's value: a model-only flag never selects.
  const same = { id: 'p7-b1', page: 7, blockIndexes: [1], text: 'Member A: Rs. 3,00,000 (schedule). Member A Rs. 3,00,000 (card). Member B: Rs. 5,00,000.' };
  const agreeing = valid(same, [
    item(same, 'd.sum_insured', 'Rs. 3,00,000', 'Member A: Rs. 3,00,000', 'Member A'),
    item(same, 'd.sum_insured', 'Rs. 3,00,000', 'Member A Rs. 3,00,000', 'Member A'),
    item(same, 'd.sum_insured', 'Rs. 5,00,000', 'Member B: Rs. 5,00,000', 'Member B'),
  ]);
  const flagged = await reconcile({ accepted: agreeing, consentCheck: consent(),
    call: pickFor('registry:d.sum_insured|member a', ['Member A: Rs. 3,00,000', 'Member A Rs. 3,00,000'], 'Member A: Rs. 3,00,000') });
  assert.deepEqual(flagged.skipped, [{ groupId: 'registry:d.sum_insured|member a', reason: 'selection_not_contradiction' }]);
  assert.equal(decide(agreeing, flagged.conflicts)[0][1], 'conflicting');
});

test('a model-invented subject is a contradiction, not a variation, and cannot be selected', async () => {
  const left = { id: 'p6-b1', page: 6, blockIndexes: [1], text: 'PED waiting 36 months in the plan' };
  const right = { id: 'p16-b1', page: 16, blockIndexes: [1], text: 'PED waiting 48 months as stated' };
  for (const [leftSubject, rightSubject] of [['Schedule', 'Policy wording'], ['Self', 'Spouse'], ['ont', 'ate']]) {
    const items = [
      ...valid(left, [item(left, 'f.ped_waiting_period', '36 months', 'PED waiting 36 months', leftSubject)]),
      ...valid(right, [item(right, 'f.ped_waiting_period', '48 months', 'PED waiting 48 months', rightSubject)]),
    ];
    assert.deepEqual(items.map(entry => entry.subjectInSource), [false, false], `${leftSubject} / ${rightSubject} are not printed in the chunk`);
    const conflicts = deterministicConflicts(groupItems(items, []));
    assert.deepEqual(conflicts.map(entry => [entry.kind, entry.reasonCode]), [['conflict', 'model_observations_conflict']], leftSubject);
    const result = await reconcile({ accepted: items, consentCheck: consent(),
      call: pickFor(conflicts[0].groupId, ['PED waiting 36 months', 'PED waiting 48 months'], 'PED waiting 36 months') });
    if (conflicts[0].groupId.endsWith('|*')) assert.equal(result.calls, 0, 'single-reading member groups are not sent, so the key-wide entry cannot be selected');
    else assert.equal(result.conflicts[0].selectedQuote, 'PED waiting 36 months', 'descriptive subjects group under the key, a real contradiction');
  }
});

test('descriptive subjects never split a key: C1 and C2 shaped readings are reported as conflicts', () => {
  const schedule = { id: 'p2-b1', page: 2, blockIndexes: [1], text: 'Pre-existing diseases: 3 Years. Pre-Hospitalization 60 days. Post-Hospitalization 90 days.' };
  const sheet = { id: 'p9-b4', page: 9, blockIndexes: [4], text: 'PED wait period applicable from policy inception: 36 / 24 / 12 months. Modification of Pre-Hospitalization expenses – Days: 30/60 days.' };
  const wording = { id: 'p12-b2', page: 12, blockIndexes: [2], text: 'declared and accepted pre-existing medical conditions are covered after 48 months.' };
  const items = [
    ...valid(schedule, [
      item(schedule, 'f.ped_waiting_period', '3 Years', 'Pre-existing diseases: 3 Years.', 'pre-existing diseases'),
      item(schedule, 'e.pre_and_post_hospitalisation', '60 days', 'Pre-Hospitalization 60 days.', 'Pre-Hospitalization'),
      item(schedule, 'e.pre_and_post_hospitalisation', '90 days', 'Post-Hospitalization 90 days.', 'Post-Hospitalization'),
    ]),
    ...valid(sheet, [
      item(sheet, 'f.ped_waiting_period', '36 / 24 / 12 months', '36 / 24 / 12 months', 'PED wait period applicable from policy inception'),
      item(sheet, 'e.pre_and_post_hospitalisation', '30/60 days', 'Days: 30/60 days.', 'Modification of Pre-Hospitalization expenses – Days'),
    ]),
    ...valid(wording, [item(wording, 'f.ped_waiting_period', '48 months', 'covered after 48 months', 'declared and accepted pre-existing medical conditions')]),
  ];
  assert.ok(items.every(entry => entry.subjectInSource), 'every descriptive subject is printed in its chunk');
  const conflicts = deterministicConflicts(groupItems(items, []));
  assert.deepEqual(conflicts.map(entry => [entry.groupId, entry.kind]), [
    ['registry:e.pre_and_post_hospitalisation|policy', 'conflict'], ['registry:f.ped_waiting_period|policy', 'conflict'],
  ]);
  assert.equal(conflicts.filter(isConflict).length, 2, 'C1 and C2 are reported, Pre and Post together is acceptable over-reporting');
  assert.deepEqual(decide(items, conflicts).map(entry => entry.slice(0, 3)), [
    ['e.pre_and_post_hospitalisation', 'conflicting', 'model_observations_conflict'], ['f.ped_waiting_period', 'conflicting', 'model_observations_conflict'],
  ]);
});

test('member placeholders and relation terms printed in the chunk are a variation; a mix with a descriptive subject is not', () => {
  const members = { id: 'p3-b2', page: 3, blockIndexes: [2], text: '<NAME_1> (Self) Sum Insured Rs. 3,00,000 | <NAME_2> Spouse Sum Insured Rs. 5,00,000 | Insured Person 3 Rs. 7,00,000' };
  const items = valid(members, [
    item(members, 'd.sum_insured', 'Rs. 3,00,000', '<NAME_1> (Self) Sum Insured Rs. 3,00,000', '<NAME_1>'),
    item(members, 'd.sum_insured', 'Rs. 5,00,000', 'Spouse Sum Insured Rs. 5,00,000', 'Spouse'),
    item(members, 'd.sum_insured', 'Rs. 7,00,000', 'Insured Person 3 Rs. 7,00,000', 'Insured Person 3'),
  ]);
  assert.deepEqual(deterministicConflicts(groupItems(items, [])).map(entry => [entry.groupId, entry.kind]), [['registry:d.sum_insured|*', 'variation']]);

  const mixedChunk = { id: 'p3-b3', page: 3, blockIndexes: [3], text: '<NAME_1> Rs. 3,00,000. Family floater sum insured Rs. 5,00,000.' };
  const mixed = valid(mixedChunk, [
    item(mixedChunk, 'd.sum_insured', 'Rs. 3,00,000', '<NAME_1> Rs. 3,00,000', '<NAME_1>'),
    item(mixedChunk, 'd.sum_insured', 'Rs. 5,00,000', 'Family floater sum insured Rs. 5,00,000', 'Family floater sum insured'),
  ]);
  assert.deepEqual(deterministicConflicts(groupItems(mixed, [])).map(entry => [entry.groupId, entry.kind]), [['registry:d.sum_insured|*', 'conflict']]);
});

test('a selected quote that is not one of that group\'s own readings is rejected', async () => {
  const chunk = { id: 'p1-b0', page: 1, blockIndexes: [0], text: 'PED waiting period: 3 Years. PED 36 months. Intimation: within 60 days of discharge.' };
  const items = valid(chunk, [
    item(chunk, 'f.ped_waiting_period', '3 Years', 'PED waiting period: 3 Years.'), item(chunk, 'f.ped_waiting_period', '36 months', 'PED 36 months'),
    item(chunk, 'h.intimation_deadline', '60 days', 'within 60 days of discharge'),
  ]);
  // The quote is grounded in the document, but in another key's readings.
  const result = await reconcile({ accepted: items, consentCheck: consent(),
    call: pickFor('registry:f.ped_waiting_period|policy', ['PED waiting period: 3 Years.', 'PED 36 months'], 'within 60 days of discharge') });
  assert.deepEqual(result.skipped, [{ groupId: 'registry:f.ped_waiting_period|policy', reason: 'ungrounded_selection' }]);
  assert.deepEqual(decide(items, result.conflicts).map(entry => entry.slice(0, 2)), [['f.ped_waiting_period', 'conflicting'], ['h.intimation_deadline', 'extracted_unverified']]);
  // Defence in depth: a selection naming an observation its entry does not cite is not resolved.
  const ped = items.filter(entry => entry.parameterKey === 'f.ped_waiting_period');
  const stray = { ...ped[0], page: 9, blockIndex: 7, evidenceQuote: 'PED stray 2 Years', value: { ...ped[0].value, text: '2 Years', normalized: null } };
  const forged = deterministicConflicts(groupItems(ped, [])).map(entry => ({ ...entry, selectedQuote: 'PED stray 2 Years' }));
  assert.deepEqual(decide([...ped, stray], forged), [['f.ped_waiting_period', 'conflicting', 'model_observations_conflict', 3]]);
});

test('in a contradiction, only a reading that takes part in it can be selected', async () => {
  const clause = 'Co-payment applies to every admissible claim of an insured person aged sixty-one years or above at entry to the policy.';
  const chunk = { id: 'p3-b1', page: 3, blockIndexes: [1], text: `Co-pay 10%. Co-pay 20%. ${clause}` };
  const items = valid(chunk, [
    item(chunk, 'd.co_pay_general', '10%', 'Co-pay 10%.'), item(chunk, 'd.co_pay_general', '20%', 'Co-pay 20%.'), item(chunk, 'd.co_pay_general', clause, clause),
  ]);
  assert.equal(items.length, 3);
  const clauseFirst = await reconcile({ accepted: items, consentCheck: consent(), call: pickFor('registry:d.co_pay_general|policy', ['Co-pay 10%.', clause], clause) });
  assert.deepEqual(clauseFirst.skipped, [{ groupId: 'registry:d.co_pay_general|policy', reason: 'selection_not_contradiction' }]);
  assert.deepEqual(decide(items, clauseFirst.conflicts), [['d.co_pay_general', 'conflicting', 'model_observations_conflict', 3]]);
  const comparable = await reconcile({ accepted: items, consentCheck: consent(), call: pickFor('registry:d.co_pay_general|policy', ['Co-pay 10%.', 'Co-pay 20%.'], 'Co-pay 20%.') });
  assert.deepEqual(decide(items, comparable.conflicts), [['d.co_pay_general', 'extracted_unverified', 'model_selected_from_conflict', 3]], 'every reading is kept');
});
