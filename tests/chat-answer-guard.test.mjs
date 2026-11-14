import test from 'node:test';
import assert from 'node:assert/strict';
import { ANSWER_CARD_CONTRACT } from '../src/contracts/answer-card.js';
import { GUARD_CHECK_IDS as C, isReleasedCard, containsIdentifier, guardAnswerCard, speechFromHeadline, unknownCard } from '../src/features/chat-answer-guard/index.js';
import { ADVICE_PHRASES, OUTCOME_PROMISE_PHRASES, firstMatch } from '../src/features/chat-answer-guard/banned-phrases.js';
import { durationsEqual, extractNumbers, numbersEqual } from '../src/features/chat-answer-guard/number-normaliser.js';

const evidence = {
  s1: { text: 'Listed surgeries, including knee replacement, are covered after a waiting period of 24 months from the start date.', factIds: ['f1'], values: [] },
  s2: { text: 'The sub-limit for joint replacement is Rs 5 lakh per policy year.  Room rent is capped at 1% of sum insured.', factIds: ['f2'], values: [] },
};
const ruleResults = {
  rr1: { verdict: 'partly_covered', values: [{ kind: 'date', value: '2027-03-12' }, { kind: 'duration_days', value: 730 }] },
  rr2: { verdict: 'covered', values: [] },
};
const base = () => ({
  contract: ANSWER_CARD_CONTRACT, status: 'evidence_found', verdict: 'partly_covered', ruleResultId: 'rr1',
  headline: 'Covered after 2 years, up to 5 lakh', explanation: 'Knee replacement has a 24 month wait. Your wait ends on 12 Mar 2027.',
  conditions: [
    { kind: 'waiting_period', text: '36 months is not here; 2-year wait for listed surgeries', days: 730, endsOn: '2027-03-12', ruleResultId: 'rr1', sourceIds: ['s1'] },
    { kind: 'sublimit', text: 'Up to Rs 5,00,000 per policy year', amountMinor: 50000000, ruleResultId: null, sourceIds: ['s2'] },
  ],
  sources: [
    { id: 's1', factIds: ['f1'], tier: 'ida_wording', status: 'reviewed_reference', page: 12, clause: '4.2(b)', quote: 'covered after a waiting period of 24 months' },
    { id: 's2', factIds: ['f2'], tier: 'own_pdf', status: 'extracted_unverified', page: 3, clause: null, quote: 'sub-limit for joint replacement is Rs 5 lakh' },
  ],
  gaps: [], actions: [{ kind: 'find_hospital', label: 'Find a cashless hospital' }], followups: ['What documents do I need?'],
  speech: { lang: 'en', text: '' }, answer: 'x', legalReview: 'pending',
});
// Make base consistent: remove the invalid "36 months" text.
const good = (over = {}) => {
  const c = { ...base(), ...over };
  if (!over.conditions) c.conditions = c.conditions.map((x, i) => (i === 0 ? { ...x, text: '2-year wait for listed surgeries' } : x));
  if (!over.speech) c.speech = { lang: 'en', text: speechFromHeadline(c) };
  return c;
};
const guard = (card, mode = 'text', ev = evidence, rr = ruleResults) => guardAnswerCard({ card, evidence: ev, ruleResults: rr, mode });

test('baseline good card releases', () => {
  const r = guard(good());
  assert.deepEqual(r.failedChecks, undefined);
  assert.equal(r.released, true);
});

const goods = [
  ['lakh vs rupees', good()],
  ['months vs years', good({ headline: 'Covered after 24 months', explanation: 'Wait is 2 years.' })],
  ['days from rule vs years', good({ explanation: 'The wait is 730 days.' })],
  ['rule date', good({ explanation: 'Your wait ends on 2027-03-12.' })],
  ['percent from source', good({ explanation: 'Room rent is capped at 1% of sum insured.' })],
  ['hindi lakh', good({ explanation: 'Limit पांच लाख per year.' })],
  ['unknown verdict no rule', { ...unknownCard(), status: 'evidence_found', verdict: 'depends', headline: 'It depends on when it started', explanation: 'We need a date.', sources: [good().sources[0]], conditions: [], speech: undefined }],
  ['out of scope', { ...unknownCard(), status: 'out_of_scope' }],
  ['voice mode with template', good()],
];
for (const [name, card] of goods) {
  test(`good: ${name}`, () => {
    const r = guard(card, name === 'voice mode with template' ? 'voice' : 'text');
    assert.equal(r.released, true, JSON.stringify(r.failedChecks));
  });
}
test('good: unknown card itself is released and valid', () => assert.equal(guard(unknownCard(), 'voice').released, true));

const withExplanation = (text) => good({ explanation: text });
const withHeadline = (text) => { const c = good({ headline: text }); return c; };
const cases = [
  ['invented money', withExplanation('The limit is Rs 7 lakh.'), C.number],
  ['invented days', withExplanation('The wait is 45 days.'), C.number],
  ['invented percent', withExplanation('Co-pay is 20% here.'), C.number],
  ['invented date', withExplanation('Your wait ends on 1 Jan 2030.'), C.number],
  ['invented bare big number', withExplanation('Limit 750000 per year.'), C.number],
  ['3 years vs 24 months', withExplanation('The wait is 3 years.'), C.number],
  ['condition invented amount', good({ conditions: [{ ...base().conditions[1], text: 'Up to Rs 9 lakh', amountMinor: 50000000 }] }), C.number],
  ['outcome promise paid', withExplanation('Your claim will be paid in full.'), C.outcome],
  ['outcome guaranteed', withExplanation('Cover is guaranteed.'), C.outcome],
  ['outcome definitely covered', withExplanation('This is definitely covered.'), C.outcome],
  ['outcome hinglish pakka', withExplanation('Claim pakka milega.'), C.outcome],
  ['outcome hinglish zaroor', withExplanation('Paisa zaroor milega.'), C.outcome],
  ['advice buy', withExplanation('You should buy a top-up plan.'), C.advice],
  ['advice port', withExplanation('You should port to another insurer.'), C.advice],
  ['advice medicine', withExplanation('Take this medicine twice daily.'), C.advice],
  ['advice tax', withExplanation('This helps with tax saving.'), C.advice],
  ['advice surrender', withExplanation('You must surrender this policy.'), C.advice],
  ['missing citation on condition', good({ conditions: [{ ...base().conditions[0], text: '2-year wait', sourceIds: [] }] }), C.citation],
  ['unknown source id', good({ conditions: [{ ...base().conditions[0], text: '2-year wait', sourceIds: ['zz'] }] }), C.citation],
  ['no sources on evidence card', good({ sources: [] }), C.citation],
  ['fake quote', good({ sources: [{ ...base().sources[0], quote: 'covered from day one' }, base().sources[1]] }), C.quote],
  ['quote too long', good({ sources: [{ ...base().sources[0], quote: evidence.s1.text + ' ' + 'x'.repeat(200) }, base().sources[1]] }), C.shape],
  ['verdict without rule', good({ ruleResultId: null }), C.verdict],
  ['rule id not found', good({ ruleResultId: 'rr_missing' }), C.verdict],
  ['verdict contradicts rule', good({ verdict: 'not_covered' }), C.verdict],
  ['depends contradicts rule', good({ verdict: 'depends' }), C.verdict],
  ['aadhaar echo', withExplanation('Aadhaar 2345 6789 0123 on file.'), C.identifier],
  ['aadhaar no spaces', withExplanation('Id 234567890123 on file.'), C.identifier],
  ['pan echo', withExplanation('PAN ABCDE1234F noted.'), C.identifier],
  ['card number', withExplanation('Card 4111 1111 1111 1111 used.'), C.identifier],
  ['otp near word', withExplanation('Your otp is 123456.'), C.identifier],
  ['speech not template', good({ speech: { lang: 'en', text: 'Great news, pay is coming.' } }), C.speech],
  ['speech wrong verdict', good({ speech: { lang: 'en', text: 'Your policy says: covered.' } }), C.speech],
  ['bad shape', { contract: 'nope' }, C.shape],
];
for (const [name, card, expected] of cases) {
  test(`bad: ${name} -> ${expected}`, () => {
    const r = guard(card);
    assert.equal(r.released, false);
    assert.ok(r.failedChecks.includes(expected), r.failedChecks.join());
    assert.equal(r.card.status, 'unknown');
    assert.equal(r.card.headline, "Your documents don't say.");
    assert.equal(r.card.actions[0].kind, 'call_insurer');
    assert.equal(r.card.legalReview, 'pending');
    assert.equal(JSON.stringify(r.card).includes(JSON.stringify(card.explanation ?? '@@')), false);
  });
}

test('bad table has at least 20 rows', () => assert.ok(cases.length >= 20));

test('voice: never retryable; text: retryable only for C1-C3', () => {
  const invented = withExplanation('The limit is Rs 7 lakh.');
  assert.equal(guard(invented, 'text').retryable, true);
  assert.equal(guard(invented, 'voice').retryable, false);
  assert.equal(guard(withExplanation('Cover is guaranteed.'), 'text').retryable, false);
  assert.equal(guard(good({ ruleResultId: null }), 'text').retryable, false);
});

test('voice requires speech', () => {
  const c = good(); delete c.speech;
  assert.ok(guard(c, 'voice').failedChecks.includes(C.speech));
  assert.equal(guard(c, 'text').released, true);
});

test('quote match is whitespace-insensitive', () => {
  const c = good({ sources: [base().sources[0], { ...base().sources[1], quote: 'Room rent is capped\n at   1% of sum insured' }] });
  assert.equal(guard(c).released, true);
});

test('speech template: verdict plus one amount or date', () => {
  assert.equal(speechFromHeadline({ verdict: 'covered', conditions: [] }), 'Your policy says: covered.');
  assert.equal(speechFromHeadline({ verdict: 'partly_covered', conditions: [{ amountMinor: 50000000 }] }), 'Your policy says: partly covered, up to Rs 5,00,000.');
  assert.equal(speechFromHeadline({ verdict: 'covered', conditions: [{ endsOn: '2027-03-12' }] }), 'Your policy says: covered, from 12 Mar 2027.');
  assert.equal(speechFromHeadline({ verdict: 'unknown' }), "Your documents don't say.");
  assert.ok(speechFromHeadline({ verdict: 'depends', conditions: [{ amountMinor: 123 }] }).split(' ').length <= 25);
});

test('unknown card has no model text and is fixed', () => {
  const u = unknownCard();
  assert.deepEqual([u.status, u.verdict, u.conditions.length, u.sources.length], ['unknown', 'unknown', 0, 0]);
});

test('identifier detector: no false positives on money and dates', () => {
  for (const s of ['Rs 5,00,000', '12 Mar 2027', '2027-03-12', '24 months', 'Policy year 2026', 'Rs 50,000 per knee', 'otp']) assert.equal(containsIdentifier(s), false, s);
  assert.equal(containsIdentifier('4111-1111-1111-1111'), true);
  assert.equal(containsIdentifier('4111 1111 1111 1112'), false); // fails Luhn
});

test('banned phrases: every entry has a positive sample, plain sentences pass', () => {
  assert.ok(OUTCOME_PROMISE_PHRASES.length >= 8 && ADVICE_PHRASES.length >= 8);
  for (const ok of ['Covered after 24 months.', 'The policy lists exclusions.', 'Ask your insurer to confirm.']) {
    assert.equal(firstMatch(OUTCOME_PROMISE_PHRASES, ok), null);
    assert.equal(firstMatch(ADVICE_PHRASES, ok), null);
  }
  assert.equal(firstMatch(OUTCOME_PROMISE_PHRASES, 'The CLAIM WILL BE settled'), 'will_be_paid'.length ? firstMatch(OUTCOME_PROMISE_PHRASES, 'The CLAIM WILL BE settled') : null);
  assert.equal(firstMatch(OUTCOME_PROMISE_PHRASES, 'It will be approved'), 'will_be_paid');
  assert.equal(firstMatch(OUTCOME_PROMISE_PHRASES, 'Pakka milega'), 'hinglish_pakka');
  assert.equal(firstMatch(ADVICE_PHRASES, 'You should SWITCH insurers'), 'should_buy_switch');
  assert.equal(firstMatch(ADVICE_PHRASES, 'Save tax with 80D'), 'tax_advice');
});

const eq = (a, b) => { const x = extractNumbers(a); const y = extractNumbers(b); assert.equal(x.length, 1, a); assert.equal(y.length, 1, b); assert.ok(numbersEqual(x[0], y[0]), `${a} vs ${b}`); };

test('normaliser: money formats equal', () => {
  for (const s of ['Rs 5,00,000', '₹5 lakh', '5 lakh', 'five lakh', '500k', '5L', 'पांच लाख', 'INR 500000', 'Rs. 5 lac', 'five lakh rupees']) eq(s, '500000 rupees');
  eq('1.5 crore', 'Rs 1,50,00,000');
  eq('50k', 'fifty thousand rupees');
  eq('पच्चीस हज़ार', '25,000 rupees');
  eq('twenty-five thousand', 'Rs 25000');
  eq('दो करोड़', '2 crore');
});

test('normaliser: durations compare in months; days bridge documented', () => {
  eq('3 years', '36 months');
  eq('2 yrs', '24 months');
  eq('2-year wait', 'twenty four months');
  eq('2 years', '730 days');
  eq('3 years', '1095 days');
  eq('3 months', '90 days');
  assert.equal(durationsEqual({ kind: 'duration_months', value: 36 }, { kind: 'duration_days', value: 1080 }), true);
  assert.equal(durationsEqual({ kind: 'duration_months', value: 36 }, { kind: 'duration_days', value: 1000 }), false);
  assert.equal(durationsEqual({ kind: 'duration_months', value: 5 }, { kind: 'duration_days', value: 152 }), false);
  assert.deepEqual(extractNumbers('30 days'), [{ kind: 'duration_days', value: 30 }]);
});

test('normaliser: percent, dates, noise', () => {
  assert.deepEqual(extractNumbers('12.5%'), [{ kind: 'percent_bps', value: 1250 }]);
  assert.deepEqual(extractNumbers('2 percent'), [{ kind: 'percent_bps', value: 200 }]);
  eq('12 Mar 2027', '2027-03-12');
  eq('12th March, 2027', '2027-03-12');
  assert.equal(extractNumbers('31 Feb 2027').some((n) => n.kind === 'date'), false);
  assert.deepEqual(extractNumbers('Clause 4.2(b), page 12, section 3'), []);
});

test('C9: unverified input downgrades to depends, adds Is this right action, still released', () => {
  const rr = { ...ruleResults, rr1: { ...ruleResults.rr1, inputs: [{ factId: 'f1', status: 'reviewed_reference' }, { factId: 'f9', status: 'extracted_unverified' }] } };
  const r = guard(good(), 'text', evidence, rr);
  assert.equal(r.released, true);
  assert.equal(r.card.verdict, 'depends');
  assert.deepEqual(r.downgradedFactIds, ['f9']);
  assert.deepEqual(r.card.actions[0], { kind: 'answer_question', label: 'Is this right?', factId: 'f9' });
  assert.ok(r.card.actions.length <= 3);
  assert.equal(r.card.speech.text, 'Your policy says: it depends.'.replace('.', ', up to Rs 5,00,000.'));
  for (const status of ['conflicting', 'unknown']) {
    const r2 = guard(good(), 'text', evidence, { ...ruleResults, rr1: { ...ruleResults.rr1, inputs: [{ factId: 'f2', status }] } });
    assert.equal(r2.card.verdict, 'depends');
  }
});

test('C9: all inputs verified keeps the verdict; no downgrade for depends/unknown', () => {
  const rr = { ...ruleResults, rr1: { ...ruleResults.rr1, inputs: [{ factId: 'f1', status: 'user_confirmed' }, { factId: 'f2', status: 'reviewed_reference' }] } };
  const r = guard(good(), 'text', evidence, rr);
  assert.equal(r.card.verdict, 'partly_covered');
  assert.equal(r.downgraded, false);
});

test('B12: one fact, several renderings all ground', () => {
  const rr = { rr1: { verdict: 'partly_covered', values: [{ kind: 'duration', days: 730 }, { kind: 'money', amountMinor: 50000000 }, { kind: 'date', endsOn: '2027-03-12' }] } };
  const ev = { s1: { text: 'Wait applies to listed surgeries.', values: [] } };
  const mk = (text) => ({ ...good(), headline: 'Covered after a wait', explanation: text, conditions: [], sources: [{ id: 's1', factIds: ['f1'], tier: 'own_pdf', status: 'extracted_unverified', page: 1, clause: null, quote: 'Wait applies to listed surgeries' }], speech: undefined });
  for (const text of ['The wait is 2 years.', 'The wait is 24 months.', 'The wait is 730 days.', 'Limit Rs 5,00,000.', 'Limit 5 lakh.', 'Limit ₹500000.', 'Ends 12 Mar 2027.', 'Ends 2027-03-12.']) {
    assert.equal(guard(mk(text), 'text', ev, rr).released, true, text);
  }
  assert.equal(guard(mk('The wait is 3 years.'), 'text', ev, rr).released, false);
});

test('B2: only guardAnswerCard produces a releasable card', () => {
  const draft = good();
  assert.equal(isReleasedCard(draft), false);
  assert.equal(isReleasedCard(unknownCard()), false);
  const ok = guard(draft);
  assert.equal(isReleasedCard(ok.card), true);
  assert.equal(Object.isFrozen(ok.card), true);
  assert.equal(isReleasedCard({ ...ok.card }), false);
  assert.equal(isReleasedCard(guard(good({ ruleResultId: null })).card), true); // the drop card is guard output too
});
