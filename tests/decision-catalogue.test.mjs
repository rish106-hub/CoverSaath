import test from 'node:test';
import assert from 'node:assert/strict';
import { ingestFacts, resolveApplicable, evaluateRules, separatePolicies, buildDecisionCatalogue, answerToCandidates, validateOfficialSource, CATALOGUE_VERSION } from '../src/features/decision-catalogue/index.js';

const H = 'household-1';
const clauses = [
  { id: 'c-wording-mat', documentId: 'doc-w', sourceVersion: '1', page: 4 },
  { id: 'c-sched-mat', documentId: 'doc-s', sourceVersion: '1', page: 1 },
  { id: 'c-sched-mat-v2', documentId: 'doc-s', sourceVersion: '2', page: 1 },
  { id: 'c-end', documentId: 'doc-e', sourceVersion: '1', page: 1 },
  { id: 'c-cis', documentId: 'doc-c', sourceVersion: '1', page: 1 },
  { id: 'c-g', documentId: 'doc-g', sourceVersion: '1', page: 2 },
  { id: 'c-x', documentId: 'doc-x', sourceVersion: '1', page: 2 },
];
const evidenceIndex = new Map(clauses.map(c => [c.id, { ...c, householdId: H, live: true }]));
const ctx = { householdId: H, evidenceIndex };
// Test helper: `_o` ('human' | 'model') and `_assoc` pick the attested channel of each candidate; order of first use is kept.
function ing(candidates, extra = {}) {
  const groups = new Map();
  for (const raw of candidates) {
    const { _o = 'human', _assoc = true, ...c0 } = raw;
    // A model batch never carries contractual standing (rejected otherwise), so the helper downgrades the label.
    const c = _o === 'model' ? { ...c0, sourceType: 'user_statement' } : c0;
    const key = `${_o}|${_assoc}`;
    if (!groups.has(key)) groups.set(key, { _o, _assoc, items: [] });
    groups.get(key).items.push(c);
  }
  const out = { facts: [], rejected: [] };
  for (const g of groups.values()) {
    const origin = g._o === 'model' ? 'model' : 'human_review';
    const r = ingestFacts(g.items, { ...ctx, ...extra, origin, reviewStatus: origin === 'human_review' ? 'accepted' : 'not_reviewed', verifiedPolicyIds: g._assoc ? new Set(['P1', 'P2']) : new Set() });
    out.facts.push(...r.facts); out.rejected.push(...r.rejected);
  }
  return out;
}
const toBatches = candidates => {
  const { _o = 'human' } = {};
  return ['human', 'model'].map(k => ({ origin: k === 'model' ? 'model' : 'human_review', reviewStatus: k === 'model' ? 'not_reviewed' : 'accepted', verifiedPolicyIds: ['P1', 'P2'], candidates: candidates.filter(c => (c._o ?? 'human') === k).map(({ _o, _assoc, ...c }) => c) }));
};
const base = { policyId: 'P1', policyAssociation: { basis: 'schedule' } };
const fact = over => ({ ...base, documentId: 'doc-w', sourceVersion: '1', sourceType: 'policy_wording', clauseIds: ['c-wording-mat'], ...over });
const build = candidates => { const r = ing(candidates); assert.deepEqual(r.rejected, []); return r.facts; };
const q = over => ({ policyId: 'P1', factType: 'add_on', topic: 'maternity', ...over });

test('wording availability is not selection: Parenthood Not Opted gives no active rider', () => {
  const facts = build([
    fact({ factType: 'add_on', topic: 'maternity', value: { name: 'maternity' }, selection: 'available' }),
    fact({ factType: 'add_on', topic: 'maternity', value: { name: 'maternity' }, selection: 'not_opted', documentId: 'doc-s', sourceVersion: '1', sourceType: 'issued_schedule', clauseIds: ['c-sched-mat'] }),
  ]);
  const r = resolveApplicable(facts, q());
  assert.equal(r.status, 'not_selected');
  assert.equal(r.value, null);
  assert.equal(resolveApplicable(facts.slice(0, 1), q()).status, 'available_not_selected');
});

test('member-specific endorsement waives one waiting period for that member only', () => {
  const facts = build([
    fact({ factType: 'waiting_period', topic: 'pre_existing', value: { months: 36 } }),
    fact({ factType: 'waiting_period', topic: 'pre_existing', value: { months: 0 }, subject: { memberId: 'm1' }, documentId: 'doc-e', sourceType: 'endorsement', clauseIds: ['c-end'] }),
    fact({ factType: 'waiting_period', topic: 'maternity', value: { months: 24 } }),
  ]);
  const wq = over => q({ factType: 'waiting_period', topic: 'pre_existing', ...over });
  assert.equal(resolveApplicable(facts, wq({ memberId: 'm1' })).value.months, 0);
  assert.equal(resolveApplicable(facts, wq({ memberId: 'm2' })).value.months, 36);
  assert.equal(resolveApplicable(facts, q({ factType: 'waiting_period', topic: 'maternity', memberId: 'm1' })).value.months, 24);
});

test('facts do not cross policy boundaries', () => {
  const facts = build([fact({ factType: 'exclusion', topic: 'dental', value: { kind: 'permanent' }, policyId: 'P2' })]);
  const r = resolveApplicable(facts, q({ factType: 'exclusion', topic: 'dental' }));
  assert.equal(r.status, 'unknown');
  assert.equal(r.excluded[0].reason, 'other_policy');
});

test('older schedule version cannot control; superseded and out-of-date facts are excluded', () => {
  const facts = build([
    fact({ factType: 'copay', value: { basisPoints: 1000 }, documentId: 'doc-s', sourceVersion: '1', sourceType: 'issued_schedule', clauseIds: ['c-sched-mat'], familyId: 'sched' }),
    fact({ factType: 'copay', value: { basisPoints: 2000 }, documentId: 'doc-s', sourceVersion: '2', sourceType: 'issued_schedule', clauseIds: ['c-sched-mat-v2'], familyId: 'sched' }),
  ]);
  const r = resolveApplicable(facts, q({ factType: 'copay', topic: '' }));
  assert.equal(r.value.basisPoints, 2000);
  assert.ok(r.excluded.some(e => e.reason === 'older_version'));
  const dated = build([fact({ factType: 'copay', value: { basisPoints: 500 }, effective: { from: '2025-01-01', to: '2025-12-31' } })]);
  assert.equal(resolveApplicable(dated, q({ factType: 'copay', topic: '', asOf: '2026-06-01' })).status, 'unknown');
});

test('certificate with no benefit wording leaves terms unknown, never false or zero', () => {
  const facts = build([fact({ factType: 'policy_period', topic: 'x', value: { start: '2026-01-01', end: '2026-12-31' } })]);
  const results = evaluateRules(facts, { policyId: 'P1' });
  for (const id of ['copay', 'sum_insured', 'waiting_period', 'exclusion']) assert.equal(results.find(r => r.rule === id).result.status, 'unknown');
});

test('customer information sheet discrepancy is preserved but never controls', () => {
  const facts = build([
    fact({ factType: 'copay', value: { basisPoints: 2000 }, documentId: 'doc-s', sourceType: 'issued_schedule', clauseIds: ['c-sched-mat'] }),
    fact({ factType: 'copay', value: { basisPoints: 0 }, documentId: 'doc-c', sourceType: 'customer_information_sheet', clauseIds: ['c-cis'] }),
  ]);
  const r = resolveApplicable(facts, q({ factType: 'copay', topic: '' }));
  assert.equal(r.value.basisPoints, 2000);
  assert.equal(r.discrepancies.length, 1);
  assert.equal(resolveApplicable(facts.slice(1), q({ factType: 'copay', topic: '' })).status, 'unknown');
});

test('two contradictory current sources stay conflicting', () => {
  const facts = build([
    fact({ factType: 'copay', value: { basisPoints: 1000 } }),
    fact({ factType: 'copay', value: { basisPoints: 2000 }, documentId: 'doc-g', clauseIds: ['c-g'], familyId: 'other' }),
  ]);
  const r = resolveApplicable(facts, q({ factType: 'copay', topic: '' }));
  assert.equal(r.status, 'conflict');
  assert.equal(r.value, null);
  assert.equal(r.conflicting.length, 2);
});

test('model output stays extracted_unverified and feeds no calculation', () => {
  const claimed = ing([fact({ _o: 'model', factType: 'copay', value: { basisPoints: 1000 }, claimedState: 'proven' })]);
  assert.equal(claimed.rejected[0].code, 'FACT_AUTHORITY_EXCEEDED');
  const facts = build([fact({ _o: 'model', factType: 'copay', value: { basisPoints: 1000 } })]);
  assert.equal(facts[0].state, 'extracted_unverified');
  const r = resolveApplicable(facts, q({ factType: 'copay', topic: '' }));
  assert.notEqual(r.status, 'known');
  assert.equal(r.value, null);
});

test('unusual insurer clause survives with no registry key; conditions kept', () => {
  const facts = build([fact({ factType: 'ayush_cap_after_cataract', topic: 'eye', value: { note: 'x' }, conditions: ['only after 2nd year'], exceptions: ['accident'] })]);
  assert.equal(facts[0].registryKey, null);
  const r = resolveApplicable(facts, q({ factType: 'ayush_cap_after_cataract', topic: 'eye' }));
  assert.deepEqual(r.conditions, ['only after 2nd year']);
  assert.deepEqual(r.exceptions, ['accident']);
});

test('unknown waiting-period date never becomes zero months', () => {
  const facts = build([fact({ factType: 'waiting_period', topic: 'pre_existing', value: { months: 24 } })]);
  const wp = date => evaluateRules(facts, { policyId: 'P1', topic: 'pre_existing', asOf: date }, ['waiting_period'])[0];
  assert.equal(wp('2026-06-01').completion.state, 'unknown');
  const withStart = build([
    fact({ factType: 'waiting_period', topic: 'pre_existing', value: { months: 24 } }),
    fact({ factType: 'continuous_cover', value: { since: '2024-07-01', uninterrupted: true } }),
  ]);
  const done = evaluateRules(withStart, { policyId: 'P1', topic: 'pre_existing', asOf: '2026-06-30' }, ['waiting_period'])[0];
  assert.equal(done.completion.state, 'not_completed');
  assert.equal(evaluateRules(withStart, { policyId: 'P1', topic: 'pre_existing', asOf: '2026-07-01' }, ['waiting_period'])[0].completion.state, 'completed');
});

test('malformed or float money is refused safely', () => {
  const facts = build([fact({ factType: 'sum_insured', topic: '', value: { amountMinor: 1000.5, currency: 'INR' } })]);
  const r = evaluateRules(facts, { policyId: 'P1', topic: '' }, ['sum_insured'])[0].result;
  assert.equal(r.status, 'unverified');
  assert.equal(r.reason, 'value_malformed');
});

test('two policies are separate layers; combined cover is never confirmed', () => {
  const facts = build([
    fact({ factType: 'sum_insured', topic: '', value: { amountMinor: 50_000_000, currency: 'INR' } }),
    fact({ factType: 'sum_insured', topic: '', value: { amountMinor: 100_000_000, currency: 'INR' }, policyId: 'P2', documentId: 'doc-g', clauseIds: ['c-g'] }),
  ]);
  const out = separatePolicies([{ policyId: 'P1', kind: 'personal' }, { policyId: 'P2', kind: 'group', coverBasis: 'shared' }], facts);
  assert.equal(out.combinedConfirmedCover, null);
  assert.equal(out.coordination.state, 'unresolved');
  assert.equal(out.layers[0].rules.find(r => r.rule === 'sum_insured').result.value.amountMinor, 50_000_000);
});

test('evidence must be live, in the same household, and from the named document', () => {
  const rej = ing([
    fact({ factType: 'copay', value: { basisPoints: 1 }, clauseIds: ['gone'] }),
    fact({ factType: 'copay', value: { basisPoints: 1 }, clauseIds: ['c-g'] }),
    fact({ factType: 'copay', value: { basisPoints: 1 }, sourceVersion: '9' }),
  ]).rejected.map(r => r.code);
  assert.deepEqual(rej, ['EVIDENCE_NOT_LIVE', 'EVIDENCE_SOURCE_MISMATCH', 'EVIDENCE_SOURCE_MISMATCH']);
  const other = new Map([...evidenceIndex].map(([k, v]) => [k, { ...v, householdId: 'household-2' }]));
  assert.equal(ing([fact({ factType: 'copay', value: { basisPoints: 1 } })], { ...ctx, evidenceIndex: other }).rejected[0].code, 'EVIDENCE_OUT_OF_SCOPE');
});

test('erasure: facts vanish from the next build when clauses are gone; duplicate input is idempotent', () => {
  const cand = [fact({ factType: 'copay', value: { basisPoints: 1000 } })];
  const args = { householdId: H, batches: toBatches([...cand, ...cand]), clauseRows: clauses, policies: [{ policyId: 'P1', kind: 'personal' }] };
  const first = buildDecisionCatalogue(args);
  assert.equal(first.catalogueVersion, CATALOGUE_VERSION);
  assert.equal(first.facts.length, 1);
  assert.deepEqual(buildDecisionCatalogue(args).facts.map(f => f.factId), first.facts.map(f => f.factId));
  const erased = buildDecisionCatalogue({ ...args, clauseRows: [] });
  assert.equal(erased.facts.length, 0);
  assert.equal(erased.rejected[0].code, 'EVIDENCE_NOT_LIVE');
  assert.equal(erased.policies[0].rules.find(r => r.rule === 'copay').result.status, 'unknown');
});

test('unverified policy association downgrades and unassociated facts are excluded', () => {
  const facts = build([
    fact({ factType: 'copay', value: { basisPoints: 1000 }, _assoc: false }),
    fact({ factType: 'exclusion', topic: 'a', value: { kind: 'permanent' }, policyId: null }),
  ]);
  assert.equal(resolveApplicable(facts, q({ factType: 'copay', topic: '' })).reason, 'policy_association_unverified');
  assert.equal(resolveApplicable(facts, q({ factType: 'exclusion', topic: 'a' })).status, 'unknown');
});

test('official source: stale, superseded and unknown freshness are visible; never overrides a contract', () => {
  const rec = over => ({ authority: 'irdai', verified: true, institution: 'IRDAI', identifier: 'ref-1', title: 't', metricDefinition: 'm', publishedOn: '2025-01-01', retrievedOn: '2026-01-01', applicability: { insurer: 'Sample' }, ...over });
  const v = (r, today = '2026-10-20') => validateOfficialSource(r, { today });
  assert.equal(v(rec({ validTo: '2027-01-01' })).freshness, 'current');
  assert.equal(v(rec({ validTo: '2026-01-01' })).freshness, 'stale');
  assert.equal(v(rec({ supersededBy: 'ref-2', validTo: '2027-01-01' })).freshness, 'superseded');
  assert.equal(v(rec({})).freshness, 'freshness_unknown');
  assert.equal(v(rec({ dynamic: true })).freshness, 'stale');
  assert.equal(v(rec({ validTo: '2027-01-01' })).mayOverrideContract, false);
  assert.equal(v(rec({ authority: 'public_review', verified: true })).verified, false);
  assert.equal(v({}).valid, false);
});

test('review regressions: authority is a batch attestation, never a candidate claim', () => {
  const base1 = { ...ctx, origin: 'model' };
  const one = c => ingestFacts([c.sourceType === 'policy_wording' ? { ...c, sourceType: 'user_statement' } : c], base1).rejected[0]?.code;
  assert.equal(one(fact({ origin: 'human_review', reviewStatus: 'accepted', factType: 'copay', value: { basisPoints: 1 } })), 'FACT_AUTHORITY_EXCEEDED');
  assert.equal(one(fact({ inputFactIds: ['x'], factType: 'copay', value: { basisPoints: 1 } })), 'FACT_AUTHORITY_EXCEEDED');
  assert.equal(one(fact({ factType: 'copay', explicitState: 'not_permitted', value: null })), 'FACT_AUTHORITY_EXCEEDED');
  assert.equal(one(fact({ supersedes: ['fact-x'], factType: 'copay', value: { basisPoints: 1 } })), 'FACT_AUTHORITY_EXCEEDED');
  assert.throws(() => ingestFacts([], { ...ctx, origin: 'deterministic' }), /origin/);
  // association is attested too: a candidate cannot verify its own policy
  const unverified = ingestFacts([fact({ factType: 'copay', policyAssociation: { verified: true }, value: { basisPoints: 1 } })], { ...ctx, origin: 'human_review', reviewStatus: 'accepted' }).facts[0];
  assert.equal(unverified.association.verified, false);
  assert.equal(one(fact({ factType: 'exclusion', topic: 'a', clauseIds: [], value: null, explicitState: 'unknown' })), 'FACT_EVIDENCE_REQUIRED');
  assert.equal(one(fact({ factType: 'copay', subject: { scope: 'member' }, value: { basisPoints: 1 } })), 'FACT_SUBJECT_MALFORMED');
  assert.equal(one(fact({ factType: 'copay', subject: 'm1', value: { basisPoints: 1 } })), 'FACT_SUBJECT_MALFORMED');
  assert.equal(one(fact({ factType: 'copay', effective: 'never', value: { basisPoints: 1 } })), 'FACT_SUBJECT_MALFORMED');
  assert.equal(one(fact({ factType: 'copay', sourceType: 'constructor', value: { basisPoints: 1 } })), 'FACT_SOURCE_TYPE_UNSUPPORTED');
  assert.equal(ingestFacts([fact({ origin: undefined, factType: 'copay', supersedes: 'fact-x', value: { basisPoints: 1 } })], { ...ctx, origin: 'human_review' }).rejected[0].code, 'FACT_QUALIFIERS_MALFORMED');
  assert.equal(one(fact({ factType: 'copay', value: { text: 'x'.repeat(2100) } })), 'FACT_VALUE_TOO_LARGE');
});

test('review regressions: applicability determinism and precedence', () => {
  const wide = build([
    fact({ factType: 'sublimit', topic: 'cataract', value: { kind: 'amount', amountMinor: 300000, currency: 'INR' }, documentId: 'doc-e', sourceType: 'endorsement', clauseIds: ['c-end'] }),
    fact({ factType: 'sublimit', topic: 'cataract', value: { kind: 'amount', amountMinor: 500000, currency: 'INR' }, subject: { memberId: 'm1' } }),
  ]);
  assert.equal(resolveApplicable(wide, q({ factType: 'sublimit', topic: 'cataract', memberId: 'm1' })).value.amountMinor, 300000);
  const mdl = ing([fact({ _o: 'model', factType: 'add_on', topic: 'r', value: { name: 'r' }, selection: 'not_opted' })]).facts;
  assert.notEqual(resolveApplicable(mdl, q({ topic: 'r' })).status, 'known');
  const pv = fact({ factType: 'copay', value: { basisPoints: 5 }, familyId: 'a' });
  const mv = fact({ _o: 'model', factType: 'copay', value: { basisPoints: 5 }, familyId: 'b' });
  for (const order of [[pv, mv], [mv, pv]]) assert.equal(resolveApplicable(ing(order).facts, q({ factType: 'copay', topic: '' })).status, resolveApplicable(ing([pv]).facts, q({ factType: 'copay', topic: '' })).status);
  // differing qualifiers are a conflict, not an order-dependent pick
  const qa = fact({ factType: 'copay', value: { basisPoints: 5 }, familyId: 'a', exceptions: ['accident'] });
  const qb = fact({ factType: 'copay', value: { basisPoints: 5 }, familyId: 'b' });
  for (const order of [[qa, qb], [qb, qa]]) assert.equal(resolveApplicable(ing(order).facts, q({ factType: 'copay', topic: '' })).status, 'conflict');
  // advisory evidence cannot supersede a contract
  const end = build([fact({ factType: 'copay', value: { basisPoints: 1000 }, documentId: 'doc-e', sourceType: 'endorsement', clauseIds: ['c-end'] })]);
  const attack = ingestFacts([fact({ factType: 'copay', value: { basisPoints: 2000 }, documentId: 'doc-c', sourceType: 'customer_information_sheet', clauseIds: ['c-cis'], supersedes: [end[0].factId] })], { ...ctx, origin: 'human_review', reviewStatus: 'accepted', verifiedPolicyIds: new Set(['P1']) }).facts;
  assert.equal(resolveApplicable([...end, ...attack], q({ factType: 'copay', topic: '' })).value.basisPoints, 1000);
  // dates and ids
  const dated = build([fact({ factType: 'copay', value: { basisPoints: 5 }, effective: { to: '2024-03-31' } })]);
  assert.equal(resolveApplicable(dated, q({ factType: 'copay', topic: '' })).reason, 'as_of_required');
  assert.throws(() => resolveApplicable(dated, q({ memberId: '   ' })), /memberId/);
  assert.throws(() => evaluateRules(dated, { policyId: 'P1', asOf: 'tomorrow' }), /asOf/);
});

test('review regressions: handoff, evidence rows, official sources', () => {
  const run = (rows, cands = [fact({ factType: 'copay', value: { basisPoints: 1 } })]) => buildDecisionCatalogue({ householdId: H, batches: toBatches(cands), policies: [], clauseRows: rows });
  const row = { id: 'c-wording-mat', documentId: 'doc-w', sourceVersion: '1', page: 4 };
  assert.equal(run([row]).facts.length, 1);
  for (const bad of [{ status: 'revoked' }, { status: null }, { lifecycleState: 'deleted' }, { householdId: 'B' }, { householdId: null }]) assert.equal(run([{ ...row, ...bad }]).facts.length, 0);
  const cat = buildDecisionCatalogue({ householdId: H, clauseRows: clauses, policies: [{ policyId: 'P1', kind: 'personal' }], batches: toBatches([
    fact({ factType: 'add_on', topic: 'opd', value: { name: 'opd' }, selection: 'selected' }),
    fact({ factType: 'add_on', topic: 'opd', value: { name: 'opd2' }, selection: 'selected', familyId: 'z' }),
    fact({ factType: 'maternity_cap_custom', registryKey: 'R-12', value: { n: 1 } }),
  ]) });
  assert.equal(cat.conflicts.length, 1);
  assert.equal(cat.reviewRequired, true);
  assert.equal(cat.openEndedFacts.length, 1);
  const src = { authority: 'irdai', verified: true, institution: 'I', identifier: 'x', title: 't', metricDefinition: 'm', publishedOn: '2025-01-01', retrievedOn: '2026-01-01', applicability: { insurer: 'S' } };
  assert.equal(validateOfficialSource({ ...src, effectiveFrom: '2027-04-01', validTo: '2028-03-31' }, { today: '2026-10-20' }).freshness, 'not_yet_effective');
  assert.equal(validateOfficialSource({ ...src, retrievedOn: '2019-01-01', validTo: '2099-12-31' }, { today: '2026-10-20' }).freshness, 'stale');
  assert.equal(validateOfficialSource({ ...src, retrievedOn: '2027-01-01' }, { today: '2026-10-20' }).valid, false);
  assert.equal(buildDecisionCatalogue({ householdId: H, batches: [], clauseRows: [], policies: [], officialSources: [{ ...src, validTo: '2027-01-01' }], today: '2026-10-20' }).officialSources[0].freshness, 'current');
});

test('impossible calendar dates are not ISO dates', () => {
  assert.throws(() => resolveApplicable([], { policyId: 'P1', factType: 'copay', asOf: '2026-02-30' }), /asOf/);
  assert.equal(validateOfficialSource({ authority: 'irdai', institution: 'I', identifier: 'x', title: 't', metricDefinition: 'm', publishedOn: '2025-02-30', retrievedOn: '2026-01-01', applicability: { insurer: 'S' } }, { today: '2026-10-20' }).valid, false);
});

test('answer adapter: facts come from stored clauses, quotes are not copied, mixed documents are skipped', () => {
  const clauseRows = [
    { clauseId: 'a1', documentId: 'doc-s', sourceVersion: '2', page: 1 },
    { clauseId: 'a2', documentId: 'doc-w', sourceVersion: '1', page: 3 },
  ];
  const answer = {
    covered: [{ findingId: 'f1', subject: 'Room Rent', quote: 'SECRET QUOTE', clauseIds: ['a1'], effect: 'covers', conditions: ['x'], exceptions: [], overrides: [] }],
    limited_or_excluded: [
      { findingId: 'f2', subject: 'cataract', quote: 'q', clauseIds: ['a1', 'a2'], effect: 'limits', conditions: [], exceptions: [], overrides: [] },
      { findingId: 'f3', subject: 'dental', quote: 'q', clauseIds: ['ghost'], effect: 'excludes', conditions: [], exceptions: [], overrides: [] },
    ],
    conditions: [],
  };
  const kinds = new Map([['doc-s', 'policy_schedule'], ['doc-w', 'other']]);
  const { candidates, skipped } = answerToCandidates(answer, { clauseRows, documentKinds: kinds, policyId: 'U1' });
  assert.equal(candidates.length, 1);
  assert.deepEqual(skipped.map(item => item.reason), ['spans_documents', 'unresolvable_evidence']);
  assert.equal(candidates[0].sourceType, 'user_statement', 'an upload label never gives a model reading contractual standing');
  assert.equal(candidates[0].declaredSourceType, 'issued_schedule');
  assert.equal(candidates[0].policyAssociation.basis, 'system_selected');
  assert.equal(answerToCandidates({ ...answer, documentAssociation: { basis: 'requester_named' } }, { clauseRows, documentKinds: kinds, policyId: 'U1' }).candidates[0].policyAssociation.basis, 'requester_named');
  const long = answerToCandidates({ covered: [{ subject: 's', clauseIds: ['a1'], effect: 'covers', conditions: ['x'.repeat(900), '  '] }] }, { clauseRows, documentKinds: kinds, policyId: 'U1' }).candidates[0];
  assert.equal(long.conditions.length, 1);
  assert.equal(long.conditions[0].length, 500);
  assert.equal(candidates[0].topic, 'room rent');
  assert.ok(!JSON.stringify(candidates).includes('SECRET QUOTE'));
});

test('B3-8: a disease-specific sublimit and waiting period surface in the policy layer and are not hidden by the general rule', () => {
  const facts = build([
    fact({ factType: 'sum_insured', topic: '', value: { amountMinor: 50000000, currency: 'INR' } }),
    fact({ factType: 'sublimit', topic: 'cataract', value: { kind: 'amount', amountMinor: 300000, currency: 'INR' } }),
    fact({ factType: 'waiting_period', topic: 'hernia', value: { months: 24 } }),
  ]);
  const layer = separatePolicies([{ policyId: 'P1', kind: 'personal', coverBasis: 'individual' }], facts, { asOf: '2026-06-01' }).layers[0];
  const find = (rule, topic) => layer.rules.find(r => r.rule === rule && r.topic === topic);
  assert.equal(find('sum_insured', '').result.status, 'known');
  assert.equal(find('sublimit', 'cataract').result.value.amountMinor, 300000);
  assert.equal(find('waiting_period', 'hernia').result.value.months, 24);
  // The general rule is still reported, and stays unknown rather than borrowing the disease-specific value.
  assert.equal(find('sublimit', '').result.status, 'unknown');
  assert.equal(find('waiting_period', '').result.status, 'unknown');
});

test('B3-3: identity, enrolment, claim-document and portability rules; network status is never permanently known', () => {
  const facts = build([
    fact({ factType: 'policy_identity', value: { insurer: 'Synthetic Insurer', productName: 'Synthetic Plan' } }),
    fact({ factType: 'member_enrolment', topic: '', value: { status: 'enrolled' }, subject: { memberId: 'm1' } }),
    fact({ factType: 'network_status', topic: 'synthetic hospital', value: { provider: 'Synthetic Hospital', status: 'network' } }),
    fact({ factType: 'claim_documents', value: { documents: ['discharge summary'] } }),
    fact({ factType: 'renewal_portability', value: { portable: true } }),
    fact({ factType: 'claim_documents', topic: 'bad', value: { documents: [] } }),
  ]);
  const rules = evaluateRules(facts, { policyId: 'P1', memberId: 'm1', asOf: '2026-06-01' });
  const one = (id, topic = '') => rules.find(r => r.rule === id && r.topic === topic).result;
  assert.equal(one('policy_identity').status, 'known');
  assert.equal(one('member_enrolment').status, 'known');
  assert.equal(one('claim_documents').status, 'known');
  assert.equal(one('renewal_portability').status, 'known');
  assert.equal(one('network_status', 'synthetic hospital').status, 'dynamic');
  assert.equal(one('network_status', 'synthetic hospital').value, null);
  assert.equal(one('claim_documents', 'bad').status, 'unverified', 'malformed value never becomes a known empty list');
  // Another member's enrolment is not this member's.
  assert.equal(evaluateRules(facts, { policyId: 'P1', memberId: 'm2' }, ['member_enrolment'])[0].result.status, 'unknown');
});

test('B3-5: the curated catalogue ships empty and every entry must pass the validator', async () => {
  const { CURATED_OFFICIAL_SOURCES } = await import('../src/features/decision-catalogue/index.js');
  assert.ok(Object.isFrozen(CURATED_OFFICIAL_SOURCES));
  for (const record of CURATED_OFFICIAL_SOURCES) assert.equal(validateOfficialSource(record, { today: '2026-10-20' }).valid, true);
  assert.deepEqual(CURATED_OFFICIAL_SOURCES, []);
});
