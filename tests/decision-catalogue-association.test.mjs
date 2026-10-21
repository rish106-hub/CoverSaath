// Phase 3: document-to-policy association. Synthetic numbers only. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { associateDocuments, extractPolicyNumbers, buildDecisionCatalogue, logicalPolicyId } from '../src/features/decision-catalogue/index.js';

const rows = (...pairs) => pairs.map(([documentId, text], i) => ({ clauseId: `c${i}`, documentId, text }));

test('a single printed policy number makes a candidate; the number itself is never returned', () => {
  const out = associateDocuments(rows(['d1', 'Policy Number: SYN-PH-000123\nRoom rent: Rs 5000 per day']), ['d1']);
  assert.equal(out.documents[0].status, 'candidate');
  assert.equal(out.documents[0].verified, false);
  assert.ok(out.documents[0].policyId.startsWith('pol-'));
  assert.ok(!JSON.stringify(out).includes('000123'));
});
test('wording and schedule with the same number share one logical policy', () => {
  const out = associateDocuments(rows(['wording', 'Policy No. SYN-PH-000123 applies'], ['schedule', 'Schedule\nPolicy No: syn-ph-000123']), ['wording', 'schedule']);
  assert.equal(out.policies.length, 1);
  assert.deepEqual(out.policies[0].documentIds, ['wording', 'schedule']);
});
test('personal and corporate numbers stay separate policies', () => {
  const out = associateDocuments(rows(['personal', 'Policy Number: SYN-PERS-1001'], ['corp', 'Policy Number: SYN-CORP-2002']), ['personal', 'corp']);
  assert.equal(out.policies.length, 2);
  assert.notEqual(out.documents[0].policyId, out.documents[1].policyId);
});
test('two numbers in one document are ambiguous; no number is unestablished; a bare label is not a number', () => {
  const out = associateDocuments(rows(['a', 'Policy Number: SYN-A-1001\nPolicy Number: SYN-B-2002'], ['b', 'Room rent applies'], ['c', 'Policy Number Format: letters only']), ['a', 'b', 'c']);
  assert.deepEqual(out.documents.map(d => d.status), ['ambiguous', 'unestablished', 'unestablished']);
  assert.ok(out.documents.every(d => d.policyId === null));
  assert.deepEqual(extractPolicyNumbers('Policy Number: ABCDEFGH'), [], 'a number needs a digit');
});
test('the uploader document kind is never used as association evidence', () => {
  const out = associateDocuments(rows(['d1', 'Room rent applies']), ['d1']);
  assert.equal(out.documents[0].status, 'unestablished');
});
test('facts of two candidate policies never cross: each rule layer sees only its own facts', () => {
  const clauseRows = [{ id: 'c1', documentId: 'd1', sourceVersion: 'v1', page: 1, digest: 'x' }, { id: 'c2', documentId: 'd2', sourceVersion: 'v1', page: 1, digest: 'y' }];
  const fact = (policyId, documentId, clauseId, amount) => ({
    policyId, policyAssociation: { basis: 'printed_policy_number' }, documentId, sourceVersion: 'v1', sourceType: 'user_statement', clauseIds: [clauseId],
    factType: 'room_rent_limit', topic: 'room rent', value: { kind: 'amount', amountMinor: amount, currency: 'INR', basis: 'day' },
  });
  const cat = buildDecisionCatalogue({
    householdId: 'h1', clauseRows,
    batches: [{ origin: 'model', reviewStatus: 'not_reviewed', verifiedPolicyIds: [], candidates: [fact('pol-a', 'd1', 'c1', 500000), fact('pol-b', 'd2', 'c2', 900000)] }],
    policies: [{ policyId: 'pol-a', kind: 'unresolved' }, { policyId: 'pol-b', kind: 'unresolved' }],
  });
  assert.equal(cat.policies.length, 2);
  assert.equal(cat.coordination.state, 'unresolved');
  assert.equal(cat.combinedConfirmedCover, null);
  for (const layer of cat.policies) {
    const rule = layer.rules.find(r => r.rule === 'room_rent_limit' && r.topic === 'room rent');
    assert.ok(rule.result.discrepancies.every(c => c.documentId === (layer.policyId === 'pol-a' ? 'd1' : 'd2')) || rule.result.citations.length === 0);
    assert.notEqual(rule.result.status, 'known');
  }
});
test('logical policy ids are keyed: the same number gives the same id under one key and an unrelated id under another', () => {
  const keyA = Buffer.alloc(32, 1);
  const keyB = Buffer.alloc(32, 2);
  const text = 'Policy Number: SYN-PH-000123';
  const a1 = associateDocuments(rows(['d1', text]), ['d1'], { key: keyA }).documents[0].policyId;
  const a2 = associateDocuments(rows(['d2', text]), ['d2'], { key: keyA }).documents[0].policyId;
  const b = associateDocuments(rows(['d1', text]), ['d1'], { key: keyB }).documents[0].policyId;
  assert.equal(a1, a2);
  assert.notEqual(a1, b);
  // An unkeyed digest of the number (what a client could compute from a guess) never equals the id.
  const guess = createHash('sha256').update('policy-association/v1:SYN-PH-000123').digest('hex');
  assert.ok(!a1.includes(guess.slice(0, 24)));
  assert.equal(logicalPolicyId('SYN-PH-000123', keyA), a1);
  assert.throws(() => logicalPolicyId('SYN-PH-000123', Buffer.alloc(8)), /32 bytes/);
});
