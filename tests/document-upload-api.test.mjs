import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { testTempRoot as tmpdir } from './support/temp-root.mjs';
import { openDatabase } from '../src/backend/database/index.js';
import { OcrRepository } from '../src/backend/repositories/index.js';
import { createApiServer } from '../src/server/server.js';

const bootstrapToken = 'coversaath-test-bootstrap-token-0001';

// Synthetic PDFs only. `marker` makes each document's bytes unique.
function syntheticPdf(marker = randomUUID(), { extraCatalog = '', trailerExtra = '' } = {}) {
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R ${extraCatalog} >>`,
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>',
  ];
  let body = `%PDF-1.7\n% synthetic ${marker}\n`;
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailerExtra} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

function environment(directory, extra = {}) {
  return {
    KNOWVIA_BOOTSTRAP_TOKEN: bootstrapToken,
    DOCUMENT_STORAGE_PATH: join(directory, 'documents'),
    DOCUMENT_ENCRYPTION_KEY_BASE64: randomBytes(32).toString('base64'),
    ...extra,
  };
}

async function start({ database, env, documentScanner, sarvamFetch }) {
  const server = createApiServer({ database, env, documentScanner, sarvamFetch });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = 'GET', body, token, headers = {} } = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: await response.json() };
  };
  const upload = async ({ token, caseId, grantId, bytes, key = randomUUID(), kind = 'policy_schedule', filename = 'synthetic-policy.pdf', contentType = 'application/pdf', headers = {} }) => {
    const response = await fetch(`${base}/api/v1/cases/${caseId}/documents`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': contentType,
        'Idempotency-Key': key,
        'X-Document-Kind': kind,
        'X-Consent-Grant-Id': grantId,
        'X-Filename': encodeURIComponent(filename),
        ...headers,
      },
      body: bytes,
    });
    return { status: response.status, data: await response.json() };
  };
  return { server, call, upload, stop: () => new Promise(resolve => server.close(resolve)) };
}

async function multiPagePdf(pageCount) {
  const document = await PDFDocument.create();
  for (let page = 1; page <= pageCount; page += 1) document.addPage([300 + page, 400 + page]);
  return Buffer.from(await document.save({ useObjectStreams: false }));
}

async function household(app, name) {
  const identity = await app.call('/api/v1/households', {
    method: 'POST', token: bootstrapToken,
    body: { displayName: `${name} household`, owner: { displayName: `${name} owner` } },
  });
  assert.equal(identity.status, 201);
  const token = identity.data.session.token;
  const householdId = identity.data.household.id;
  const adultId = identity.data.owner.id;
  const created = await app.call('/api/v1/cases', {
    method: 'POST', token,
    body: { householdId, subjectMemberId: identity.data.ownerMember.id, triggerType: 'planned_care' },
  });
  assert.equal(created.status, 201);
  const caseId = created.data.id;
  const grant = await app.call('/api/v1/consents', {
    method: 'POST', token,
    body: {
      householdId, subjectAdultId: adultId, purpose: 'document_processing',
      scopes: [
        { resourceType: 'document', action: 'collect', dataCategory: 'insurance_document' },
        { resourceType: 'case', resourceId: caseId, action: 'read', dataCategory: 'source_pack_metadata', recipient: adultId },
      ],
    },
  });
  assert.equal(grant.status, 201);
  return { token, householdId, adultId, caseId, grantId: grant.data.id };
}

async function householdActor(database, householdId, role, name) {
  const { createBackendServices } = await import('../src/backend/services/index.js');
  const services = createBackendServices(database);
  const adult = services.households.createAdult({ displayName: `${name} synthetic adult` });
  services.households.addMember({ householdId, adultUserId: adult.id, displayName: `${name} synthetic adult` });
  services.households.addRole({ householdId, adultUserId: adult.id, role });
  return { adultId: adult.id, token: services.auth.issueSession({ adultUserId: adult.id }).token };
}

function harness(t, extraEnv = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'coversaath-upload-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, 'app.sqlite');
  const env = environment(directory, extraEnv);
  return { directory, databasePath, env, storedFiles: () => (existsSync(env.DOCUMENT_STORAGE_PATH) ? readdirSync(env.DOCUMENT_STORAGE_PATH).filter(name => name.endsWith('.csd')) : []) };
}

async function eventually(check, { timeoutMs = 3000 } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error('Condition not met in time.');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

const cleanScanner = () => ({ mode: 'clamd', scans: 0, async scan() { this.scans += 1; return { status: 'clean' }; }, async ping() { return true; } });
const providerJson = (value, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  async text() { return JSON.stringify(value); },
});
const customClamdHost = process.env.CLAMD_CUSTOM_TEST_HOST;
const customClamdPort = process.env.CLAMD_CUSTOM_TEST_PORT || '3311';
const customClamdSkip = customClamdHost ? false : 'set CLAMD_CUSTOM_TEST_HOST to run against isolated test clamd';

test('Block 1 journey: five uploads persist across restart and stay inside the household', async t => {
  const h = harness(t);
  let database = openDatabase({ path: h.databasePath });
  let app = await start({ database, env: h.env });
  t.after(async () => { if (app.server.listening) await app.stop(); try { database.close(); } catch {} });

  const owner = await household(app, 'Synthetic');
  const other = await household(app, 'Other');
  const ids = [];
  for (let index = 0; index < 5; index += 1) {
    const result = await app.upload({ ...owner, bytes: syntheticPdf(`doc-${index}`), filename: `Synthetic Policy ${index}.pdf` });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    const document = result.data.document;
    assert.equal(document.status, 'received_pending_checks');
    assert.equal(document.statusLabel, 'Received, waiting for security checks');
    assert.equal(document.lifecycleState, 'quarantined');
    assert.equal(document.malwareStatus, 'pending');
    for (const forbidden of ['storageKey', 'storagePath', 'contentSha256', 'originalFilename', 'uploadedByAdultId', 'consentGrantId']) {
      assert.equal(forbidden in document, false, `${forbidden} must not be returned`);
    }
    ids.push(document.id);
  }

  // Bytes at rest are encrypted: no PDF header, no filename, one file per document.
  const files = h.storedFiles();
  assert.equal(files.length, 5);
  for (const file of files) {
    const raw = readFileSync(join(h.env.DOCUMENT_STORAGE_PATH, file));
    assert.equal(raw.includes(Buffer.from('%PDF')), false);
    assert.equal(raw.includes(Buffer.from('Synthetic Policy')), false);
  }

  // Audit: one counts-only event per upload, no filename or hash.
  const auditRows = database.prepare("SELECT event_payload_json FROM audit_events WHERE action = 'document.uploaded'").all();
  assert.equal(auditRows.length, 5);
  for (const row of auditRows) assert.doesNotMatch(row.event_payload_json, /Synthetic Policy|[0-9a-f]{64}|\.pdf/);

  // Restart: same documents, same household.
  await app.stop();
  database.close();
  database = openDatabase({ path: h.databasePath });
  app = await start({ database, env: h.env });
  const listed = await app.call(`/api/v1/cases/${owner.caseId}/documents`, { token: owner.token });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.data.documents.map(document => document.id).sort(), [...ids].sort());
  const single = await app.call(`/api/v1/documents/${ids[0]}`, { token: owner.token });
  assert.equal(single.status, 200);
  assert.equal(single.data.id, ids[0]);

  // Another household cannot list, read or upload into this case, and a foreign document id
  // gets the same answer as a missing one.
  const foreignList = await app.call(`/api/v1/cases/${owner.caseId}/documents`, { token: other.token });
  assert.equal(foreignList.status, 404);
  const foreignRead = await app.call(`/api/v1/documents/${ids[0]}`, { token: other.token });
  const missingRead = await app.call(`/api/v1/documents/${randomUUID()}`, { token: other.token });
  assert.equal(foreignRead.status, 404);
  assert.deepEqual(foreignRead.data, missingRead.data);
  assert.equal(foreignRead.data.error.code, 'DOCUMENT_NOT_FOUND');
  const foreignUpload = await app.upload({ ...other, caseId: owner.caseId, bytes: syntheticPdf('foreign') });
  assert.equal(foreignUpload.status, 404);
  // Using the other household's own grant against this case is refused too.
  const crossGrant = await app.upload({ ...owner, grantId: other.grantId, bytes: syntheticPdf('cross-grant') });
  assert.equal(crossGrant.status, 403);
  assert.equal(database.prepare('SELECT count(*) AS count FROM document_uploads').get().count, 5);
});

test('single-document deletion enforces household roles, hides foreign ids and is idempotent', async t => {
  const h = harness(t);
  const database = openDatabase({ path: h.databasePath });
  const app = await start({ database, env: h.env, documentScanner: cleanScanner() });
  t.after(async () => { await app.stop(); database.close(); });
  const owner = await household(app, 'Deletion');
  const other = await household(app, 'Deletion other');
  const member = await householdActor(database, owner.householdId, 'member', 'Member');
  const operator = await householdActor(database, owner.householdId, 'operator', 'Operator');
  const backupMember = await householdActor(database, owner.householdId, 'member', 'Backup member');
  const viewerUploader = await householdActor(database, owner.householdId, 'member', 'Viewer uploader');
  const viewerGrant = await app.call('/api/v1/consents', {
    method: 'POST', token: viewerUploader.token,
    body: {
      householdId: owner.householdId, subjectAdultId: viewerUploader.adultId, purpose: 'document_processing',
      scopes: [
        { resourceType: 'document', action: 'collect', dataCategory: 'insurance_document' },
        { resourceType: 'case', resourceId: owner.caseId, action: 'read', dataCategory: 'source_pack_metadata', recipient: viewerUploader.adultId },
      ],
    },
  });
  assert.equal(viewerGrant.status, 201);

  const memberTarget = await app.upload({ ...owner, bytes: syntheticPdf('member-target') });
  const operatorTarget = await app.upload({ ...owner, bytes: syntheticPdf('operator-target') });
  const backupTarget = await app.upload({ ...owner, bytes: syntheticPdf('backup-target') });
  const viewerTarget = await app.upload({
    token: viewerUploader.token, caseId: owner.caseId, grantId: viewerGrant.data.id,
    bytes: syntheticPdf('viewer-uploader-target'),
  });
  const memberId = memberTarget.data.document.id;
  const operatorId = operatorTarget.data.document.id;
  const backupId = backupTarget.data.document.id;
  const viewerId = viewerTarget.data.document.id;
  await eventually(() => [memberId, operatorId, backupId, viewerId].every(id =>
    database.prepare('SELECT lifecycle_state FROM document_uploads WHERE id = ?').get(id).lifecycle_state === 'active'));
  // The uploader later becomes a read-only viewer. Erasure remains their right.
  database.prepare("UPDATE household_roles SET status = 'revoked' WHERE household_id = ? AND adult_user_id = ? AND role = 'member'")
    .run(owner.householdId, viewerUploader.adultId);
  const { createBackendServices } = await import('../src/backend/services/index.js');
  const roleServices = createBackendServices(database);
  roleServices.households.addRole({ householdId: owner.householdId, adultUserId: viewerUploader.adultId, role: 'viewer' });
  roleServices.households.addRole({ householdId: owner.householdId, adultUserId: backupMember.adultId, role: 'backup_operator' });
  const at = new Date().toISOString();
  database.prepare(`INSERT INTO ocr_jobs
    (id, document_upload_id, provider, status, attempt_count, requested_at, completed_at,
     authorization_json, result_json, result_digest, updated_at)
    VALUES ('ocr-delete', ?, 'fixture', 'succeeded', 1, ?, ?, '{"allowed":true}',
      '{"text":"synthetic sensitive text"}', ?, ?)`).run(memberId, at, at, 'a'.repeat(64), at);
  database.prepare(`INSERT INTO source_pages
    (id, document_upload_id, ocr_job_id, page_number, source_version, page_sha256, extracted_text,
     extraction_status, confidence_basis_points, created_at, text_sha256, provider_page_ref, provenance_json)
    VALUES ('page-delete', ?, 'ocr-delete', 1, '1', ?, 'synthetic sensitive text', 'extracted',
      9000, ?, ?, 'provider-page', '{"source":"fixture"}')`).run(memberId, 'b'.repeat(64), at, 'c'.repeat(64));
  database.prepare(`INSERT INTO workflow_runs
    (id, case_id, workflow_name, workflow_version, execution_mode, status, input_digest, input_json,
     consent_grant_id, created_at)
    VALUES ('run-delete', ?, 'coverage-reconstruction', 'v2', 'fixture', 'completed', ?, ?, ?, ?)`)
    .run(owner.caseId, 'd'.repeat(64), JSON.stringify({
      authorizedSources: [{ documentId: memberId }],
      sourcePages: [{ documentId: memberId, sourceId: 'page-delete', version: '1', page: 1, text: 'synthetic sensitive text' }],
    }), owner.grantId, at);
  database.prepare(`INSERT INTO workflow_tasks
    (id, workflow_run_id, agent_name, task_kind, status, output_json, output_digest, created_at)
    VALUES ('task-delete', 'run-delete', 'fixture-agent', 'fixture-task', 'completed',
      '{"value":"synthetic sensitive output"}', ?, ?)`).run('e'.repeat(64), at);
  const ownerMemberId = database.prepare('SELECT id FROM household_members WHERE household_id = ? AND adult_user_id = ?')
    .get(owner.householdId, owner.adultId).id;
  database.prepare(`INSERT INTO policies
    (id, household_id, policy_kind, policy_number_masked, policy_version, starts_on, ends_on,
     source_document_id, verification_state, created_at, updated_at)
    VALUES ('policy-delete', ?, 'personal', '****1234', 'sensitive-version', '2026-01-01', '2026-12-31',
      ?, 'document_backed', ?, ?)`).run(owner.householdId, memberId, at, at);
  database.prepare(`INSERT INTO policy_members
    (policy_id, household_member_id, membership_state, member_reference_masked, source_page_id, created_at)
    VALUES ('policy-delete', ?, 'document_backed', 'member-secret', 'page-delete', ?)`)
    .run(ownerMemberId, at);
  database.prepare(`INSERT INTO coverage_graph_snapshots
    (id, household_id, case_id, version, status, graph_json, generated_by_run_id, created_at)
    VALUES ('graph-delete', ?, ?, 1, 'released', '{"sensitive":"graph payload"}', 'run-delete', ?)`)
    .run(owner.householdId, owner.caseId, at);
  database.prepare(`INSERT INTO coverage_graph_nodes
    (id, snapshot_id, node_type, entity_ref, label, epistemic_state, created_at)
    VALUES ('node-delete-a', 'graph-delete', 'policy', 'policy-delete', 'Sensitive policy label', 'known', ?),
      ('node-delete-b', 'graph-delete', 'protection', 'benefit-secret', 'Sensitive benefit label', 'known', ?)`)
    .run(at, at);
  database.prepare(`INSERT INTO coverage_graph_edges
    (id, snapshot_id, from_node_id, to_node_id, relationship, created_at)
    VALUES ('edge-delete', 'graph-delete', 'node-delete-a', 'node-delete-b', 'sensitive relationship', ?)`)
    .run(at);

  const missing = await app.call(`/api/v1/documents/${randomUUID()}`, { method: 'DELETE', token: other.token });
  const foreign = await app.call(`/api/v1/documents/${memberId}`, { method: 'DELETE', token: other.token });
  assert.equal(foreign.status, 404);
  assert.deepEqual(foreign.data, missing.data);
  assert.equal(foreign.data.error.code, 'DOCUMENT_NOT_FOUND');

  const denied = await app.call(`/api/v1/documents/${memberId}`, { method: 'DELETE', token: member.token });
  assert.equal(denied.status, 403);
  assert.equal(denied.data.error.code, 'DOCUMENT_DELETE_FORBIDDEN');
  assert.equal(database.prepare('SELECT lifecycle_state FROM document_uploads WHERE id = ?').get(memberId).lifecycle_state, 'active');
  const unrelatedGrant = await app.call('/api/v1/consents', {
    method: 'POST', token: member.token,
    body: {
      householdId: owner.householdId, subjectAdultId: member.adultId, purpose: 'document_processing',
      scopes: [{ resourceType: 'document', resourceId: memberId, action: 'derive', dataCategory: 'insurance_document' }],
    },
  });
  assert.equal(unrelatedGrant.status, 201);
  const unrelatedRevocation = await app.call(`/api/v1/consents/${unrelatedGrant.data.id}/revoke`, {
    method: 'POST', token: member.token, body: { reason: 'synthetic unrelated scope' },
  });
  assert.equal(unrelatedRevocation.status, 200);
  assert.equal(database.prepare('SELECT lifecycle_state FROM document_uploads WHERE id = ?').get(memberId).lifecycle_state,
    'active', 'revoking a later scope cannot bypass uploader-or-operator deletion authorization');
  const memberInventory = await app.call(`/api/v1/cases/${owner.caseId}/documents/deletion-inventory`, { token: member.token });
  assert.equal(memberInventory.status, 200);
  assert.deepEqual(memberInventory.data.documents, [], 'a member cannot enumerate another uploader\'s documents');

  const operated = await app.call(`/api/v1/documents/${operatorId}`, { method: 'DELETE', token: operator.token });
  assert.equal(operated.status, 202);
  assert.equal(operated.data.document.status, 'deletion_pending');
  const backupOperated = await app.call(`/api/v1/documents/${backupId}`, { method: 'DELETE', token: backupMember.token });
  assert.equal(backupOperated.status, 202, 'backup_operator wins even when the adult also has a member role');
  const viewerDeleted = await app.call(`/api/v1/documents/${viewerId}`, { method: 'DELETE', token: viewerUploader.token });
  assert.equal(viewerDeleted.status, 202, 'the original uploader can erase after becoming a viewer');

  // Erasure remains available after processing consent expires.
  database.prepare("UPDATE consent_grants SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(owner.grantId);
  const deletionInventory = await app.call(`/api/v1/cases/${owner.caseId}/documents/deletion-inventory`, { token: owner.token });
  assert.equal(deletionInventory.status, 200);
  assert.ok(deletionInventory.data.documents.some(document => document.id === memberId));
  for (const document of deletionInventory.data.documents) {
    assert.deepEqual(Object.keys(document).sort(), ['byteSize', 'documentKind', 'id', 'status', 'statusLabel', 'uploadedAt']);
  }
  const requested = await app.call(`/api/v1/documents/${memberId}`, { method: 'DELETE', token: owner.token });
  assert.equal(requested.status, 202);
  assert.equal(requested.data.document.status, 'deletion_pending');
  await eventually(() => database.prepare('SELECT lifecycle_state FROM document_uploads WHERE id = ?').get(memberId).lifecycle_state === 'deleted');
  const erasedOcr = database.prepare("SELECT status, authorization_json, result_json, result_digest FROM ocr_jobs WHERE id = 'ocr-delete'").get();
  assert.deepEqual({ ...erasedOcr }, { status: 'succeeded', authorization_json: null, result_json: null, result_digest: null });
  const erasedPage = database.prepare("SELECT extracted_text, confidence_basis_points, text_sha256, provider_page_ref, provenance_json FROM source_pages WHERE id = 'page-delete'").get();
  assert.deepEqual({ ...erasedPage }, { extracted_text: null, confidence_basis_points: null, text_sha256: null, provider_page_ref: null, provenance_json: null });
  const erasedInput = JSON.parse(database.prepare("SELECT input_json FROM workflow_runs WHERE id = 'run-delete'").get().input_json);
  assert.deepEqual(erasedInput.sourcePages, [{ documentId: memberId, sourceId: 'page-delete', version: '1', page: 1, redacted: 'document_erasure' }]);
  const erasedTask = database.prepare("SELECT status, terminal_reason, output_json, output_digest FROM workflow_tasks WHERE id = 'task-delete'").get();
  assert.deepEqual({ ...erasedTask }, { status: 'revoked', terminal_reason: 'DOCUMENT_DELETED', output_json: null, output_digest: null });
  const erasedPolicy = database.prepare(`SELECT policy_kind, policy_number_masked, policy_version, starts_on,
    ends_on, verification_state FROM policies WHERE id = 'policy-delete'`).get();
  assert.deepEqual({ ...erasedPolicy }, {
    policy_kind: 'unknown', policy_number_masked: null, policy_version: null, starts_on: null,
    ends_on: null, verification_state: 'unverified',
  });
  assert.equal(database.prepare("SELECT count(*) AS count FROM policy_members WHERE policy_id = 'policy-delete'").get().count, 0);
  assert.deepEqual({ ...database.prepare("SELECT status, graph_json FROM coverage_graph_snapshots WHERE id = 'graph-delete'").get() },
    { status: 'superseded', graph_json: '{}' });
  assert.equal(database.prepare("SELECT count(*) AS count FROM coverage_graph_nodes WHERE snapshot_id = 'graph-delete'").get().count, 0);
  assert.equal(database.prepare("SELECT count(*) AS count FROM coverage_graph_edges WHERE snapshot_id = 'graph-delete'").get().count, 0);
  const repeated = await app.call(`/api/v1/documents/${memberId}`, { method: 'DELETE', token: owner.token });
  assert.equal(repeated.status, 200);
  assert.equal(repeated.data.document.status, 'deleted');

  await eventually(() => [operatorId, backupId, viewerId].every(id =>
    database.prepare('SELECT lifecycle_state FROM document_uploads WHERE id = ?').get(id).lifecycle_state === 'deleted'));
  assert.equal(h.storedFiles().length, 0);
  const audits = database.prepare("SELECT event_payload_json FROM audit_events WHERE action = 'document.deletion_requested'").all();
  assert.equal(audits.length, 4);
  for (const audit of audits) assert.doesNotMatch(audit.event_payload_json, /\.pdf|[0-9a-f]{64}|storage|filename/i);
});

test('deletion is durably queued while storage is unconfigured and resumes after recovery', async t => {
  const h = harness(t);
  const database = openDatabase({ path: h.databasePath });
  let app = await start({ database, env: h.env });
  t.after(async () => { if (app.server.listening) await app.stop(); database.close(); });
  const owner = await household(app, 'Storage recovery');
  const uploaded = await app.upload({ ...owner, bytes: syntheticPdf('storage-recovery') });
  const id = uploaded.data.document.id;
  assert.equal(h.storedFiles().length, 1);

  await app.stop();
  app = await start({ database, env: { KNOWVIA_BOOTSTRAP_TOKEN: bootstrapToken } });
  const requested = await app.call(`/api/v1/documents/${id}`, { method: 'DELETE', token: owner.token });
  assert.equal(requested.status, 202);
  assert.equal(database.prepare('SELECT lifecycle_state FROM document_uploads WHERE id = ?').get(id).lifecycle_state, 'deletion_requested');
  assert.equal(h.storedFiles().length, 1, 'ciphertext remains until storage configuration recovers');

  await app.stop();
  app = await start({ database, env: h.env });
  await eventually(() => database.prepare('SELECT lifecycle_state FROM document_uploads WHERE id = ?').get(id).lifecycle_state === 'deleted');
  assert.equal(h.storedFiles().length, 0);
});

test('server-side validation rejects unsafe or invalid uploads before storing anything', async t => {
  const h = harness(t);
  const database = openDatabase({ path: h.databasePath });
  const app = await start({ database, env: h.env });
  t.after(async () => { await app.stop(); database.close(); });
  const owner = await household(app, 'Validation');

  const cases = [
    ['wrong media type', { contentType: 'application/octet-stream' }, 415, 'UNSUPPORTED_MEDIA_TYPE'],
    ['missing idempotency key', { key: 'short' }, 400, 'IDEMPOTENCY_KEY_REQUIRED'],
    ['unsupported kind', { kind: 'medical_record' }, 400, 'UNSUPPORTED_DOCUMENT_KIND'],
    ['not a PDF', { bytes: Buffer.from('plain text pretending to be a pdf') }, 400, 'MIME_MISMATCH'],
    ['wrong extension', { filename: 'policy.txt' }, 400, 'EXTENSION_MISMATCH'],
    ['empty body', { bytes: Buffer.alloc(0) }, 400, 'EMPTY_FILE'],
    ['password protected', { bytes: syntheticPdf('enc', { trailerExtra: '/Encrypt 9 0 R' }) }, 422, 'PDF_PASSWORD_REQUIRED'],
    ['javascript action', { bytes: syntheticPdf('js', { extraCatalog: '/OpenAction << /S /JavaScript /JS (app.alert(1)) >>' }) }, 422, 'PDF_ACTIVE_CONTENT'],
    ['launch action', { bytes: syntheticPdf('launch', { extraCatalog: '/OpenAction << /S /Launch /F (cmd.exe) >>' }) }, 422, 'PDF_ACTIVE_CONTENT'],
    ['missing consent', { grantId: 'consent-does-not-exist' }, 403, 'CONSENT_REQUIRED'],
  ];
  for (const [name, overrides, status, code] of cases) {
    const result = await app.upload({ ...owner, bytes: syntheticPdf(name), ...overrides });
    assert.equal(result.status, status, `${name}: ${JSON.stringify(result.data)}`);
    assert.equal(result.data.error.code, code, name);
  }

  // A declared Content-Length above the cap is refused before the body is read. The server answers
  // 413 and closes the connection, so a client still sending may see the socket drop instead.
  const tooLarge = await fetch(`http://127.0.0.1:${app.server.address().port}/api/v1/cases/${owner.caseId}/documents`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${owner.token}`, 'Content-Type': 'application/pdf', 'Idempotency-Key': randomUUID(),
      'X-Document-Kind': 'policy_schedule', 'X-Consent-Grant-Id': owner.grantId, 'X-Filename': 'big.pdf',
    },
    body: Buffer.alloc(15 * 1024 * 1024 + 1, 0x20),
  }).catch(error => ({ dropped: ['EPIPE', 'ECONNRESET'].includes(error?.cause?.code), error }));
  if (tooLarge.dropped === undefined) {
    assert.equal(tooLarge.status, 413);
    assert.equal(tooLarge.headers.get('connection'), 'close');
    assert.equal((await tooLarge.json()).error.code, 'REQUEST_TOO_LARGE');
  } else {
    assert.equal(tooLarge.dropped, true, String(tooLarge.error));
  }

  // Unauthenticated callers never reach validation.
  const anonymous = await app.upload({ ...owner, token: 'not-a-session' });
  assert.equal(anonymous.status, 401);

  assert.equal(database.prepare('SELECT count(*) AS count FROM document_uploads').get().count, 0);
  assert.equal(h.storedFiles().length, 0);
});

test('uploads are idempotent and duplicates within a household are refused', async t => {
  const h = harness(t);
  const database = openDatabase({ path: h.databasePath });
  const app = await start({ database, env: h.env });
  t.after(async () => { await app.stop(); database.close(); });
  const owner = await household(app, 'Idempotent');
  const other = await household(app, 'Neighbour');
  const bytes = syntheticPdf('same-bytes');
  const key = randomUUID();

  const first = await app.upload({ ...owner, bytes, key });
  assert.equal(first.status, 201);
  const replay = await app.upload({ ...owner, bytes, key });
  assert.equal(replay.status, 200);
  assert.equal(replay.data.idempotentReplay, true);
  assert.equal(replay.data.document.id, first.data.document.id);

  const conflict = await app.upload({ ...owner, bytes: syntheticPdf('different'), key });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.error.code, 'IDEMPOTENCY_CONFLICT');

  const duplicate = await app.upload({ ...owner, bytes });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.data.error.code, 'DUPLICATE_DOCUMENT');

  // The same bytes in another household are stored separately with separate ownership.
  const neighbour = await app.upload({ ...other, bytes });
  assert.equal(neighbour.status, 201);
  assert.notEqual(neighbour.data.document.id, first.data.document.id);

  // Concurrent retries with one key create exactly one document.
  const raceKey = randomUUID();
  const raceBytes = syntheticPdf('race');
  const results = await Promise.all(Array.from({ length: 5 }, () => app.upload({ ...owner, bytes: raceBytes, key: raceKey })));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 200, 200, 200, 201]);
  assert.equal(new Set(results.map(result => result.data.document.id)).size, 1);
  assert.equal(database.prepare('SELECT count(*) AS count FROM document_uploads').get().count, 3);
  assert.equal(h.storedFiles().length, 3);
});

test('a clean scan activates the document for the Block 2 handoff; without a scanner it stays quarantined', async t => {
  const h = harness(t);
  const database = openDatabase({ path: h.databasePath });
  const scanner = cleanScanner();
  const app = await start({ database, env: h.env, documentScanner: scanner });
  t.after(async () => { await app.stop(); database.close(); });
  const owner = await household(app, 'Clean');

  const uploaded = await app.upload({ ...owner, bytes: syntheticPdf('clean') });
  assert.equal(uploaded.status, 201);
  const accepted = await eventually(async () => {
    const result = await app.call(`/api/v1/documents/${uploaded.data.document.id}`, { token: owner.token });
    return result.data.status === 'accepted' ? result.data : null;
  });
  assert.equal(accepted.lifecycleState, 'active');
  assert.equal(accepted.malwareStatus, 'clean');
  assert.equal(scanner.scans, 1);
  const ready = new OcrRepository(database).getReadyDocument(uploaded.data.document.id, new Date().toISOString());
  assert.equal(ready.documentId, uploaded.data.document.id);
  assert.ok(database.prepare("SELECT 1 FROM audit_events WHERE action = 'document.scan_clean'").get());

  // No scanner configured: the document is never activated.
  const h2 = harness(t);
  const database2 = openDatabase({ path: h2.databasePath });
  const app2 = await start({ database: database2, env: h2.env });
  t.after(async () => { await app2.stop(); database2.close(); });
  const owner2 = await household(app2, 'Unscanned');
  const pending = await app2.upload({ ...owner2, bytes: syntheticPdf('unscanned') });
  await new Promise(resolve => setTimeout(resolve, 150));
  const still = await app2.call(`/api/v1/documents/${pending.data.document.id}`, { token: owner2.token });
  assert.equal(still.data.status, 'received_pending_checks');
  assert.equal(new OcrRepository(database2).getReadyDocument(pending.data.document.id, new Date().toISOString()), null);
});

test('Block 1 to Block 2 journey splits 11 pages, uses Sarvam consent and persists ordered safe output', async t => {
  const h = harness(t, {
    SARVAM_OCR_ENABLED: 'true', SARVAM_API_KEY: 'test-only',
    SARVAM_OCR_RETRY_DELAY_MS: '0',
    SARVAM_OCR_POLL_INTERVAL_MS: '0',
  });
  const database = openDatabase({ path: h.databasePath });
  let submissions = 0;
  const sarvamFetch = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/digitise')) {
      submissions += 1;
      assert.equal(options.headers['api-subscription-key'], 'test-only');
      assert.equal(options.body.get('language'), 'hi-IN');
      assert.equal(options.body.get('output_format'), 'json');
      assert.equal(options.body.get('content_type'), 'mixed');
      return providerJson({ job_id: `e2e-job-${submissions}`, status: 'pending' }, 201);
    }
    const jobId = parsed.pathname.split('/').at(-2);
    if (parsed.pathname.endsWith('/status')) return providerJson({ job_id: jobId, status: 'completed' });
    if (parsed.pathname.endsWith('/results')) {
      const count = jobId === 'e2e-job-1' ? 10 : 1;
      return providerJson({
        type: 'digitise', job_id: jobId, status: 'completed',
        usage: { pages_total: count, pages_processed: count, pages_succeeded: count, pages_failed: 0, provider_secret: 'do-not-store' },
        documents: [{ pages: Array.from({ length: count }, (_, index) => ({ page_num: index + 1, blocks: [{ block_id: `b${index + 1}`, text: `Page ${index + 1} from ${jobId}`, layout_tag: 'paragraph', reading_order: 1 }] })) }],
      });
    }
    throw new Error(`Unexpected provider request: ${url}`);
  };
  const app = await start({ database, env: h.env, documentScanner: cleanScanner(), sarvamFetch });
  t.after(async () => { await app.stop(); database.close(); });
  const owner = await household(app, 'OCR journey');
  const uploaded = await app.upload({ ...owner, bytes: await multiPagePdf(11), filename: 'synthetic-11-page.pdf' });
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.data));
  const documentId = uploaded.data.document.id;
  await eventually(() => database.prepare(`SELECT 1 FROM document_uploads
    WHERE id = ? AND lifecycle_state = 'active' AND malware_status = 'clean'`).get(documentId));
  const disclosure = await app.call('/api/v1/consents', {
    method: 'POST', token: owner.token,
    body: {
      householdId: owner.householdId, subjectAdultId: owner.adultId,
      grantedToActor: 'sarvam', purpose: 'document_processing',
      scopes: [{
        resourceType: 'document', resourceId: documentId, action: 'derive',
        dataCategory: 'insurance_document', recipient: 'sarvam',
      }],
    },
  });
  assert.equal(disclosure.status, 201, JSON.stringify(disclosure.data));
  const started = await app.call(`/api/v1/documents/${documentId}/ocr-jobs`, {
    method: 'POST', token: owner.token,
    body: { consentGrantId: disclosure.data.id, language: 'hi-IN', contentType: 'mixed' },
  });
  assert.equal(started.status, 202, JSON.stringify(started.data));
  assert.equal(started.data.job.status, 'submitted');
  assert.equal(submissions, 2);
  const refreshed = await app.call(`/api/v1/ocr-jobs/${started.data.job.id}/refresh`, {
    method: 'POST', token: owner.token, body: { consentGrantId: disclosure.data.id },
  });
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.data));
  assert.equal(refreshed.data.job.status, 'succeeded');
  assert.equal(refreshed.data.job.pageCount, 11);
  assert.deepEqual(database.prepare(`SELECT page_number FROM source_pages
    WHERE document_upload_id = ? ORDER BY page_number`).all(documentId).map(row => row.page_number),
  Array.from({ length: 11 }, (_, index) => index + 1));
  assert.equal(JSON.stringify(database.prepare('SELECT * FROM ocr_jobs WHERE id = ?').get(started.data.job.id)).includes('do-not-store'), false);
  const ocrAudit = database.prepare(`SELECT action, event_payload_json FROM audit_events
    WHERE resource_type = 'ocr_job' AND resource_id = ? ORDER BY id`).all(started.data.job.id);
  assert.deepEqual(ocrAudit.map(event => event.action), [
    'ocr.job_created', 'ocr.job_status_changed', 'ocr.job_succeeded',
  ]);
  assert.equal(JSON.stringify(ocrAudit).includes('do-not-store'), false);
  assert.equal(JSON.stringify(ocrAudit).includes('e2e-job-'), false);
  assert.equal(JSON.stringify(ocrAudit).includes('Page 1 from'), false);

  const repeated = await app.call(`/api/v1/documents/${documentId}/ocr-jobs`, {
    method: 'POST', token: owner.token,
    body: { consentGrantId: disclosure.data.id, language: 'hi-IN', contentType: 'mixed' },
  });
  assert.equal(repeated.status, 200);
  assert.equal(repeated.data.job.id, started.data.job.id);
  assert.equal(submissions, 2);
});

test('disabling Sarvam never blocks local document deletion when remote cancellation is unavailable', async t => {
  const h = harness(t, { SARVAM_OCR_ENABLED: 'false' });
  const database = openDatabase({ path: h.databasePath });
  const app = await start({ database, env: h.env, documentScanner: cleanScanner() });
  t.after(async () => { await app.stop(); database.close(); });
  const owner = await household(app, 'Disabled OCR deletion');
  const uploaded = await app.upload({ ...owner, bytes: await multiPagePdf(1) });
  const documentId = uploaded.data.document.id;
  await eventually(() => database.prepare(`SELECT 1 FROM document_uploads
    WHERE id = ? AND lifecycle_state = 'active'`).get(documentId));
  const at = new Date().toISOString();
  database.prepare(`INSERT INTO ocr_jobs
    (id, document_upload_id, provider, provider_job_ref, status, attempt_count, contract_version,
     authorization_json, requested_at, started_at, updated_at)
    VALUES ('ocr-disabled-delete', ?, 'sarvam', 'retained-provider-job', 'submitted', 1,
      'knowvia.ocr.v1', '{}', ?, ?, ?)`)
    .run(documentId, at, at, at);

  const requested = await app.call(`/api/v1/documents/${documentId}`, { method: 'DELETE', token: owner.token });
  assert.equal(requested.status, 202);
  await eventually(() => database.prepare(`SELECT 1 FROM document_uploads
    WHERE id = ? AND lifecycle_state = 'deleted'`).get(documentId));
  assert.deepEqual({ ...database.prepare(`SELECT status, provider_job_ref, error_code
    FROM ocr_jobs WHERE id = 'ocr-disabled-delete'`).get() }, {
    status: 'cancelled', provider_job_ref: 'retained-provider-job',
    error_code: 'OCR_PROVIDER_CANCELLATION_UNSUPPORTED',
  });
  assert.equal(h.storedFiles().length, 0);
});

test('a malware hit rejects the document and deletes its bytes; revocation deletes bytes too', async t => {
  const h = harness(t);
  const database = openDatabase({ path: h.databasePath });
  const scanner = { mode: 'clamd', async scan() { return { status: 'blocked', signature: 'Synthetic.Test.Signature' }; }, async ping() { return true; } };
  const app = await start({ database, env: h.env, documentScanner: scanner });
  t.after(async () => { await app.stop(); database.close(); });
  const owner = await household(app, 'Infected');

  const uploaded = await app.upload({ ...owner, bytes: syntheticPdf('infected') });
  assert.equal(uploaded.status, 201);
  const id = uploaded.data.document.id;
  await eventually(() => database.prepare("SELECT 1 FROM document_uploads WHERE id = ? AND lifecycle_state = 'deleted'").get(id));
  const row = database.prepare('SELECT malware_status, original_filename FROM document_uploads WHERE id = ?').get(id);
  assert.equal(row.malware_status, 'blocked');
  assert.equal(row.original_filename, '[deleted]');
  assert.equal(h.storedFiles().length, 0);
  const listed = await app.call(`/api/v1/cases/${owner.caseId}/documents`, { token: owner.token });
  assert.equal(listed.data.documents.length, 0);
  const blockedAudit = database.prepare("SELECT event_payload_json FROM audit_events WHERE action = 'document.scan_blocked'").get();
  assert.match(blockedAudit.event_payload_json, /MALWARE_DETECTED/);

  // Revocation: the existing path marks the document deletion_requested; the worker removes bytes.
  const h2 = harness(t, { DOCUMENT_WORKER_SWEEP_MS: '100' });
  const database2 = openDatabase({ path: h2.databasePath });
  const app2 = await start({ database: database2, env: h2.env });
  t.after(async () => { await app2.stop(); database2.close(); });
  const owner2 = await household(app2, 'Revoking');
  const kept = await app2.upload({ ...owner2, bytes: syntheticPdf('revoked') });
  assert.equal(h2.storedFiles().length, 1);
  const revoked = await app2.call(`/api/v1/consents/${owner2.grantId}/revoke`, {
    method: 'POST', token: owner2.token, body: { revokedByAdultId: owner2.adultId, reason: 'Synthetic revocation' },
  });
  assert.equal(revoked.status, 200);
  await eventually(() => database2.prepare("SELECT 1 FROM document_uploads WHERE id = ? AND lifecycle_state = 'deleted'").get(kept.data.document.id), { timeoutMs: 5_000 });
  assert.equal(h2.storedFiles().length, 0);
});

test('real clamd blocks a valid synthetic PDF through the authenticated upload API', { skip: customClamdSkip }, async t => {
  const h = harness(t, {
    DOCUMENT_SCAN_MODE: 'clamd', CLAMD_HOST: customClamdHost, CLAMD_PORT: customClamdPort,
  });
  const database = openDatabase({ path: h.databasePath });
  const app = await start({ database, env: h.env });
  t.after(async () => { await app.stop(); database.close(); });
  const owner = await household(app, 'Real scanner');
  const marker = 'COVERSAATH_CUSTOM_CLAMD_TEST_20261018';
  const uploaded = await app.upload({ ...owner, bytes: syntheticPdf(marker), filename: 'synthetic-scanner-test.pdf' });
  assert.equal(uploaded.status, 201);
  const id = uploaded.data.document.id;
  await eventually(() => database.prepare('SELECT lifecycle_state FROM document_uploads WHERE id = ?').get(id).lifecycle_state === 'deleted', { timeoutMs: 10_000 });
  assert.equal(h.storedFiles().length, 0);
  const event = database.prepare("SELECT event_payload_json FROM audit_events WHERE action = 'document.scan_blocked' AND resource_id = ?").get(id);
  assert.match(event.event_payload_json, /CoverSaath-Custom-PDF-Test/i);
});

test('upload capacity and missing storage configuration fail closed', async t => {
  const h = harness(t, { MAX_PENDING_DOCUMENTS_PER_HOUSEHOLD: '2' });
  const database = openDatabase({ path: h.databasePath });
  const app = await start({ database, env: h.env });
  t.after(async () => { await app.stop(); database.close(); });
  const owner = await household(app, 'Capacity');
  assert.equal((await app.upload({ ...owner, bytes: syntheticPdf('c1') })).status, 201);
  assert.equal((await app.upload({ ...owner, bytes: syntheticPdf('c2') })).status, 201);
  const third = await app.upload({ ...owner, bytes: syntheticPdf('c3') });
  assert.equal(third.status, 429);
  assert.equal(third.data.error.code, 'UPLOAD_CAPACITY_REACHED');

  const h2 = harness(t);
  const database2 = openDatabase({ path: h2.databasePath });
  const { DOCUMENT_ENCRYPTION_KEY_BASE64: _unused, ...withoutKey } = h2.env;
  const app2 = await start({ database: database2, env: withoutKey });
  t.after(async () => { await app2.stop(); database2.close(); });
  const owner2 = await household(app2, 'Unconfigured');
  const refused = await app2.upload({ ...owner2, bytes: syntheticPdf('no-storage') });
  assert.equal(refused.status, 503);
  assert.equal(refused.data.error.code, 'DOCUMENT_STORAGE_NOT_CONFIGURED');

  assert.throws(() => createApiServer({ env: { ...h2.env, DOCUMENT_ENCRYPTION_KEY_BASE64: 'c2hvcnQ=' } }), /32 bytes/);
  assert.throws(() => createApiServer({ env: { ...h2.env, DOCUMENT_SCAN_MODE: 'structural_only' } }), /DOCUMENT_SCAN_MODE/);
  assert.throws(() => createApiServer({ env: { ...h2.env, DOCUMENT_SCAN_MODE: 'clamd', CLAMD_HOST: 'http://clamd/' } }), /CLAMD_HOST/);
});

test('a streamed body without Content-Length is cut off at the cap', async t => {
  const { request } = await import('node:http');
  const h = harness(t);
  const database = openDatabase({ path: h.databasePath });
  const app = await start({ database, env: h.env });
  t.after(async () => { await app.stop(); database.close(); });
  const owner = await household(app, 'Chunked');
  const result = await new Promise(resolvePromise => {
    // Settles exactly once: on the response, on a socket error, or when the socket closes.
    let settled = false;
    const resolve = value => { if (!settled) { settled = true; resolvePromise(value); } };
    const req = request({
      host: '127.0.0.1', port: app.server.address().port, method: 'POST',
      path: `/api/v1/cases/${owner.caseId}/documents`,
      headers: {
        Authorization: `Bearer ${owner.token}`, 'Content-Type': 'application/pdf', 'Idempotency-Key': randomUUID(),
        'X-Document-Kind': 'policy_schedule', 'X-Consent-Grant-Id': owner.grantId, 'X-Filename': 'chunked.pdf',
        'Transfer-Encoding': 'chunked',
      },
    }, response => {
      let text = '';
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, data: JSON.parse(text) }));
      response.on('error', () => resolve({ status: 'socket-closed' }));
    });
    req.on('error', () => resolve({ status: 'socket-closed' }));
    req.on('close', () => setTimeout(() => resolve({ status: 'socket-closed' }), 50));
    const chunk = Buffer.alloc(1024 * 1024, 0x20);
    let sent = 0;
    const pump = () => {
      while (sent < 16) {
        sent += 1;
        if (!req.write(chunk)) return req.once('drain', pump);
      }
      req.end();
    };
    pump();
  });
  // Either the coded 413 arrives, or the server closes the socket mid-upload; never a stored file.
  if (result.status !== 'socket-closed') {
    assert.equal(result.status, 413);
    assert.equal(result.data.error.code, 'REQUEST_TOO_LARGE');
  }
  assert.equal(database.prepare('SELECT count(*) AS count FROM document_uploads').get().count, 0);
  assert.equal(h.storedFiles().length, 0);
});

test('guarded document transitions never resurrect a rejected or deleted document', async t => {
  const { DocumentRepository, AuditRepository } = await import('../src/backend/repositories/index.js');
  const h = harness(t);
  const database = openDatabase({ path: h.databasePath });
  const app = await start({ database, env: h.env });
  t.after(async () => { await app.stop(); database.close(); });
  const owner = await household(app, 'Guarded');
  const uploaded = await app.upload({ ...owner, bytes: syntheticPdf('guarded') });
  const id = uploaded.data.document.id;
  const repository = new DocumentRepository(database, { audit: new AuditRepository(database) });

  assert.equal(repository.markScanBlocked(id, { reasonCode: 'MALWARE_DETECTED' }), true);
  assert.equal(repository.markScanClean(id), false, 'a blocked document cannot become clean');
  assert.equal(repository.markScanBlocked(id, { reasonCode: 'MALWARE_DETECTED' }), false, 'blocked once');
  assert.equal(repository.completeDeletion(id), true);
  assert.equal(repository.markScanClean(id), false, 'a deleted document cannot become clean');
  assert.equal(repository.completeDeletion(id), false, 'deleted once');
  const row = database.prepare('SELECT lifecycle_state, malware_status FROM document_uploads WHERE id = ?').get(id);
  assert.deepEqual({ ...row }, { lifecycle_state: 'deleted', malware_status: 'blocked' });
  assert.throws(() => repository.updateDocument(id, {}), error => error.code === 'DOCUMENT_UPDATE_NOT_SUPPORTED');
});

test('a failed insert removes stored bytes and a failed store writes no row', async t => {
  const { createBackendServices, createDocumentUploadService } = await import('../src/backend/services/index.js');
  const { createEncryptedLocalByteStorage } = await import('../src/features/input/index.js');
  const h = harness(t);
  const database = openDatabase({ path: h.databasePath });
  const app = await start({ database, env: h.env });
  t.after(async () => { await app.stop(); database.close(); });
  const owner = await household(app, 'Faults');
  const services = createBackendServices(database);
  const caseRecord = database.prepare('SELECT * FROM service_cases WHERE id = ?').get(owner.caseId);
  const principal = { adultId: owner.adultId };
  const headers = key => ({
    'idempotency-key': key, 'x-document-kind': 'policy_schedule', 'x-consent-grant-id': owner.grantId, 'x-filename': 'fault.pdf',
  });
  const storage = createEncryptedLocalByteStorage({ baseDirectory: h.env.DOCUMENT_STORAGE_PATH, key: randomBytes(32) });

  const failingInsert = Object.create(services.documents);
  failingInsert.createDocument = () => { throw Object.assign(new Error('synthetic insert failure'), { code: 'SYNTHETIC_FAILURE' }); };
  const insertFails = createDocumentUploadService({ services, repository: failingInsert, storage });
  await assert.rejects(insertFails.upload({ principal, caseRecord, headers: headers(randomUUID()), bytes: syntheticPdf('insert-fails') }), /synthetic insert failure/);
  assert.equal(h.storedFiles().length, 0, 'bytes are removed when the row cannot be written');

  const failingStorage = { mode: 'live', protection: 'authenticated_encryption', async put() { throw new Error('synthetic storage outage'); }, async read() {}, async remove() {} };
  const storeFails = createDocumentUploadService({ services, repository: services.documents, storage: failingStorage });
  await assert.rejects(storeFails.upload({ principal, caseRecord, headers: headers(randomUUID()), bytes: syntheticPdf('store-fails') }), /synthetic storage outage/);
  assert.equal(database.prepare('SELECT count(*) AS count FROM document_uploads').get().count, 0);
  assert.equal(database.prepare("SELECT count(*) AS count FROM idempotency_keys WHERE scope LIKE 'document-upload:%'").get().count, 0);
});

// --- Review round 1 regressions -------------------------------------------------------------

async function serviceHarness(t, { scanner = null, cancelOcrJob = null, now = Date.now() } = {}) {
  const { createBackendServices, createDocumentUploadService } = await import('../src/backend/services/index.js');
  const { createEncryptedLocalByteStorage } = await import('../src/features/input/index.js');
  const h = harness(t);
  const database = openDatabase({ path: h.databasePath });
  const app = await start({ database, env: h.env });
  t.after(async () => { await app.stop(); database.close(); });
  const owner = await household(app, 'Service');
  const services = createBackendServices(database);
  const clock = { value: now };
  const storage = createEncryptedLocalByteStorage({ baseDirectory: join(h.directory, 'service-docs'), key: randomBytes(32) });
  const uploads = createDocumentUploadService({
    services, repository: services.documents, storage, scanner, cancelOcrJob,
    clock: () => new Date(clock.value), random: () => 1,
    limits: { maxDocumentsPerCase: 500, maxPendingPerHousehold: 500 },
  });
  const caseRecord = database.prepare('SELECT * FROM service_cases WHERE id = ?').get(owner.caseId);
  const put = (marker, extraHeaders = {}) => uploads.upload({
    principal: { adultId: owner.adultId }, caseRecord, bytes: syntheticPdf(marker),
    headers: { 'idempotency-key': randomUUID(), 'x-document-kind': 'policy_schedule', 'x-consent-grant-id': owner.grantId, 'x-filename': 'svc.pdf', ...extraHeaders },
  });
  return { h, database, app, owner, services, uploads, storage, clock, put, serviceDir: join(h.directory, 'service-docs') };
}

test('concurrent uploads with different keys cannot duplicate content or an immutable version', async t => {
  const h = harness(t);
  const database = openDatabase({ path: h.databasePath });
  const app = await start({ database, env: h.env });
  t.after(async () => { await app.stop(); database.close(); });
  const owner = await household(app, 'Racing');
  const bytes = syntheticPdf('same-content-race');
  const sameContent = await Promise.all(Array.from({ length: 6 }, () => app.upload({ ...owner, bytes })));
  assert.equal(sameContent.filter(result => result.status === 201).length, 1);
  assert.ok(sameContent.filter(result => result.status !== 201).every(result => result.data.error.code === 'DUPLICATE_DOCUMENT'));

  const logical = `logical-${randomUUID()}`;
  const sameVersion = await Promise.all(Array.from({ length: 6 }, (_, index) => app.upload({
    ...owner, bytes: syntheticPdf(`version-race-${index}`), headers: { 'X-Logical-Document-Id': logical, 'X-Document-Version': '1' },
  })));
  assert.equal(sameVersion.filter(result => result.status === 201).length, 1);
  assert.ok(sameVersion.filter(result => result.status !== 201).every(result => result.data.error.code === 'DOCUMENT_VERSION_EXISTS'));
  assert.equal(database.prepare('SELECT count(*) AS count FROM document_uploads').get().count, 2);
  assert.equal(h.storedFiles().length, 2, 'losing racers leave no ciphertext behind');
});

test('revocation during an in-flight scan never activates the document', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const scanner = { mode: 'clamd', async scan() { await gate; return { status: 'clean' }; }, async ping() { return true; } };
  const s = await serviceHarness(t, { scanner });
  const uploaded = await s.put('in-flight');
  const id = uploaded.body.document.id;
  const scanning = s.uploads.processDocument(id);
  const revoked = await s.app.call(`/api/v1/consents/${s.owner.grantId}/revoke`, {
    method: 'POST', token: s.owner.token, body: { revokedByAdultId: s.owner.adultId, reason: 'Synthetic revocation' },
  });
  assert.equal(revoked.status, 200);
  release();
  assert.equal(await scanning, 'skipped');
  assert.equal(s.database.prepare('SELECT lifecycle_state FROM document_uploads WHERE id = ?').get(id).lifecycle_state, 'deletion_requested');
  assert.equal(await s.uploads.processDocument(id), 'deleted');
  assert.equal(new OcrRepository(s.database).getReadyDocument(id, new Date().toISOString()), null);
});

test('deletion durably cancels submitted OCR before removing bytes and clears provider metadata', async t => {
  const cancellations = [];
  let cancellationFails = true;
  const s = await serviceHarness(t, {
    scanner: cleanScanner(),
    cancelOcrJob: async cancellation => {
      cancellations.push(cancellation);
      if (cancellationFails) throw new Error('synthetic provider outage');
    },
  });
  const id = (await s.put('ocr-cancellation')).body.document.id;
  assert.equal(await s.uploads.processDocument(id), 'clean');
  const at = new Date(s.clock.value).toISOString();
  s.database.prepare(`INSERT INTO ocr_jobs
    (id, document_upload_id, provider, provider_job_ref, status, attempt_count, contract_version, started_at,
     authorization_json, result_json, result_digest, error_message, requested_at, updated_at)
    VALUES ('ocr-cancel-on-delete', ?, 'sarvam', NULL, 'queued', 1,
      'knowvia.ocr.v1', ?, '{"authorized":true}', '{"sensitive":"payload"}', ?,
      'provider content-bearing failure', ?, ?)`).run(id, at, 'a'.repeat(64), at, at);

  s.uploads.requestDeletion({ documentId: id, actorAdultId: s.owner.adultId });
  assert.equal(s.database.prepare('SELECT lifecycle_state FROM document_uploads WHERE id = ?').get(id).lifecycle_state, 'deletion_requested');
  assert.equal(await s.uploads.processDocument(id), 'deferred');
  assert.equal(readdirSync(s.serviceDir).filter(name => name.endsWith('.csd')).length, 1,
    'bytes remain until the provider reconciles the durable client request identity');
  assert.deepEqual(cancellations, [{
    provider: 'sarvam', jobRef: null, requestId: 'ocr-cancel-on-delete', documentId: id,
  }]);
  s.services.ocr.recordCancellationReference('ocr-cancel-on-delete', 'remote-job-sensitive-ref');
  assert.equal(await s.uploads.processDocument(id), 'deferred');
  assert.equal(s.database.prepare("SELECT provider_job_ref FROM ocr_jobs WHERE id = 'ocr-cancel-on-delete'").get().provider_job_ref,
    'remote-job-sensitive-ref', 'the durable cancellation reference survives a provider outage');
  cancellationFails = false;
  s.clock.value += 2 * 60 * 60 * 1000;
  assert.equal(await s.uploads.processDocument(id), 'deleted');
  assert.deepEqual(cancellations, [
    { provider: 'sarvam', jobRef: null, requestId: 'ocr-cancel-on-delete', documentId: id },
    { provider: 'sarvam', jobRef: 'remote-job-sensitive-ref', requestId: 'ocr-cancel-on-delete', documentId: id },
    { provider: 'sarvam', jobRef: 'remote-job-sensitive-ref', requestId: 'ocr-cancel-on-delete', documentId: id },
  ]);
  const erased = s.database.prepare(`SELECT status, provider_job_ref, authorization_json, result_json,
    result_digest, error_code, error_message FROM ocr_jobs WHERE id = 'ocr-cancel-on-delete'`).get();
  assert.deepEqual({ ...erased }, {
    status: 'cancelled', provider_job_ref: null, authorization_json: null, result_json: null,
    result_digest: null, error_code: null, error_message: null,
  });
});

test('a scanner outage defers scans on the row and they complete after recovery', async t => {
  let down = true;
  const scanner = {
    mode: 'clamd',
    async scan() { if (down) throw Object.assign(new Error('down'), { code: 'SCANNER_UNAVAILABLE', retryable: true }); return { status: 'clean' }; },
    async ping() { return !down; },
  };
  const s = await serviceHarness(t, { scanner });
  const id = (await s.put('outage')).body.document.id;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    assert.deepEqual(s.uploads.listWorkDocumentIds(50), [id]);
    assert.equal(await s.uploads.processDocument(id), 'deferred');
    const row = s.database.prepare('SELECT scan_attempts, next_scan_at, lifecycle_state FROM document_uploads WHERE id = ?').get(id);
    assert.equal(row.scan_attempts, attempt);
    assert.equal(row.lifecycle_state, 'quarantined');
    assert.deepEqual(s.uploads.listWorkDocumentIds(50), [], 'not due before next_scan_at');
    assert.ok(Date.parse(row.next_scan_at) - s.clock.value <= 60 * 60 * 1000, 'backoff is capped at an hour');
    s.clock.value = Date.parse(row.next_scan_at) + 1;
  }
  down = false;
  assert.equal(await s.uploads.processDocument(id), 'clean');
  assert.equal(s.database.prepare('SELECT lifecycle_state FROM document_uploads WHERE id = ?').get(id).lifecycle_state, 'active');
});

test('deletion work is served before any backlog of scans', async t => {
  const scanner = { mode: 'clamd', async scan() { return { status: 'clean' }; }, async ping() { return true; } };
  const s = await serviceHarness(t, { scanner });
  for (let index = 0; index < 55; index += 1) await s.put(`backlog-${index}`);
  const victim = (await s.put('to-revoke-later')).body.document.id;
  s.database.prepare("UPDATE document_uploads SET lifecycle_state = 'deletion_requested' WHERE id = ?").run(victim);
  const work = s.uploads.listWorkDocumentIds(50);
  assert.equal(work.length, 50);
  assert.equal(work[0], victim);
});

test('transient storage errors defer; a missing object is rejected; tampering is rejected', async t => {
  const scanner = { mode: 'clamd', async scan() { return { status: 'clean' }; }, async ping() { return true; } };
  const s = await serviceHarness(t, { scanner });
  const { chmodSync, unlinkSync, writeFileSync } = await import('node:fs');
  const keyOf = id => s.database.prepare('SELECT storage_path FROM document_uploads WHERE id = ?').get(id).storage_path;

  const transient = (await s.put('transient')).body.document.id;
  const path = join(s.serviceDir, `${keyOf(transient)}.csd`);
  chmodSync(path, 0o000);
  assert.equal(await s.uploads.processDocument(transient), 'deferred');
  assert.equal(s.database.prepare('SELECT lifecycle_state FROM document_uploads WHERE id = ?').get(transient).lifecycle_state, 'quarantined');
  chmodSync(path, 0o600);

  const missing = (await s.put('missing')).body.document.id;
  unlinkSync(join(s.serviceDir, `${keyOf(missing)}.csd`));
  // Confirmed over three attempts before the document is rejected.
  assert.equal(await s.uploads.processDocument(missing), 'deferred');
  assert.equal(await s.uploads.processDocument(missing), 'deferred');
  assert.equal(await s.uploads.processDocument(missing), 'blocked');

  const tampered = (await s.put('tampered')).body.document.id;
  const tamperedPath = join(s.serviceDir, `${keyOf(tampered)}.csd`);
  const ciphertext = readFileSync(tamperedPath);
  ciphertext[ciphertext.length - 1] ^= 0xff;
  writeFileSync(tamperedPath, ciphertext);
  assert.equal(await s.uploads.processDocument(tampered), 'blocked');
  assert.equal(existsSync(tamperedPath), false);
  const audit = s.database.prepare("SELECT event_payload_json FROM audit_events WHERE action = 'document.scan_blocked'").all().map(row => row.event_payload_json).join(' ');
  assert.match(audit, /STORAGE_OBJECT_MISSING/);
  assert.match(audit, /STORAGE_INTEGRITY_FAILED/);
});

test('deleted tombstones keep no content fingerprint and the orphan sweep removes stray ciphertext', async t => {
  const s = await serviceHarness(t);
  const { utimesSync, writeFileSync } = await import('node:fs');
  const uploaded = await s.put('tombstone');
  const id = uploaded.body.document.id;
  const before = s.database.prepare('SELECT content_sha256, storage_path FROM document_uploads WHERE id = ?').get(id);
  s.database.prepare("UPDATE document_uploads SET lifecycle_state = 'deletion_requested' WHERE id = ?").run(id);
  assert.equal(await s.uploads.processDocument(id), 'deleted');
  const after = s.database.prepare('SELECT content_sha256, storage_path, original_filename FROM document_uploads WHERE id = ?').get(id);
  assert.notEqual(after.content_sha256, before.content_sha256);
  assert.notEqual(after.storage_path, before.storage_path);
  assert.equal(after.original_filename, '[deleted]');
  // The same bytes can be uploaded again after deletion.
  assert.equal((await s.put('tombstone')).status, 201);

  const live = (await s.put('live-file')).body.document.id;
  const orphanKey = 'f'.repeat(64);
  const orphan = join(s.serviceDir, `${orphanKey}.csd`);
  const temporary = join(s.serviceDir, `.${'e'.repeat(64)}.${randomUUID()}.tmp`);
  const fresh = join(s.serviceDir, `${'d'.repeat(64)}.csd`);
  for (const path of [orphan, temporary, fresh]) writeFileSync(path, 'synthetic');
  const old = (s.clock.value - 2 * 60 * 60 * 1000) / 1000;
  utimesSync(orphan, old, old);
  utimesSync(temporary, old, old);
  const liveKey = s.database.prepare('SELECT storage_path FROM document_uploads WHERE id = ?').get(live).storage_path;
  utimesSync(join(s.serviceDir, `${liveKey}.csd`), old, old);
  assert.deepEqual(await s.uploads.sweepOrphans(), { removed: 2 });
  assert.equal(existsSync(orphan), false);
  assert.equal(existsSync(temporary), false);
  assert.equal(existsSync(fresh), true, 'recent files are left alone');
  assert.equal(existsSync(join(s.serviceDir, `${liveKey}.csd`)), true, 'live documents are never swept');
});

test('a document-scoped grant cannot collect new documents; replays show current state; oracles and long names', async t => {
  const h = harness(t);
  const database = openDatabase({ path: h.databasePath });
  const scanner = { mode: 'clamd', async scan() { return { status: 'blocked', signature: 'Synthetic.Sig' }; }, async ping() { return true; } };
  const app = await start({ database, env: h.env, documentScanner: scanner });
  t.after(async () => { await app.stop(); database.close(); });
  const owner = await household(app, 'Scoped');
  const other = await household(app, 'Outsider');

  const key = randomUUID();
  const bytes = syntheticPdf('replay-after-delete');
  const first = await app.upload({ ...owner, bytes, key });
  assert.equal(first.status, 201);
  await eventually(() => database.prepare("SELECT 1 FROM document_uploads WHERE id = ? AND lifecycle_state = 'deleted'").get(first.data.document.id));
  // Deletion drops the upload's idempotency record (it fingerprints the file), so reusing the key
  // is a fresh upload rather than a replay of the deleted document.
  assert.equal(database.prepare("SELECT count(*) AS count FROM idempotency_keys WHERE scope LIKE 'document-upload:%'").get().count, 0);
  const reused = await app.upload({ ...owner, bytes, key });
  assert.equal(reused.status, 201);
  assert.notEqual(reused.data.document.id, first.data.document.id);

  const narrow = await app.call('/api/v1/consents', {
    method: 'POST', token: owner.token,
    body: { householdId: owner.householdId, subjectAdultId: owner.adultId, purpose: 'document_processing',
      scopes: [{ resourceType: 'document', resourceId: first.data.document.id, action: 'collect', dataCategory: 'insurance_document' }] },
  });
  assert.equal(narrow.status, 201);
  const refused = await app.upload({ ...owner, grantId: narrow.data.id, bytes: syntheticPdf('narrow') });
  assert.equal(refused.status, 403);
  assert.equal(refused.data.error.code, 'CONSENT_SCOPE_REQUIRED');

  const foreignCase = await app.upload({ ...other, caseId: owner.caseId, bytes: syntheticPdf('oracle') });
  const missingCase = await app.upload({ ...other, caseId: `case-${randomUUID()}`, bytes: syntheticPdf('oracle-2') });
  assert.equal(foreignCase.status, 404);
  assert.deepEqual(foreignCase.data, missingCase.data);
  const foreignList = await app.call(`/api/v1/cases/${owner.caseId}/documents`, { token: other.token });
  const missingList = await app.call(`/api/v1/cases/case-${randomUUID()}/documents`, { token: other.token });
  assert.deepEqual(foreignList.data, missingList.data);

  const longName = await app.upload({ ...owner, bytes: syntheticPdf('long-name'), filename: `${'नाम'.repeat(80)}.pdf` });
  assert.equal(longName.status, 400);
  assert.equal(longName.data.error.code, 'INVALID_FILENAME');
});

test('round 2: failing deletions defer without starving work; scanner errors and missing volumes are bounded', async t => {
  let mode = 'error';
  const scanner = {
    mode: 'clamd',
    async scan() {
      if (mode === 'error') throw Object.assign(new Error('scanner error'), { code: 'SCANNER_ERROR', retryable: false });
      return { status: 'clean' };
    },
    async ping() { return true; },
  };
  const s = await serviceHarness(t, { scanner });
  const { renameSync } = await import('node:fs');

  // A scanner that keeps answering ERROR is given up on after a bounded number of attempts.
  const stubborn = (await s.put('stubborn')).body.document.id;
  let outcome;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    outcome = await s.uploads.processDocument(stubborn);
    s.clock.value += 2 * 60 * 60 * 1000;
  }
  assert.equal(outcome, 'blocked');
  assert.match(s.database.prepare("SELECT event_payload_json FROM audit_events WHERE action = 'document.scan_blocked'").get().event_payload_json, /SCAN_FAILED_REPEATEDLY/);

  // An unmounted or empty storage volume is an outage: documents are deferred, never rejected.
  mode = 'clean';
  const waiting = (await s.put('volume-outage')).body.document.id;
  renameSync(s.serviceDir, `${s.serviceDir}-away`);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal(await s.uploads.processDocument(waiting), 'deferred');
    s.clock.value += 2 * 60 * 60 * 1000;
  }
  renameSync(`${s.serviceDir}-away`, s.serviceDir);
  assert.equal(await s.uploads.processDocument(waiting), 'clean');

  // A deletion whose byte removal fails is deferred on the row and does not crowd out scans.
  const failingStorage = { ...s.storage, remove: async () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); } };
  const { createDocumentUploadService } = await import('../src/backend/services/index.js');
  const stuck = createDocumentUploadService({
    services: s.services, repository: s.services.documents, storage: failingStorage, scanner,
    clock: () => new Date(s.clock.value), random: () => 1, limits: { maxDocumentsPerCase: 500, maxPendingPerHousehold: 500 },
  });
  const doomed = [];
  for (let index = 0; index < 3; index += 1) doomed.push((await s.put(`doomed-${index}`)).body.document.id);
  const scanMe = (await s.put('scan-me')).body.document.id;
  for (const id of doomed) s.database.prepare("UPDATE document_uploads SET lifecycle_state = 'deletion_requested' WHERE id = ?").run(id);
  for (const id of doomed) assert.equal(await stuck.processDocument(id), 'deferred');
  assert.deepEqual(stuck.listWorkDocumentIds(3), [scanMe], 'deferred deletions are not due; the scan is served');
  s.clock.value += 2 * 60 * 60 * 1000;
  assert.deepEqual(new Set(s.uploads.listWorkDocumentIds(3)), new Set(doomed), 'due deletions come first again');
  for (const id of doomed) assert.equal(await s.uploads.processDocument(id), 'deleted');

  // Expired idempotency records are purged for every scope by the hourly sweep.
  s.database.prepare(`INSERT INTO idempotency_keys (scope, idempotency_key, request_digest, expires_at, created_at)
    VALUES ('analysis_run:synthetic', 'expired-key-0001', 'x', '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z')`).run();
  await s.uploads.sweepOrphans();
  assert.equal(s.database.prepare("SELECT count(*) AS count FROM idempotency_keys WHERE idempotency_key = 'expired-key-0001'").get().count, 0);
});
