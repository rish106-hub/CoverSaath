#!/usr/bin/env node
/**
 * Critical-field accuracy and repeatability of policy structuring runs made through the application (W5).
 *   node scripts/eval-structuring-accuracy.mjs <result.json> [<result.json> ...]
 * Each result file holds `{ result }`, the body of GET /api/v1/documents/:id/structuring-runs for one run.
 * Golden: .local/eval/golden.json `fields` (owner-verified). Prints counts and field names only; the
 * per-field detail with document values goes to .local/eval/accuracy-report.json (gitignored).
 */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getPolicyParameterRegistry, POLICY_PARAMETER_REGISTRY_VERSION } from '../src/features/coverage-analysis/policy-parameter-registry.js';
import { CRITICAL_FIELD_KEYS, readingMatches, scoreCriticalFields } from '../src/features/policy-structuring/index.js';

const OUT = resolve('.local/eval');
const files = process.argv.slice(2);
assert.ok(files.length > 0, 'Pass one or more structuring result files.');
const golden = JSON.parse(await readFile(resolve(OUT, 'golden.json'), 'utf8')).fields;
const forbidden = getPolicyParameterRegistry(POLICY_PARAMETER_REGISTRY_VERSION).parameters
  .filter(entry => !entry.modelExtraction.allowed).map(entry => entry.key);
const runs = [];
for (const file of files) {
  const { result } = JSON.parse(await readFile(resolve(file), 'utf8'));
  // 'completed' is the status of result files saved before processing and evidence outcomes were separated.
  if (!['finished', 'completed'].includes(result?.status) || !result.structuringRun) throw new Error(`${file}: run is not finished.`);
  runs.push(result);
}
const scored = runs.map(review => scoreCriticalFields(golden, review, { modelForbiddenKeys: forbidden }));
const outcomesByField = Object.fromEntries(Object.keys(scored[0].fields).map(field => [field, scored.map(score => score.fields[field].outcome)]));
const stableFields = Object.entries(outcomesByField).filter(([, outcomes]) => new Set(outcomes).size === 1).map(([field]) => field);
const summary = {
  runs: runs.length,
  criticalFields: Object.keys(outcomesByField).length,
  perRun: scored.map((score, index) => ({
    totals: score.totals,
    observations: runs[index].structuringRun.counts.observations,
    parameters: runs[index].parameters.length,
    contradictions: runs[index].contradictions.length,
    skippedChunks: runs[index].skippedChunks?.length ?? null,
    skippedReasons: Object.fromEntries((runs[index].skippedChunks ?? []).reduce((counts, entry) => counts.set(String(entry.reason), (counts.get(String(entry.reason)) ?? 0) + 1), new Map())),
    calls: runs[index].structuringRun.counts.coverage?.calls ?? null,
    usage: runs[index].structuringRun.counts.coverage?.usage ?? null,
    costUsd: runs[index].structuringRun.counts.coverage?.costUsd ?? null,
  })),
  wrongInAnyRun: Object.entries(outcomesByField).filter(([, outcomes]) => outcomes.includes('wrong')).map(([field]) => field),
  repeatability: { stableFields: stableFields.length, unstableFields: Object.keys(outcomesByField).filter(field => !stableFields.includes(field)) },
  outcomesByField,
};
const detail = Object.fromEntries(Object.entries(golden).filter(([field]) => CRITICAL_FIELD_KEYS[field]).map(([field, expected]) => [field, {
  key: CRITICAL_FIELD_KEYS[field],
  golden: expected.value,
  runs: runs.map(review => {
    const parameter = review.parameters.find(entry => entry.key === CRITICAL_FIELD_KEYS[field]);
    return parameter ? { state: parameter.state, reasonCode: parameter.reasonCode, readings: parameter.readings.map(reading => ({ value: reading.value, page: reading.page, selected: reading.selected, matches: readingMatches(expected.value, reading) })) } : null;
  }),
}]));
await writeFile(resolve(OUT, 'accuracy-report.json'), JSON.stringify({ summary, detail }, null, 2));
console.log(JSON.stringify(summary, null, 1));
