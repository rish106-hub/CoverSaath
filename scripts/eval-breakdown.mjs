#!/usr/bin/env node
// Extraction accuracy harness for the 12-section policy breakdown.
//
//   node scripts/eval-breakdown.mjs --set fixtures [--pack a|b|c|all] [--section n]   # synthetic packs, no network, no cost
//   node --env-file=.env.local scripts/eval-breakdown.mjs --set local [--case name] [--max-usd 5]
//
// Local cases live in .local/eval/<case>/ (ignored by git):
//   policy.pdf    the document (public insurer wording or an anonymised user PDF)
//   gold.json     { "parameters": { "<key>": { "found": true, "value": <number|string|boolean|string[]>, "page": <n> } } }
//                 Only keys you have hand-marked are scored. found:false asserts the pack does not state it.
//   pages.json    written by this script after OCR so later runs do not pay for OCR again.
// Reports go to .local/eval/reports/<timestamp>.json.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXTRACTION_SECTIONS, PARAMETER_INDEX } from '../src/modules/policy-breakdown/sections/index.js';
import { runExtractionSection, assembleSectionFromStep, runAnalysisSections } from '../src/modules/policy-breakdown/pipeline/run-sections.js';
import { createFixtureModelRunner, createJobBudget, createLiveModelRunner } from '../src/modules/policy-breakdown/agents/model-runner.js';
import { chunkPdf } from '../src/modules/policy-breakdown/ocr/pdf-tools.js';
import { readZip } from '../src/modules/policy-breakdown/ocr/zip-reader.js';
import { createSarvamDocAiClient } from '../src/integrations/index.js';
import { loadSyntheticPack, createGoldResponder, SYNTHETIC_PACKS } from '../tests/fixtures/policy-breakdown/synthetic-pack.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => (value.startsWith('--') ? [...pairs, [value.slice(2), all[index + 1]?.startsWith('--') ? true : all[index + 1] ?? true]] : pairs), []));
const set = args.set ?? 'fixtures';
const root = '.local/eval';

function comparable(value) {
  if (!value) return null;
  switch (value.kind) {
    case 'money': return value.amountMinor / 100;
    case 'percent': return value.percent;
    case 'days': case 'months': case 'years': case 'count': return value.count;
    case 'boolean': return value.flag;
    case 'enum': return value.enumValue;
    case 'date': return value.date;
    case 'text': case 'rule': return value.text;
    case 'text_list': return value.items;
    default: return null;
  }
}

function matches(expected, actual) {
  if (expected === actual) return true;
  if (typeof expected === 'number' && typeof actual === 'number') return Math.abs(expected - actual) < 0.005;
  const norm = text => String(text).toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const left = new Set(expected.map(norm));
    const right = new Set(actual.map(norm));
    return left.size === right.size && [...left].every(item => right.has(item));
  }
  if (typeof expected === 'string' && typeof actual === 'string') return norm(expected) === norm(actual) || norm(actual).includes(norm(expected));
  return false;
}

const scopeKey = scope => String(scope ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** The result a gold row is scored against: the policy-wide result, or the member variant it names. */
function resultFor(parameters, key, memberScope) {
  const result = parameters[key];
  if (!memberScope || !result) return result;
  const variant = (result.memberVariants ?? []).find(item => scopeKey(item.memberScope) === scopeKey(memberScope));
  return variant ? { ...result, ...variant } : { ...result, value: null, evidenceState: 'Unknown', proposedValue: null, stateReason: 'member_variant_missing' };
}

function score(parameters, gold) {
  const rows = [];
  for (const [goldKey, expected] of Object.entries(gold)) {
    const key = goldKey.split('@')[0];
    const definition = PARAMETER_INDEX.get(key);
    if (!definition) { rows.push({ key: goldKey, outcome: 'unknown_key' }); continue; }
    const result = resultFor(parameters, key, expected.memberScope);
    const found = result?.evidenceState === 'Proven';
    let outcome;
    if (expected.found === false) outcome = found ? 'false_positive' : 'correct_absent';
    else if (!result || result.evidenceState === 'Unknown') outcome = result?.proposedValue != null ? 'unverified' : 'missed';
    else if (result.evidenceState === 'Conflicting') outcome = 'conflicting';
    else outcome = matches(expected.value, comparable(result.value)) ? 'correct' : 'wrong_value';
    rows.push({ key: goldKey, section: definition.section, critical: definition.critical, outcome, expected: expected.value ?? null, actual: comparable(result?.value) ?? null, state: result?.evidenceState ?? null, reason: result?.stateReason ?? null });
  }
  return rows;
}

/** Share of model-proposed values whose every quote was found on the cited page text. */
function citationStats(parameters) {
  const proposed = Object.values(parameters).filter(result => (result.citations ?? []).length > 0);
  const valid = proposed.filter(result => result.citations.every(citation => citation.matched));
  return { proposedWithCitations: proposed.length, allQuotesVerified: valid.length, citationValidityPercent: proposed.length ? Math.round((valid.length / proposed.length) * 1000) / 10 : null };
}

function summarise(rows) {
  const bySection = {};
  for (const row of rows) {
    if (!row.section) continue;
    bySection[row.section] ??= { scored: 0, correct: 0, wrong_value: 0, missed: 0, false_positive: 0, conflicting: 0, unverified: 0 };
    const bucket = bySection[row.section];
    bucket.scored += 1;
    if (['correct', 'correct_absent'].includes(row.outcome)) bucket.correct += 1; else bucket[row.outcome] = (bucket[row.outcome] ?? 0) + 1;
  }
  const scored = rows.filter(row => row.section);
  const critical = scored.filter(row => row.critical);
  const pct = (part, whole) => (whole ? Math.round((part / whole) * 1000) / 10 : null);
  const correct = list => list.filter(row => ['correct', 'correct_absent'].includes(row.outcome)).length;
  return {
    scored: scored.length,
    accuracyPercent: pct(correct(scored), scored.length),
    criticalScored: critical.length,
    criticalAccuracyPercent: pct(correct(critical), critical.length),
    dangerous: scored.filter(row => ['wrong_value', 'false_positive'].includes(row.outcome) && row.state === 'Proven').map(row => row.key),
    bySection,
  };
}

async function extract(pages, runner, budget) {
  const parameters = {};
  const calls = [];
  await Promise.all(EXTRACTION_SECTIONS.map(async section => {
    try {
      const output = await runExtractionSection({ section, pages, runner, budget });
      calls.push(...output.calls);
      Object.assign(parameters, assembleSectionFromStep({ section, stepOutput: output, pages, runner }));
    } catch (error) {
      calls.push({ agent: section.id, status: 'failed', errorCode: error.code ?? error.message });
    }
  }));
  Object.assign(parameters, runAnalysisSections({ parameters, household: { members: [], city: null }, asOf: new Date().toISOString().slice(0, 10) }));
  return { parameters, calls };
}

async function fixtureCase(packName) {
  const pack = loadSyntheticPack({ pack: packName });
  const pages = pack.pages.map(page => ({ ...page, documentId: 'synthetic', localPageNumber: page.pageNumber, documentLabel: `synthetic-pack-${packName}` }));
  const runner = createFixtureModelRunner({ responder: createGoldResponder(pack) });
  const { parameters, calls } = await extract(pages, runner, createJobBudget(Number.MAX_SAFE_INTEGER));
  const gold = {};
  const section = args.section ? Number(args.section) : null;
  for (const items of Object.values(pack.gold)) {
    for (const item of items) {
      const definition = PARAMETER_INDEX.get(item.key);
      if (!definition || (section && definition.section !== section)) continue;
      const goldKey = item.memberScope ? `${item.key}@${item.memberScope}` : item.key;
      if (goldKey in gold) continue; // a deliberate contradiction keeps its first item as the expectation
      if (!item.found) { gold[goldKey] = { found: false, memberScope: item.memberScope ?? null }; continue; }
      const value = { money: item.valueNumber, percent: item.valueNumber, days: item.valueNumber, months: item.valueNumber, years: item.valueNumber, count: item.valueNumber, boolean: item.valueBoolean, text_list: item.valueList }[definition.valueType] ?? item.valueText;
      gold[goldKey] = { found: true, value, memberScope: item.memberScope ?? null };
    }
  }
  return { name: `synthetic-pack-${packName}`, rows: score(parameters, gold), calls, citations: citationStats(parameters) };
}

/** Every extraction key must be scored as found (a value) in at least one synthetic pack. */
function foundCoverage(cases) {
  const foundKeys = new Set(cases.flatMap(item => item.rows.filter(row => row.outcome === 'correct').map(row => row.key.split('@')[0])));
  const section = args.section ? Number(args.section) : null;
  const all = [...PARAMETER_INDEX.values()].filter(definition => definition.section <= 9 && (!section || definition.section === section));
  return { extractionKeys: all.length, provenInSomePack: all.filter(definition => foundKeys.has(definition.key)).length, neverProven: all.filter(definition => !foundKeys.has(definition.key)).map(definition => definition.key) };
}

async function localCases() {
  if (!existsSync(root)) throw new Error(`Create ${root}/<case>/policy.pdf and gold.json first.`);
  const names = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name !== 'reports').map(entry => entry.name).filter(name => !args.case || name === args.case);
  const runner = createLiveModelRunner({ env: process.env });
  const budget = createJobBudget(Number(args['max-usd'] ?? 5));
  let ocr = null;
  const results = [];
  for (const name of names) {
    const directory = join(root, name);
    if (!existsSync(join(directory, 'policy.pdf')) || !existsSync(join(directory, 'gold.json'))) { console.warn(`skip ${name}: needs policy.pdf and gold.json`); continue; }
    let pages;
    if (existsSync(join(directory, 'pages.json'))) pages = JSON.parse(readFileSync(join(directory, 'pages.json'), 'utf8'));
    else {
      ocr ||= createSarvamDocAiClient({ apiKey: process.env.SARVAM_API_KEY, splitPdf: chunkPdf, readZip });
      const extracted = await ocr.extractPages({ bytes: readFileSync(join(directory, 'policy.pdf')), mimeType: 'application/pdf' });
      pages = extracted.pages.map(page => ({ pageNumber: page.pageNumber, localPageNumber: page.pageNumber, documentId: name, documentLabel: name, text: page.text }));
      writeFileSync(join(directory, 'pages.json'), JSON.stringify(pages));
    }
    const gold = JSON.parse(readFileSync(join(directory, 'gold.json'), 'utf8')).parameters ?? {};
    const { parameters, calls } = await extract(pages, runner, budget);
    results.push({ name, rows: score(parameters, gold), calls, citations: citationStats(parameters) });
  }
  return { results, spentUsd: budget.snapshot().spentUsd };
}

const started = Date.now();
let cases;
let spentUsd = 0;
let coverage = null;
if (set === 'fixtures') {
  const packs = !args.pack || args.pack === 'all' ? SYNTHETIC_PACKS : [args.pack];
  cases = [];
  for (const name of packs) cases.push(await fixtureCase(name));
  coverage = foundCoverage(cases);
}
else if (set === 'local') ({ results: cases, spentUsd } = await localCases());
else throw new Error('--set must be fixtures or local');

const report = { set, coverage, at: new Date().toISOString(), durationMs: Date.now() - started, spentUsd, cases: cases.map(item => ({ name: item.name, summary: { ...summarise(item.rows), ...item.citations }, failedCalls: item.calls.filter(call => call.status === 'failed'), rows: item.rows })) };
mkdirSync(join(root, 'reports'), { recursive: true });
const file = join(root, 'reports', `${report.at.replace(/[:.]/g, '-')}-${set}.json`);
writeFileSync(file, JSON.stringify(report, null, 2));
for (const item of report.cases) {
  const { summary } = item;
  console.log(`${item.name}: ${summary.accuracyPercent}% of ${summary.scored} scored · critical ${summary.criticalAccuracyPercent}% of ${summary.criticalScored} · citation validity ${summary.citationValidityPercent}% · dangerous (wrong but Proven): ${summary.dangerous.length ? summary.dangerous.join(', ') : 'none'}`);
  for (const [section, bucket] of Object.entries(summary.bySection)) console.log(`  section ${section}: ${bucket.correct}/${bucket.scored} correct${bucket.wrong_value ? ` · ${bucket.wrong_value} wrong` : ''}${bucket.missed ? ` · ${bucket.missed} missed` : ''}${bucket.false_positive ? ` · ${bucket.false_positive} false positive` : ''}${bucket.conflicting ? ` · ${bucket.conflicting} conflicting` : ''}${bucket.unverified ? ` · ${bucket.unverified} unverified` : ''}`);
}
if (coverage) console.log(`found-path coverage: ${coverage.provenInSomePack}/${coverage.extractionKeys} extraction keys proven in at least one pack${coverage.neverProven.length ? ` · never proven: ${coverage.neverProven.join(', ')}` : ''}`);
console.log(`spent $${spentUsd.toFixed(4)} · report ${file}`);
const failed = report.cases.some(item => item.summary.dangerous.length > 0 || (set === 'fixtures' && item.summary.accuracyPercent !== 100));
process.exitCode = failed ? 1 : 0;
