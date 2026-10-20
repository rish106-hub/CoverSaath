// Phase 7: the nine minimum scenarios, evidence -> facts -> rules -> Block 4 handoff. Synthetic data only. No network.
// Real-endpoint journey (upload, OCR, question, review, revoke) lives in catalogue-review-api.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDecisionCatalogue, toHandoff, assertHandoffContract, HANDOFF_VERSION } from '../src/features/decision-catalogue/index.js';

const H = 'household-1';
const clause = (id, documentId, sourceVersion = '1', page = 1) => ({ id, documentId, sourceVersion, page, digest: `sha-${id}` });
const CLAUSES = [clause('c-sched', 'doc-s'), clause('c-word', 'doc-w', '1', 7), clause('c-end', 'doc-e'), clause('c-corp', 'doc-c'), clause('c-s2', 'doc-s2'), clause('c-old', 'doc-old', '1'), clause('c-new', 'doc-old', '2')];
const fact = (over) => ({ policyId: 'P1', policyAssociation: { basis: 'printed_policy_number' }, documentId: 'doc-s', sourceVersion: '1', sourceType: 'issued_schedule', clauseIds: ['c-sched'], topic: '', ...over });
const money = amountMinor => ({ amountMinor, currency: 'INR' });
const rr = amountMinor => ({ kind: 'amount', amountMinor, currency: 'INR', basis: 'day' });
const reviewed = (candidates, verified = ['P1']) => ({ origin: 'human_review', reviewStatus: 'accepted', verifiedPolicyIds: verified, candidates });
const model = candidates => ({ origin: 'model', reviewStatus: 'not_reviewed', verifiedPolicyIds: [], candidates });
const policies = [{ policyId: 'P1', kind: 'personal', coverBasis: 'individual' }];
function journey(batches, { clauseRows = CLAUSES, pol = policies, asOf = '2026-06-01', extra = {} } = {}) {
  const catalogue = buildDecisionCatalogue({ householdId: H, batches, clauseRows, policies: pol, asOf, ...extra });
  const handoff = toHandoff({ sourceAnswerId: 'ans-1', pipelineCurrent: true, catalogue, skipped: [] });
  assert.equal(assertHandoffContract(handoff), true);
  return { catalogue, handoff };
}
const item = (handoff, rule, topic = '', policyId = 'P1') => handoff.policies.find(p => p.policyId === policyId).items.find(i => i.rule === rule && i.topic === topic);

test('1. one policy with full source evidence: known values carry citations and a verified association', () => {
  const { handoff } = journey([reviewed([
    fact({ factType: 'sum_insured', value: money(50000000) }),
    fact({ factType: 'room_rent_limit', topic: 'room rent', value: rr(500000) }),
    fact({ factType: 'copay', value: { basisPoints: 1000 } }),
    fact({ factType: 'member_enrolment', subject: { memberId: 'm1', scope: 'member' }, value: { status: 'enrolled' } }),
  ])], { extra: { memberId: 'm1' } });
  assert.equal(handoff.handoffVersion, HANDOFF_VERSION);
  assert.equal(item(handoff, 'sum_insured').state, 'known');
  assert.deepEqual(item(handoff, 'sum_insured').value, money(50000000));
  assert.equal(item(handoff, 'room_rent_limit', 'room rent').state, 'known');
  assert.equal(item(handoff, 'copay').value.basisPoints, 1000);
  assert.equal(item(handoff, 'member_enrolment').state, 'known');
  assert.ok(item(handoff, 'sum_insured').citations[0].clauseIds.length);
  assert.equal(handoff.combinedConfirmedCover, null);
  assert.equal(handoff.completeness.retrievalComplete, false);
});

test('2. missing enrolment evidence stays missing, never false or enrolled', () => {
  const { handoff } = journey([reviewed([fact({ factType: 'sum_insured', value: money(50000000) })])], { extra: { memberId: 'm1' } });
  assert.equal(item(handoff, 'sum_insured').state, 'known');
  assert.equal(item(handoff, 'member_enrolment').state, 'missing');
  assert.equal(item(handoff, 'member_enrolment').value, null);
  assert.equal(item(handoff, 'waiting_period').state, 'missing');
});

test('3. personal and corporate policies stay separate layers and are never summed', () => {
  const pol = [{ policyId: 'P1', kind: 'personal', coverBasis: 'individual' }, { policyId: 'P2', kind: 'group', coverBasis: 'shared' }];
  const { handoff } = journey([reviewed([
    fact({ factType: 'sum_insured', value: money(50000000) }),
    fact({ policyId: 'P2', documentId: 'doc-c', clauseIds: ['c-corp'], sourceType: 'group_benefit_booklet', factType: 'sum_insured', value: money(20000000) }),
  ], ['P1', 'P2'])], { pol });
  assert.equal(item(handoff, 'sum_insured', '', 'P1').value.amountMinor, 50000000);
  assert.equal(item(handoff, 'sum_insured', '', 'P2').value.amountMinor, 20000000);
  assert.equal(handoff.combinedConfirmedCover, null);
  assert.equal(handoff.coordination.state, 'unresolved');
  assert.ok(handoff.policies.every(p => p.spendableCash === false));
});

test('4. wording offers a rider, schedule says Not Opted: not selected, never an entitlement', () => {
  const { handoff } = journey([reviewed([
    fact({ factType: 'add_on', topic: 'parenthood', selection: 'available', sourceType: 'policy_wording', documentId: 'doc-w', clauseIds: ['c-word'], sourceVersion: '1', value: { name: 'Parenthood' } }),
    fact({ factType: 'add_on', topic: 'parenthood', selection: 'not_opted', value: { name: 'Parenthood' } }),
  ])]);
  assert.equal(item(handoff, 'add_on', 'parenthood').state, 'not_selected');
  assert.equal(item(handoff, 'add_on', 'parenthood').value, null);
});

test('5. disease-specific limits surface beside, not behind, the general rule', () => {
  const { handoff } = journey([reviewed([
    fact({ factType: 'sublimit', topic: 'cataract', value: { kind: 'amount', amountMinor: 4000000, currency: 'INR', basis: 'eye' } }),
    fact({ factType: 'waiting_period', topic: 'cataract', value: { months: 24 } }),
  ])]);
  assert.equal(item(handoff, 'sublimit', '').state, 'missing', 'no general sublimit is invented');
  assert.equal(item(handoff, 'sublimit', 'cataract').value.basis, 'eye');
  assert.equal(item(handoff, 'waiting_period', 'cataract').value.months, 24);
  assert.equal(item(handoff, 'waiting_period', '').state, 'missing');
});

test('6. a newer endorsement controls and the schedule is kept as a discrepancy', () => {
  const { handoff } = journey([reviewed([
    fact({ factType: 'room_rent_limit', topic: 'room rent', value: rr(500000) }),
    fact({ factType: 'room_rent_limit', topic: 'room rent', documentId: 'doc-e', clauseIds: ['c-end'], sourceType: 'endorsement', value: rr(700000) }),
  ])]);
  const entry = item(handoff, 'room_rent_limit', 'room rent');
  assert.equal(entry.state, 'known');
  assert.equal(entry.value.amountMinor, 700000);
  assert.equal(entry.discrepancies.length, 1);
});

test('7. contradictory current sources stay conflicting with both sides listed', () => {
  const { handoff } = journey([reviewed([
    fact({ factType: 'room_rent_limit', topic: 'room rent', value: rr(500000) }),
    fact({ factType: 'room_rent_limit', topic: 'room rent', documentId: 'doc-s2', clauseIds: ['c-s2'], familyId: 'other-schedule', value: rr(900000) }),
  ])]);
  const entry = item(handoff, 'room_rent_limit', 'room rent');
  assert.equal(entry.state, 'conflicting');
  assert.equal(entry.value, null);
  assert.equal(entry.conflicting.length, 2);
});

test('8. erased evidence and superseded versions cannot control the result', () => {
  // The schedule clause is gone (document erased or consent revoked): nothing known survives.
  const erased = journey([reviewed([fact({ factType: 'sum_insured', value: money(50000000) })])], { clauseRows: CLAUSES.filter(c => c.id !== 'c-sched') });
  assert.equal(item(erased.handoff, 'sum_insured').state, 'missing');
  assert.equal(erased.handoff.completeness.rejectedCandidates, 1);
  // Two versions of one document: the newer controls.
  const versions = journey([reviewed([
    fact({ factType: 'sum_insured', documentId: 'doc-old', sourceVersion: '1', clauseIds: ['c-old'], value: money(30000000) }),
    fact({ factType: 'sum_insured', documentId: 'doc-old', sourceVersion: '2', clauseIds: ['c-new'], value: money(40000000) }),
  ])]);
  assert.equal(item(versions.handoff, 'sum_insured').value.amountMinor, 40000000);
});

test('9. an unusual insurer rule with no registry key survives as cited open-ended evidence', () => {
  const { handoff } = journey([model([fact({ sourceType: 'user_statement', factType: 'finding.limits', topic: 'robotic surgery loading', value: { effect: 'limits', findingId: 'f1' }, conditions: ['only in network hospitals'], exceptions: ['emergency'] })])]);
  assert.equal(handoff.openEndedFindings.length, 1);
  const finding = handoff.openEndedFindings[0];
  assert.equal(finding.topic, 'robotic surgery loading');
  assert.equal(finding.state, 'extracted_unverified');
  assert.deepEqual(finding.conditions, ['only in network hospitals']);
  assert.equal(finding.citations[0].digest, 'sha-c-sched');
  assert.equal(handoff.reviewRequired, true);
  assert.ok(handoff.policies[0].items.every(i => i.state !== 'known'));
});

test('handoff contract: model values are candidates only, dynamic facts need a current check, bad status never reads as known', () => {
  const { handoff } = journey([
    model([fact({ sourceType: 'user_statement', factType: 'sum_insured', value: money(50000000) })]),
    { origin: 'official_source', reviewStatus: 'accepted', verifiedPolicyIds: ['P1'], candidates: [fact({ factType: 'network_status', value: { provider: 'Sample Hospital', status: 'network' } })] },
  ]);
  assert.notEqual(item(handoff, 'sum_insured').state, 'known');
  assert.notEqual(item(handoff, 'network_status').state, 'known');
  assert.ok(handoff.dynamicChecks.length <= 1);
  assert.throws(() => toHandoff({ catalogue: { catalogueVersion: 'decision-catalogue/v0' } }), /Unsupported catalogue version/);
  const forged = JSON.parse(JSON.stringify(handoff));
  forged.policies[0].items[0].state = 'known';
  assert.throws(() => assertHandoffContract(forged), /Handoff contract/);
});
