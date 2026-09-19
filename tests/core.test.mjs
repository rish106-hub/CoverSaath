import test from 'node:test';
import assert from 'node:assert/strict';
import { createCase, runCase, approveQuestion, recordReply, reviewPurchase, simulatePayment, revokeConsent, validateFindings } from '../src/core/engine.js';
const input = { trigger: 'planned_care', patientName: 'Synthetic adult', procedure: 'Clinician-proposed therapy', hospital: 'Sample hospital', estimate: 500000, consent: true };

test('no consent exposes no policy results or outbound work', async () => {
  const direct = createCase({ ...input, consent: false });
  assert.equal(direct.input.patientName, ''); assert.equal(direct.input.procedure, ''); assert.equal(direct.input.estimate, 0);
  const record = await runCase(createCase({ ...input, consent: false }));
  assert.equal(record.status, 'blocked_consent'); assert.deepEqual(record.policies, []); assert.deepEqual(record.questions, []); assert.equal(record.brief, null);
  assert.throws(() => approveQuestion(record, 'q-tpa'), /consent/);
});
test('emergency gives immediate human route without buying gate', async () => {
  const record = await runCase(createCase({ ...input, trigger: 'emergency' }));
  assert.equal(record.status, 'human_handoff'); assert.match(record.brief.summary, /Admit first/); assert.equal(record.handoff.required, true);
  assert.throws(() => reviewPurchase(record, { decision: 'buy', householdApproved: true }), /Emergency/);
});
test('findings retain page/version citations and unknown cashless status', async () => {
  const record = await runCase(createCase(input));
  assert.ok(record.findings.every(finding => finding.sources.every(source => source.page && source.version)));
  assert.ok(record.policies.every(policy => policy.cashlessStatus === 'unknown')); assert.equal(record.brief.cashScenario.confirmedPayable, null);
  assert.equal(record.brief.cashScenario.possibleUpfront, 500000); assert.ok(record.reviews.every(review => review.iteration <= review.maxIterations));
  assert.equal(record.coverageGraph.kind, 'source_linked_household_coverage_graph');
  assert.equal(record.classification.score, null); assert.equal(record.classification.probabilityOfApproval, null);
  assert.equal(record.classification.route, 'collect_evidence_and_human_review');
});
test('all worker starts precede first completion and primary joins reviews', async () => {
  const record = await runCase(createCase(input));
  const workerEvents = record.trace.filter(event => event.role === 'worker');
  assert.deepEqual(workerEvents.slice(0, 3).map(event => event.status), ['started', 'started', 'started']);
  assert.equal(record.trace.at(-1).agent, 'primary-orchestrator'); assert.equal(record.reviews.length, 3);
});
test('sharing approval and replies cannot fabricate institutional approval', async () => {
  const record = await runCase(createCase(input));
  assert.throws(() => recordReply(record, 'q-tpa', 'Approved'), /Approve/);
  const approved = approveQuestion(record, 'q-tpa'); assert.equal(record.questions[2].status, 'draft');
  const replied = recordReply(approved, 'q-tpa', 'All claims approved');
  assert.equal(replied.questions[2].reply.bindingApproval, false); assert.equal(replied.policies[0].cashlessStatus, 'unknown');
  assert.equal(replied.brief.cashScenario.confirmedPayable, null);
});
test('buy requires completed review and explicit household approval; payment is not issuance', async () => {
  assert.throws(() => reviewPurchase(createCase(input), 'buy'), /reconstruction/);
  const record = await runCase(createCase(input)); assert.throws(() => simulatePayment(record), /approval/);
  assert.throws(() => simulatePayment(reviewPurchase(record, 'buy')), /approval/);
  const paid = simulatePayment(reviewPurchase(record, { decision: 'buy', householdApproved: true }));
  assert.equal(paid.purchase.paymentStatus, 'succeeded_demo'); assert.equal(paid.purchase.issuanceStatus, 'not_issued');
  assert.equal(simulatePayment(paid).trace.length, paid.trace.length);
  assert.equal(reviewPurchase(record, 'retain').purchase.status, 'retain_recorded_demo');
  assert.equal(reviewPurchase(record, 'defer').purchase.status, 'defer_recorded_demo');
});
test('revocation clears content and blocks subsequent processing', async () => {
  const record = revokeConsent(await runCase(createCase(input)));
  assert.equal(record.status, 'consent_revoked'); assert.deepEqual(record.policies, []); assert.deepEqual(record.questions, []); assert.equal(record.input.patientName, '');
  assert.equal(record.coverageGraph, null); assert.equal(record.classification, null);
  assert.throws(() => reviewPurchase(record, 'retain'), /consent/); assert.throws(() => recordReply(record, 'q-tpa', 'reply'), /consent/);
  assert.equal((await runCase(record)).status, 'consent_revoked');
});
test('validation rejects invalid trigger and estimate', () => {
  assert.throws(() => createCase({ ...input, trigger: 'unknown' }), /trigger/);
  assert.throws(() => createCase({ ...input, estimate: -1 }), /non-negative/);
});
test('repeated execution preserves approved questions replies and payment state', async () => {
  let record = await runCase(createCase(input));
  record = recordReply(approveQuestion(record, 'q-tpa'), 'q-tpa', 'Written synthetic response');
  record = simulatePayment(reviewPurchase(record, { decision: 'buy', householdApproved: true }));
  assert.deepEqual(await runCase(record), record);
});
test('review rejects agreement without evidence and citation mismatch', async () => {
  const record = await runCase(createCase(input));
  const findings = structuredClone(record.findings);
  findings[0].applicability = 'institution-confirmed'; findings[0].agreeingAgents = ['worker-one', 'worker-two'];
  assert.equal(validateFindings(findings, record.policies).pass, false);
  findings[0].applicability = 'unresolved'; findings[0].sources[0].page = 999;
  assert.equal(validateFindings(findings, record.policies).pass, false);
  findings[0] = structuredClone(record.findings[0]); findings[0].guaranteed = true;
  assert.equal(validateFindings(findings, record.policies).pass, false);
  findings[0] = structuredClone(record.findings[0]); findings[0].text = 'All claims will be paid';
  assert.equal(validateFindings(findings, record.policies).pass, false);
  assert.equal(validateFindings(record.findings, record.policies).pass, true);
});
