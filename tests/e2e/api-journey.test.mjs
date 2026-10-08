// End-to-end API journey: the real API process and real pipeline talk over HTTP to fake Sarvam and fake Gemini.
// No provider keys, no spend, and a preload guard proves no traffic left the machine.
// Run: npm run test:e2e:api
import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { PARAMETER_INDEX } from '../../src/modules/policy-breakdown/sections/index.js';
import { startStack, syntheticPolicyPdf, bootstrapHousehold, FAMILY, uploadPolicy, startBreakdown, pollJob } from './helpers/stack.mjs';

const EVIDENCE = ['Proven', 'Calculated', 'Reported', 'Dynamic', 'Unknown', 'Conflicting', 'NotPermitted'];

async function withStack(t, options) {
  const stack = await startStack(options);
  t.after(() => stack.stop());
  const pdf = await syntheticPolicyPdf(stack.pack);
  const who = await bootstrapHousehold(stack);
  return { stack, pdf, who };
}

async function reviewAllCritical(stack, who, recordId) {
  const sections = await stack.call(`/api/v1/policy-records/${recordId}/sections`, { token: who.token });
  const all = sections.data.sections.flatMap(section => section.parameters);
  for (const parameter of all.filter(item => item.critical)) {
    const memberOnly = parameter.memberVariants?.length && parameter.memberVariants.every(variant => variant.evidenceState === 'Proven');
    const action = parameter.value || memberOnly ? 'confirm' : 'mark_absent';
    const reviewed = await stack.call(`/api/v1/policy-records/${recordId}/parameters/${parameter.key}/review`, { method: 'POST', token: who.token, body: { action } });
    assert.equal(reviewed.status, 200, `${parameter.key}: ${JSON.stringify(reviewed.data)}`);
  }
  return all;
}

test('full journey: bootstrap → family → consent → multi-chunk upload → live breakdown on fakes → review → ready → consumers', async t => {
  const { stack, pdf, who } = await withStack(t);
  const pageCount = (await PDFDocument.load(pdf)).getPageCount();
  assert.ok(pageCount > 10, `fixture PDF must exceed Sarvam's 10-page limit (has ${pageCount})`);

  for (const member of FAMILY) assert.equal((await stack.call(`/api/v1/households/${who.householdId}/members`, { method: 'POST', token: who.token, body: member })).status, 201);
  const uploaded = await uploadPolicy(stack, who, pdf);
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.data));
  assert.equal(uploaded.data.accepted, true);

  const { created } = await startBreakdown(stack, who, uploaded.data.document.id);
  assert.equal(created.status, 202, JSON.stringify(created.data));
  const job = await pollJob(stack, who, created.data.job.id);
  assert.equal(job.status, 'succeeded', JSON.stringify(job.error ?? job.steps?.filter(step => step.status === 'failed')));
  assert.equal(job.steps.length, 11);
  assert.ok(job.steps.every(step => step.status === 'succeeded'));
  assert.equal(job.steps[0].metrics.pageCount, pageCount);

  // Chunking: 25 pages → 3 Sarvam jobs of ≤10 pages, each created, polled and downloaded.
  const sarvam = stack.sarvam.stats();
  assert.equal(sarvam.creates, Math.ceil(pageCount / 10));
  assert.equal(sarvam.downloads, sarvam.creates);
  assert.ok(sarvam.statusPolls >= sarvam.creates, 'each job was polled');

  // Gemini: 9 extractors + a verifier for every section that has critical parameters, all keyed by section.
  const gemini = stack.gemini.stats();
  assert.equal(gemini.failed, 0);
  assert.ok(gemini.total >= 9 && gemini.total <= 18, `unexpected Gemini call count ${gemini.total}`);
  for (let section = 1; section <= 9; section += 1) assert.equal(gemini.bySection[`${section}:extractor`], 1, `section ${section} extractor ran exactly once`);

  // Costs are recorded from provider usage and stay inside the budget.
  assert.ok(job.spentUsd > 0, 'spend recorded');
  assert.ok(job.spentUsd < job.budgetUsd);
  assert.equal(job.budgetUsd, 5);
  const expectedUsd = stack.gemini.requests.reduce((sum, item) => sum + ((item.systemChars + item.promptChars) / 3.5 * 0.3) / 1e6, 0);
  assert.ok(job.spentUsd >= expectedUsd * 0.9, `spend ${job.spentUsd} reflects input tokens (≥ ${expectedUsd})`);

  const recordId = created.data.record.id;
  const record = await stack.call(`/api/v1/policy-records/${recordId}`, { token: who.token });
  assert.equal(record.data.record.status, 'needs_review');
  assert.equal(record.data.sections.length, 12);

  const sections = await stack.call(`/api/v1/policy-records/${recordId}/sections`, { token: who.token });
  const all = sections.data.sections.flatMap(section => section.parameters);
  assert.equal(all.length, PARAMETER_INDEX.size);
  assert.ok(all.every(parameter => EVIDENCE.includes(parameter.evidenceState)));
  const proven = all.filter(parameter => parameter.evidenceState === 'Proven');
  assert.ok(proven.length > 150, `proven count ${proven.length}`);
  assert.ok(proven.every(parameter => parameter.citations.length > 0 && parameter.citations.every(citation => citation.matched)), 'Proven requires citations matched against OCR page text');
  const sumInsured = all.find(parameter => parameter.key === 'sum_insured_amount');
  assert.deepEqual(sumInsured.value, { kind: 'money', amountMinor: 100000000, currency: 'INR' });

  const blocked = await stack.call(`/api/v1/policy-records/${recordId}/readiness`, { method: 'POST', token: who.token });
  assert.equal(blocked.data.ready, false);
  await reviewAllCritical(stack, who, recordId);
  const ready = await stack.call(`/api/v1/policy-records/${recordId}/readiness`, { method: 'POST', token: who.token });
  assert.equal(ready.data.ready, true, JSON.stringify(ready.data.blockers));
  assert.equal(ready.data.recordStatus, 'ready');

  const card = await stack.call(`/api/v1/policy-records/${recordId}/emergency-card`, { token: who.token });
  assert.equal(card.status, 200);
  assert.equal(card.data.confirmedByPerson, true);
  assert.equal(card.data.policy.find(field => field.key === 'tpa_helpline').display, '1800-000-0000');

  const members = (await stack.call(`/api/v1/households/${who.householdId}`, { token: who.token })).data.members;
  const mother = members.find(member => member.displayName === 'Kaushalya Devi');
  const estimateBody = {
    memberId: mother.id, procedure: 'cataract', eyes: 1, hospital: { networkStatus: 'network', zone: 'zone_b' },
    room: { category: 'single_private_ac_room', ratePerDayMinor: 900000, days: 1 },
    billLines: [{ head: 'surgeon_fees', amountMinor: 3000000 }, { head: 'implants_devices', amountMinor: 2500000 }],
  };
  const estimate = await stack.call(`/api/v1/policy-records/${recordId}/estimates`, { method: 'POST', token: who.token, body: estimateBody });
  assert.equal(estimate.status, 200, JSON.stringify(estimate.data));
  assert.equal(estimate.data.status, 'coverage_not_established');
  assert.deepEqual(estimate.data.insurerPaysMinor, { low: 0, high: 0 });
  assert.deepEqual(estimate.data.insurerPaysIfEligibleMinor, { low: 3200000, high: 3200000 });
  const check = await stack.call(`/api/v1/policy-records/${recordId}/procedure-checks`, { method: 'POST', token: who.token, body: { memberId: mother.id, procedure: 'cataract', eyes: 1 } });
  assert.equal(check.status, 200, JSON.stringify(check.data));
  assert.ok(['no_blocker_found', 'needs_confirmation', 'blocker_found'].includes(check.data.verdict));
  const status = await stack.call(`/api/v1/policy-records/${recordId}/policy-status`, { token: who.token });
  assert.equal(status.status, 200);
  assert.ok(['in_force', 'grace_period', 'lapsed', 'not_started', 'unknown'].includes(status.data.state));

  // Tenancy still holds through the live path.
  const other = await bootstrapHousehold(stack, 'Other household');
  assert.equal((await stack.call(`/api/v1/policy-records/${recordId}`, { token: other.token })).status, 404);

  // No real network egress: the guard saw nothing, and nothing but fakes answered.
  assert.deepEqual(stack.egressViolations(), []);
  assert.ok(sarvam.requests > 0 && gemini.total > 0);
});

test('Sarvam 429 on create and on download is retried with backoff and the job still succeeds', async t => {
  const { stack, pdf, who } = await withStack(t);
  stack.sarvam.setFailure({ stage: 'create', mode: '429', times: 1 });
  stack.sarvam.setFailure({ stage: 'download', mode: '500', times: 1 });
  const uploaded = await uploadPolicy(stack, who, pdf);
  const { created } = await startBreakdown(stack, who, uploaded.data.document.id);
  assert.equal(created.status, 202, JSON.stringify(created.data));
  const job = await pollJob(stack, who, created.data.job.id);
  assert.equal(job.status, 'succeeded', JSON.stringify(job.steps?.filter(step => step.status === 'failed')));
  assert.equal(stack.sarvam.stats().pendingFailures, 0, 'both injected failures were actually hit and recovered');
  assert.deepEqual(stack.egressViolations(), []);
});

test('Sarvam persistent failure fails the OCR step cleanly, then resume recovers', async t => {
  const { stack, pdf, who } = await withStack(t);
  stack.sarvam.setFailure({ stage: 'download', mode: 'malformed_zip', times: 1 });
  const uploaded = await uploadPolicy(stack, who, pdf);
  const { created } = await startBreakdown(stack, who, uploaded.data.document.id);
  const failed = await pollJob(stack, who, created.data.job.id);
  assert.equal(failed.status, 'failed');
  const ocr = failed.steps.find(step => step.id === 'ocr');
  assert.equal(ocr.status, 'failed');
  assert.equal(stack.gemini.stats().total, 0, 'no model spend when OCR fails');
  assert.equal(failed.spentUsd, 0);
  const resumed = await stack.call(`/api/v1/breakdown-jobs/${created.data.job.id}/resume`, { method: 'POST', token: who.token });
  assert.equal(resumed.status, 202, JSON.stringify(resumed.data));
  const job = await pollJob(stack, who, created.data.job.id);
  assert.equal(job.status, 'succeeded', JSON.stringify(job.steps?.filter(step => step.status === 'failed')));
});

test('Gemini timeout on one section → partial failure keeps other sections → resume retries only that section', async t => {
  const { stack, pdf, who } = await withStack(t, { env: { BREAKDOWN_TIMEOUT_MS: '1500' } });
  stack.gemini.setFailure({ mode: 'timeout', times: 1, section: 4, role: 'extractor' });
  const uploaded = await uploadPolicy(stack, who, pdf);
  const { created } = await startBreakdown(stack, who, uploaded.data.document.id);
  const failed = await pollJob(stack, who, created.data.job.id);
  assert.equal(failed.status, 'failed');
  const failedSteps = failed.steps.filter(step => step.status === 'failed');
  assert.deepEqual(failedSteps.map(step => step.section), [4]);
  assert.equal(failed.steps.filter(step => step.status === 'succeeded').length, 10, 'OCR, 8 sections and assembly kept');
  const recordId = created.data.record.id;
  const partial = await stack.call(`/api/v1/policy-records/${recordId}/sections/6`, { token: who.token });
  assert.equal(partial.status, 200, 'finished sections stay reviewable');
  const before = stack.gemini.stats().total;
  const resumed = await stack.call(`/api/v1/breakdown-jobs/${created.data.job.id}/resume`, { method: 'POST', token: who.token });
  assert.equal(resumed.status, 202);
  const job = await pollJob(stack, who, created.data.job.id);
  assert.equal(job.status, 'succeeded', JSON.stringify(job.steps?.filter(step => step.status === 'failed')));
  const retried = stack.gemini.requests.slice(before);
  assert.ok(retried.length >= 1 && retried.every(item => item.section === 4), `resume re-ran only section 4 (saw ${[...new Set(retried.map(item => item.section))]})`);
  assert.equal(stack.sarvam.stats().creates, Math.ceil(25 / 10), 'resume did not repeat OCR');
  assert.deepEqual(stack.egressViolations(), []);
});

test('Gemini unparseable output on one section fails that section (after one retry) without poisoning the record', async t => {
  const { stack, pdf, who } = await withStack(t);
  stack.gemini.setFailure({ mode: 'invalid_json', times: null, section: 2, role: 'extractor' });
  const uploaded = await uploadPolicy(stack, who, pdf);
  const { created } = await startBreakdown(stack, who, uploaded.data.document.id);
  const job = await pollJob(stack, who, created.data.job.id);
  assert.equal(job.status, 'failed');
  assert.deepEqual(job.steps.filter(step => step.status === 'failed').map(step => step.section), [2]);
  assert.ok(stack.gemini.requests.filter(item => item.section === 2 && item.role === 'extractor').length >= 2, 'the runner retried once on a parse failure');
});

test('Gemini output with unknown keys never produces Proven values for that section (assembly is the schema gate)', async t => {
  const { stack, pdf, who } = await withStack(t);
  stack.gemini.setFailure({ mode: 'schema_invalid', times: null, section: 2, role: 'extractor' });
  const uploaded = await uploadPolicy(stack, who, pdf);
  const { created } = await startBreakdown(stack, who, uploaded.data.document.id);
  const job = await pollJob(stack, who, created.data.job.id);
  const sections = await stack.call(`/api/v1/policy-records/${created.data.record.id}/sections/2`, { token: who.token });
  const parameters = sections.data.sections[0].parameters;
  assert.ok(parameters.length > 0);
  assert.ok(parameters.every(parameter => parameter.evidenceState !== 'Proven'), `job ${job.status}: junk output must not be Proven`);
});

test('exhausted job budget stops model calls before they are made (HTTP 402 semantics) and records no spend', async t => {
  const { stack, pdf, who } = await withStack(t, { env: { BREAKDOWN_JOB_BUDGET_USD: '0.0001' } });
  const uploaded = await uploadPolicy(stack, who, pdf);
  const { created } = await startBreakdown(stack, who, uploaded.data.document.id);
  assert.equal(created.status, 202);
  const job = await pollJob(stack, who, created.data.job.id);
  assert.equal(job.status, 'failed');
  const failedSteps = job.steps.filter(step => step.status === 'failed');
  assert.ok(failedSteps.length >= 1);
  assert.ok(failedSteps.every(step => step.errorCode === 'BREAKDOWN_BUDGET_EXHAUSTED'), JSON.stringify(failedSteps.map(step => step.errorCode)));
  assert.equal(stack.gemini.stats().total, 0, 'the budget gate fires before any paid call');
  assert.equal(job.spentUsd, 0);
});

test('egress guard blocks non-loopback fetch and sockets, and logs the attempt', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = mkdtempSync(join(tmpdir(), 'knowvia-egress-'));
  try {
    const log = join(directory, 'egress.log');
    const script = "const r=[];try{await fetch('https://example.com/')}catch(e){r.push(e.code)}try{await import('node:net').then(n=>new Promise((res,rej)=>{const s=n.connect(443,'example.com');s.on('error',rej);s.on('connect',res)}))}catch(e){r.push(e.code)}console.log(r.join())";
    const out = execFileSync(process.execPath, ['--import', new URL('./helpers/egress-guard.mjs', import.meta.url).pathname, '--input-type=module', '-e', script], { env: { PATH: process.env.PATH, E2E_EGRESS_LOG: log }, encoding: 'utf8' });
    assert.equal(out.trim(), 'E2E_EGRESS_BLOCKED,E2E_EGRESS_BLOCKED');
    assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 2);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('prompt contract: every call in a job shares an identical system + document prefix (cache-friendly)', async t => {
  const { stack, pdf, who } = await withStack(t);
  const uploaded = await uploadPolicy(stack, who, pdf);
  const { created } = await startBreakdown(stack, who, uploaded.data.document.id);
  await pollJob(stack, who, created.data.job.id);
  const calls = stack.gemini.requests;
  assert.ok(calls.length >= 9);
  assert.equal(new Set(calls.map(call => call.systemSha)).size, 1, 'system prompt is byte-identical for every agent and role');
  const documentBlock = call => call.prompt.slice(0, call.prompt.indexOf('<<<END OF DOCUMENT PAGES>>>'));
  assert.equal(new Set(calls.map(documentBlock)).size, 1, 'document pages block is byte-identical for every call in the job');
  assert.ok(documentBlock(calls[0]).includes('<<<PAGE 1 BEGIN'));
  const later = calls.slice(1);
  assert.ok(later.every(call => call.cachedContentTokenCount > 0), 'later calls reuse the shared prefix (fake models implicit caching by longest common prefix)');
  t.diagnostic(`cached tokens: ${stack.gemini.stats().cachedTokens}; calls: ${calls.length}`);
});
