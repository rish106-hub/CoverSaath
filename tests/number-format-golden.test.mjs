import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractNumbers } from '../src/features/chat-answer-guard/number-normaliser.js';

// Golden cases from public insurer PDFs (Squad B). Their shape is mapped to ours here; the fixture is not edited.
const cases = readFileSync(new URL('./fixtures/number-formats-golden.jsonl', import.meta.url), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

function toGolden(n) {
  switch (n.kind) {
    case 'money': return { kind: 'money', expected: n.value };
    case 'duration_days': case 'duration_months': return { kind: 'duration', expected: { value: n.amount, unit: n.unit } };
    case 'policy_year': return { kind: 'policy_year', expected: n.value };
    case 'percent_bps': return { kind: 'percent', expected: n.value / 100 };
    case 'percent_of_si': return { kind: 'percent_of_si', expected: n.value / 100 };
    case 'percent_of_sa': return { kind: 'percent_of_sa', expected: n.value / 100 };
    default: return { kind: n.kind, expected: n.value };
  }
}

test('golden file has 59 cases', () => assert.equal(cases.length, 59));

// Rows where the golden expected value disagrees with the arithmetic. Reported to Squad B, not bent around.
// "₹ 185 cr" = 185 x 1,00,00,000 rupees = 18,50,00,00,000 rupees = 185000000000 paise; the file says 18500000000 (10x low).
const KNOWN_CONFLICTS = new Map([['₹ 185 cr', { kind: 'money', expected: 185000000000 }]]);

for (const c of cases) {
  if (KNOWN_CONFLICTS.has(c.raw)) {
    test(`golden conflict (fixture expected ${c.expected}, arithmetic differs): ${c.raw}`, () => {
      assert.deepEqual(toGolden(extractNumbers(c.raw)[0]), KNOWN_CONFLICTS.get(c.raw));
      assert.notEqual(c.expected, KNOWN_CONFLICTS.get(c.raw).expected);
    });
    continue;
  }
  test(`golden: ${c.raw} -> ${c.kind}`, () => {
    const found = extractNumbers(c.raw);
    if (c.kind === 'none') return assert.deepEqual(found, []);
    assert.equal(found.length, 1, JSON.stringify(found));
    assert.deepEqual(toGolden(found[0]), { kind: c.kind, expected: c.expected });
  });
}

test('golden: months stay months, years convert only for comparison', () => {
  assert.deepEqual(extractNumbers('48 months')[0], { kind: 'duration_months', value: 48, unit: 'month', amount: 48 });
  assert.equal(extractNumbers('18 years')[0].value, 216);
});
