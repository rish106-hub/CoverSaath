import assert from 'node:assert/strict';
import test from 'node:test';
import { QUESTION_CATALOGUE_VERSION, validateCatalogue } from '../src/contracts/question-catalogue.js';
import { CATALOGUE_V1 } from '../src/features/question-planner/catalogue-v1.js';

const clone = () => structuredClone(CATALOGUE_V1);
const errorsFor = mutate => { const items = clone(); mutate(items); return validateCatalogue(items); };

test('starter catalogue validates', () => {
  assert.equal(QUESTION_CATALOGUE_VERSION, 'question-catalogue/v1');
  assert.deepEqual(validateCatalogue(CATALOGUE_V1), []);
  assert.equal(CATALOGUE_V1.length, 12);
});
test('every item is tap-first, reviewed-pending and never machine translated', () => {
  for (const item of CATALOGUE_V1) {
    assert.equal(item.legalReview, 'pending');
    assert.equal(item.prompt.hi, null);
    assert.equal(item.why.hi, null);
    assert.ok(item.prompt.en.length < 120);
  }
  assert.ok(CATALOGUE_V1.filter(i => i.sensitive).every(i => i.id.startsWith('ped.') || i.id.startsWith('claims.')));
});
test('rejects duplicate ids, missing text, bad slot and non-pending review', () => {
  assert.match(errorsFor(i => { i[1].id = i[0].id; }).join(), /duplicate id/);
  assert.match(errorsFor(i => { delete i[0].why; }).join(), /why\.en missing/);
  assert.match(errorsFor(i => { i[0].slot.factKey = 'made_up_key'; }).join(), /neither a registry key/);
  assert.match(errorsFor(i => { i[0].slot.memberScope = 'nobody'; }).join(), /memberScope/);
  assert.match(errorsFor(i => { i[0].legalReview = 'approved'; }).join(), /legalReview/);
});
test('option limits per input kind', () => {
  const single = CATALOGUE_V1.findIndex(i => i.id === 'members.relationship');
  assert.match(errorsFor(i => { i[single].input.options.splice(0, 0, { id: 'x1', label: { en: 'x' } }); }).join(), /at most 5/);
  assert.match(errorsFor(i => { i[single].input.options = i[single].input.options.filter(o => o.id !== 'not_sure'); }).join(), /needs not_sure/);
  const chips = CATALOGUE_V1.findIndex(i => i.id === 'ped.which_conditions');
  assert.match(errorsFor(i => { for (let n = 0; n < 3; n += 1) i[chips].input.options.unshift({ id: `c${n}`, label: { en: 'c' } }); }).join(), /at most 8/);
  assert.match(errorsFor(i => { i[chips].input.options = i[chips].input.options.filter(o => o.id !== 'other'); }).join(), /needs other/);
});
test('followups must reference existing ids and not cycle', () => {
  const ped = CATALOGUE_V1.findIndex(i => i.id === 'ped.has_any');
  assert.match(errorsFor(i => { i[ped].followups = { yes: ['nope'] }; }).join(), /does not exist/);
  assert.match(errorsFor(i => { i[ped].followups = { yes: ['ped.which_conditions'], bogus: ['ped.started_on'] }; }).join(), /not an option/);
  const started = CATALOGUE_V1.findIndex(i => i.id === 'ped.started_on');
  assert.match(errorsFor(i => { i[started].followups = { this_year: ['ped.has_any'] }; }).join(), /cycle/);
});
