// Round-2 certainty filter findings S1 (false positives) and S2 (bypasses).
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTaskOutput } from '../src/modules/ai-analysis/schemas.js';

const KNOWN = 'source_aaaaaaaaaaaaaaaaaaaaaaaa';
const UNKNOWN = 'source_bbbbbbbbbbbbbbbbbbbbbbbb';
const POLICY_WORDING = [
  'The insurer will pay the room rent up to 1% of the sum insured per day.',
  'Renewal is guaranteed for life.',
  'Lifelong renewability guaranteed.',
  'Guaranteed Surrender Value applies after three premiums.',
  'Maternity is 100% covered after the waiting period of 24 months.',
  'नेटवर्क के लिए स्वीकृत अस्पताल सूची देखें।',
].join(' ');

const input = () => ({
  context: { caseId: 'case_synthetic', subjectId: 'subject_synthetic', purpose: 'Extract requested cover facts.', requestedFields: ['d.room_rent_limit'] },
  sources: [
    { id: KNOWN, version: '1', page: 1, text: POLICY_WORDING, status: 'known' },
    { id: UNKNOWN, version: '2', page: 4, text: 'Room rent applicability is unresolved.', status: 'unknown' },
  ],
  upstream: [],
});
const extraction = ({ value = '5000', summary = 'One source-linked field was extracted.', citations = [KNOWN] } = {}) => ({
  facts: [{ id: 'f-1', field: 'd.room_rent_limit', value, status: 'known', citations }],
  summary,
});
const synthesis = text => ({
  statements: [{ id: 's-1', text, kind: 'observation', citations: [KNOWN] }],
  unknowns: [{ id: 'u-1', text: 'Applicability is unresolved.', citations: [UNKNOWN] }],
  summary: 'Reviewed.',
});
const questions = text => ({
  questions: [{ id: 'q-1', text, authorityOwner: 'insurer', citations: [UNKNOWN] }],
  unresolvedSourceIds: [UNKNOWN],
});
const allowed = (task, output, label) => assert.doesNotThrow(() => validateTaskOutput(task, output, input()), label);
const rejected = (task, output, label) => assert.throws(() => validateTaskOutput(task, output, input()), { code: 'unsupported_claim' }, label);

test('S1: question forms addressed to the institution are not assertions', () => {
  for (const text of [
    'Is the claim approved?',
    'Was the pre-authorisation approved?',
    'Can you confirm whether the claim is approved?',
    'Will cashless be approved for this admission?',
    'If the patient is admitted, will the room rent be covered?',
    'क्या क्लेम स्वीकृत है?',
  ]) allowed('question_drafting', questions(text), text);
  // A question sentence does not shelter an assertion next to it, and tag
  // questions are assertions.
  for (const text of [
    'It is guaranteed. Is the claim approved?',
    'The claim is approved, right?',
    'Your claim is assured, isn\'t it?',
  ]) rejected('question_drafting', questions(text), text);
});

test('S1: policy wording quoted verbatim from a cited source is evidence, not model certainty', () => {
  for (const value of [
    'The insurer will pay the room rent up to 1%…',
    'The insurer will pay the room rent up to 1% of the sum insured per day',
    'renewal is guaranteed for life',
    'Lifelong renewability guaranteed',
    'Guaranteed Surrender Value',
    'Maternity is 100% covered after the waiting period',
    'स्वीकृत अस्पताल सूची',
  ]) allowed('profile_extraction', extraction({ value }), value);
  // Quoted spans inside model-authored text are exempt only when they reproduce source wording.
  allowed('evidence_synthesis', synthesis('The schedule states "Maternity is 100% covered after the waiting period".'), 'quoted span');
  allowed('evidence_synthesis', synthesis('The schedule states “The insurer will pay the room rent up to 1% of the sum insured per day.”'), 'curly quoted span');
  // Recognised feature names stay usable in the model's own words.
  for (const summary of [
    'The schedule says renewal is guaranteed for life.',
    'Lifelong renewability guaranteed per the schedule.',
    'A Guaranteed Surrender Value is listed.',
    'The schedule refers to the स्वीकृत अस्पताल सूची.',
    'Sum assured is stated in the schedule.',
    'The insurer shall not be liable to pay for cosmetic procedures.',
  ]) allowed('profile_extraction', extraction({ summary }), summary);
});

test('S1: the same wording is still rejected when the model asserts it unquoted or without a supporting source', () => {
  rejected('evidence_synthesis', synthesis('Maternity is 100% covered after the waiting period.'), 'unquoted 100% covered');
  rejected('evidence_synthesis', synthesis('The schedule states "Maternity is 100% covered from day one".'), 'quote not in any source');
  rejected('profile_extraction', extraction({ value: 'The insurer will pay the full bill.' }), 'value not in source');
  // A verbatim quote counts only against the fact's own cited source.
  rejected('profile_extraction', extraction({ value: 'Maternity is 100% covered after the waiting period', citations: [UNKNOWN] }), 'value cited to the wrong source');
  rejected('profile_extraction', extraction({ value: 'Approved' , summary: 'Claim approved.' }), 'short value with certainty summary');
});

test('S2: broader assertion forms and obfuscated spellings are rejected', () => {
  const phrases = [
    'Your claim is assured.',
    'The insurer is obligated to pay this bill.',
    'The company is bound to settle the claim.',
    'This treatment is certain to be covered.',
    'It is sure to be paid.',
    'Zero risk of rejection.',
    'Nil chance of claim denial.',
    'The claim stands approved.',
    'The pre-authorisation is deemed approved.',
    'Assured payout on discharge.',
    'This is guar​anteed.',
    'This is guаranteed.',
    'This is GUАRANTEED.',
    'This is guarantéed.',
    'This is ｇｕａｒａｎｔｅｅｄ.',
    'क्लेम मंज़ूर होगा',
  ];
  for (const phrase of phrases) {
    rejected('profile_extraction', extraction({ summary: phrase }), phrase);
    rejected('profile_extraction', extraction({ value: phrase }), `value: ${phrase}`);
    rejected('evidence_synthesis', synthesis(phrase), `statement: ${phrase}`);
  }
});
