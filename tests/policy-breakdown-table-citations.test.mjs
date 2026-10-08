import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHtmlTables, tableAlignedMatch, verifyQuote } from '../src/modules/policy-breakdown/verification/citations.js';

// Synthetic schedule table in Sarvam's HTML shape. No real policy data.
const page = [
  'Policy Schedule',
  '<table>',
  '<tr><th>Policy Number</th><th>Plan</th><th>Policy Start Date</th><th>First Policy Inception date</th></tr>',
  '<tr><td>TEST-0001</td><td>Sample Plan</td><td>01-04-2026</td><td>01-04-2019</td></tr>',
  '</table>',
  '<table>',
  '<tr><th>Name</th><th>Relation</th><th>Date of Birth</th></tr>',
  '<tr><td rowspan="2">Member A</td><td>Self</td><td>01-01-1980</td></tr>',
  '<tr><td>Spouse</td><td>02-02-1982</td></tr>',
  '<tr><td>Member C</td><td colspan="2">Child&nbsp;one</td></tr>',
  '</table>',
].join('\n');

test('parseHtmlTables tracks rowspan and colspan', () => {
  const tables = parseHtmlTables(page);
  assert.equal(tables.length, 2);
  const spouse = tables[1].find(cell => cell.text === 'spouse');
  assert.deepEqual([spouse.row, spouse.start], [2, 1]);
  const child = tables[1].find(cell => cell.text === 'child one');
  assert.deepEqual([child.start, child.end], [1, 2]);
});

test('header over its value in the same column is accepted', () => {
  assert.equal(tableAlignedMatch('First Policy Inception date\n01-04-2019', page), true);
  const result = verifyQuote({ quote: 'First Policy Inception date\n01-04-2019', pageNumber: 3 }, new Map([[3, { text: page }]]));
  assert.equal(result.matched, true);
  assert.equal(result.method, 'table_aligned');
});

test('header over a value from another column is rejected', () => {
  assert.equal(tableAlignedMatch('First Policy Inception date\n01-04-2026', page), false);
});

test('row fragments must be one row, left to right', () => {
  assert.equal(tableAlignedMatch('Member C\tChild one', page), true);
  assert.equal(tableAlignedMatch('Self | 01-01-1980', page), true);
  assert.equal(tableAlignedMatch('01-01-1980\tSelf', page), false);
  assert.equal(tableAlignedMatch('Self\t02-02-1982', page), false);
});

test('later lines must sit in later rows of the same table', () => {
  assert.equal(tableAlignedMatch('Name\tRelation\nMember C\tChild one', page), true);
  assert.equal(tableAlignedMatch('Member C\tChild one\nName\tRelation', page), false);
  assert.equal(tableAlignedMatch('Policy Number\nSelf', page), false);
});

test('pages without tables and single fragments never match', () => {
  assert.equal(tableAlignedMatch('Spouse', page), false);
  assert.equal(tableAlignedMatch('Plan\nSample Plan', 'Plan Sample Plan as plain text'), false);
});

// ---------------------------------------------------------------------------------------------------------
// Line-break noise around numbers, joined spans, and off-by-one page citations (synthetic text)
// ---------------------------------------------------------------------------------------------------------
const pagesOf = texts => new Map(texts.map((text, index) => [index + 1, { text }]));

test('punctuation and line-break noise is tolerated around numbers, but never a moved decimal point or digit', () => {
  const pages = pagesOf(['Hospitalisation means admission for a minimum period of 24 consecutive ‘In-\npatient Care’ hours.\nCo-payment of 1.5% applies.']);
  assert.equal(verifyQuote({ quote: "minimum period of 24 consecutive 'In-patient Care' hours", pageNumber: 1 }, pages).method, 'compact');
  assert.equal(verifyQuote({ quote: 'Co-payment of 15% applies', pageNumber: 1 }, pages).matched, false);
  // A decoy "15" elsewhere on the page must not let "1.5%" read as "15%".
  const decoy = pagesOf(['Co-payment of 1.5% applies to every claim. Claims must be filed within 15 days of discharge.']);
  assert.equal(verifyQuote({ quote: 'Co-payment of 15% applies to every claim', pageNumber: 1 }, decoy).matched, false);
  assert.equal(verifyQuote({ quote: 'Co-payment of 1.5 % applies to every claim', pageNumber: 1 }, decoy).matched, true);
  assert.equal(verifyQuote({ quote: 'minimum period of 42 consecutive In-patient Care hours', pageNumber: 1 }, pages).matched, false);
});

test('spans joined with an ellipsis match only when each long span is on the cited page, in order', () => {
  const pages = pagesOf(['Treatment may be taken in a Network Provider subject to pre authorization. Other text here. The Network Provider shall obtain the relevant information from the Insured Person.']);
  const joined = 'Treatment may be taken in a Network Provider ... The Network Provider shall obtain the relevant information';
  assert.equal(verifyQuote({ quote: joined, pageNumber: 1 }, pages).method, 'ellipsis_segments');
  assert.equal(verifyQuote({ quote: 'The Network Provider shall obtain the relevant information ... Treatment may be taken in a Network Provider', pageNumber: 1 }, pages).matched, false, 'order matters');
  assert.equal(verifyQuote({ quote: 'Treatment may be taken in a Network Provider ... ok', pageNumber: 1 }, pages).matched, false, 'short spans are not distinctive');
});

test('repeated text cited one page off is corrected only to the single neighbouring page', () => {
  const sentence = 'A free look period of thirty days applies from receipt of the policy document.';
  const pages = pagesOf(['schedule page', sentence, 'other', 'other', 'other', sentence]);
  const result = verifyQuote({ quote: sentence, pageNumber: 1 }, pages);
  assert.deepEqual([result.method, result.correctedPage], ['adjacent_page', 2]);
  assert.equal(verifyQuote({ quote: sentence, pageNumber: 4 }, pages).matched, false, 'two non-adjacent copies stay ambiguous');
});
