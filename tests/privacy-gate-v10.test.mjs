// Gate v10 review fixes (ADR 0017 S2 review P2-3, P2-4, P2-5). Synthetic values only; none is a real identifier.
import assert from 'node:assert/strict';
import test from 'node:test';
import { gateText } from '../src/features/ai-analysis/privacy-evidence-gate.js';
import { leaks } from './support/leak-oracle.mjs';

const gate = (text, knownIdentifiers = []) => gateText(text, { knownIdentifiers }).text;

test('P2-3: wording with a number and a letter is not read as a split PAN', () => {
  for (const wording of ['Table 1500 A shows limits', 'Total 2024 B', 'Annex 2026 B', 'TOTAL 1500 B', 'TABLE 1500 A', 'Section 4000 C applies', 'Plan 3000 D']) {
    assert.equal(gate(wording), wording, wording);
  }
});

test('P2-3: a split PAN is still found, labelled in any holder type or bare for an individual', () => {
  for (const text of ['PAN: ABCCE 1234 F', 'Permanent Account Number ABCHE-1234-F', 'pan no ABCPE 1234 F', 'ABCPE 1234 F', 'ABCPE-1234-F']) {
    const out = gate(text);
    assert.match(out, /<PAN_\d+>/, text);
    assert.equal(leaks(out, ['ABC', '1234']), 0, text);
  }
});

test('P2-4: an ABHA number split into other groups is found, with or without a label', () => {
  const groupings = [[2, 4, 4, 4], [4, 4, 4, 2], [5, 5, 4], [3, 4, 4, 3], [14]];
  for (const shape of groupings) {
    let at = 0;
    const digits = '91234567890123';
    const groups = shape.map(size => { const part = digits.slice(at, at + size); at += size; return part; });
    for (const text of [groups.join(' '), groups.join('-'), `ABHA ${groups.join(' ')}`, `Card ${groups.join(' ')} issued`]) {
      const out = gate(text);
      assert.match(out, /<HEALTH_ID_\d+>/, text);
      assert.equal(leaks(out, ['9123', '5678', '8901']), 0, text);
    }
  }
});

test('P2-4: a labelled policy or receipt number of 14 digits keeps its own placeholder and years are left alone', () => {
  assert.match(gate('Policy No 12345678901234'), /<IDENTIFIER_\d+>/);
  assert.equal(gate('Policy period 2026 2027'), 'Policy period 2026 2027');
  assert.equal(gate('Sum insured 500000'), 'Sum insured 500000');
});

test('P2-5: a labelled phone broken by a blank line does not keep its tail', () => {
  for (const text of ['Ph: 98765\n\n43210', 'Phone: 98765\n43210', 'Mobile 98765\n\n\n43210', 'Ph: 98765 \n \n 43210']) {
    const out = gate(text);
    assert.match(out, /<PHONE_\d+>/, text);
    assert.equal(leaks(out, ['98765', '43210']), 0, text);
  }
  // A blank line after a complete number ends the value; the next paragraph is wording.
  assert.equal(gate('Ph: 98765 43210\n\nSum insured 500000').includes('500000'), true);
});
