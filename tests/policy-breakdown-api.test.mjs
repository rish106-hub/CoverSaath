import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { openDatabase } from '../src/backend/database/index.js';
import { createApiServer } from '../src/server/server.js';
import { createEncryptedLocalByteStorage } from '../src/modules/document-intake/encrypted-local-storage.js';
import { createFixtureModelRunner } from '../src/modules/policy-breakdown/agents/model-runner.js';
import { PARAMETER_INDEX } from '../src/modules/policy-breakdown/sections/index.js';
import { loadSyntheticPack, createGoldResponder, buildSyntheticPdf, createFixturePageTextProvider, sha256 } from './fixtures/policy-breakdown/synthetic-pack.mjs';

const bootstrapToken = 'knowvia-test-bootstrap-token-00001';
const pack = loadSyntheticPack();
const pdf = await buildSyntheticPdf(pack);

async function start(t, { mutate = null, scanMode = 'structural_only' } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'knowvia-policy-api-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const database = openDatabase({ path: join(directory, 'knowvia.sqlite') });
  const storage = createEncryptedLocalByteStorage({ baseDirectory: join(directory, 'documents'), key: randomBytes(32) });
  const server = createApiServer({
    database,
    env: { KNOWVIA_BOOTSTRAP_TOKEN: bootstrapToken },
    policyBreakdownOverrides: {
      storage,
      scanMode,
      pageTextProvider: mode => {
        if (mode !== 'fixture') throw Object.assign(new Error('live OCR disabled in tests'), { code: 'SARVAM_NOT_CONFIGURED', statusCode: 503 });
        return createFixturePageTextProvider(new Map([[sha256(pdf), pack.pages]]));
      },
      modelRunner: mode => {
        if (mode !== 'fixture') throw Object.assign(new Error('live model disabled in tests'), { code: 'BREAKDOWN_AI_NOT_CONFIGURED', statusCode: 503 });
        return createFixtureModelRunner({ responder: createGoldResponder(pack, { mutate }) });
      },
    },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); try { database.close(); } catch {} });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = 'GET', body, idempotencyKey, token } = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: await response.json() };
  };
  return { call, database, server };
}

async function household(call, name = 'Kumar household') {
  const identity = await call('/api/v1/households', { method: 'POST', token: bootstrapToken, body: { displayName: name, owner: { displayName: 'Ram Kumar' } } });
  assert.equal(identity.status, 201);
  return { token: identity.data.session.token, householdId: identity.data.household.id, adultId: identity.data.owner.id };
}

async function consent(call, who, purpose, scopes) {
  const grant = await call('/api/v1/consents', { method: 'POST', token: who.token, body: { householdId: who.householdId, subjectAdultId: who.adultId, purpose, scopes } });
  assert.equal(grant.status, 201, JSON.stringify(grant.data));
  return grant.data.id;
}

async function upload(call, who, bytes = pdf, filename = 'policy-pack.pdf') {
  const documentConsent = await consent(call, who, 'document_processing', [{ resourceType: 'document', action: 'collect', dataCategory: 'insurance_document' }]);
  return call(`/api/v1/households/${who.householdId}/documents`, {
    method: 'POST', token: who.token,
    body: { consentGrantId: documentConsent, documentKind: 'policy_wording', filename, mimeType: 'application/pdf', contentBase64: bytes.toString('base64') },
  });
}

async function breakdown(call, who, documentId, key = 'breakdown-key-0001') {
  const recordConsent = await consent(call, who, 'coverage_reconstruction', [{ resourceType: 'policy', action: 'derive', dataCategory: 'insurance_document' }]);
  const created = await call(`/api/v1/households/${who.householdId}/policy-records`, {
    method: 'POST', token: who.token, idempotencyKey: key,
    body: { documentIds: [documentId], consentGrantId: recordConsent, executionMode: 'fixture' },
  });
  assert.equal(created.status, 202, JSON.stringify(created.data));
  let job;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    job = await call(`/api/v1/breakdown-jobs/${created.data.job.id}`, { token: who.token });
    if (['succeeded', 'failed'].includes(job.data.status)) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return { created, job: job.data, recordConsent };
}

test('policy breakdown runs end to end over HTTP: upload → 12 sections → review → ready → card → estimate', async t => {
  const { call } = await start(t);
  const ram = await household(call);
  for (const member of [
    { displayName: 'Sita Kumar', relationship: 'spouse', dateOfBirth: '1991-02-02' },
    { displayName: 'Luv Kumar', relationship: 'son', dateOfBirth: '2018-09-30' },
    { displayName: 'Kaushalya Devi', relationship: 'mother', dateOfBirth: '1962-07-21' },
  ]) assert.equal((await call(`/api/v1/households/${ram.householdId}/members`, { method: 'POST', token: ram.token, body: member })).status, 201);

  const uploaded = await upload(call, ram);
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.data));
  assert.equal(uploaded.data.accepted, true);
  assert.equal(uploaded.data.document.lifecycleState, 'active');
  assert.equal(uploaded.data.document.storageKey, undefined, 'storage key never leaves the server');
  const listed = await call(`/api/v1/households/${ram.householdId}/documents`, { token: ram.token });
  assert.equal(listed.data.documents.length, 1);

  const { created, job } = await breakdown(call, ram, uploaded.data.document.id);
  assert.equal(job.status, 'succeeded', JSON.stringify(job.error));
  assert.equal(job.steps.length, 11);
  assert.ok(job.steps.every(step => step.status === 'succeeded'));
  assert.equal(job.steps[0].metrics.pageCount, pack.pages.length);

  const recordId = created.data.record.id;
  const record = await call(`/api/v1/policy-records/${recordId}`, { token: ram.token });
  assert.equal(record.data.record.status, 'needs_review');
  assert.equal(record.data.record.insurerName, 'EXAMPLE GENERAL INSURANCE COMPANY LIMITED');
  assert.match(record.data.record.policyNumberMasked, /0123$/);
  assert.equal(record.data.sections.length, 12);

  const sections = await call(`/api/v1/policy-records/${recordId}/sections`, { token: ram.token });
  assert.equal(sections.data.sections.length, 12);
  const all = sections.data.sections.flatMap(section => section.parameters);
  assert.equal(all.length, PARAMETER_INDEX.size, 'every parameter of all 12 sections is present');
  assert.ok(all.every(parameter => ['Proven', 'Calculated', 'Reported', 'Dynamic', 'Unknown', 'Conflicting', 'NotPermitted'].includes(parameter.evidenceState)));
  const proven = all.filter(parameter => parameter.evidenceState === 'Proven');
  assert.ok(proven.length > 150);
  assert.ok(proven.every(parameter => parameter.citations.length > 0 && parameter.citations.every(citation => citation.matched)), 'Proven requires verified citations');
  const money = await call(`/api/v1/policy-records/${recordId}/sections/6`, { token: ram.token });
  const sumInsured = money.data.sections[0].parameters.find(parameter => parameter.key === 'sum_insured_amount');
  assert.deepEqual(sumInsured.value, { kind: 'money', amountMinor: 100000000, currency: 'INR' });
  assert.equal(sumInsured.verification.verifier, 'agrees');

  const blocked = await call(`/api/v1/policy-records/${recordId}/readiness`, { method: 'POST', token: ram.token });
  assert.equal(blocked.data.ready, false);
  assert.ok(blocked.data.blockers.some(blocker => blocker.code === 'CRITICAL_PARAMETER_UNREVIEWED'));

  const critical = all.filter(parameter => parameter.critical);
  for (const parameter of critical) {
    const memberOnly = parameter.memberVariants?.length && parameter.memberVariants.every(variant => variant.evidenceState === 'Proven');
    const action = parameter.value || memberOnly ? 'confirm' : 'mark_absent';
    const reviewed = await call(`/api/v1/policy-records/${recordId}/parameters/${parameter.key}/review`, { method: 'POST', token: ram.token, body: { action } });
    assert.equal(reviewed.status, 200, `${parameter.key}: ${JSON.stringify(reviewed.data)}`);
  }
  const ready = await call(`/api/v1/policy-records/${recordId}/readiness`, { method: 'POST', token: ram.token });
  assert.equal(ready.data.ready, true, JSON.stringify(ready.data.blockers));
  assert.equal(ready.data.recordStatus, 'ready');

  const card = await call(`/api/v1/policy-records/${recordId}/emergency-card`, { token: ram.token });
  assert.equal(card.status, 200);
  assert.equal(card.data.confirmedByPerson, true);
  assert.match(card.data.instruction.route, /No AI or voice agent/);
  assert.equal(card.data.policy.find(field => field.key === 'tpa_helpline').display, '1800-000-0000');
  const mother = card.data.members.find(member => member.displayName === 'Kaushalya Devi');
  assert.equal(mother.namedOnPolicy, true);
  assert.equal(mother.ageCopayPercent, 20);
  assert.ok(card.data.protectedFieldsWithheld > 0, 'protected fields never appear on the card');

  const members = (await call(`/api/v1/households/${ram.householdId}`, { token: ram.token })).data.members;
  const estimate = await call(`/api/v1/policy-records/${recordId}/estimates`, {
    method: 'POST', token: ram.token,
    body: {
      memberId: members.find(member => member.displayName === 'Kaushalya Devi').id,
      procedure: 'cataract', eyes: 1, hospital: { networkStatus: 'network', zone: 'zone_b' },
      room: { category: 'single_private_ac_room', ratePerDayMinor: 900000, days: 1 },
      billLines: [{ head: 'surgeon_fees', amountMinor: 3000000 }, { head: 'implants_devices', amountMinor: 2500000 }],
    },
  });
  assert.equal(estimate.status, 200, JSON.stringify(estimate.data));
  assert.equal(estimate.data.billTotalMinor, 6400000);
  assert.deepEqual(estimate.data.insurerPaysMinor, { low: 3200000, high: 3200000 }, 'cataract cap ₹40,000 then 20% age co-pay');
  assert.deepEqual(estimate.data.householdPaysMinor, { low: 3200000, high: 3200000 });
  assert.ok(estimate.data.steps.some(step => step.step === 'procedure_sublimit'));
  assert.match(estimate.data.boundaries[0], /not a claim decision/);

  const invalidEstimate = await call(`/api/v1/policy-records/${recordId}/estimates`, { method: 'POST', token: ram.token, body: { billLines: [{ head: 'gold_plating', amountMinor: 1 }] } });
  assert.equal(invalidEstimate.status, 400);

  // A correction without a citation is Reported and sends the record back to review.
  const corrected = await call(`/api/v1/policy-records/${recordId}/parameters/grace_period_days/review`, { method: 'POST', token: ram.token, body: { action: 'correct', value: { valueNumber: 15 }, note: 'Checked with insurer' } });
  assert.equal(corrected.data.parameter.evidenceState, 'Reported');
  const badCitation = await call(`/api/v1/policy-records/${recordId}/parameters/grace_period_days/review`, { method: 'POST', token: ram.token, body: { action: 'correct', value: { valueNumber: 15 }, citation: { documentId: uploaded.data.document.id, pageNumber: 1, quote: 'this sentence is not in the policy' } } });
  assert.equal(badCitation.status, 422);

  // Idempotency.
  const replay = await call(`/api/v1/households/${ram.householdId}/policy-records`, { method: 'POST', token: ram.token, idempotencyKey: 'breakdown-key-0001', body: { documentIds: [uploaded.data.document.id], consentGrantId: created.data.record.consentGrantId, executionMode: 'fixture' } });
  assert.equal(replay.status, 200);
  assert.equal(replay.data.job.id, created.data.job.id);
  const conflict = await call(`/api/v1/households/${ram.householdId}/policy-records`, { method: 'POST', token: ram.token, idempotencyKey: 'breakdown-key-0001', body: { documentIds: [uploaded.data.document.id], consentGrantId: created.data.record.consentGrantId, executionMode: 'live', modelPermission: true } });
  assert.equal(conflict.status, 403, 'live mode needs a share scope before idempotency is even considered');

  // Tenancy: another household cannot see or act on this record.
  const other = await household(call, 'Other household');
  for (const path of [`/api/v1/policy-records/${recordId}`, `/api/v1/policy-records/${recordId}/sections`, `/api/v1/policy-records/${recordId}/emergency-card`, `/api/v1/breakdown-jobs/${created.data.job.id}`]) {
    const denied = await call(path, { token: other.token });
    assert.equal(denied.status, 404, path);
  }
  assert.equal((await call(`/api/v1/households/${ram.householdId}/documents`, { token: other.token })).status, 404);
  assert.equal((await call(`/api/v1/policy-records/${recordId}`)).status, 401);

  // Revoking consent stops reads.
  await call(`/api/v1/consents/${created.data.record.consentGrantId}/revoke`, { method: 'POST', token: ram.token, body: { reason: 'test' } });
  const revoked = await call(`/api/v1/policy-records/${recordId}/sections`, { token: ram.token });
  assert.equal(revoked.status, 403);
  assert.equal(revoked.data.error.code, 'CONSENT_REVOKED');
});

test('live breakdown requires explicit model permission and a sharing scope', async t => {
  const { call } = await start(t);
  const ram = await household(call);
  const uploaded = await upload(call, ram);
  const derive = await consent(call, ram, 'coverage_reconstruction', [{ resourceType: 'policy', action: 'derive', dataCategory: 'insurance_document' }]);
  const noPermission = await call(`/api/v1/households/${ram.householdId}/policy-records`, { method: 'POST', token: ram.token, idempotencyKey: 'live-key-0001', body: { documentIds: [uploaded.data.document.id], consentGrantId: derive } });
  assert.equal(noPermission.status, 403);
  assert.equal(noPermission.data.error.code, 'MODEL_PERMISSION_REQUIRED');
  const noShare = await call(`/api/v1/households/${ram.householdId}/policy-records`, { method: 'POST', token: ram.token, idempotencyKey: 'live-key-0002', body: { documentIds: [uploaded.data.document.id], consentGrantId: derive, modelPermission: true } });
  assert.equal(noShare.status, 403);
  const share = await consent(call, ram, 'coverage_reconstruction', [
    { resourceType: 'policy', action: 'derive', dataCategory: 'insurance_document' },
    { resourceType: 'document', action: 'share', dataCategory: 'insurance_document' },
  ]);
  const unconfigured = await call(`/api/v1/households/${ram.householdId}/policy-records`, { method: 'POST', token: ram.token, idempotencyKey: 'live-key-0003', body: { documentIds: [uploaded.data.document.id], consentGrantId: share, modelPermission: true } });
  assert.equal(unconfigured.status, 503, 'fails closed without live keys');
  const missingKey = await call(`/api/v1/households/${ram.householdId}/policy-records`, { method: 'POST', token: ram.token, body: { documentIds: [uploaded.data.document.id], consentGrantId: share, executionMode: 'fixture' } });
  assert.equal(missingKey.status, 400);
  assert.equal(missingKey.data.error.code, 'IDEMPOTENCY_KEY_REQUIRED');
});

test('verifier disagreement and fabricated quotes never become Proven', async t => {
  const { call } = await start(t, {
    mutate: ({ sectionId, role, output }) => {
      if (sectionId === 'section-06-money' && role === 'verifier') {
        for (const item of output.parameters) if (item.key === 'sum_insured_amount') item.valueNumber = 500000;
      }
      if (sectionId === 'section-03-time' && role === 'extractor') {
        for (const item of output.parameters) if (item.key === 'grace_period_days') item.citations = [{ pageNumber: item.citations[0]?.pageNumber ?? 1, quote: 'Grace period of ninety days is allowed' }];
      }
      if (sectionId === 'section-08-claims' && role === 'extractor') throw Object.assign(new Error('provider timeout'), { code: 'BREAKDOWN_MODEL_CALL_FAILED' });
      return output;
    },
  });
  const ram = await household(call);
  const uploaded = await upload(call, ram);
  const { created, job } = await breakdown(call, ram, uploaded.data.document.id);
  assert.equal(job.status, 'failed');
  assert.equal(job.error.code, 'SECTIONS_FAILED');
  assert.equal(job.steps.find(step => step.id === 'extract:section-08-claims').status, 'failed');
  const sections = await call(`/api/v1/policy-records/${created.data.record.id}/sections`, { token: ram.token });
  const byKey = Object.fromEntries(sections.data.sections.flatMap(section => section.parameters).map(parameter => [parameter.key, parameter]));
  assert.equal(byKey.sum_insured_amount.evidenceState, 'Conflicting');
  assert.equal(byKey.sum_insured_amount.verification.verifier, 'disagrees');
  assert.equal(byKey.grace_period_days.evidenceState, 'Unknown');
  assert.equal(byKey.grace_period_days.stateReason, 'citation_not_found_in_page_text');
  assert.equal(byKey.reimbursement_submission_days.stateReason, 'section_agent_failed');
  const readiness = await call(`/api/v1/policy-records/${created.data.record.id}/readiness`, { method: 'POST', token: ram.token });
  assert.ok(readiness.data.blockers.some(blocker => blocker.code === 'BREAKDOWN_NOT_COMPLETE'));
  const resumed = await call(`/api/v1/breakdown-jobs/${created.data.job.id}/resume`, { method: 'POST', token: ram.token });
  assert.equal(resumed.status, 202);
});

test('uploads with active content are quarantined, not processed', async t => {
  const { call } = await start(t);
  const ram = await household(call);
  const document = await PDFDocument.create();
  document.addPage();
  document.catalog.set(PDFName.of('OpenAction'), document.context.obj({ S: PDFName.of('JavaScript'), JS: PDFString.of('app.alert(1)') }));
  const hostile = Buffer.from(await document.save());
  const uploaded = await upload(call, ram, hostile, 'hostile.pdf');
  assert.equal(uploaded.status, 201);
  assert.equal(uploaded.data.accepted, false);
  assert.equal(uploaded.data.document.lifecycleState, 'quarantined');
  assert.ok(uploaded.data.scan.findings.includes('JavaScript'));
  const notPdf = await call(`/api/v1/households/${ram.householdId}/documents`, { method: 'POST', token: ram.token, body: { consentGrantId: 'x', documentKind: 'policy_wording', filename: 'a.pdf', mimeType: 'application/pdf', contentBase64: Buffer.from('hello').toString('base64') } });
  assert.ok([403, 415].includes(notPdf.status));
});

test('review H1/M2: protected values are masked for other adults, and conflicts cannot be marked absent', async t => {
  const { createBackendServices } = await import('../src/backend/services/index.js');
  const { call, database } = await start(t, {
    mutate: ({ sectionId, role, output }) => {
      if (sectionId === 'section-06-money' && role === 'verifier') for (const item of output.parameters) if (item.key === 'sum_insured_amount') item.valueNumber = 500000;
      return output;
    },
  });
  const ram = await household(call);
  const uploaded = await upload(call, ram);
  const { created } = await breakdown(call, ram, uploaded.data.document.id);
  const recordId = created.data.record.id;

  const services = createBackendServices(database, { env: {} });
  const sita = services.households.createAdult({ displayName: 'Sita Kumar' });
  services.households.addRole({ householdId: ram.householdId, adultUserId: sita.id, role: 'member', status: 'active' });
  const sitaToken = services.auth.issueSession({ adultUserId: sita.id }).token;

  const ownerView = (await call(`/api/v1/policy-records/${recordId}/sections/2`, { token: ram.token })).data.sections[0].parameters;
  const otherView = (await call(`/api/v1/policy-records/${recordId}/sections/2`, { token: sitaToken })).data.sections[0].parameters;
  const ownerConditions = ownerView.find(parameter => parameter.key === 'member_specific_conditions');
  const otherConditions = otherView.find(parameter => parameter.key === 'member_specific_conditions');
  assert.ok(ownerConditions.memberVariants?.length || ownerConditions.value, 'owner sees the protected value');
  assert.equal(otherConditions.evidenceState, 'NotPermitted');
  const leaked = JSON.stringify(otherView.filter(parameter => parameter.visibility === 'protected'));
  assert.ok(!/hypertension/i.test(leaked), 'no protected text in any field, including verifier output');
  assert.deepEqual(Object.keys(otherConditions).sort(), ['citations', 'conditions', 'critical', 'evidenceState', 'exceptions', 'key', 'label', 'review', 'section', 'stateReason', 'value', 'valueType', 'visibility'].sort());
  const otherReview = await call(`/api/v1/policy-records/${recordId}/parameters/member_specific_conditions/review`, { method: 'POST', token: sitaToken, body: { action: 'confirm' } });
  assert.equal(otherReview.status, 403);

  const conflicting = await call(`/api/v1/policy-records/${recordId}/parameters/sum_insured_amount/review`, { method: 'POST', token: ram.token, body: { action: 'mark_absent' } });
  assert.equal(conflicting.status, 409);
  assert.equal(conflicting.data.error.code, 'CANNOT_MARK_ABSENT');
  const fixed = await call(`/api/v1/policy-records/${recordId}/parameters/sum_insured_amount/review`, { method: 'POST', token: ram.token, body: { action: 'correct', value: { valueNumber: 1000000 }, citation: { documentId: uploaded.data.document.id, pageNumber: created.data.record ? undefined : 1, quote: 'Base Sum Insured (Floater): Rs. 10,00,000/-' } } });
  assert.ok([200, 422].includes(fixed.status));
});

test('review M4: consent revoked mid-job stops further provider work', async t => {
  let revoke = () => {};
  const { call, database } = await start(t, {
    mutate: ({ sectionId, role, output }) => {
      if (sectionId === 'section-01-document-authority' && role === 'extractor') revoke();
      return output;
    },
  });
  const ram = await household(call);
  const uploaded = await upload(call, ram);
  const recordConsent = await consent(call, ram, 'coverage_reconstruction', [{ resourceType: 'policy', action: 'derive', dataCategory: 'insurance_document' }]);
  revoke = () => database.prepare('UPDATE consent_grants SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), recordConsent);
  const created = await call(`/api/v1/households/${ram.householdId}/policy-records`, { method: 'POST', token: ram.token, idempotencyKey: 'revoke-key-0001', body: { documentIds: [uploaded.data.document.id], consentGrantId: recordConsent, executionMode: 'fixture' } });
  assert.equal(created.status, 202);
  let job;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    job = await call(`/api/v1/breakdown-jobs/${created.data.job.id}`, { token: ram.token });
    if (['succeeded', 'failed'].includes(job.data.status)) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(job.data.status, 'failed');
  assert.ok(job.data.steps.some(step => step.errorCode === 'CONSENT_REVOKED'));
  const record = database.prepare('SELECT status FROM policy_records WHERE id = ?').get(created.data.record.id);
  assert.equal(record.status, 'revoked');
});

test('review M5: without an antivirus, live uploads stay quarantined', async t => {
  const { call } = await start(t, { scanMode: 'antivirus_required' });
  const ram = await household(call);
  const uploaded = await upload(call, ram);
  assert.equal(uploaded.status, 201);
  assert.equal(uploaded.data.accepted, false);
  assert.equal(uploaded.data.document.lifecycleState, 'quarantined');
  assert.match(uploaded.data.reason, /antivirus/i);
});

test('every policy write route denies another household', async t => {
  const { call } = await start(t);
  const ram = await household(call);
  const uploaded = await upload(call, ram);
  const { created } = await breakdown(call, ram, uploaded.data.document.id);
  const recordId = created.data.record.id;
  const other = await household(call, 'Other household');
  const attempts = [
    [`/api/v1/households/${ram.householdId}/members`, { displayName: 'Intruder' }],
    [`/api/v1/households/${ram.householdId}/documents`, { consentGrantId: 'x', documentKind: 'policy_wording', filename: 'a.pdf', mimeType: 'application/pdf', contentBase64: pdf.toString('base64') }],
    [`/api/v1/households/${ram.householdId}/policy-records`, { documentIds: [uploaded.data.document.id], consentGrantId: 'x', executionMode: 'fixture' }, 'other-key-0001'],
    [`/api/v1/policy-records/${recordId}/parameters/sum_insured_amount/review`, { action: 'confirm' }],
    [`/api/v1/policy-records/${recordId}/readiness`, {}],
    [`/api/v1/policy-records/${recordId}/estimates`, { billLines: [{ head: 'other', amountMinor: 100 }] }],
    [`/api/v1/policy-records/${recordId}/procedure-checks`, { admissionDate: '2026-11-01' }],
    [`/api/v1/breakdown-jobs/${created.data.job.id}/resume`, {}],
  ];
  for (const [path, body, idempotencyKey] of attempts) {
    const denied = await call(path, { method: 'POST', token: other.token, body, idempotencyKey });
    assert.equal(denied.status, 404, `${path} → ${denied.status} ${JSON.stringify(denied.data)}`);
  }
  assert.equal((await call(`/api/v1/households/${ram.householdId}/policy-records`, { token: other.token })).status, 404);
  assert.equal((await call(`/api/v1/policy-records/${recordId}/policy-status`, { token: other.token })).status, 404);
  assert.equal((await call(`/api/v1/households/${ram.householdId}/city`, { method: 'PATCH', token: other.token, body: { city: 'Pune' } })).status, 404);
  for (const [path, body] of attempts) assert.equal((await call(path, { method: 'POST', body })).status, 401, path);
});

test('procedure checks, policy status and household city work over HTTP', async t => {
  const { call, server } = await start(t);
  const ram = await household(call);
  const mother = await call(`/api/v1/households/${ram.householdId}/members`, { method: 'POST', token: ram.token, body: { displayName: 'Kaushalya Devi', relationship: 'mother', dateOfBirth: '1962-07-21' } });
  const uploaded = await upload(call, ram);
  const { created, job } = await breakdown(call, ram, uploaded.data.document.id);
  assert.equal(job.status, 'succeeded');
  const recordId = created.data.record.id;

  const checked = await call(`/api/v1/policy-records/${recordId}/procedure-checks`, { method: 'POST', token: ram.token, body: {
    memberId: mother.data.id, procedure: 'cataract', admissionDate: '2026-11-02', stayHours: 6, condition: { name: 'cataract', preExisting: false }, hospital: { networkStatus: 'network' },
  } });
  assert.equal(checked.status, 200, JSON.stringify(checked.data));
  assert.equal(checked.data.checks.find(check => check.id === 'specified_disease_wait').outcome, 'met');
  assert.ok(checked.data.steps.some(step => step.id === 'reimbursement'));
  assert.match(checked.data.verdictNote, /not a claim decision/);
  const invalid = await call(`/api/v1/policy-records/${recordId}/procedure-checks`, { method: 'POST', token: ram.token, body: { admissionDate: 'tomorrow' } });
  assert.equal(invalid.status, 400);

  const estimate = await call(`/api/v1/policy-records/${recordId}/estimates`, { method: 'POST', token: ram.token, body: { memberId: mother.data.id, procedure: 'cataract', admissionDate: '2026-11-02', hospital: { networkStatus: 'network', zone: 'zone_b' }, billLines: [{ head: 'surgeon_fees', amountMinor: 3000000 }] } });
  assert.equal(estimate.status, 200);
  assert.ok(estimate.data.eligibility.checks.length > 5, 'the estimate carries the eligibility checklist');

  const status = await call(`/api/v1/policy-records/${recordId}/policy-status`, { token: ram.token });
  assert.equal(status.status, 200);
  assert.ok(['in_force', 'not_started', 'grace_period', 'lapsed'].includes(status.data.state));
  assert.ok(status.data.groups.renewal.length > 0);

  const city = await call(`/api/v1/households/${ram.householdId}/city`, { method: 'PATCH', token: ram.token, body: { city: 'Pune' } });
  assert.equal(city.status, 200, JSON.stringify(city.data));
  assert.equal(city.data.city, 'Pune');
  const sections = await call(`/api/v1/policy-records/${recordId}/sections/10`, { token: ram.token });
  const network = sections.data.sections[0].parameters.find(parameter => parameter.key === 'network_hospitals_in_city');
  assert.equal(network.stateReason, 'no_city_disclosure_for_insurer', 'with a city set, the reason moves from city unknown to missing disclosure');
  assert.equal((await call(`/api/v1/households/${ram.householdId}/city`, { method: 'PATCH', token: ram.token, body: { city: '' } })).status, 400);
  for (const path of [`/api/v1/policy-records/${recordId}/procedure-checks`, `/api/v1/policy-records/${recordId}/estimates`]) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ram.token}` }, body: 'null' });
    assert.equal(response.status, 400, `${path} with a null body`);
  }
});
