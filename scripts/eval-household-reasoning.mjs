// Runs the Block 4 golden matrix and writes a machine-readable report and a short human summary under .local/eval/.
// Synthetic cases only: no insurer, provider or network call. It measures the engine against hand-written expectations;
// it says nothing about real-policy accuracy, OCR or retrieval recall, or insurer-data coverage.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GOLDEN_CASES } from '../tests/support/household-golden-cases.mjs';
import { evaluateAll } from '../tests/support/household-evaluation.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = resolve(root, '.local', 'eval');
const report = evaluateAll(GOLDEN_CASES);
const { metrics, thresholds } = report;
const full = {
  evaluator: 'household-reasoning-golden-matrix/v1', scope: 'synthetic engine behaviour only; not model accuracy, OCR or retrieval recall, insurer-data coverage or real-policy claim accuracy',
  networkCalls: 0, metrics, thresholds, passed: report.passed, cases: report.results,
};
const percent = value => `${(value * 100).toFixed(1)}%`;
const summary = [
  '# Block 4 household reasoning: synthetic evaluation',
  '',
  `Result: ${report.passed ? 'PASS' : 'FAIL'} (${metrics.casesPassed} of ${metrics.cases} cases; ${metrics.acceptedInputCases} accepted inputs, ${metrics.rejectedInputCases} rejected inputs).`,
  'Scope: synthetic engine behaviour only. Not a measure of model accuracy, OCR or retrieval recall, insurer-data coverage or real-policy claim accuracy.',
  '',
  `- Critical gaps detected: ${metrics.criticalGapsDetected} of ${metrics.criticalGapsExpected} labelled (missed ${metrics.criticalGapsMissed}).`,
  `- Questions asked: ${metrics.questionsAsked} over ${metrics.acceptedInputCases} accepted cases (max ${metrics.questionsPerScenarioMax} per response). Unnecessary: ${metrics.unnecessaryQuestions} (${percent(metrics.unnecessaryQuestionRate)}). Duplicates: ${metrics.duplicateQuestions}.`,
  `- Material gaps delegated to a document, review or external check: ${metrics.materialGapsDelegated} of ${metrics.materialGapsNeedingDelegation}.`,
  `- Unsupported documented conclusions: ${metrics.unsupportedKnownConclusions}. Cross-member or cross-policy contamination: ${metrics.crossContamination}. Illegal authority upgrades: ${metrics.illegalAuthorityUpgrades}. Uncited documented conclusions: ${metrics.uncitedDocumentedConclusions}. Cross-policy summations: ${metrics.crossPolicySummations}.`,
  `- Forbidden-text disclosures: ${metrics.forbiddenTextDisclosures}. Unhandled exceptions: ${metrics.unhandledExceptions}. Determinism mismatches: ${metrics.determinismMismatches}.`,
  `- Latency on fixed synthetic inputs (in-process build, ${metrics.latencyMs.samples} samples): median ${metrics.latencyMs.median} ms, p95 ${metrics.latencyMs.p95} ms, max ${metrics.latencyMs.max} ms. This is not a production latency claim.`,
  '',
  '## Thresholds',
  ...Object.entries(thresholds).map(([name, ok]) => `- ${ok ? 'PASS' : 'FAIL'} ${name}`),
  ...(report.results.some(r => !r.pass) ? ['', '## Failing cases', ...report.results.filter(r => !r.pass).map(r => `- ${r.id}: ${r.failures.join('; ')}`)] : []),
  '',
].join('\n');

await mkdir(outputDirectory, { recursive: true });
await writeFile(resolve(outputDirectory, 'household-reasoning-report.json'), `${JSON.stringify(full, null, 2)}\n`);
await writeFile(resolve(outputDirectory, 'household-reasoning-summary.md'), summary);
console.log(summary);
if (!report.passed) process.exitCode = 1;
