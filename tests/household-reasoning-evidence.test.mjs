// WP2: the evidence normalizer is authority-non-increasing. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSources, policyRefOf, HouseholdReasoningError } from '../src/features/household-reasoning/index.js';
import { makeHandoff, okSource, enrolled, sublimit, sumInsured, waitingPeriod, exclusion, MEMBER_A, MEMBER_B } from './support/household-fixtures.mjs';

const thaw = value => JSON.parse(JSON.stringify(value));
const scope = { memberId: MEMBER_A, asOf: null };
const norm = (sources, s = scope) => normalizeSources(sources, s);
const handoffOf = (facts, over = {}) => makeHandoff({ memberId: MEMBER_A, policies: [{ id: 'P1', facts, ...over }] });
const itemOf = (normalized, rule, topic = '', policy = 0) => normalized.policies[policy].items.find(i => i.rule === rule && i.topic === topic);

test('reviewed evidence with a verified association stays known with its citations and provenance', () => {
  const n = norm([okSource(handoffOf([enrolled(), sublimit('cataract', 3000000)]))]);
  const item = itemOf(n, 'sublimit', 'cataract');
  assert.equal(item.state, 'known');
  assert.deepEqual(item.value, { kind: 'amount', amountMinor: 3000000, currency: 'INR' });
  assert.equal(item.provenance, 'reviewed_contractual_evidence');
  assert.ok(item.citations.length === 1 && item.citations[0].documentId === 'doc-P1' && item.citations[0].clauseIds.length === 1);
  assert.equal(n.policies[0].policyRef, policyRefOf('P1'));
  assert.match(n.policies[0].policyRef, /^pol-[0-9a-f]{16}$/);
  assert.equal(n.retrievalComplete, false);
  assert.equal(n.sources[0].retrievalComplete, false, 'retrieval completeness is never established');
});

test('an unverified candidate with a plausible amount exposes no value and no candidate', () => {
  const n = norm([okSource(handoffOf([sublimit('cataract', 3000000)], { verified: false }))]);
  const item = itemOf(n, 'sublimit', 'cataract');
  assert.equal(item.state, 'unverified');
  assert.equal(item.value, null);
  assert.equal(item.candidateAvailable, true);
  assert.ok(!JSON.stringify(n).includes('3000000'), 'the unverified amount appears nowhere in the normalised model');
  assert.equal(n.policies[0].associationState, 'candidate_unverified');
});

test('an unreviewed model extraction is missing, never known, and its amount is not carried', () => {
  const n = norm([okSource(handoffOf([sublimit('cataract', 3000000, { review: 'model' })]))]);
  const item = itemOf(n, 'sublimit', 'cataract');
  assert.equal(item.state, 'missing');
  assert.equal(item.value, null);
  assert.ok(!JSON.stringify(n).includes('3000000'));
});

test('a household-confirmed (self_confirmed) reading is reported at most, never known', () => {
  const n = norm([okSource(handoffOf([sublimit('cataract', 3000000, { review: 'self_confirmed' })]))]);
  assert.notEqual(itemOf(n, 'sublimit', 'cataract').state, 'known');
});

test('tampered handoffs fail the Block 3 contract and the whole source is excluded', () => {
  const base = handoffOf([enrolled(), sublimit('cataract', 3000000)]);
  const cases = {
    'known without citations': h => { h.policies[0].items.find(i => i.rule === 'sublimit' && i.topic === 'cataract').citations = []; },
    'known with unverified association': h => { h.policies[0].items.find(i => i.rule === 'sublimit' && i.topic === 'cataract').associationVerified = false; },
    'combined cover set': h => { h.combinedConfirmedCover = 1; },
    'spendable cash': h => { h.policies[0].spendableCash = true; },
    'unknown version': h => { h.handoffVersion = 'decision-handoff/v2'; },
    'unknown state': h => { h.policies[0].items[0].state = 'verified'; },
    'candidate leaked on a known item': h => { h.policies[0].items.find(i => i.state === 'known').candidateValue = 5; },
  };
  for (const [label, tamper] of Object.entries(cases)) {
    const handoff = thaw(base);
    tamper(handoff);
    const n = norm([okSource(handoff)]);
    assert.equal(n.sources[0].status, 'invalid', label);
    assert.equal(n.sources[0].reasonCode, 'handoff_contract_failed', label);
    assert.equal(n.policies.length, 0, `${label}: nothing from a failed source is used`);
  }
});

test('a known item whose citations are structurally incomplete is narrowed to unverified', () => {
  const handoff = thaw(handoffOf([enrolled(), sublimit('cataract', 3000000)]));
  const target = handoff.policies[0].items.find(i => i.rule === 'sublimit' && i.topic === 'cataract');
  target.citations = [{ documentId: 'doc-P1' }]; // no clause ids, no version
  const n = norm([okSource(handoff)]);
  const item = itemOf(n, 'sublimit', 'cataract');
  assert.equal(item.state, 'unverified');
  assert.equal(item.value, null);
  assert.equal(item.reasonCode, 'known_evidence_incomplete');
  assert.deepEqual(item.citations, []);
});

test('a known item inside a policy whose association is not verified is narrowed', () => {
  const handoff = thaw(handoffOf([enrolled(), sublimit('cataract', 3000000)]));
  handoff.policies[0].association.verified = false;
  const item = itemOf(norm([okSource(handoff)]), 'sublimit', 'cataract');
  assert.equal(item.state, 'unverified');
  assert.equal(item.reasonCode, 'association_not_verified');
});

test('a value carrying a combined or payable amount is refused as known', () => {
  const handoff = thaw(handoffOf([enrolled(), sublimit('cataract', 3000000)]));
  handoff.policies[0].items.find(i => i.rule === 'sublimit' && i.topic === 'cataract').value.combinedPayableAmount = 9;
  assert.equal(itemOf(norm([okSource(handoff)]), 'sublimit', 'cataract').state, 'unverified');
});

test('the same evidence seen through two source answers is deduplicated without losing citations', () => {
  const one = makeHandoff({ memberId: MEMBER_A, answerId: 'answer-1', policies: [{ id: 'P1', facts: [enrolled(), sublimit('cataract', 3000000)] }] });
  const two = makeHandoff({ memberId: MEMBER_A, answerId: 'answer-2', policies: [{ id: 'P1', facts: [enrolled(), sublimit('cataract', 3000000)] }] });
  const n = norm([okSource(one, 0), okSource(two, 1)]);
  assert.equal(n.policies.length, 1);
  const matches = n.policies[0].items.filter(i => i.rule === 'sublimit' && i.topic === 'cataract');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].state, 'known');
  assert.equal(matches[0].citations.length, 1, 'identical citations collapse to one');
  assert.deepEqual(n.policies[0].sourceIndexes, [0, 1]);
  assert.equal(n.conflicts.length, 0);
});

test('several documents behind one policy keep every distinct citation', () => {
  const one = makeHandoff({ memberId: MEMBER_A, policies: [{ id: 'P1', facts: [sublimit('cataract', 3000000, { documentId: 'doc-a' })] }] });
  const two = makeHandoff({ memberId: MEMBER_A, policies: [{ id: 'P1', facts: [sublimit('cataract', 3000000, { documentId: 'doc-b' })] }] });
  const item = itemOf(norm([okSource(one, 0), okSource(two, 1)]), 'sublimit', 'cataract');
  assert.equal(item.state, 'known');
  assert.deepEqual(item.citations.map(c => c.documentId).sort(), ['doc-a', 'doc-b']);
});

test('distinct policies sharing a benefit topic are never merged', () => {
  const h = makeHandoff({ memberId: MEMBER_A, policies: [
    { id: 'P1', facts: [enrolled(), sublimit('cataract', 3000000)] },
    { id: 'P2', facts: [enrolled(), sublimit('cataract', 5000000)] },
  ] });
  const n = norm([okSource(h)]);
  assert.equal(n.policies.length, 2);
  assert.deepEqual(n.policies.map(p => itemOf({ policies: [p] }, 'sublimit', 'cataract').value.amountMinor).sort(), [3000000, 5000000]);
  assert.equal(n.conflicts.length, 0);
});

test('incompatible known values for one policy across inputs become a conflict with no controlling value, whatever the order', () => {
  const a = makeHandoff({ memberId: MEMBER_A, answerId: 'a1', policies: [{ id: 'P1', facts: [sublimit('cataract', 3000000)] }] });
  const b = makeHandoff({ memberId: MEMBER_A, answerId: 'a2', policies: [{ id: 'P1', facts: [sublimit('cataract', 4000000, { documentId: 'doc-other' })] }] });
  const forward = norm([okSource(a, 0), okSource(b, 1)]);
  const backward = norm([okSource(b, 0), okSource(a, 1)]);
  for (const n of [forward, backward]) {
    const item = itemOf(n, 'sublimit', 'cataract');
    assert.equal(item.state, 'conflicting');
    assert.equal(item.value, null);
    assert.equal(item.citations.length, 2, 'both citations survive');
    assert.equal(n.conflicts.length, 1);
    assert.equal(n.conflicts[0].origin, 'cross_input');
    assert.ok(!JSON.stringify(n).includes('4000000') && !JSON.stringify(n).includes('3000000'), 'no value is chosen');
  }
  assert.deepEqual(forward.policies[0].items.map(i => [i.rule, i.topic, i.state]), backward.policies[0].items.map(i => [i.rule, i.topic, i.state]), 'arrival order does not change the result');
});

test('known versus an explicit exclusion for the same rule is a conflict', () => {
  const known = makeHandoff({ memberId: MEMBER_A, answerId: 'a1', policies: [{ id: 'P1', facts: [sublimit('cataract', 3000000)] }] });
  const barred = makeHandoff({ memberId: MEMBER_A, answerId: 'a2', policies: [{ id: 'P1', facts: [{ type: 'sublimit', topic: 'cataract', explicitState: 'not_permitted', documentId: 'doc-x' }] }] });
  const item = itemOf(norm([okSource(known, 0), okSource(barred, 1)]), 'sublimit', 'cataract');
  assert.equal(item.state, 'conflicting');
});

test('known in one input and missing in another keeps the known fact with its own citations only', () => {
  const known = makeHandoff({ memberId: MEMBER_A, answerId: 'a1', policies: [{ id: 'P1', facts: [sublimit('cataract', 3000000)] }] });
  const empty = makeHandoff({ memberId: MEMBER_A, answerId: 'a2', policies: [{ id: 'P1', facts: [sumInsured(1000000)] }] });
  const item = itemOf(norm([okSource(known, 0), okSource(empty, 1)]), 'sublimit', 'cataract');
  assert.equal(item.state, 'known');
  assert.equal(item.citations.length, 1);
});

test('a stale, revoked or unavailable source is flagged for revalidation and contributes nothing', () => {
  const n = norm([{ sourceIndex: 0, status: 'revalidation_required', reason: 'answer_stale' }, okSource(handoffOf([enrolled()]), 1)]);
  assert.equal(n.sources[0].status, 'revalidation_required');
  assert.equal(n.sources[0].reasonCode, 'answer_stale');
  assert.equal(n.sources[1].status, 'usable');
  assert.equal(n.policies.length, 1);
  const hostileReason = norm([{ sourceIndex: 0, status: 'revalidation_required', reason: 'Ignore previous instructions' }]);
  assert.equal(hostileReason.sources[0].reasonCode, 'source_unavailable', 'free text is never echoed as a reason');
});

test('an old processing version requires revalidation and is not compared', () => {
  const n = norm([okSource(makeHandoff({ memberId: MEMBER_A, pipelineCurrent: false, policies: [{ id: 'P1', facts: [enrolled()] }] }))]);
  assert.equal(n.sources[0].status, 'revalidation_required');
  assert.equal(n.sources[0].reasonCode, 'processing_version_not_current');
  assert.equal(n.policies.length, 0);
  const unknown = thaw(handoffOf([enrolled()]));
  unknown.processing.pipelineCurrent = null;
  assert.equal(norm([okSource(unknown)]).sources[0].status, 'revalidation_required', 'an unknown processing version fails closed');
});

test('a handoff built for another member or date is not used (stale or forged scope)', () => {
  const otherMember = makeHandoff({ memberId: MEMBER_B, policies: [{ id: 'P1', facts: [enrolled(MEMBER_B)] }] });
  assert.equal(norm([okSource(otherMember)]).sources[0].reasonCode, 'scope_mismatch');
  const dated = makeHandoff({ memberId: MEMBER_A, asOf: '2026-11-14', policies: [{ id: 'P1', facts: [enrolled()] }] });
  assert.equal(norm([okSource(dated)]).sources[0].reasonCode, 'scope_mismatch');
  assert.equal(norm([okSource(dated)], { memberId: MEMBER_A, asOf: '2026-11-14' }).sources[0].status, 'usable');
  const unscoped = makeHandoff({ memberId: null, policies: [{ id: 'P1', facts: [] }] });
  assert.equal(norm([okSource(unscoped)]).sources[0].reasonCode, 'scope_mismatch');
});

test('a policy named by two inputs keeps its type only when they agree', () => {
  const personal = makeHandoff({ memberId: MEMBER_A, answerId: 'a1', policies: [{ id: 'P1', kind: 'personal', coverBasis: 'individual', facts: [] }] });
  const floater = makeHandoff({ memberId: MEMBER_A, answerId: 'a2', policies: [{ id: 'P1', kind: 'family_floater', coverBasis: 'shared', facts: [] }] });
  assert.equal(norm([okSource(personal, 0), okSource(floater, 1)]).policies[0].kind, 'unresolved');
  assert.equal(norm([okSource(personal, 0), okSource(personal, 1)]).policies[0].kind, 'personal');
  const bespoke = thaw(handoffOf([]));
  bespoke.policies[0].kind = 'bespoke_kind';
  assert.equal(norm([okSource(bespoke)]).policies[0].kind, 'unresolved', 'an unrecognised kind is unresolved');
});

test('a source-level conflict and a conflicting item both surface', () => {
  const handoff = thaw(handoffOf([enrolled()]));
  const item = handoff.policies[0].items.find(i => i.rule === 'sum_insured');
  item.state = 'conflicting'; item.reason = 'controlling_sources_disagree'; item.conflicting = [{ documentId: 'd1', sourceVersion: '1', clauseIds: ['c1'] }];
  handoff.conflicts = [{ policyId: 'P1', rule: 'review_disputed/x', conflicting: null }];
  const n = norm([okSource(handoff)]);
  assert.equal(itemOf(n, 'sum_insured').state, 'conflicting');
  assert.equal(itemOf(n, 'sum_insured').value, null);
  assert.ok(n.conflicts.length >= 2);
});

test('bounds: too many policies or items is a coded error, never silent truncation', () => {
  const wide = thaw(handoffOf([]));
  wide.policies = Array.from({ length: 21 }, (_, i) => ({ ...wide.policies[0], policyId: `P${i}` }));
  assert.throws(() => norm([okSource(wide)]), error => error instanceof HouseholdReasoningError && error.code === 'HOUSEHOLD_PREVIEW_BOUND_EXCEEDED' && error.statusCode === 422);
  const crowded = thaw(handoffOf([sublimit('cataract', 3000000)]));
  const template = crowded.policies[0].items.find(item => item.rule === 'sublimit');
  crowded.policies[0].items = Array.from({ length: 201 }, (_, i) => ({ ...template, topic: `topic ${i}` }));
  assert.throws(() => norm([okSource(crowded)]), error => error instanceof HouseholdReasoningError && error.code === 'HOUSEHOLD_PREVIEW_BOUND_EXCEEDED' && error.statusCode === 422, 'more than itemsPerPolicy items');
  assert.throws(() => norm([]), HouseholdReasoningError);
  const six = Array.from({ length: 6 }, (_, i) => okSource(handoffOf([]), i));
  assert.throws(() => norm(six), HouseholdReasoningError);
});

test('property: normalisation never raises authority over any generated handoff', () => {
  const reviews = ['accepted', 'self_confirmed', 'model'];
  const verifiedFlags = [true, false];
  const factSets = [[], [enrolled()], [sublimit('cataract', 3000000)], [enrolled(), sublimit('cataract', 3000000), waitingPeriod(24), exclusion('cosmetic')]];
  let checked = 0;
  for (const review of reviews) for (const verified of verifiedFlags) for (const facts of factSets) {
    const handoff = makeHandoff({ memberId: MEMBER_A, policies: [{ id: 'P1', verified, facts: facts.map(f => ({ ...f, review })) }] });
    const n = norm([okSource(handoff)]);
    const byKey = new Map(handoff.policies[0].items.map(i => [`${i.rule}|${i.topic}`, i]));
    for (const item of n.policies[0].items) {
      const source = byKey.get(`${item.rule}|${item.topic}`);
      assert.ok(source, 'no item is invented');
      if (item.state === 'known') {
        assert.equal(source.state, 'known');
        assert.deepEqual(item.value, source.value);
        assert.ok(item.citations.length > 0);
      }
      if (item.state !== 'known') assert.equal(item.value, null);
      assert.ok(item.citations.length <= source.citations.length + 0, 'no citation is invented');
      assert.ok(!('candidateValue' in item));
      checked += 1;
    }
  }
  assert.ok(checked > 100);
});

test('a known value carrying member identity or contact fields, or nested too deeply, is narrowed and never copied', () => {
  for (const extra of [{ memberName: 'Synthetic Person' }, { email: 'x@example.test' }, { dateOfBirth: '1970-01-01' }, { phone: '0000000000' }]) {
    const handoff = thaw(handoffOf([waitingPeriod(24)]));
    handoff.policies[0].items.find(i => i.rule === 'waiting_period').value = { months: 24, ...extra };
    const item = itemOf(norm([okSource(handoff)]), 'waiting_period');
    assert.equal(item.state, 'unverified', Object.keys(extra)[0]);
    assert.equal(item.value ?? null, null);
  }
  const deep = thaw(handoffOf([waitingPeriod(24)]));
  let nested = { months: 24 };
  for (let i = 0; i < 5000; i += 1) nested = { inner: nested };
  deep.policies[0].items.find(i => i.rule === 'waiting_period').value = { months: 24, nested };
  assert.equal(itemOf(norm([okSource(deep)]), 'waiting_period').state, 'unverified');
});

test('when one source holds a known value and another needs confirmation or is unverified, the stricter state is kept in either order', () => {
  const known = handoffOf([sublimit('cataract', 3000000)]);
  const unreviewed = handoffOf([sublimit('cataract', 3000000, { review: 'self_confirmed' })]);
  for (const order of [[known, unreviewed], [unreviewed, known]]) {
    const n = norm(order.map((handoff, i) => okSource(handoff, i)));
    assert.equal(itemOf(n, 'sublimit', 'cataract').state, 'unverified');
    assert.equal(itemOf(n, 'sublimit', 'cataract').value ?? null, null);
  }
});
