import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { PDFDocument } from 'pdf-lib';
import { LIVE_RUN_CEILING_USD, main, parseArgs, planRun } from '../scripts/smoke-test-gemini.mjs';
import { SYNTHETIC_BANNER, SYNTHETIC_CANARIES, SYNTHETIC_POLICY_PAGES, buildSyntheticPolicyPdf, stripTags } from '../scripts/fixtures/synthetic-policy-pages.mjs';

// B2 live-run preparation (docs/runbooks/gemini-live-run.md). Everything here is stubbed: the model driver is a
// local fake and global fetch is replaced so that any real network call fails the test. Synthetic data only.

const FAKE_KEY = 'synthetic-test-key-not-a-secret';
const liveEnv = {
  LLM_PROVIDER: 'google', GEMINI_API_KEY: FAKE_KEY, LLM_MODEL: 'stub-model',
  LLM_INPUT_USD_PER_MILLION: '1', LLM_OUTPUT_USD_PER_MILLION: '1',
  ORCHESTRATION_RUN_BUDGET_USD: '0.25', ORCHESTRATION_PROJECT_BUDGET_USD: '5',
};
const READINGS = [
  { phrase: '5,000 per day', key: 'd.room_rent_limit' },
  { phrase: '3 Years', key: 'f.ped_waiting_period' },
  { phrase: '36 months', key: 'f.ped_waiting_period' },
  { phrase: '15 days', key: 'b.free_look_period' },
];

// Answers from the text it was sent, so every quote is a literal substring of the gated chunk.
function stubDriver({ usage = { inputTokens: 200, outputTokens: 50 } } = {}) {
  const prompts = [];
  const loaded = [];
  return {
    prompts,
    loaded,
    loadModel: async () => { loaded.push(true); return { mocked: true }; },
    createAgent: settings => ({
      generate: async ({ prompt }) => {
        prompts.push({ agent: settings.id, prompt });
        if (settings.id.endsWith('policy_structuring_reconcile')) return { output: { conflicts: [] }, totalUsage: usage };
        const items = [];
        for (const chunk of JSON.parse(prompt).chunks) {
          for (const line of chunk.text.split('\n')) {
            for (const reading of READINGS.filter(entry => line.includes(entry.phrase))) {
              items.push({
                chunk_id: chunk.chunk_id, registry_key: reading.key, value: reading.phrase, subject: 'policy', evidence_quote: line.trim(),
                page: chunk.page, block_index: chunk.block_indexes[0], confidence: 'high', rationale: 'Printed in the chunk.',
              });
            }
          }
        }
        return { output: { items }, totalUsage: usage };
      },
    }),
  };
}

async function run(argv, env, driver = stubDriver()) {
  const lines = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('network call attempted'); };
  try {
    const result = await main(argv, env, { print: line => lines.push(line), loadModel: driver.loadModel, createAgent: driver.createAgent });
    return { ...result, output: lines.join('\n'), driver };
  } finally {
    globalThis.fetch = realFetch;
  }
}

test('default and --dry-run never reach the provider, even with a fully configured live env', async () => {
  for (const argv of [[], ['--dry-run']]) {
    for (const env of [{}, liveEnv]) {
      const { exitCode, report, output, driver } = await run(argv, env);
      assert.equal(exitCode, 0);
      assert.equal(report.mode, 'dry-run');
      assert.equal(driver.loaded.length, 0);
      assert.equal(driver.prompts.length, 0);
      assert.match(output, /"providerCallsMade": 0/);
      assert.ok(!output.includes(FAKE_KEY), 'the key is never printed');
    }
  }
});

test('dry run prints model, estimate, budget caps and gate status', async () => {
  const { report } = await run([], liveEnv);
  assert.equal(report.config.model, 'stub-model');
  assert.equal(report.budget.runCapUsd, 0.25);
  assert.equal(report.budget.liveRunCeilingUsd, LIVE_RUN_CEILING_USD);
  assert.equal(report.gate.status, 'pass');
  assert.equal(report.gate.canariesFoundInOutgoingText, 0);
  assert.ok(report.estimate.plannedCalls >= 2);
  assert.ok(report.estimate.worstCaseUsd > 0 && report.estimate.worstCaseUsd <= report.budget.runCapUsd * report.estimate.plannedCalls);
  assert.equal(report.liveReady, true);
});

test('--live is refused, with no provider contact, unless a budget cap and every live precondition are set', async () => {
  const cases = [
    ['no budget cap', { ...liveEnv, ORCHESTRATION_RUN_BUDGET_USD: undefined }, 'BUDGET_CAP_MISSING'],
    ['no project cap', { ...liveEnv, ORCHESTRATION_PROJECT_BUDGET_USD: undefined }, 'BUDGET_CAP_MISSING'],
    ['cap above the ceiling', { ...liveEnv, ORCHESTRATION_RUN_BUDGET_USD: '0.9' }, 'BUDGET_CAP_ABOVE_CEILING'],
    ['one reservation above the cap', { ...liveEnv, ORCHESTRATION_RUN_BUDGET_USD: '0.01' }, 'RESERVATION_EXCEEDS_RUN_BUDGET'],
    ['no key', { ...liveEnv, GEMINI_API_KEY: undefined }, 'API_KEY_MISSING'],
    ['no model', { ...liveEnv, LLM_MODEL: undefined }, 'LLM_MODEL_MISSING_OR_INVALID'],
    ['bad model name', { ...liveEnv, LLM_MODEL: '../models/x' }, 'LLM_MODEL_MISSING_OR_INVALID'],
    ['no rates', { ...liveEnv, LLM_INPUT_USD_PER_MILLION: undefined }, 'RATES_MISSING'],
    ['prompt above the input cap', { ...liveEnv, STRUCTURING_MAX_INPUT_BYTES: '2000' }, 'PROMPT_EXCEEDS_INPUT_LIMIT'],
  ];
  for (const [name, env, code] of cases) {
    const { exitCode, report, driver } = await run(['--live'], env);
    assert.equal(exitCode, 1, name);
    assert.equal(report.refused, true, name);
    assert.ok(report.problems.includes(code), `${name}: ${report.problems}`);
    assert.equal(driver.loaded.length + driver.prompts.length, 0, `${name}: no provider contact`);
  }
});

test('bad arguments are rejected before anything runs', async () => {
  assert.deepEqual(parseArgs(['--live', '--dry-run']), { error: 'LIVE_AND_DRY_RUN' });
  assert.deepEqual(parseArgs(['--consent=gemini']), { error: 'UNKNOWN_ARGUMENT' });
  assert.deepEqual(parseArgs(['--write-pdf']), { error: 'WRITE_PDF_NEEDS_PATH' });
  assert.deepEqual(parseArgs(['--live=']), { error: 'FLAG_TAKES_NO_VALUE' });
  assert.deepEqual(parseArgs(['--live=no']), { error: 'FLAG_TAKES_NO_VALUE' });
  assert.deepEqual(parseArgs(['--dry-run=']), { error: 'FLAG_TAKES_NO_VALUE' });
  const { exitCode, driver } = await run(['--live', '--dry-run'], liveEnv);
  assert.equal(exitCode, 2);
  assert.equal(driver.prompts.length, 0);
});

test('stubbed live run: the gate precedes every provider call, output stays unverified, spend is inside the cap', async () => {
  const { exitCode, report, output, driver } = await run(['--live'], liveEnv);
  assert.equal(exitCode, 0, output);
  assert.equal(driver.prompts.length, 3, 'two extraction calls and one reconcile call');
  assert.ok(driver.prompts.length > 0);
  for (const { prompt } of driver.prompts) {
    for (const canary of SYNTHETIC_CANARIES) assert.ok(!prompt.includes(canary), `raw value reached the provider: ${canary.slice(0, 6)}...`);
  }
  assert.match(driver.prompts[0].prompt, /<NAME_\d+>/, 'known names are replaced by placeholders');
  assert.equal(report.run.passed, true);
  assert.ok(Object.values(report.run.pass).every(Boolean), JSON.stringify(report.run.pass));
  assert.equal(report.run.pass.allCallsOk, true);
  assert.ok(report.run.decisionStates.length > 0);
  assert.ok(report.run.decisionStates.every(state => ['extracted_unverified', 'conflicting', 'unknown'].includes(state)));
  assert.ok(report.run.spentUsd <= report.run.runCapUsd);
  assert.ok(!output.includes(FAKE_KEY), 'the key is never printed');
});

test('the run budget cap stops further paid calls', async () => {
  // Reservation per call = (24000 + 8000) tokens-worth at 1 USD per million = 0.032. Cap 0.06 fits one reservation, but after
  // the first call settles at 0.0288 a second one (0.0608 in all) is refused and no second call is dispatched.
  const env = { ...liveEnv, ORCHESTRATION_RUN_BUDGET_USD: '0.06' };
  const { exitCode, report, driver } = await run(['--live'], env, stubDriver({ usage: { inputTokens: 20_000, outputTokens: 8_800 } }));
  assert.equal(driver.prompts.length, 1, 'only the first call reached the provider');
  assert.ok(report.run.callOutcomes.includes('budget_refused'));
  assert.ok(report.run.spentUsd <= 0.06);
  assert.equal(report.run.pass.insideRunBudget, true);
  assert.equal(report.run.pass.allCallsOk, false);
  assert.notEqual(report.run.outcome.evidenceOutcome, 'complete', 'a budget-stopped run is never complete');
  assert.equal(report.run.passed, false, 'a run with a refused call never passes');
  assert.equal(exitCode, 1);
});

test('a leaking gate fails closed: no live run', async () => {
  const leaky = planRun({ env: liveEnv, sanitize: text => ({ text, truncated: false }) });
  assert.equal(leaky.gate.status, 'LEAK');
  assert.ok(leaky.problems.includes('PRIVACY_GATE_LEAK'));
  assert.ok(leaky.gate.canariesFoundInOutgoingText > 0);
  assert.equal(planRun({ env: liveEnv }).problems.length, 0);
});

test('the synthetic PDF is deterministic, three pages, and banner-marked; --write-pdf never overwrites', async () => {
  const bytes = await buildSyntheticPolicyPdf();
  assert.deepEqual(Buffer.from(bytes), Buffer.from(await buildSyntheticPolicyPdf()));
  assert.equal((await PDFDocument.load(bytes)).getPageCount(), 3);
  // Content streams are Flate-compressed and pdf-lib writes text as hex strings: inflate each stream and count the banner drawn on every page (top and bottom).
  const raw = Buffer.from(bytes).toString('latin1');
  let banners = 0;
  for (const match of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    try { banners += inflateSync(Buffer.from(match[1], 'latin1')).toString('latin1').split(`<${Buffer.from(SYNTHETIC_BANNER, 'latin1').toString('hex').toUpperCase()}>`).length - 1; } catch { /* not a content stream */ }
  }
  assert.equal(banners, 3 * 2, 'banner drawn at the top and bottom of every page');
  const dir = await mkdtemp(join(tmpdir(), 'coversaath-b2-'));
  try {
    const target = join(dir, 'synthetic.pdf');
    assert.equal((await run([`--write-pdf=${target}`], {})).exitCode, 0);
    assert.deepEqual(Buffer.from(await readFile(target)), Buffer.from(bytes));
    const again = await run([`--write-pdf=${target}`], {});
    assert.equal(again.exitCode, 1);
    assert.match(again.output, /WRITE_PDF_FAILED/);
    assert.deepEqual(Buffer.from(await readFile(target)), Buffer.from(bytes), 'the existing file is untouched');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('stripTags removes nested and reassembled tags and keeps table cells readable', () => {
  for (const hostile of ['<scr<b>ipt>alert</scr</b>ipt>', '<scr<script>ipt>x', '<<i>script>y']) {
    for (const line of stripTags(hostile)) assert.doesNotMatch(line, /[<>]/, hostile);
  }
  assert.deepEqual(stripTags('<table><tr><td>A</td><td>B</td></tr><tr><td>C</td><td>D</td></tr></table>'), ['A | B', 'C | D']);
});

test('a live run where no call succeeds does not pass', async () => {
  const failing = stubDriver();
  failing.createAgent = () => ({ generate: async () => { throw Object.assign(new Error('provider down'), { code: 'provider_error' }); } });
  const { exitCode, report } = await run(['--live'], liveEnv, failing);
  assert.equal(exitCode, 1);
  assert.equal(report.run.pass.allCallsOk, false);
  assert.equal(report.run.passed, false);
});

test('a failure inside runLive attaches the spend and call counts to the thrown error (main prints them as `spend`)', async () => {
  const { runLive } = await import('../scripts/smoke-test-gemini.mjs');
  const plan = { ...planRun({ env: liveEnv }), pagesInput: [{ page: 1, blocks: 'not-an-array' }] };
  const driver = stubDriver();
  const error = await runLive(plan, { loadModel: driver.loadModel, createAgent: driver.createAgent }).then(() => null, caught => caught);
  assert.ok(error, 'the malformed input makes the run throw');
  assert.deepEqual(error.smokeSpend, { providerCalls: 0, callsOk: 0, spentUsd: 0 });
}

);

test('the preflight input limit is measured on the gateway prompt contract, not on chunk text alone', async () => {
  const plan = planRun({ env: liveEnv });
  const largest = plan.estimate.largestPromptBytes;
  assert.ok(largest > 0);
  assert.equal(planRun({ env: { ...liveEnv, STRUCTURING_MAX_INPUT_BYTES: String(largest) } }).problems.includes('PROMPT_EXCEEDS_INPUT_LIMIT'), false);
  assert.equal(planRun({ env: { ...liveEnv, STRUCTURING_MAX_INPUT_BYTES: String(largest - 1) } }).problems.includes('PROMPT_EXCEEDS_INPUT_LIMIT'), true);
  // At exactly that cap the stubbed run produces no input_limit outcome (the stub does not enforce the real gateway limit;
  // the preflight above is what measures the prompt contract).
  const { report } = await run(['--live'], { ...liveEnv, STRUCTURING_MAX_INPUT_BYTES: String(largest) });
  assert.ok(!report.run.callOutcomes.includes('input_limit'));
});

test('the synthetic fixture is deeply frozen', () => {
  assert.ok(Object.isFrozen(SYNTHETIC_POLICY_PAGES[0]));
  assert.ok(Object.isFrozen(SYNTHETIC_POLICY_PAGES[0].blocks));
  assert.ok(Object.isFrozen(SYNTHETIC_POLICY_PAGES[0].blocks[0]));
});
