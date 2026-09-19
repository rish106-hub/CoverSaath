import { evaluateDataset, loadReferenceDataset } from '../src/evaluation/index.js';

const report = evaluateDataset(await loadReferenceDataset());

console.log(JSON.stringify({
  datasetVersion: report.datasetVersion,
  evaluatorVersion: report.evaluatorVersion,
  executionMode: report.executionMode,
  cases: report.results.length,
  score: report.score,
  threshold: report.threshold,
  passed: report.passed,
  networkCalls: report.networkCalls,
  estimatedCostInr: report.estimatedCostInr,
  byDimension: report.byDimension,
  failures: report.results.filter(result => !result.matched),
  limitation: report.limitation,
}, null, 2));

if (!report.passed) process.exitCode = 1;

