// Evaluator for the Block 4 golden matrix. It runs the engine on each case, compares the output with the hand-written
// expectation in the case, checks invariants that hold for every case, and counts the acceptance metrics. It measures a
// synthetic matrix only: not model accuracy, OCR or retrieval recall, insurer-data coverage or real-policy correctness.
import { performance } from 'node:perf_hooks';
import { buildHouseholdCoveragePreview, policyRefOf, validateScenarioInput } from '../../src/features/household-reasoning/index.js';
import { makeHandoff, okSource, requestOf } from './household-fixtures.mjs';

const thaw = value => JSON.parse(JSON.stringify(value));
const documentedOf = preview => preview.policies.flatMap(policy => [...policy.documentedTerms, ...policy.documentedRestrictions].map(entry => ({ policy, entry })));
const entryKey = ({ policy, entry }) => `${policy.policyId}:${entry.rule}/${entry.topic}`;
const withRef = key => { const i = key.indexOf(':'); return `${policyRefOf(key.slice(0, i))}${key.slice(i)}`; };
const numbersIn = json => new Set([...json.matchAll(/(?<![\w.])\d{4,}(?![\w.])/g)].map(match => Number(match[0])));
const nonScenario = preview => JSON.stringify({ ...preview, scenario: undefined });

function build(c) {
  const request = validateScenarioInput(requestOf(c.scenario));
  let sources = c.sources;
  if (!sources) {
    sources = c.handoffs.map((spec, index) => {
      const handoff = thaw(makeHandoff(spec));
      c.tamper?.(handoff);
      return okSource(handoff, index);
    });
  }
  return { request, sources, preview: buildHouseholdCoveragePreview({ request, sources }) };
}

export function evaluateCase(c, { repeats = 3 } = {}) {
  const failures = [];
  const fail = message => failures.push(message);
  const result = { id: c.id, group: c.group, title: c.title, failures, metrics: {} };
  const expect = c.expect;

  if (expect.error) {
    try { build(c); fail(`expected error ${expect.error}, got a preview`); } catch (error) { if (error.code !== expect.error) fail(`expected error ${expect.error}, got ${error.code ?? error.message}`); }
    result.pass = failures.length === 0;
    return result;
  }

  let first;
  const timings = [];
  const runs = [];
  try {
    for (let i = 0; i < repeats; i += 1) {
      const started = performance.now();
      const run = build(c);
      timings.push(performance.now() - started);
      runs.push(JSON.stringify(run.preview));
      first ??= run;
    }
  } catch (error) { fail(`unhandled exception: ${error.message}`); result.pass = false; result.metrics.exception = 1; return result; }
  result.metrics.latencyMs = timings;
  result.metrics.determinismMismatch = runs.every(run => run === runs[0]) ? 0 : 1;
  if (result.metrics.determinismMismatch) fail('non-deterministic output');

  const { preview, request, sources } = first;
  const documented = documentedOf(preview);
  const keys = documented.map(entryKey).sort();
  const gapKeys = preview.contextGaps.map(g => g.gapKey);
  const questionIds = preview.nextQuestions.map(q => q.questionId);
  const gapOf = key => preview.contextGaps.find(g => g.gapKey === key);
  const refs = Object.fromEntries(preview.policies.map(p => [p.policyId, p]));
  const policyOf = id => refs[policyRefOf(id)];
  const entryOf = key => documented.find(d => entryKey(d) === withRef(key));
  const json = JSON.stringify(preview);
  const body = nonScenario(preview);

  // Invariants for every case.
  if (preview.nextQuestions.length > 2) fail('more than two questions');
  const answered = Object.keys(request.scenario.answers);
  const repeated = preview.nextQuestions.filter(q => answered.includes(q.questionKey));
  result.metrics.duplicateQuestions = repeated.length;
  if (repeated.length) fail(`repeated question ${repeated.map(q => q.questionId)}`);
  const uncited = documented.filter(d => !d.entry.citations?.length);
  result.metrics.uncited = uncited.length;
  if (uncited.length) fail('documented entry without citations');
  if (preview.nextActions.some(a => a.status !== 'pending') || preview.externalChecks.some(c2 => c2.status !== 'not_performed')) fail('an action or check claims completion');
  const amounts = documented.filter(d => d.entry.value?.amountMinor).map(d => ({ policy: d.policy.policyId, amount: d.entry.value.amountMinor }));
  const single = new Set(amounts.map(a => a.amount));
  const present = numbersIn(body);
  let sums = 0;
  for (const a of amounts) for (const b of amounts) if (a.policy < b.policy && !single.has(a.amount + b.amount) && present.has(a.amount + b.amount)) sums += 1;
  result.metrics.summations = sums;
  if (sums) fail('limits were added together');
  // Authority: a documented entry must come from a known/decisive item of some source handoff, and carry its value.
  let upgrades = 0;
  for (const d of documented) {
    const origin = sources.filter(s => s.status === 'ok').flatMap(s => s.handoff.policies.filter(p => policyRefOf(p.policyId) === d.policy.policyId).flatMap(p => p.items))
      .filter(i => i.rule === d.entry.rule && i.topic === d.entry.topic);
    if (d.entry.rule !== 'finding' && !origin.some(i => ['known', 'not_permitted', 'not_selected', 'available_not_selected'].includes(i.state))) upgrades += 1;
  }
  result.metrics.illegalUpgrades = upgrades;
  if (upgrades) fail('authority upgrade');

  // Case expectations.
  if (expect.state && preview.assessmentState !== expect.state) fail(`state ${preview.assessmentState}, expected ${expect.state}`);
  if (expect.known) {
    const want = expect.known.map(withRef).sort();
    const extra = keys.filter(k => !want.includes(k));
    const missing = want.filter(k => !keys.includes(k));
    result.metrics.unsupportedKnown = extra.length;
    if (extra.length || missing.length) fail(`documented entries differ: extra ${JSON.stringify(extra)} missing ${JSON.stringify(missing)}`);
  }
  for (const key of expect.mustNotBeKnown ?? []) if (keys.includes(withRef(key))) { fail(`${key} must not be documented`); result.metrics.contamination = (result.metrics.contamination ?? 0) + 1; }
  for (const [key, amount] of Object.entries(expect.values ?? {})) if (entryOf(key)?.entry.value?.amountMinor !== amount) fail(`${key} value`);
  for (const [id, state] of Object.entries(expect.applicability ?? {})) if (policyOf(id)?.memberApplicability.state !== state) fail(`${id} applicability ${policyOf(id)?.memberApplicability.state}`);
  for (const [key, state] of Object.entries(expect.appliesToMember ?? {})) if (entryOf(key)?.entry.appliesToMember !== state) fail(`${key} appliesToMember`);
  for (const [id, kind] of Object.entries(expect.policyKinds ?? {})) if (policyOf(id)?.policyType.kind !== kind) fail(`${id} kind`);
  for (const g of expect.gaps ?? []) if (!gapKeys.includes(g)) fail(`gap ${g} missing`);
  for (const g of expect.noGaps ?? []) if (gapKeys.includes(g)) fail(`gap ${g} must be absent`);
  for (const [g, state] of Object.entries(expect.gapState ?? {})) { const actual = gapOf(g)?.currentState; if (state === 'user_no' ? actual !== 'user_unknown' && actual !== 'user_answered' && !/^user_/.test(actual ?? '') : actual !== state) fail(`gap ${g} state ${actual}`); }
  for (const [g, reason] of Object.entries(expect.gapReason ?? {})) if (gapOf(g)?.reason !== reason) fail(`gap ${g} reason ${gapOf(g)?.reason}`);
  for (const [g, resolver] of Object.entries(expect.gapResolver ?? {})) if (gapOf(g)?.expectedResolver !== resolver) fail(`gap ${g} resolver`);
  if (expect.questions && JSON.stringify(questionIds) !== JSON.stringify(expect.questions)) fail(`questions ${JSON.stringify(questionIds)}, expected ${JSON.stringify(expect.questions)}`);
  for (const id of expect.mustNotAsk ?? []) if (questionIds.includes(id)) fail(`${id} must not be asked`);
  for (const a of expect.actions ?? []) if (!preview.nextActions.some(x => x.actionType === a)) fail(`action ${a} missing`);
  if (expect.overlaps !== undefined && preview.comparisons.possibleOverlap.length !== expect.overlaps) fail(`overlaps ${preview.comparisons.possibleOverlap.length}`);
  for (const code of expect.coordination ?? []) if (!preview.comparisons.unresolvedCoordination.some(u => u.code === code)) fail(`coordination ${code} missing`);
  let disclosures = 0;
  for (const text of expect.forbidden ?? []) if (body.toLowerCase().includes(text.toLowerCase())) { fail(`forbidden text present: ${text}`); disclosures += 1; }
  for (const text of expect.forbiddenInPolicies ?? []) if (JSON.stringify(preview.policies).toLowerCase().includes(text.toLowerCase())) { fail(`forbidden text in policies: ${text}`); disclosures += 1; }
  result.metrics.disclosures = disclosures;
  for (const [key, state] of Object.entries(expect.completion ?? {})) if (entryOf(key)?.entry.completion?.state !== state) fail(`${key} completion ${entryOf(key)?.entry.completion?.state}`);
  for (const key of expect.restrictions ?? []) if (!preview.policies.some(p => p.documentedRestrictions.some(r => `${p.policyId}:${r.rule}/${r.topic}` === withRef(key)))) fail(`restriction ${key} missing`);
  for (const key of expect.uncertain ?? []) {
    const parts = key.split(':'); const last = parts.pop(); const policy = policyOf(parts[0]); const target = parts.slice(1).join(':');
    if (!policy?.uncertainties.some(u => `${u.rule}/${u.topic}` === target && (u.state === last || u.reasonCode === last))) fail(`uncertainty ${key} missing`);
  }
  for (const key of expect.dynamic ?? []) { const [id, rt] = key.split(':'); if (!policyOf(id)?.dynamicChecks.some(x => `${x.rule}/${x.topic}` === rt)) fail(`dynamic check ${key} missing`); }
  if (expect.policies !== undefined && preview.policies.length !== expect.policies) fail(`policies ${preview.policies.length}`);
  if (expect.sourceReason && !preview.sourceSummary.sources.some(s => s.reasonCode === expect.sourceReason)) fail(`source reason ${expect.sourceReason}`);
  for (const [id, idx] of Object.entries(expect.sourceIndexes ?? {})) if (JSON.stringify(policyOf(id)?.sourceIndexes) !== JSON.stringify(idx)) fail(`${id} sourceIndexes`);
  if (expect.noConflicts && gapKeys.includes('source_conflict')) fail('unexpected conflict');
  for (const [key, count] of Object.entries(expect.citationCount ?? {})) if (entryOf(key)?.entry.citations.length !== count) fail(`${key} citation count`);
  if (expect.maxQuestions !== undefined && preview.nextQuestions.length > expect.maxQuestions) fail('too many questions');
  if (expect.noRequiredQuestions && preview.nextQuestions.some(q => q.required)) fail('a required question');
  for (const pattern of expect.limitationMatches ?? []) if (!preview.limitations.some(l => new RegExp(pattern, 'i').test(l))) fail(`limitation ${pattern} missing`);
  if (expect.retrievalComplete !== undefined && preview.completeness.retrievalComplete !== expect.retrievalComplete) fail('retrievalComplete');
  if (expect.dateSemantics && preview.scenario.dateSemantics !== expect.dateSemantics) fail('dateSemantics');
  if (expect.plannedDate !== undefined && preview.scenario.plannedDate !== expect.plannedDate) fail('plannedDate');
  if (expect.hospitalIdentity && preview.scenario.hospital.identity !== expect.hospitalIdentity) fail('hospital identity');
  if (expect.externalChecks !== undefined && preview.externalChecks.length !== expect.externalChecks) fail(`external checks ${preview.externalChecks.length}`);

  // Metrics against the labels.
  result.metrics.questions = questionIds.length;
  result.metrics.unnecessaryQuestions = expect.questions ? questionIds.filter(id => !expect.questions.includes(id)).length : 0;
  result.metrics.criticalExpected = (c.critical ?? []).length;
  result.metrics.criticalDetected = (c.critical ?? []).filter(g => gapKeys.includes(g)).length;
  const blockingDelegated = preview.contextGaps.filter(g => g.blocking && g.expectedResolver !== 'USER');
  result.metrics.delegatedMaterialGaps = blockingDelegated.filter(g => preview.nextActions.some(a => a.relatedGapKeys.includes(g.gapKey))).length;
  result.metrics.delegatedMaterialExpected = blockingDelegated.length;
  result.pass = failures.length === 0;
  void json;
  return result;
}

const sum = (results, key) => results.reduce((total, r) => total + (r.metrics?.[key] ?? 0), 0);
const percentile = (values, q) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0; };

export function evaluateAll(cases) {
  const results = cases.map(c => evaluateCase(c));
  const accepted = results.filter(r => r.metrics.latencyMs || r.metrics.exception);
  const latencies = results.flatMap(r => r.metrics.latencyMs ?? []);
  const questions = sum(results, 'questions');
  const metrics = {
    cases: results.length, casesPassed: results.filter(r => r.pass).length, acceptedInputCases: accepted.length, rejectedInputCases: results.length - accepted.length,
    criticalGapsExpected: sum(results, 'criticalExpected'), criticalGapsDetected: sum(results, 'criticalDetected'),
    criticalGapsMissed: sum(results, 'criticalExpected') - sum(results, 'criticalDetected'),
    questionsAsked: questions, questionsPerScenarioMax: Math.max(0, ...results.map(r => r.metrics.questions ?? 0)), unnecessaryQuestions: sum(results, 'unnecessaryQuestions'),
    unnecessaryQuestionRate: questions ? sum(results, 'unnecessaryQuestions') / questions : 0, duplicateQuestions: sum(results, 'duplicateQuestions'),
    materialGapsDelegated: sum(results, 'delegatedMaterialGaps'), materialGapsNeedingDelegation: sum(results, 'delegatedMaterialExpected'),
    unsupportedKnownConclusions: sum(results, 'unsupportedKnown'), crossContamination: sum(results, 'contamination'), illegalAuthorityUpgrades: sum(results, 'illegalUpgrades'),
    uncitedDocumentedConclusions: sum(results, 'uncited'), forbiddenTextDisclosures: sum(results, 'disclosures'), crossPolicySummations: sum(results, 'summations'),
    unhandledExceptions: sum(results, 'exception'), determinismMismatches: sum(results, 'determinismMismatch'),
    latencyMs: { samples: latencies.length, median: Number(percentile(latencies, 0.5).toFixed(3)), p95: Number(percentile(latencies, 0.95).toFixed(3)), max: Number(Math.max(0, ...latencies).toFixed(3)) },
  };
  const thresholds = {
    unauthorizedDisclosures: metrics.forbiddenTextDisclosures === 0, unsupportedKnown: metrics.unsupportedKnownConclusions === 0, crossPolicySummations: metrics.crossPolicySummations === 0,
    crossMemberOrPolicyContamination: metrics.crossContamination === 0, illegalAuthorityUpgrades: metrics.illegalAuthorityUpgrades === 0, uncitedKnown: metrics.uncitedDocumentedConclusions === 0,
    unhandledExceptions: metrics.unhandledExceptions === 0, criticalGapsMissed: metrics.criticalGapsMissed === 0, duplicateQuestions: metrics.duplicateQuestions === 0,
    moreThanTwoQuestions: metrics.questionsPerScenarioMax <= 2, determinism: metrics.determinismMismatches === 0, unnecessaryQuestionRate: metrics.unnecessaryQuestionRate <= 0.1,
    goldenSuite: metrics.casesPassed === metrics.cases, minimumCases: metrics.cases >= 40,
  };
  return { metrics, thresholds, passed: Object.values(thresholds).every(Boolean), results: results.map(({ id, group, title, pass, failures }) => ({ id, group, title, pass, failures })) };
}
