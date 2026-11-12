#!/usr/bin/env node
/**
 * 100-question evaluation of the P0 journey: policy documents -> facts -> grounded answer with citations.
 *   node scripts/eval-policy-questions.mjs [--set <questions.json>] [--mode synthetic|real] [--out <report.json>]
 * Reports five scores separately (extraction, retrieval recall, answer, citation, unsupported claims); never one blended
 * number. Exit code is non-zero only for a harness error (bad set, bad flags, API failure), never for a low score.
 * synthetic (default): offline, deterministic, no network, key or cost. Scores do NOT measure real-policy accuracy.
 * real: owner-run against own documents and API; refuses unless RUN_POLICY_QUESTIONS_LIVE=1. See
 *   scripts/lib/real-policy-pipeline.mjs for environment variable names and docs/runbooks/eval-100-questions.md.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertValidQuestionSet, formatTable, scoreResults } from './lib/policy-question-eval.mjs';
import { createRealPipeline, readRealConfig } from './lib/real-policy-pipeline.mjs';
import { createSyntheticPipeline } from './lib/synthetic-policy-pipeline.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SET = resolve(here, 'fixtures/synthetic-policy-questions.json');
export const DEFAULT_REPORT = resolve(here, '..', '.local/eval/policy-questions-report.json');

export function parseArgs(argv) {
  const options = { mode: 'synthetic', set: DEFAULT_SET, out: DEFAULT_REPORT };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!['--set', '--mode', '--out'].includes(flag) || value === undefined) throw Object.assign(new Error(`Unknown or incomplete option: ${flag}. Use --set, --mode, --out.`), { code: 'USAGE' });
    options[flag.slice(2)] = flag === '--mode' ? value : resolve(value);
  }
  if (!['synthetic', 'real'].includes(options.mode)) throw Object.assign(new Error('--mode must be synthetic or real.'), { code: 'USAGE' });
  return options;
}

export async function runEval({ argv = process.argv.slice(2), env = process.env, fetchImpl } = {}) {
  const options = parseArgs(argv);
  // Real mode checks its opt-in before reading anything.
  const pipeline = options.mode === 'real' ? createRealPipeline(readRealConfig(env), { fetchImpl }) : createSyntheticPipeline();
  const set = assertValidQuestionSet(JSON.parse(await readFile(options.set, 'utf8')));
  const report = { mode: options.mode, setVersion: set.version ?? null, ...scoreResults(set.questions, await pipeline.run(set.questions)) };
  report.limitation = options.mode === 'synthetic'
    ? 'Synthetic mode: OCR, retrieval, extraction and answering are offline stubs over invented text. These scores do not measure real-policy accuracy.'
    : 'Real mode: scores describe only the documents and question set you supplied, and one run.';
  return { options, report };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { options, report } = await runEval();
    await mkdir(dirname(options.out), { recursive: true });
    await writeFile(options.out, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`mode: ${report.mode}\n${formatTable(report)}\n\n${report.limitation}\nreport: ${options.out}`);
  } catch (error) {
    console.error(`eval:questions failed: ${error.message}`);
    process.exitCode = 1;
  }
}
