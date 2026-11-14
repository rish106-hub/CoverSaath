import test from 'node:test';
import assert from 'node:assert/strict';
import { ANSWER_CARD_CONTRACT, validateAnswerCardShape } from '../src/contracts/answer-card.js';
import { GUARD_CHECK_IDS as C, containsContactValue, guardAnswerCard, isReleasedCard, pickInsurerContact, unknownCard } from '../src/features/chat-answer-guard/index.js';

// Synthetic contacts only (shape of raw-docs links/insurer-contacts.csv as served by FSS).
const ct = (id, kind, value, purpose, documents = 2) => ({ id, kind, value, purpose, documents });
const CONTACTS = [
  ct('c-svc-phone', 'phone', '1800-000-0001', 'service', 9),
  ct('c-claims-phone', 'phone', '1800 000 0002', 'claims', 3),
  ct('c-blank-phone', 'phone', '1860-000-0003', null, 40),
  ct('c-other-mail', 'email', 'groupops@insurer.example', 'other', 50),
  ct('c-svc-mail', 'email', 'care@insurer.example', 'service', 5),
  ct('c-gro-mail', 'email', 'gro@insurer.example', 'grievance', 4),
];
const byId = Object.fromEntries(CONTACTS.map((c) => [c.id, c]));

test('picker: claims phone beats a service phone seen in more documents', () => {
  assert.equal(pickInsurerContact(CONTACTS).id, 'c-claims-phone');
});

test('picker: service phone, then claims/service e-mail; untagged and "other" stay hidden', () => {
  const noClaims = CONTACTS.filter((c) => c.id !== 'c-claims-phone');
  assert.equal(pickInsurerContact(noClaims).id, 'c-svc-phone');
  const mailsOnly = CONTACTS.filter((c) => c.kind === 'email' || c.purpose == null);
  assert.equal(pickInsurerContact(mailsOnly).id, 'c-svc-mail');
  assert.equal(pickInsurerContact([byId['c-blank-phone'], byId['c-other-mail']]), null);
});

test('picker: grievance use returns only grievance contacts', () => {
  assert.equal(pickInsurerContact(CONTACTS, { use: 'grievance' }).id, 'c-gro-mail');
  assert.equal(pickInsurerContact([byId['c-svc-phone']], { use: 'grievance' }), null);
  assert.equal(pickInsurerContact(CONTACTS, { use: 'sales' }), null);
});

test('picker: ties go to more documents, then lower id', () => {
  const a = ct('b', 'phone', '1800-000-0010', 'service', 2);
  const b = ct('a', 'phone', '1800-000-0011', 'service', 2);
  const c = ct('c', 'phone', '1800-000-0012', 'service', 7);
  assert.equal(pickInsurerContact([a, b]).id, 'a');
  assert.equal(pickInsurerContact([a, b, c]).id, 'c');
});

test('picker: rejects non toll-free numbers, bad e-mails, bad purpose, missing id', () => {
  assert.equal(pickInsurerContact([ct('x', 'phone', '022-0000-0000', 'service')]), null);
  assert.equal(pickInsurerContact([ct('x', 'phone', '9800000000', 'claims')]), null);
  assert.equal(pickInsurerContact([ct('x', 'email', 'not-an-email', 'service')]), null);
  assert.equal(pickInsurerContact([ct('x', 'phone', '1800-000-0001', 'sales')]), null);
  assert.equal(pickInsurerContact([ct('', 'phone', '1800-000-0001', 'service')]), null);
  assert.equal(pickInsurerContact(null), null);
});

test('containsContactValue: catches e-mails, toll-free and mobile numbers, not policy numbers', () => {
  for (const t of ['write to care@insurer.example', 'call 1800-000-0001', 'call 18600000003', 'ring +91 98000 00000', '9800000000']) assert.equal(containsContactValue(t), true, t);
  for (const t of ['Up to Rs 5,00,000 per policy year', 'Rs 18,00,000 sum insured', 'wait of 24 months', 'ends on 12 Mar 2027', '1% of sum insured', 'clause 4.2(b)']) assert.equal(containsContactValue(t), false, t);
});

const card = (over = {}) => ({
  ...unknownCard(), status: 'out_of_scope', actions: [{ kind: 'call_insurer', label: 'Call your insurer', contactId: 'c-svc-phone' }], ...over,
});
const guard = (c, extra = {}) => guardAnswerCard({ card: c, contacts: byId, ...extra });

test('guard: a referenced trusted contact is resolved onto the released card', () => {
  const r = guard(card());
  assert.equal(r.released, true, JSON.stringify(r.failedChecks));
  assert.deepEqual(r.card.actions[0].contact, { kind: 'phone', value: '1800-000-0001' });
  assert.equal(isReleasedCard(r.card), true);
  assert.equal(validateAnswerCardShape(r.card).valid, true);
});

test('guard C10: unknown contactId drops the card', () => {
  const r = guard(card({ actions: [{ kind: 'call_insurer', label: 'Call your insurer', contactId: 'c-made-up' }] }));
  assert.equal(r.released, false);
  assert.deepEqual(r.failedChecks, [C.contact]);
});

test('guard C10: a draft that carries its own contact value drops, even if the id is trusted', () => {
  const r = guard(card({ actions: [{ kind: 'call_insurer', label: 'Call', contactId: 'c-svc-phone', contact: { kind: 'phone', value: '1800-000-0999' } }] }));
  assert.equal(r.released, false);
  assert.ok(r.failedChecks.includes(C.contact));
});

test('guard C10: contact values written into text drop the card', () => {
  for (const over of [
    { explanation: 'Please call 1800-000-0001.' },
    { headline: 'Write to care@insurer.example' },
    { actions: [{ kind: 'call_insurer', label: 'Call 1800 000 0002' }] },
    { followups: ['Can I e-mail gro@insurer.example?'] },
  ]) {
    const r = guard(card(over));
    assert.equal(r.released, false, JSON.stringify(over));
    assert.ok(r.failedChecks.includes(C.contact), JSON.stringify(r.failedChecks));
  }
});

test('shape: contactId only on call_insurer or grievance_path', () => {
  const r = guard(card({ actions: [{ kind: 'find_hospital', label: 'Find a hospital', contactId: 'c-svc-phone' }] }));
  assert.deepEqual(r.failedChecks, [C.shape]);
});

test('dropped card offers the fallback contact when it is trusted', () => {
  const bad = card({ explanation: 'Please call 1800-000-0001.' });
  const withFallback = guard(bad, { fallbackContactId: 'c-claims-phone' });
  assert.deepEqual(withFallback.card.actions[0], { kind: 'call_insurer', label: 'Call your insurer', contactId: 'c-claims-phone', contact: { kind: 'phone', value: '1800 000 0002' } });
  assert.equal(validateAnswerCardShape(withFallback.card).valid, true);
  for (const fallbackContactId of [null, 'c-made-up', 'c-blank-phone-missing']) {
    const r = guard(bad, { fallbackContactId });
    assert.deepEqual(r.card.actions[0], { kind: 'call_insurer', label: 'Call the number on your policy card' });
  }
});

test('dropped card with an invalid fallback contact never shows it', () => {
  const contacts = { ...byId, bad: ct('bad', 'phone', '022-0000-0000', 'service') };
  const r = guardAnswerCard({ card: { contract: ANSWER_CARD_CONTRACT }, contacts, fallbackContactId: 'bad' });
  assert.equal(r.released, false);
  assert.equal(r.card.actions[0].contactId, undefined);
});
