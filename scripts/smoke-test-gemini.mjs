#!/usr/bin/env node
/**
 * Gemini live smoke run for policy structuring (B2). Runbook: docs/runbooks/gemini-live-run.md
 *
 *   node scripts/smoke-test-gemini.mjs                dry run (default): offline, no provider call, no key needed
 *   node scripts/smoke-test-gemini.mjs --dry-run      same, explicit
 *   node scripts/smoke-test-gemini.mjs --live         ONE paid run on the built-in synthetic fixture
 *   node scripts/smoke-test-gemini.mjs --write-pdf=<new file>   also write the synthetic PDF (no overwrite)
 *
 * Input is only the built-in synthetic fixture (scripts/fixtures/synthetic-policy-pages.mjs); there is no way to point
 * this script at another document. The OCR step is skipped: the fixture already has the shape Sarvam produces.
 * Path: sectioner -> privacy gate (fails closed on a leak) -> model gateway (reservation per call, run and project
 * budget) -> extractor/reconciler -> deterministic decisions. Nothing is stored; output is counts only.
 * Exit 0 needs: spend inside the cap, only allowed states, a clean gate, every call ok (at least one), every chunk accounted
 * for, an evidence outcome that is not `failed`, and at least one decision.
 *
 * --live is refused unless ALL hold: the flag is given; ORCHESTRATION_RUN_BUDGET_USD and ORCHESTRATION_PROJECT_BUDGET_USD
 * are set explicitly (not defaulted) and the run cap is at most LIVE_RUN_CEILING_USD; a Gemini key, LLM_MODEL and both
 * LLM_*_USD_PER_MILLION rates are set; one reservation fits the run cap; every planned prompt fits the input limit;
 * the privacy gate leaves no known identifier in what would be sent. The key is never printed.
 */
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { STRUCTURING_EXTRACT_TASK, STRUCTURING_RECONCILE_TASK, buildPromptContract, createStructuringModelCallFactory } from '../src/features/ai-analysis/index.js';
import { POLICY_PARAMETER_REGISTRY_VERSION } from '../src/features/coverage-analysis/policy-parameter-registry.js';
import {
  STRUCTURING_LIMITS, gateChunks, registryCatalog, sectionDocument, structurePolicyDocument,
} from '../src/features/policy-structuring/index.js';
import {
  SYNTHETIC_CANARIES, SYNTHETIC_KNOWN_IDENTIFIERS, SYNTHETIC_POLICY_PAGES, buildSyntheticPolicyPdf,
} from './fixtures/synthetic-policy-pages.mjs';

export const LIVE_RUN_CEILING_USD = 0.5;
// The fixture is three short pages; smaller per-call caps than the production defaults keep each reservation small.
export const SMOKE_CAP_DEFAULTS = Object.freeze({ STRUCTURING_MAX_INPUT_BYTES: '24000', STRUCTURING_MAX_OUTPUT_TOKENS: '8000', STRUCTURING_TIMEOUT_MS: '120000' });
const ALLOWED_FLAGS = new Set(['live', 'dry-run', 'write-pdf']);
const ALLOWED_STATES = new Set(['extracted_unverified', 'conflicting', 'unknown']);
const MODEL_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

const number = value => {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};
const round = value => Number(value.toFixed(6));

export function parseArgs(argv) {
  const flags = {};
  for (const arg of argv) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!match || !ALLOWED_FLAGS.has(match[1])) return { error: 'UNKNOWN_ARGUMENT' };
    // --live and --dry-run are switches: `--live=` or `--live=no` must not be read as a quiet dry run.
    if (match[2] !== undefined && match[1] !== 'write-pdf') return { error: 'FLAG_TAKES_NO_VALUE' };
    flags[match[1]] = match[2] ?? true;
  }
  if (flags.live && flags['dry-run']) return { error: 'LIVE_AND_DRY_RUN' };
  if (flags['write-pdf'] !== undefined && (flags['write-pdf'] === true || !flags['write-pdf'])) return { error: 'WRITE_PDF_NEEDS_PATH' };
  return { live: flags.live === true, writePdf: flags['write-pdf'] ?? null };
}

// Same greedy batching as the extractor, to count planned calls and the largest prompt.
function batchesOf(chunks) {
  const batches = [];
  let current = [];
  let chars = 0;
  for (const chunk of chunks) {
    if (chunk.text.length > STRUCTURING_LIMITS.maxCharsPerCall) continue;
    if (current.length && (current.length >= STRUCTURING_LIMITS.maxChunksPerCall || chars + chunk.text.length > STRUCTURING_LIMITS.maxCharsPerCall)) {
      batches.push(current); current = []; chars = 0;
    }
    current.push(chunk); chars += chunk.text.length;
  }
  if (current.length) batches.push(current);
  return batches;
}

/** Offline plan: sections and gates the fixture, sizes the calls, reads (never prints) the env. Makes no network call. */
export function planRun({
  env = process.env, pages = SYNTHETIC_POLICY_PAGES, knownIdentifiers = SYNTHETIC_KNOWN_IDENTIFIERS, canaries = SYNTHETIC_CANARIES, sanitize,
} = {}) {
  const sectioned = sectionDocument(pages);
  const gated = gateChunks(sectioned.chunks, { knownIdentifiers, ...(sanitize ? { sanitize } : {}) });
  const sentText = gated.sent.map(chunk => `${chunk.title ?? ''}\n${chunk.text}`).join('\n');
  const leaked = canaries.filter(value => sentText.includes(value));

  const catalog = registryCatalog(POLICY_PARAMETER_REGISTRY_VERSION);
  const batches = batchesOf(gated.sent);
  // Measured with the gateway's own prompt contract and the same payload shape the extractor sends, so the input limit
  // here is the one the gateway enforces at run time (contract.evidence is what it measures).
  const evidenceBytes = (task, payload) => Buffer.byteLength(buildPromptContract(task, { payload }).evidence, 'utf8');
  const batchBytes = batches.map(batch => evidenceBytes(STRUCTURING_EXTRACT_TASK, {
    registry: catalog,
    chunks: batch.map(chunk => ({ chunk_id: chunk.id, page: chunk.page, block_indexes: chunk.blockIndexes, kind: chunk.kind, title: chunk.title, text: chunk.text })),
  }));
  // The reconcile call is made only when readings differ. Upper bound: every sent chunk text as a quote of one group
  // (a quote is a substring of one chunk), so the real payload is expected to be smaller.
  const reconcileBytes = evidenceBytes(STRUCTURING_RECONCILE_TASK, {
    groups: [{ group_id: 'g', target: 'f.example', subject: 'policyholder', readings: gated.sent.map(chunk => ({ value: chunk.text.slice(0, 200), quote: chunk.text, page: chunk.page })) }],
  });
  // Extraction calls plus one possible reconcile call (made only when readings of one key differ).
  const plannedCalls = batches.length + 1;

  const caps = {
    maxInputBytes: number(env.STRUCTURING_MAX_INPUT_BYTES ?? SMOKE_CAP_DEFAULTS.STRUCTURING_MAX_INPUT_BYTES),
    maxOutputTokens: number(env.STRUCTURING_MAX_OUTPUT_TOKENS ?? SMOKE_CAP_DEFAULTS.STRUCTURING_MAX_OUTPUT_TOKENS),
  };
  const rates = { input: number(env.LLM_INPUT_USD_PER_MILLION), output: number(env.LLM_OUTPUT_USD_PER_MILLION) };
  const budget = { runUsd: number(env.ORCHESTRATION_RUN_BUDGET_USD), projectUsd: number(env.ORCHESTRATION_PROJECT_BUDGET_USD) };
  const model = typeof env.LLM_MODEL === 'string' && MODEL_PATTERN.test(env.LLM_MODEL.trim()) ? env.LLM_MODEL.trim() : null;
  const keyPresent = [env.GEMINI_API_KEY, env.GOOGLE_GENERATIVE_AI_API_KEY].some(value => typeof value === 'string' && value.trim().length > 0);
  const reservationUsd = caps.maxInputBytes && caps.maxOutputTokens && rates.input && rates.output
    ? (caps.maxInputBytes * rates.input + caps.maxOutputTokens * rates.output) / 1_000_000 : null;

  const inputBytesTotal = batchBytes.reduce((sum, bytes) => sum + bytes, 0) + (batches.length ? reconcileBytes : 0);
  const estimate = {
    plannedCalls,
    largestPromptBytes: Math.max(0, ...batchBytes, ...(batches.length ? [reconcileBytes] : [])),
    inputTokensExpected: Math.ceil(inputBytesTotal / 4),
    inputTokensCeiling: inputBytesTotal, // one token is at least one byte
    outputTokensCeiling: plannedCalls * (caps.maxOutputTokens ?? 0),
    costExpectedInputOnlyUsd: rates.input ? round((Math.ceil(inputBytesTotal / 4) * rates.input) / 1_000_000) : null,
    worstCaseUsd: reservationUsd === null ? null : round(plannedCalls * reservationUsd),
    reservationPerCallUsd: reservationUsd === null ? null : round(reservationUsd),
  };

  const problems = [];
  if (env.LLM_PROVIDER !== 'google' && env.LLM_PROVIDER !== 'gemini') problems.push('LLM_PROVIDER_NOT_GOOGLE');
  if (!keyPresent) problems.push('API_KEY_MISSING');
  if (!model) problems.push('LLM_MODEL_MISSING_OR_INVALID');
  if (!rates.input || !rates.output) problems.push('RATES_MISSING');
  if (budget.runUsd === null || budget.projectUsd === null) problems.push('BUDGET_CAP_MISSING');
  if (budget.runUsd !== null && budget.runUsd > LIVE_RUN_CEILING_USD) problems.push('BUDGET_CAP_ABOVE_CEILING');
  // The shared live-AI config also checks its own reservation (LLM_MAX_* defaults) against the run cap.
  const baseReservationUsd = rates.input && rates.output
    ? (number(env.LLM_MAX_INPUT_BYTES ?? 48_000) * rates.input + number(env.LLM_MAX_OUTPUT_TOKENS ?? 1_500) * rates.output) / 1_000_000 : null;
  if (budget.runUsd !== null && [reservationUsd, baseReservationUsd].some(value => value !== null && value > budget.runUsd)) problems.push('RESERVATION_EXCEEDS_RUN_BUDGET');
  if (caps.maxInputBytes === null || caps.maxOutputTokens === null) problems.push('CALL_CAPS_INVALID');
  else if ([...batchBytes, ...(batches.length ? [reconcileBytes] : [])].some(bytes => bytes > caps.maxInputBytes)) problems.push('PROMPT_EXCEEDS_INPUT_LIMIT');
  if (!batches.length) problems.push('NOTHING_TO_SEND');
  if (leaked.length) problems.push('PRIVACY_GATE_LEAK');

  return {
    pages: pages.length,
    gate: {
      status: leaked.length ? 'LEAK' : 'pass',
      chunksSent: gated.sent.length,
      chunksWithheld: Object.keys(gated.skipped).length,
      knownIdentifiersMasked: knownIdentifiers.length,
      canariesFoundInOutgoingText: leaked.length,
    },
    config: {
      model, provider: env.LLM_PROVIDER ?? null, keyPresent,
      rates: { inputUsdPerMillion: rates.input, outputUsdPerMillion: rates.output },
      caps,
    },
    budget: { runCapUsd: budget.runUsd, projectCapUsd: budget.projectUsd, liveRunCeilingUsd: LIVE_RUN_CEILING_USD },
    estimate,
    problems,
    batches: batches.length,
    pagesInput: pages,
    knownIdentifiers,
    liveEnv: { ...env, STRUCTURING_MAX_INPUT_BYTES: String(caps.maxInputBytes), STRUCTURING_MAX_OUTPUT_TOKENS: String(caps.maxOutputTokens), STRUCTURING_TIMEOUT_MS: env.STRUCTURING_TIMEOUT_MS ?? SMOKE_CAP_DEFAULTS.STRUCTURING_TIMEOUT_MS },
  };
}

const publicPlan = plan => ({
  gate: plan.gate, config: plan.config, budget: plan.budget, estimate: plan.estimate, pages: plan.pages, plannedExtractionCalls: plan.batches,
  liveReady: plan.problems.length === 0, problems: plan.problems,
});

/** One paid run. Callers have already refused on any plan problem. */
export async function runLive(plan, { loadModel, createAgent } = {}) {
  const consentCheck = async () => {}; // --live on the built-in synthetic fixture is the grant; there is no household here
  const events = [];
  const create = createStructuringModelCallFactory({ env: plan.liveEnv, loadModel, createAgent })({ consentCheck, onCall: event => events.push(event) });
  const call = ({ task, payload }) => create({ task, payload });
  let result;
  try {
    result = await structurePolicyDocument({
      pages: plan.pagesInput, call, consentCheck, knownIdentifiers: plan.knownIdentifiers, env: { ...plan.liveEnv, POLICY_STRUCTURING_ENABLED: 'true' },
    });
  } catch (error) {
    // A paid call may have settled before the failure: attach what was spent so the operator can see it.
    throw Object.assign(error, { smokeSpend: { providerCalls: events.length, callsOk: events.filter(event => event.outcome === 'ok').length, spentUsd: round(events.reduce((sum, event) => sum + (event.costUsd ?? 0), 0)) } });
  }
  const spentUsd = round(events.reduce((sum, event) => sum + (event.costUsd ?? 0), 0));
  const states = [...new Set(result.decisions.map(decision => decision.state))].sort();
  const dispatched = events.filter(event => event.outcome === 'ok').length;
  const pass = {
    insideRunBudget: spentUsd <= plan.budget.runCapUsd,
    outputStatesAllowed: states.every(state => ALLOWED_STATES.has(state)),
    gateClean: plan.gate.status === 'pass',
    // A run where no call succeeded, or any call was refused or failed, never passes (an empty list is not success).
    allCallsOk: events.length > 0 && dispatched === events.length,
    everyChunkAccounted: result.report.chunks.unaccounted === 0,
    evidenceNotFailed: result.outcome.evidenceOutcome !== 'failed',
    producedDecisions: result.decisions.length > 0,
  };
  return {
    providerCalls: events.length, callsOk: dispatched, callOutcomes: events.map(event => event.outcome),
    tokens: { input: result.report.usage.inputTokens, output: result.report.usage.outputTokens },
    spentUsd, runCapUsd: plan.budget.runCapUsd,
    outcome: result.outcome,
    chunks: result.report.chunks, items: { accepted: result.report.items.accepted, proposals: result.report.items.proposals, rejected: result.report.items.rejected },
    conflicts: result.report.conflicts, decisionStates: states, pass, passed: Object.values(pass).every(Boolean),
  };
}

export async function main(argv = process.argv.slice(2), env = process.env, { print = line => console.log(line), loadModel, createAgent } = {}) {
  const args = parseArgs(argv);
  if (args.error) {
    print(JSON.stringify({ error: args.error, usage: 'node scripts/smoke-test-gemini.mjs [--dry-run | --live] [--write-pdf=<new file>]' }));
    return { exitCode: 2 };
  }
  if (args.writePdf) {
    try { await writeFile(args.writePdf, await buildSyntheticPolicyPdf(), { flag: 'wx' }); } catch (error) {
      print(JSON.stringify({ error: 'WRITE_PDF_FAILED', code: error.code ?? 'ERROR' }));
      return { exitCode: 1 };
    }
  }
  const plan = planRun({ env });
  const report = { mode: args.live ? 'live' : 'dry-run', ...publicPlan(plan) };
  if (!args.live) {
    print(JSON.stringify({ ...report, providerCallsMade: 0, note: 'Dry run: no provider was contacted. Pass --live to spend money.' }, null, 2));
    return { exitCode: 0, report };
  }
  if (plan.problems.length) {
    print(JSON.stringify({ ...report, refused: true, providerCallsMade: 0 }, null, 2));
    return { exitCode: 1, report: { ...report, refused: true } };
  }
  try {
    const run = await runLive(plan, { loadModel, createAgent });
    print(JSON.stringify({ ...report, run }, null, 2));
    return { exitCode: run.passed ? 0 : 1, report: { ...report, run } };
  } catch (error) {
    // Codes only: never the message, which could echo provider detail.
    const failure = { ...report, failed: true, code: error?.code ?? 'ERROR', ...(error?.smokeSpend ? { spend: error.smokeSpend } : {}) };
    print(JSON.stringify(failure, null, 2));
    return { exitCode: 1, report: failure };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { exitCode } = await main();
  process.exitCode = exitCode;
}
