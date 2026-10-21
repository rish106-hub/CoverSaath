// WP9: the Block 4 golden matrix. 40+ labelled synthetic cases with hand-written expectations (see household-golden-cases.mjs),
// run through the evaluator, plus property-style invariants. Synthetic only: it does not measure real-policy accuracy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { GOLDEN_CASES } from './support/household-golden-cases.mjs';
import { evaluateAll, evaluateCase } from './support/household-evaluation.mjs';
import { buildHouseholdCoveragePreview, validateScenarioInput } from '../src/features/household-reasoning/index.js';
import { makeHandoff, okSource, requestOf } from './support/household-fixtures.mjs';

const buildCase = c => buildHouseholdCoveragePreview({ request: validateScenarioInput(requestOf(c.scenario)), sources: c.handoffs.map((spec, index) => okSource(makeHandoff(spec), index)) });

test('the matrix has at least 40 distinct labelled cases covering every required group', () => {
  assert.ok(GOLDEN_CASES.length >= 40, `${GOLDEN_CASES.length} cases`);
  assert.equal(new Set(GOLDEN_CASES.map(c => c.id)).size, GOLDEN_CASES.length);
  const groups = new Set(GOLDEN_CASES.map(c => c.group));
  for (const group of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z', 'AA', 'AB', 'AC', 'AD', 'AE', 'AF', 'AG', 'AH', 'AI', 'AJ', 'AK', 'AL', 'AM', 'AN']) assert.ok(groups.has(group), `group ${group}`);
  for (const c of GOLDEN_CASES) assert.ok(c.why && c.why.length > 20, `${c.id} records why its expectation is correct`);
});

for (const c of GOLDEN_CASES) {
  test(`golden ${c.id} (${c.group}): ${c.title}`, () => {
    const result = evaluateCase(c);
    assert.deepEqual(result.failures, [], c.why);
  });
}

test('acceptance thresholds hold over the whole matrix', () => {
  const report = evaluateAll(GOLDEN_CASES);
  assert.deepEqual(Object.entries(report.thresholds).filter(([, ok]) => !ok).map(([name]) => name), []);
  assert.equal(report.passed, true);
  assert.equal(report.metrics.casesPassed, report.metrics.cases);
  assert.ok(report.metrics.criticalGapsExpected > 15, 'the matrix labels enough critical gaps to be meaningful');
});

test('the evaluator itself catches a wrong expectation (it is not a rubber stamp)', () => {
  const base = GOLDEN_CASES.find(c => c.id === 'C1');
  const wrongKnown = evaluateCase({ ...base, expect: { ...base.expect, known: [] } });
  assert.ok(wrongKnown.failures.length > 0);
  const wrongQuestions = evaluateCase({ ...base, expect: { ...base.expect, questions: ['Q_MEMBER'] } });
  assert.ok(wrongQuestions.failures.length > 0);
  const wrongState = evaluateCase({ ...base, expect: { state: 'evidence_summary_available' } });
  assert.ok(wrongState.failures.length > 0);
  const missedGap = evaluateCase({ ...base, critical: ['hospital_branch_missing'] });
  assert.equal(missedGap.metrics.criticalDetected, 0);
});

test('property: for every multi-source case the preview does not depend on the order of the sources', () => {
  const strip = preview => JSON.stringify({ ...preview, sourceSummary: undefined, policies: preview.policies.map(p => ({ ...p, sourceIndexes: undefined })) });
  let compared = 0;
  for (const c of GOLDEN_CASES.filter(x => x.handoffs?.length > 1)) {
    const forward = buildCase(c); const backward = buildCase({ ...c, handoffs: [...c.handoffs].reverse() });
    assert.equal(strip(forward), strip(backward), `${c.id}: source order changed the preview`);
    compared += 1;
  }
  assert.ok(compared >= 3);
});
