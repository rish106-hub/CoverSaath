import test from 'node:test';
import assert from 'node:assert/strict';
import { collateSlot, resolveSlot, assertMachineRowAuthority } from '../src/features/insurance-rules/collate.js';
import { nextHoldingStatus, holdingStatusTable } from '../src/features/insurance-rules/holding-status.js';
import { equalityKey, sameFactValue } from '../src/features/policy-facts/fact-equality.js';
import { HOLDING_STATUSES } from '../src/contracts/holdings.js';
import { holdingsEnabled } from '../src/backend/services/holdings-flag.js';
import { holdingJobDedupeKey, holdingInputSha } from '../src/backend/services/holding-pipeline.js';

// Pure collate, status machine, equality and idempotency key (complete.md 3.2, 9.4; ADR 0023 D3). Synthetic values only.

const days = n => ({ days: n, original: [] });
const own = (value, { factId = 'pf-1', origin = 'deterministic', state = 'extracted_unverified', alternatives = [] } = {}) => ({ factId, origin, state, value, alternatives });
const ida = (value, { refId = 'ref-1', origin = 'reference' } = {}) => ({ refId, origin, value });

test('typed equality: units normalise, text folds, wrong shapes never match', () => {
  assert.equal(sameFactValue('duration', { days: 1095, original: [36, 'month'] }, { days: 1095, original: [3, 'year'] }), true);
  assert.equal(sameFactValue('money', { amountMinor: 50_000_000 }, { amountMinor: 50_000_000, currency: 'INR' }), true);
  assert.equal(sameFactValue('money', { amountMinor: 50_000_000 }, { amountMinor: 50_000_001 }), false);
  assert.equal(sameFactValue('text', { text: '  Cataract  Surgery ' }, { text: 'cataract surgery' }), true);
  assert.equal(sameFactValue('bool', { value: true }, { value: true }), true);
  assert.equal(sameFactValue('enum', { value: 'upi' }, { value: 'cash' }), false);
  assert.equal(equalityKey('money', null), null);
  assert.equal(sameFactValue('money', {}, {}), false);
  assert.equal(equalityKey('percent', { bp: 2000 }), 'percent:2000');
});

test('product term: both machine tiers agree -> reviewed_reference citing both, no conflict', () => {
  const slot = collateSlot({ factKey: 'waiting_ped', own: [own(days(1095))], ida: [ida(days(1095))] });
  assert.equal(slot.conflict, null);
  assert.equal(slot.own.status, 'extracted_unverified');
  assert.equal(slot.ida.status, 'reviewed_reference');
  assert.equal(slot.ida.policyFactId, 'pf-1');
  assert.equal(slot.ida.referenceId, 'ref-1');
  const resolved = resolveSlot({ factKey: 'waiting_ped', own: { id: 'm-own', ...slot.own }, ida: { id: 'm-ida', ...slot.ida } });
  assert.equal(resolved.status, 'reviewed_reference');
  assert.deepEqual(resolved.sourceIds, ['m-own', 'm-ida']);
  assert.equal(resolved.checkWithInsurer, false);
});

test('product term: tiers differ -> both rows conflicting and exactly one own_vs_insurer conflict', () => {
  const slot = collateSlot({ factKey: 'copay_percent', own: [own({ bp: 2000 })], ida: [ida({ bp: 1000 })] });
  assert.deepEqual(slot.conflict, { reason: 'own_vs_insurer' });
  assert.equal(slot.own.status, 'conflicting');
  assert.equal(slot.ida.status, 'conflicting');
  assert.deepEqual(slot.own.alternatives, [{ bp: 2000 }]);
  const resolved = resolveSlot({ factKey: 'copay_percent', own: { id: 'a', ...slot.own }, ida: { id: 'b', ...slot.ida } });
  assert.equal(resolved.status, 'conflicting');
  assert.equal(resolved.alternatives.length, 2);
  assert.equal(resolved.checkWithInsurer, true);
});

test('missing -> nothing written and the resolver answers unknown', () => {
  const slot = collateSlot({ factKey: 'waiting_maternity' });
  assert.equal(slot.own, null);
  assert.equal(slot.ida, null);
  assert.equal(slot.conflict, null);
  assert.equal(resolveSlot({ factKey: 'waiting_maternity' }).status, 'unknown');
  // An unknown own fact is not a value.
  assert.equal(collateSlot({ factKey: 'waiting_maternity', own: [own(null, { state: 'unknown' })] }).own, null);
});

test('only one tier -> extracted_unverified (own) or reviewed_reference (IDA)', () => {
  const ownOnly = collateSlot({ factKey: 'grace_period', own: [own(days(30))] });
  assert.equal(ownOnly.own.status, 'extracted_unverified');
  assert.equal(resolveSlot({ factKey: 'grace_period', own: { id: 'x', ...ownOnly.own } }).status, 'extracted_unverified');
  const idaOnly = collateSlot({ factKey: 'grace_period', ida: [ida(days(30))] });
  assert.equal(idaOnly.ida.status, 'reviewed_reference');
  assert.equal(idaOnly.ida.policyFactId, null);
});

test('personal value: IDA is ignored, a differing typed declaration raises own_vs_declaration', () => {
  const slot = collateSlot({ factKey: 'sum_insured', own: [own({ amountMinor: 50_000_000 })], ida: [ida({ amountMinor: 1 })] });
  assert.equal(slot.ida, null);
  assert.deepEqual(slot.refused, ['IDA_NOT_PRODUCT_TERM']);
  const declared = collateSlot({ factKey: 'sum_insured', own: [own({ amountMinor: 50_000_000 })], declaration: { captureMethod: 'typed', value: { amountMinor: 70_000_000 } } });
  assert.deepEqual(declared.conflict, { reason: 'own_vs_declaration' });
  assert.equal(declared.own.status, 'conflicting');
});

test('in-tier disagreement -> own row conflicting with alternatives and an in-tier conflict (audit F4)', () => {
  const slot = collateSlot({ factKey: 'grace_period', own: [own(days(30)), own(days(15), { factId: 'pf-2', origin: 'model_proposed' })] });
  assert.equal(slot.own.status, 'conflicting');
  assert.equal(slot.own.inTierReason, 'model_disagree');
  assert.equal(slot.own.alternatives.length, 2);
  assert.deepEqual(slot.conflict, { reason: 'model_disagree' });
});

test('user resolution -> user_confirmed, machine rows stay, product term keeps both values and check-with-insurer', () => {
  const slot = collateSlot({ factKey: 'copay_percent', own: [own({ bp: 2000 })], ida: [ida({ bp: 1000 })] });
  const rows = { own: { id: 'a', ...slot.own }, ida: { id: 'b', ...slot.ida } };
  const declaration = { id: 'd', status: 'user_confirmed', value: { bp: 1000 }, captureMethod: 'conflict_resolution', resolvesFactIds: ['a', 'b'] };
  const resolved = resolveSlot({ factKey: 'copay_percent', ...rows, declaration });
  assert.equal(resolved.status, 'user_confirmed');
  assert.equal(resolved.sourceTier, 'user_declaration');
  assert.deepEqual(resolved.alternatives, [{ bp: 2000 }, { bp: 1000 }]);
  assert.equal(resolved.checkWithInsurer, true);
  // A later machine row with a different value makes the slot conflicting again.
  const later = resolveSlot({ factKey: 'copay_percent', own: { id: 'a2', status: 'extracted_unverified', value: { bp: 3000 } }, ida: rows.ida, declaration });
  assert.equal(later.status, 'conflicting');
});

// The authority test: model-sourced input must never reach reviewed_reference or user_confirmed (complete.md O-A4 failure rule).
test('model-sourced input never reaches reviewed_reference or user_confirmed', () => {
  const keys = ['waiting_ped', 'copay_percent', 'sum_insured', 'grace_period', 'declared_ped', 'room_category'];
  const valueFor = key => ({ waiting_ped: days(1095), copay_percent: { bp: 2000 }, sum_insured: { amountMinor: 50_000_000 }, grace_period: days(30), declared_ped: { text: 'none' }, room_category: { value: 'single_private' } })[key];
  let checked = 0;
  for (const factKey of keys) {
    const value = valueFor(factKey);
    const modelOwn = [own(value, { origin: 'model_proposed' })];
    const modelIda = [ida(value, { origin: 'model_proposed' })];
    for (const input of [{ own: modelOwn }, { ida: modelIda }, { own: modelOwn, ida: modelIda }, { own: modelOwn, ida: [ida(value)] }]) {
      const slot = collateSlot({ factKey, ...input });
      for (const row of [slot.own, slot.ida].filter(Boolean)) {
        checked += 1;
        assert.notEqual(row.status, 'user_confirmed');
        assert.notEqual(row.tier, 'user_declaration');
        if (row.status === 'reviewed_reference') {
          // Only a deterministic reference reading gives it, and it never cites the model fact.
          assert.equal(row.reference.origin, 'reference');
          assert.equal(row.policyFactId, null, factKey);
        }
      }
      if (input.ida === modelIda) assert.equal(slot.ida, null, `${factKey}: model IDA value refused`);
      const resolved = resolveSlot({ factKey, own: slot.own && { id: 'o', ...slot.own }, ida: slot.ida && { id: 'i', ...slot.ida } });
      assert.notEqual(resolved.status, 'user_confirmed');
      if (resolved.status === 'reviewed_reference') assert.equal(input.ida === modelIda, false);
    }
  }
  assert.ok(checked > 10);
  // The writer guard refuses every forbidden shape even when called directly.
  const refused = row => assert.throws(() => assertMachineRowAuthority(row), { code: 'COLLATE_AUTHORITY_REFUSED' });
  refused({ tier: 'user_declaration', status: 'user_confirmed' });
  refused({ tier: 'own_pdf', status: 'user_confirmed' });
  refused({ tier: 'own_pdf', status: 'reviewed_reference', modelSourced: false });
  refused({ tier: 'ida_wording', status: 'reviewed_reference', modelSourced: true, reference: { origin: 'reference' } });
  refused({ tier: 'ida_wording', status: 'reviewed_reference', modelSourced: false, reference: { origin: 'model_proposed' } });
  refused({ tier: 'ida_wording', status: 'confirmed', modelSourced: false });
  refused({ tier: 'own_pdf', status: 'unknown' });
});

test('holding status machine: happy path, conflicts non-blocking, replays are no-ops, illegal steps refused', () => {
  let status = 'uploaded';
  const step = (event, openConflicts = 0) => { const next = nextHoldingStatus(status, event, { openConflicts }); status = next.status; return next; };
  assert.equal(step('detect').status, 'insurer_pending');
  assert.equal(step('report').status, 'product_reported');
  assert.equal(step('parse').status, 'parsed');
  assert.equal(step('collate', 1).status, 'parsed');
  assert.equal(step('memorise', 1).status, 'conflicts');
  assert.equal(step('parse').changed, false);
  assert.equal(step('resolve', 0).status, 'ready');
  assert.equal(step('memorise', 0).changed, false);
  assert.equal(step('collate', 1).status, 'conflicts');
  assert.throws(() => nextHoldingStatus('uploaded', 'parse'), { code: 'HOLDING_TRANSITION_INVALID' });
  assert.throws(() => nextHoldingStatus('insurer_pending', 'memorise'), { code: 'HOLDING_TRANSITION_INVALID' });
  assert.throws(() => nextHoldingStatus('confirmed', 'parse'), { code: 'HOLDING_TRANSITION_INVALID' });
  assert.equal(HOLDING_STATUSES.includes('confirmed'), false);
  assert.equal(holdingStatusTable().length, HOLDING_STATUSES.length * 6);
});

test('idempotency key: sha256 hex of (holding, step, input sha), identifier-safe, stable, input-sensitive', () => {
  const sha = holdingInputSha(['pf-1', 'ref-1']);
  assert.match(sha, /^[0-9a-f]{64}$/);
  assert.equal(holdingInputSha(['ref-1', 'pf-1']), sha);
  const key = holdingJobDedupeKey({ holdingId: 'hold-1', step: 'collate', inputSha: sha });
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(key, holdingJobDedupeKey({ holdingId: 'hold-1', step: 'collate', inputSha: sha }));
  assert.notEqual(key, holdingJobDedupeKey({ holdingId: 'hold-1', step: 'memorise', inputSha: sha }));
  assert.notEqual(key, holdingJobDedupeKey({ holdingId: 'hold-2', step: 'collate', inputSha: sha }));
  assert.throws(() => holdingJobDedupeKey({ holdingId: 'hold-1', step: 'other', inputSha: sha }));
});

test('HOLDINGS_ENABLED is on only when exactly "true"', () => {
  assert.equal(holdingsEnabled({ HOLDINGS_ENABLED: 'true' }), true);
  for (const value of [undefined, '', 'TRUE', '1', 'yes', ' true']) assert.equal(holdingsEnabled({ HOLDINGS_ENABLED: value }), false);
});

test('in-tier: two own-PDF readings that differ raise one two_pages conflict (a personal value, no other tier needed)', () => {
  const slot = collateSlot({ factKey: 'sum_insured', own: [own({ amountMinor: 50_000_000 }, { factId: 'pf-a' }), own({ amountMinor: 70_000_000 }, { factId: 'pf-b' })] });
  assert.deepEqual(slot.conflict, { reason: 'two_pages' });
  assert.equal(slot.own.status, 'conflicting');
  assert.equal(slot.own.alternatives.length, 2);
  const mixed = collateSlot({ factKey: 'sum_insured', own: [own({ amountMinor: 50_000_000 }, { factId: 'pf-a' }), own({ amountMinor: 70_000_000 }, { factId: 'pf-m', origin: 'model_proposed' })] });
  assert.deepEqual(mixed.conflict, { reason: 'model_disagree' });
  const same = collateSlot({ factKey: 'sum_insured', own: [own({ amountMinor: 50_000_000 }, { factId: 'pf-a' }), own({ amountMinor: 50_000_000 }, { factId: 'pf-b' })] });
  assert.equal(same.conflict, null, 'two pages that agree are not a conflict');
});
