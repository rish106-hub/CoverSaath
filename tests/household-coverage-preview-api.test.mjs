// WP8: the household coverage preview through the real application. Upload, OCR (mocked), clauses, Gemini (mocked),
// stored answers, consents, Block 3 catalogue, Block 4 preview. Synthetic data only; no provider call leaves the process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { assertHouseholdPreviewContract } from '../src/features/household-reasoning/index.js';
import { CatalogueReviewRepository } from '../src/backend/repositories/index.js';
import { createBackendServices, createHouseholdPreviewService } from '../src/backend/services/index.js';
import { makeBuilt, enrolled, sublimit, MEMBER_A } from './support/household-fixtures.mjs';
import { postgresTestOptions } from './support/pg.mjs';
import { NUMBERS, ask, household, preview, scenarioBody, startApp, tableCounts } from './support/household-api-harness.mjs';

const attest = { decision: 'accepted', reasonCode: 'matches_clause', attestedSourceType: 'issued_schedule', attestsPolicyAssociation: true };
const soon = () => new Date(Date.now() + 3_600_000).toISOString();
const sourceOf = (s, answerId) => ({ caseId: s.caseId, answerId });
const catalogueOf = (app, s, answerId) => app.call(`/api/v1/cases/${s.caseId}/decision-catalogue?answerId=${encodeURIComponent(answerId)}`, { token: s.token });

async function answerWith(app, s, documentIds) {
  const res = await ask(app, s, { documentIds });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  return res.data.answerId;
}

test('journey: authorised unreviewed evidence -> bounded preview -> follow-up answer -> updated preview, and nothing is written', postgresTestOptions(), async t => {
  const app = await startApp(t);
  const s = await household(app, { name: 'Mine' });
  const answerId = await answerWith(app, s, s.documentIds);
  const before = await tableCounts(app.database);

  const first = await preview(app, s.householdId, scenarioBody([sourceOf(s, answerId)], {
    scenarioType: 'planned_procedure', procedureText: 'My father needs cataract surgery next month at Healtworld Hospital.', topic: undefined, reportedMemberRelation: 'father',
    plannedMonth: '2026-11', reportedPolicyType: 'family', hospital: { name: 'Healtworld Hospital', city: 'Durgapur' },
  }), { token: s.token });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(assertHouseholdPreviewContract(first.data), true);
  const p = first.data;
  assert.equal(p.contractVersion, 'household-coverage-preview/v1');
  assert.equal(p.assessmentState, 'insufficient_evidence');
  assert.equal(p.policies.length, 1);
  assert.equal(p.policies[0].policyType.kind, 'unresolved');
  assert.deepEqual(p.policies[0].documentedTerms.concat(p.policies[0].documentedRestrictions), [], 'an unreviewed model reading is never a documented term');
  assert.deepEqual(p.nextQuestions.map(q => q.questionId), ['Q_MEMBER', 'Q_POLICY_SCHEDULE']);
  assert.equal(p.scenario.dateSemantics, 'month_only_not_an_exact_day');
  assert.ok(p.externalChecks.some(c => c.checkId === 'hospital_network_status' && c.status === 'not_performed'));
  for (const text of [JSON.stringify(p)]) {
    assert.ok(!NUMBERS.some(n => text.includes(n)), 'no printed policy number');
    assert.ok(!text.includes('Mine Owner Synthetic'), 'no household name');
    assert.ok(!text.includes(s.questionGrantId) && !text.includes(s.token) && !text.includes(s.adultId), 'no consent, session or adult identifier');
    assert.ok(!text.includes('500000') && !text.includes('Rs 5,000'), 'the unreviewed room rent value is not exposed');
  }
  assert.deepEqual(await tableCounts(app.database), before, 'a preview writes no row anywhere');

  // Follow-up: the member is chosen and the schedule question is answered. A fresh request, no stored conversation.
  const second = await preview(app, s.householdId, scenarioBody([sourceOf(s, answerId)], {
    scenarioType: 'planned_procedure', procedureText: 'cataract surgery', reportedMemberRelation: 'father', plannedMonth: '2026-11', hospital: { name: 'Healtworld Hospital', city: 'Durgapur' },
    memberId: s.memberId, answers: { policy_schedule_available: 'NO' },
  }), { token: s.token });
  assert.equal(second.status, 200, JSON.stringify(second.data));
  assert.ok(!second.data.nextQuestions.some(q => q.questionId === 'Q_POLICY_SCHEDULE' || q.questionId === 'Q_MEMBER'), 'answered questions are not repeated');
  assert.equal(second.data.scenario.memberId, s.memberId);
  assert.equal(second.data.scenario.answers.policy_schedule_available.provenance, 'user_reported');
  assert.equal(second.data.assessmentState, 'insufficient_evidence', 'a user answer upgrades nothing');
  assert.deepEqual(await tableCounts(app.database), before);
});

test('reviewed evidence flows through to a cited documented term, never as a total, and revocation removes it', postgresTestOptions(), async t => {
  const app = await startApp(t, { env: { CATALOGUE_INDEPENDENT_REVIEW_ENABLED: 'true' } });
  const s = await household(app, { name: 'Mine' });
  const reviewer = await household(app, { name: 'Reviewer' });
  await new CatalogueReviewRepository(app.database).grantIndependentReviewer({ householdId: s.householdId, adultUserId: reviewer.adultId, operatorId: 'test-operator', caseId: s.caseId, expiresAt: soon() });
  const answerId = await answerWith(app, s, s.documentIds);
  const built = await catalogueOf(app, s, answerId);
  const fact = built.data.catalogue.facts.find(f => f.factType === 'room_rent_limit');
  const reviewed = await app.call(`/api/v1/cases/${s.caseId}/decision-catalogue/reviews`, { method: 'POST', token: reviewer.token, headers: { 'Idempotency-Key': randomUUID() }, body: { answerId, factId: fact.factId, ...attest } });
  assert.equal(reviewed.status, 201, JSON.stringify(reviewed.data));

  const res = await preview(app, s.householdId, scenarioBody([sourceOf(s, answerId)], { memberId: s.memberId }), { token: s.token });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const [policy] = res.data.policies;
  const rent = policy.documentedRestrictions.find(r => r.rule === 'room_rent_limit');
  assert.deepEqual(rent.value, { kind: 'amount', amountMinor: 500000, currency: 'INR', basis: 'day' });
  assert.equal(rent.citations[0].documentId, s.documentIds[0]);
  assert.equal(rent.provenance, 'reviewed_contractual_evidence');
  assert.equal(policy.associationState, 'verified');
  assert.equal(policy.memberApplicability.state, 'unresolved', 'a policy-wide term does not prove the member is insured');
  assert.equal(res.data.assessmentState, 'conditional_evidence_summary');
  assert.ok(res.data.contextGaps.some(g => g.gapKey === 'membership_unestablished' && g.expectedResolver === 'DOCUMENT'));

  const revoked = await app.call(`/api/v1/consents/${s.questionGrantId}/revoke`, { method: 'POST', token: s.token, body: { reason: 'test' } });
  assert.ok([200, 201].includes(revoked.status));
  const after = await preview(app, s.householdId, scenarioBody([sourceOf(s, answerId)], { memberId: s.memberId }), { token: s.token });
  assert.equal(after.status, 404, 'revocation leaves no stale conclusion');
  assert.ok(!JSON.stringify(after.data).includes('500000'));
});

test('two distinct authorised answers: separate policies, separate limits, no sum, no invented coordination', postgresTestOptions(), async t => {
  const app = await startApp(t, { env: { CATALOGUE_INDEPENDENT_REVIEW_ENABLED: 'true' } });
  const s = await household(app, { name: 'Mine', documents: 2 });
  const reviewer = await household(app, { name: 'Reviewer' });
  await new CatalogueReviewRepository(app.database).grantIndependentReviewer({ householdId: s.householdId, adultUserId: reviewer.adultId, operatorId: 'test-operator', caseId: s.caseId, expiresAt: soon() });
  const answers = [await answerWith(app, s, [s.documentIds[0]]), await answerWith(app, s, [s.documentIds[1]])];
  for (const answerId of answers) {
    const built = await catalogueOf(app, s, answerId);
    const fact = built.data.catalogue.facts.find(f => f.factType === 'room_rent_limit');
    const r = await app.call(`/api/v1/cases/${s.caseId}/decision-catalogue/reviews`, { method: 'POST', token: reviewer.token, headers: { 'Idempotency-Key': randomUUID() }, body: { answerId, factId: fact.factId, ...attest } });
    assert.equal(r.status, 201, JSON.stringify(r.data));
  }
  const res = await preview(app, s.householdId, scenarioBody(answers.map(a => sourceOf(s, a)), { scenarioType: 'policy_comparison', memberId: s.memberId, plannedDate: '2026-11-14' }), { token: s.token });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.sourceSummary.usable, 2);
  assert.equal(res.data.policies.length, 2);
  const limits = res.data.policies.flatMap(p => p.documentedRestrictions.filter(r => r.rule === 'room_rent_limit').map(r => r.value.amountMinor)).sort();
  assert.deepEqual(limits, [500000, 800000]);
  assert.ok(!JSON.stringify(res.data).includes('1300000'));
  assert.equal(res.data.comparisons.possibleOverlap.length, 0, 'member enrolment is not evidenced in either policy');
  assert.ok(res.data.comparisons.unresolvedCoordination.some(u => u.code === 'coordination_not_established'));
  assert.equal(assertHouseholdPreviewContract(res.data), true);
});

test('protected failures: unauthenticated, foreign household, foreign case, foreign answer, foreign member, mixed sources', postgresTestOptions(), async t => {
  const app = await startApp(t);
  const mine = await household(app, { name: 'Mine' });
  const other = await household(app, { name: 'Other' });
  const mineAnswer = await answerWith(app, mine, mine.documentIds);
  const otherAnswer = await answerWith(app, other, other.documentIds);
  const ok = (sources, scenario = {}) => preview(app, mine.householdId, scenarioBody(sources, scenario), { token: mine.token });
  const baseline = await ok([sourceOf(mine, mineAnswer)]);
  assert.equal(baseline.status, 200);

  assert.equal((await preview(app, mine.householdId, scenarioBody([sourceOf(mine, mineAnswer)]), {})).status, 401);
  assert.equal((await preview(app, mine.householdId, scenarioBody([sourceOf(mine, mineAnswer)]), { token: 'x'.repeat(40) })).status, 401);

  const foreignHousehold = await preview(app, mine.householdId, scenarioBody([sourceOf(other, otherAnswer)]), { token: other.token });
  const unknownHousehold = await preview(app, 'household-does-not-exist', scenarioBody([sourceOf(mine, mineAnswer)]), { token: mine.token });
  assert.equal(foreignHousehold.status, 404);
  assert.deepEqual(foreignHousehold.data, unknownHousehold.data, 'a foreign household and an unknown one are indistinguishable');

  const foreignCase = await ok([sourceOf(other, otherAnswer)]);
  const unknownCase = await ok([{ caseId: 'case-does-not-exist', answerId: mineAnswer }]);
  assert.equal(foreignCase.status, 404);
  assert.deepEqual(foreignCase.data, unknownCase.data, 'a foreign case and an unknown one are indistinguishable');

  const foreignAnswer = await ok([{ caseId: mine.caseId, answerId: otherAnswer }]);
  const unknownAnswer = await ok([{ caseId: mine.caseId, answerId: 'answer-does-not-exist' }]);
  assert.equal(foreignAnswer.status, 404);
  assert.deepEqual(foreignAnswer.data, unknownAnswer.data, 'a foreign answer and an unknown one are indistinguishable');

  const mixed = await ok([sourceOf(mine, mineAnswer), sourceOf(other, otherAnswer)]);
  assert.equal(mixed.status, 404);
  assert.deepEqual(mixed.data, foreignCase.data, 'a mixed request fails whole and reveals nothing about the valid source');
  assert.ok(!JSON.stringify(mixed.data).includes('policies'), 'no partial result');

  const foreignMember = await ok([sourceOf(mine, mineAnswer)], { memberId: other.memberId });
  const unknownMember = await ok([sourceOf(mine, mineAnswer)], { memberId: 'member-does-not-exist' });
  assert.equal(foreignMember.status, 404);
  assert.deepEqual(foreignMember.data, unknownMember.data);
  assert.ok(!JSON.stringify([foreignHousehold.data, foreignCase.data, foreignAnswer.data, mixed.data, foreignMember.data]).includes(other.householdId));
});

test('malformed, oversized and forged bodies are refused with coded errors', postgresTestOptions(), async t => {
  const app = await startApp(t);
  const s = await household(app, { name: 'Mine' });
  const answerId = await answerWith(app, s, s.documentIds);
  const src = [sourceOf(s, answerId)];
  const post = body => preview(app, s.householdId, body, { token: s.token });
  const code = res => res.data?.error?.code;

  assert.equal(code(await post({ ...scenarioBody(src), contractVersion: 'household-scenario/v9' })), 'HOUSEHOLD_SCENARIO_VERSION_UNSUPPORTED');
  assert.equal(code(await post({ ...scenarioBody(src), handoff: { handoffVersion: 'decision-handoff/v1', policies: [] } })), 'HOUSEHOLD_SCENARIO_FORBIDDEN_FIELD', 'a client-supplied handoff is never authoritative');
  assert.equal(code(await post(scenarioBody(src, { reviewerRole: 'independent' }))), 'HOUSEHOLD_SCENARIO_FORBIDDEN_FIELD');
  assert.equal(code(await post(scenarioBody(src, { verified: true }))), 'HOUSEHOLD_SCENARIO_FORBIDDEN_FIELD');
  assert.equal(code(await post(scenarioBody([{ ...src[0], citations: [{ documentId: 'x' }] }]))), 'HOUSEHOLD_SCENARIO_FORBIDDEN_FIELD');
  assert.equal(code(await post(scenarioBody([...src, ...src]))), 'HOUSEHOLD_SCENARIO_DUPLICATE_SOURCE');
  assert.equal(code(await post(scenarioBody([]))), 'HOUSEHOLD_SCENARIO_INVALID');
  assert.equal(code(await post(scenarioBody(src, { plannedDate: '2026-02-30' }))), 'HOUSEHOLD_SCENARIO_INVALID');
  assert.equal(code(await post(scenarioBody(src, { plannedMonth: '2026-11', plannedDate: '2026-12-01' }))), 'HOUSEHOLD_SCENARIO_CONTRADICTORY');
  assert.equal(code(await post(scenarioBody(src, { hospital: { name: 'x'.repeat(161) } }))), 'HOUSEHOLD_SCENARIO_INVALID');
  assert.equal(code(await post(scenarioBody(src, { procedureText: 'a\u0000b' }))), 'HOUSEHOLD_SCENARIO_INVALID');
  assert.equal((await preview(app, s.householdId, null, { token: s.token, rawBody: '{ not json' })).status, 400);
  assert.equal((await preview(app, s.householdId, null, { token: s.token, rawBody: JSON.stringify(scenarioBody(src, { procedureText: 'x'.repeat(17_000) })) })).status, 413);
  for (const res of [await post({ ...scenarioBody(src), contractVersion: 'bad' })]) assert.ok(!JSON.stringify(res.data).includes('stack'));
});

test('consent expiry and document deletion: no stale conclusion is served', postgresTestOptions(), async t => {
  const app = await startApp(t);
  const s = await household(app, { name: 'Mine' });
  const answerId = await answerWith(app, s, s.documentIds);
  const ok = () => preview(app, s.householdId, scenarioBody([sourceOf(s, answerId)], { memberId: s.memberId }), { token: s.token });
  assert.equal((await ok()).status, 200);

  await app.database.prepare("UPDATE consent_grants SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(s.questionGrantId);
  const expired = await ok();
  assert.equal(expired.status, 403);
  assert.equal(expired.data.error.code, 'CONSENT_REQUIRED');
  assert.ok(!JSON.stringify(expired.data).includes('policies'));
});

test('a deleted document removes the evidence behind the answer', postgresTestOptions(), async t => {
  const app = await startApp(t);
  const s = await household(app, { name: 'Mine' });
  const answerId = await answerWith(app, s, s.documentIds);
  const deleted = await app.call(`/api/v1/documents/${s.documentIds[0]}`, { method: 'DELETE', token: s.token });
  assert.ok([200, 202, 204].includes(deleted.status), JSON.stringify(deleted.data));
  const res = await preview(app, s.householdId, scenarioBody([sourceOf(s, answerId)], { memberId: s.memberId }), { token: s.token });
  assert.equal(res.status, 404, 'deletion erases the derived answer, so nothing remains to revalidate');
  assert.equal(res.data.error.code, 'POLICY_EVIDENCE_NOT_FOUND');
  assert.ok(!JSON.stringify(res.data).includes('500000'));
});

test('a user with no role on the household cannot preview', postgresTestOptions(), async t => {
  const app = await startApp(t);
  const mine = await household(app, { name: 'Mine' });
  const outsider = await household(app, { name: 'Outsider' });
  const answerId = await answerWith(app, mine, mine.documentIds);
  const res = await preview(app, mine.householdId, scenarioBody([sourceOf(mine, answerId)]), { token: outsider.token });
  assert.equal(res.status, 404);
  assert.equal(res.data.error.code, 'HOUSEHOLD_NOT_FOUND');
});

test('the model never sees the scenario: no provider request is made by a preview', postgresTestOptions(), async t => {
  const app = await startApp(t);
  const s = await household(app, { name: 'Mine' });
  const answerId = await answerWith(app, s, s.documentIds);
  const calls = app.requests.length;
  const marker = 'ZZ-SCENARIO-MARKER-ZZ';
  const res = await preview(app, s.householdId, scenarioBody([sourceOf(s, answerId)], { procedureText: `cataract ${marker}`, hospital: { name: `${marker} Hospital` } }), { token: s.token });
  assert.equal(res.status, 200);
  assert.equal(app.requests.length, calls, 'no model call');
  assert.ok(app.requests.every(r => !r.prompt.includes(marker)));
});

// The adapter with the real access, household and case records but a scripted catalogue, to reach states the stored
// answers of a stub model cannot: a stale answer, a current handoff with reviewed facts, an unexpected failure.
function adapter(app, s, build, { authorize = () => {} } = {}) {
  const services = createBackendServices(app.database, { env: app.env });
  const service = createHouseholdPreviewService({ services, catalogue: { build } });
  const principal = { adultId: s.adultId };
  const call = (body, authorizeCase = authorize) => service.preview({ principal, householdId: s.householdId, body, authorizeCase });
  return { call, services };
}

test('adapter: the consent gate runs for every case before any source is read', postgresTestOptions(), async t => {
  const app = await startApp(t);
  const s = await household(app, { name: 'Mine' });
  const order = [];
  const { call } = adapter(app, s, () => { order.push('build'); throw new Error('must not be reached'); }, {});
  const refuse = () => { order.push('authorize'); throw Object.assign(new Error('Consent required.'), { code: 'CONSENT_REQUIRED', statusCode: 403 }); };
  await assert.rejects(() => call(scenarioBody([sourceOf(s, 'answer-1')], { memberId: s.memberId }), refuse), error => error.code === 'CONSENT_REQUIRED');
  assert.deepEqual(order, ['authorize'], 'a refused source is never built');
});

test('adapter: a stale answer becomes a revalidation request; other failures propagate unchanged', postgresTestOptions(), async t => {
  const app = await startApp(t);
  const s = await household(app, { name: 'Mine' });
  const stale = adapter(app, s, () => { throw Object.assign(new Error('changed'), { code: 'POLICY_EVIDENCE_ANSWER_STALE', statusCode: 409 }); });
  const result = await stale.call(scenarioBody([sourceOf(s, 'answer-1')], { memberId: s.memberId }));
  assert.equal(result.assessmentState, 'source_revalidation_required');
  assert.equal(result.sourceSummary.sources[0].reasonCode, 'answer_stale');
  assert.ok(result.nextActions.some(a => a.actionType === 'upload_document'));
  assert.deepEqual(result.policies, []);
  const broken = adapter(app, s, () => { throw Object.assign(new Error('provider down'), { code: 'EVIDENCE_DISABLED', statusCode: 503 }); });
  await assert.rejects(() => broken.call(scenarioBody([sourceOf(s, 'answer-1')])), error => error.code === 'EVIDENCE_DISABLED');
});

test('adapter: the member and date reach the catalogue exactly as supplied; a month is never turned into a day', postgresTestOptions(), async t => {
  const app = await startApp(t);
  const s = await household(app, { name: 'Mine' });
  const seen = [];
  const { call } = adapter(app, s, query => {
    seen.push({ asOf: query.asOf, memberId: query.memberId, independent: query.documentsUntil });
    return (makeBuilt({ memberId: query.memberId, asOf: query.asOf, policies: [{ id: 'P1', facts: [enrolled(query.memberId), sublimit('cataract', 3000000)] }] }));
  });
  await call(scenarioBody([sourceOf(s, 'a1')], { scenarioType: 'planned_procedure', procedureText: 'cataract surgery', memberId: s.memberId, plannedMonth: '2026-11' }));
  await call(scenarioBody([sourceOf(s, 'a1')], { scenarioType: 'planned_procedure', procedureText: 'cataract surgery', memberId: s.memberId, plannedMonth: '2026-11', answers: { exact_date: '2026-11-14' } }));
  assert.deepEqual(seen, [{ asOf: null, memberId: s.memberId, independent: undefined }, { asOf: '2026-11-14', memberId: s.memberId, independent: undefined }], 'the independent-reviewer exemption is never requested');
});

test('adapter: a handoff built for another scope or version is not used as evidence', postgresTestOptions(), async t => {
  const app = await startApp(t);
  const s = await household(app, { name: 'Mine' });
  const forged = adapter(app, s, () => (makeBuilt({ memberId: MEMBER_A, policies: [{ id: 'P1', facts: [enrolled(MEMBER_A), sublimit('cataract', 3000000)] }] })));
  const result = await forged.call(scenarioBody([sourceOf(s, 'a1')], { scenarioType: 'planned_procedure', procedureText: 'cataract surgery', memberId: s.memberId }));
  assert.equal(result.assessmentState, 'source_revalidation_required');
  assert.equal(result.sourceSummary.sources[0].reasonCode, 'scope_mismatch');
  assert.ok(!JSON.stringify(result).includes('3000000'));
  const stale = adapter(app, s, query => (makeBuilt({ memberId: query.memberId, pipelineCurrent: false, policies: [{ id: 'P1', facts: [enrolled(query.memberId)] }] })));
  assert.equal((await stale.call(scenarioBody([sourceOf(s, 'a1')], { memberId: s.memberId }))).sourceSummary.sources[0].reasonCode, 'processing_version_not_current');
});
