// WP11: a repeatable local latency baseline for the coverage-preview route on fixed synthetic inputs (mocked providers,
// in-process server, SQLite). It records figures for the report and asserts only a loose sanity ceiling. It is not a
// production latency or capacity claim: no representative workload exists.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { ask, household, preview, scenarioBody, startApp } from './support/household-api-harness.mjs';

const percentile = (values, q) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(q * values.length))];
const stats = values => ({ samples: values.length, medianMs: Number(percentile(values, 0.5).toFixed(2)), p95Ms: Number(percentile(values, 0.95).toFixed(2)), maxMs: Number(Math.max(...values).toFixed(2)) });

test('latency baseline: one source and the five-source cap', async t => {
  const app = await startApp(t);
  const s = await household(app, { name: 'Latency', documents: 2 });
  const answers = [];
  for (let i = 0; i < 5; i += 1) {
    const asked = await ask(app, s, { documentIds: [s.documentIds[i % 2]] });
    assert.equal(asked.status, 201, JSON.stringify(asked.data));
    answers.push(asked.data.answerId);
  }
  const body = sources => scenarioBody(sources.map(answerId => ({ caseId: s.caseId, answerId })), { scenarioType: 'planned_procedure', procedureText: 'cataract surgery', memberId: s.memberId, plannedMonth: '2026-11', hospital: { name: 'Healtworld Hospital', city: 'Durgapur' } });
  const measure = async sources => {
    await preview(app, s.householdId, body(sources), { token: s.token }); // warm-up
    const times = [];
    for (let i = 0; i < 25; i += 1) {
      const started = performance.now();
      const res = await preview(app, s.householdId, body(sources), { token: s.token });
      times.push(performance.now() - started);
      assert.equal(res.status, 200);
    }
    return stats(times);
  };
  const report = { note: 'Local, mocked providers, in-process HTTP, SQLite. Not a production latency or capacity claim.', node: process.version, oneSource: await measure(answers.slice(0, 1)), fiveSources: await measure(answers) };
  await mkdir('.local/eval', { recursive: true });
  await writeFile('.local/eval/household-preview-latency.json', `${JSON.stringify(report, null, 2)}\n`);
  assert.ok(report.oneSource.medianMs < 2000 && report.fiveSources.medianMs < 5000, JSON.stringify(report));
});
