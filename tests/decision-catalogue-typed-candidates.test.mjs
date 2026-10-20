// Phase 2: strict typed twins of cited findings. Synthetic text only. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { typedTwin, typedTwins, buildDecisionCatalogue, answerToCandidates } from '../src/features/decision-catalogue/index.js';

const rows = text => [{ clauseId: 'c1', documentId: 'd1', sourceVersion: 'v1', page: 1, digest: 'dg1', text }];
const cand = (topic, body) => ({ topic, clauseIds: ['c1'], documentId: 'd1', sourceVersion: 'v1', sourceType: 'user_statement', factType: 'finding.covers', value: { effect: 'covers', findingId: 'f1' }, _body: body });
const twin = (topic, body) => typedTwin(cand(topic, body), rows(body));

test('Room Rent At Actuals is not a room-rent cap', () => {
  assert.deepEqual(twin('room rent', 'Room Rent: At Actuals').value, { kind: 'actuals' });
  assert.equal(twin('room rent', 'Room Rent: At Actuals up to Rs 5,000 per day').value.kind, 'amount');
});
test('cataract amount keeps unit and basis', () => {
  const t = twin('cataract', 'Cataract: Rs 40000 per eye');
  assert.equal(t.factType, 'sublimit');
  assert.deepEqual(t.value, { kind: 'amount', amountMinor: 4000000, currency: 'INR', basis: 'eye' });
});
test('Parenthood Not Opted is not a selected cover', () => {
  const t = twin('parenthood', 'Parenthood Benefit: Not Opted');
  assert.equal(t.factType, 'add_on');
  assert.equal(t.selection, 'not_opted');
});
test('waiting period years become whole months; ambiguous lines produce no twin', () => {
  assert.equal(twin('pre-existing waiting period', 'Pre-existing waiting period: 3 years').value.months, 36);
  assert.equal(twin('pre-existing waiting period', 'Pre-existing waiting period: 3 years or 36 months'), null);
});
test('two lines naming the subject, or two amounts, produce no twin', () => {
  assert.equal(twin('room rent', 'Room rent: Rs 5000 per day\nRoom rent: Rs 6000 per day'), null);
  assert.equal(twin('room rent', 'Room rent: Rs 5000 or Rs 6000 per day'), null);
});
test('unrecognised unusual terms yield no twin and stay open-ended', () => {
  assert.equal(twin('ayush treatment', 'AYUSH treatment is covered subject to terms'), null);
});
test('a twin spanning several clauses is refused', () => {
  const c = { ...cand('room rent'), clauseIds: ['c1', 'c2'] };
  assert.equal(typedTwin(c, rows('Room rent: Rs 5000 per day')), null);
});
test('typed twins stay extracted_unverified in the catalogue and never known', () => {
  const body = 'Room rent: Rs 5000 per day';
  const c = cand('room rent', body);
  const all = [c, ...typedTwins([c], rows(body))];
  const cat = buildDecisionCatalogue({
    householdId: 'h1', clauseRows: [{ id: 'c1', documentId: 'd1', sourceVersion: 'v1', page: 1, digest: 'dg1' }],
    batches: [{ origin: 'model', reviewStatus: 'not_reviewed', verifiedPolicyIds: [], candidates: all }],
    policies: [{ policyId: 'p1', kind: 'unresolved', coverBasis: 'unknown' }],
  });
  assert.ok(cat.facts.some(f => f.factType === 'room_rent_limit' && f.state === 'extracted_unverified' && !f.verified));
  assert.ok(cat.facts.some(f => f.factType === 'finding.covers'));
  const rr = cat.policies[0].rules.find(r => r.rule === 'room_rent_limit' && r.topic === 'room rent');
  assert.notEqual(rr?.result.status, 'known');
  assert.equal(rr?.result.value ?? null, null);
  assert.equal(cat.reviewRequired, true);
});
