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

// All 59 rows now agree with the arithmetic (Squad B fixed "₹ 185 cr" in insurance-raw-docs a5d16dc).
for (const c of cases) {
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
