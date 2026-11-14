import assert from 'node:assert/strict';
import test from 'node:test';
import { planNextQuestions, recordAnswer, analyticsPayloadFor, MAX_QUESTIONS_BEFORE_CARD, CATALOGUE_V1 } from '../src/features/question-planner/index.js';
import { QUESTION_CATALOGUE_VERSION } from '../src/contracts/question-catalogue.js';

const now = '2026-11-14T00:00:00.000Z';
const adult = { id: 'm1', isMinor: false };
const child = { id: 'm2', isMinor: true };
const ids = plan => plan.map(p => `${p.questionId}@${p.memberId}`);

test('before the card: cap of 2, members and PED only; strip is unlimited (B9)', () => {
  assert.equal(MAX_QUESTIONS_BEFORE_CARD, 2);
  const plan = planNextQuestions({ members: [adult, child], now, limit: 50 });
  assert.equal(plan.length, 2);
  assert.equal(planNextQuestions({ members: [adult], now }).length, 2);
  assert.ok(plan.every(p => p.phase === 'before_card' && /^(members|ped)\./.test(p.questionId)));
  const strip = planNextQuestions({ members: [adult], now, phase: 'strip' });
  assert.ok(strip.length > 5 && strip.every(p => p.phase === 'strip'));
});
test('strip is ordered by score and a required-input question ranks high (B6)', () => {
  const strip = planNextQuestions({ members: [adult], now, phase: 'strip' });
  assert.equal(strip[0].questionId, 'portability.prior_cover_years');
  const none = planNextQuestions({ members: [adult], now, phase: 'strip', openedTiles: [] });
  assert.deepEqual(none, strip);
});
test('orders by score then catalogue order', () => {
  const plan = planNextQuestions({ members: [adult], now });
  assert.deepEqual(plan.map(p => p.questionId), ['members.confirm', 'ped.has_any']);
  const strip = planNextQuestions({ members: [adult], now, phase: 'strip' }).map(p => p.questionId);
  assert.deepEqual(strip.slice(0, 3), ['portability.prior_cover_years', 'claims.prior_4y', 'cover.other_health']);
  assert.ok(!plan.some(p => p.questionId === 'ped.which_conditions'), 'followup stays hidden until parent answered');
});
test('not_sure suppresses the slot for 30 days, then it returns', () => {
  const log = [{ questionId: 'members.confirm', memberId: 'm1', outcome: 'not_sure', answeredAt: '2026-11-01T00:00:00.000Z' }];
  assert.ok(!planNextQuestions({ members: [adult], answeredLog: log, now }).some(p => p.questionId === 'members.confirm'));
  assert.ok(planNextQuestions({ members: [adult], answeredLog: log, now: '2026-12-02T00:00:00.000Z' }).some(p => p.questionId === 'members.confirm'));
});
test('answered and user_confirmed slots are not asked again', () => {
  const slots = [{ factKey: 'member_covered', memberId: 'm1', status: 'user_confirmed', sourceTier: 'user_declaration' }];
  assert.ok(!planNextQuestions({ members: [adult], slots, now }).some(p => p.questionId === 'members.confirm'));
  const log = [{ questionId: 'home.city', memberId: null, outcome: 'answered', optionIds: ['delhi'], answeredAt: now }];
  assert.ok(!planNextQuestions({ members: [adult], answeredLog: log, now }).some(p => p.questionId === 'home.city'));
});
test('extracted_unverified declaration-primary slots are asked; product terms are not', () => {
  const slots = [
    { factKey: 'declared_prior_claims', memberId: 'm1', status: 'extracted_unverified', sourceTier: 'own_pdf' },
  ];
  const plan = planNextQuestions({ members: [adult], slots, now, phase: 'strip' });
  assert.equal(plan.find(p => p.questionId === 'claims.prior_4y').reason, 'confirm_extracted');
});
test('conflicting slot gives a 2-choice question with both source tiers', () => {
  const slots = [{ factKey: 'declared_other_cover', memberId: null, status: 'conflicting', alternatives: [
    { value: 'yes', sourceTier: 'own_pdf' }, { value: 'no', sourceTier: 'user_declaration' }, { value: 'x', sourceTier: 'ida_wording' }] }];
  const entry = planNextQuestions({ members: [adult], slots, now, phase: 'strip' }).find(p => p.questionId === 'cover.other_health');
  assert.equal(entry.reason, 'conflict');
  assert.equal(entry.conflict.prompt, 'Which is right?');
  assert.deepEqual(entry.conflict.choices, [{ choiceId: 'a', value: 'yes', sourceTier: 'own_pdf' }, { choiceId: 'b', value: 'no', sourceTier: 'user_declaration' }]);
});
test('minors only get coverage-relevant questions', () => {
  const plan = [...planNextQuestions({ members: [child], now }), ...planNextQuestions({ members: [child], now, phase: 'strip' })];
  const byId = new Map(CATALOGUE_V1.map(i => [i.id, i]));
  for (const p of plan) if (p.memberId === 'm2') assert.equal(byId.get(p.questionId).coverageRelevant, true);
  assert.ok(plan.some(p => p.memberId === 'm2'));
});
test('a question that changes an asked verdict ranks first', () => {
  const answeredLog = [{ questionId: 'portability.prior_cover_years', memberId: null, outcome: 'answered', optionIds: ['this_year'], answeredAt: now }];
  const opts = { members: [adult], now, phase: 'strip', answeredLog };
  const base = planNextQuestions({ ...opts, askedVerdictNeeds: [] });
  assert.equal(base[0].questionId, 'claims.prior_4y');
  const boosted = planNextQuestions({ ...opts, askedVerdictNeeds: ['declared_other_cover'] });
  assert.equal(boosted[0].questionId, 'cover.other_health');
  assert.equal(boosted[0].reason, 'changes_verdict');
});
test('opened tiles raise the score of what unlocks them', () => {
  const strip = extra => planNextQuestions({ members: [adult], now, phase: 'strip', ...extra }).map(p => p.questionId);
  assert.ok(strip({ openedTiles: ['cashless'] }).indexOf('home.city') < strip().indexOf('home.city'));
  // B10: interest is not echoed back.
  assert.ok(planNextQuestions({ members: [adult], now, phase: 'strip', openedTiles: ['cashless'] }).every(p => !('openedTiles' in p) && !('score' in p)));
});
test('PED yes activates which-conditions, then started-on', () => {
  const answered = (questionId, optionIds) => ({ questionId, memberId: 'm1', outcome: 'answered', optionIds, answeredAt: now });
  const after = planNextQuestions({ members: [adult], answeredLog: [answered('ped.has_any', ['yes'])], now });
  assert.deepEqual(ids(after).slice(0, 1), ['ped.which_conditions@m1']);
  assert.equal(after[0].reason, 'followup');
  const no = planNextQuestions({ members: [adult], answeredLog: [answered('ped.has_any', ['no'])], now });
  assert.ok(!no.some(p => p.questionId === 'ped.which_conditions'));
  const next = planNextQuestions({ members: [adult], answeredLog: [answered('ped.has_any', ['yes']), answered('ped.which_conditions', ['diabetes'])], now });
  assert.equal(next[0].questionId, 'ped.started_on');
});
test('deterministic for identical input and returns no text', () => {
  const input = { members: [adult, child], now, openedTiles: ['waiting_periods'], askedVerdictNeeds: ['declared_ped'], phase: 'strip' };
  const a = planNextQuestions(structuredClone(input));
  assert.deepEqual(a, planNextQuestions(structuredClone(input)));
  assert.ok(a.every(p => !('prompt' in p)));
  assert.throws(() => planNextQuestions({ members: [adult] }), /valid now/);
});
test('recordAnswer builds a user_declaration DTO with audit fields', () => {
  const row = recordAnswer({ questionId: 'ped.which_conditions', memberId: 'm1', optionIds: ['thyroid', 'diabetes'], catalogueVersion: QUESTION_CATALOGUE_VERSION });
  assert.equal(row.sourceTier, 'user_declaration');
  assert.equal(row.status, 'user_confirmed');
  assert.equal(row.factKey, 'declared_ped');
  assert.deepEqual(row.value, ['diabetes', 'thyroid']);
  assert.equal(row.questionId, 'ped.which_conditions');
  assert.equal(row.catalogueVersion, 'question-catalogue/v1');
  assert.equal(row.sensitivity, 'health');
  assert.deepEqual(row.followupsActivated, ['ped.started_on']);
  const yes = recordAnswer({ questionId: 'ped.has_any', memberId: 'm1', optionIds: ['yes'], catalogueVersion: QUESTION_CATALOGUE_VERSION });
  assert.deepEqual(yes.followupsActivated, ['ped.which_conditions']);
});
test('recordAnswer: not_sure is unknown and writes no row; bad input is refused', () => {
  const ns = recordAnswer({ questionId: 'home.city', optionIds: ['not_sure'], catalogueVersion: QUESTION_CATALOGUE_VERSION });
  assert.equal(ns.status, 'unknown');
  assert.equal(ns.writeMemoryRow, false);
  assert.equal(ns.value, null);
  const bad = o => () => recordAnswer({ catalogueVersion: QUESTION_CATALOGUE_VERSION, ...o });
  assert.throws(bad({ questionId: 'home.city', optionIds: ['mars'] }), { code: 'QUESTION_ANSWER_INVALID' });
  assert.throws(bad({ questionId: 'ped.has_any', optionIds: ['yes'] }), /member/);
  assert.throws(bad({ questionId: 'home.city', optionIds: ['delhi'], catalogueVersion: 'old' }), /version/);
  assert.throws(bad({ questionId: 'nope', optionIds: ['x'] }), /Unknown/);
  assert.equal(recordAnswer({ questionId: 'cover.other_health', optionIds: ['yes'], catalogueVersion: QUESTION_CATALOGUE_VERSION, conflictResolution: true }).captureMethod, 'conflict_resolution');
});

test('analytics payload never carries a health or money option (B1)', () => {
  const v = QUESTION_CATALOGUE_VERSION;
  const health = recordAnswer({ questionId: 'ped.which_conditions', memberId: 'm1', optionIds: ['diabetes'], catalogueVersion: v });
  const payload = analyticsPayloadFor(health);
  assert.deepEqual(payload, { questionId: 'ped.which_conditions', answered: true });
  assert.ok(!JSON.stringify(payload).includes('diabetes'));
  const money = recordAnswer({ questionId: 'cover.employer', optionIds: ['yes'], catalogueVersion: v });
  assert.deepEqual(analyticsPayloadFor(money), { questionId: 'cover.employer', answered: true });
  const none = recordAnswer({ questionId: 'pref.language', optionIds: ['hi'], catalogueVersion: v });
  assert.deepEqual(analyticsPayloadFor(none), { questionId: 'pref.language', answered: true, optionIds: ['hi'] });
  for (const item of CATALOGUE_V1.filter(i => i.sensitivity !== 'none' && !i.perMember)) {
    const opt = item.input.options[0]?.id ?? 'x';
    assert.ok(!('optionIds' in analyticsPayloadFor(recordAnswer({ questionId: item.id, optionIds: [opt], catalogueVersion: v }))));
  }
});
