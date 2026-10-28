// Shared synthetic scenario for live-analysis tests. No network: the model
// driver is an in-process stub, and every identifier below is synthetic.
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { testTempRoot as tmpdir } from './temp-root.mjs';
import { freshDatabase } from './pg.mjs';
import { createApiServer } from '../../src/server/server.js';

export const bootstrapToken = 'knowvia-live-test-bootstrap-token-001';
export const liveEnv = Object.freeze({
  KNOWVIA_BOOTSTRAP_TOKEN: bootstrapToken,
  LLM_PROVIDER: 'google',
  GEMINI_API_KEY: 'test-only-not-a-real-key',
  LLM_MODEL: 'mock-gemini',
  LLM_MODEL_VERSION: 'mock-gemini-v1',
  LLM_INPUT_USD_PER_MILLION: '0.75',
  LLM_OUTPUT_USD_PER_MILLION: '4.50',
  ORCHESTRATION_RUN_BUDGET_USD: '0.25',
  ORCHESTRATION_PROJECT_BUDGET_USD: '5',
  LLM_MAX_CONCURRENT_CALLS: '2',
  LLM_TIMEOUT_MS: '30000',
});

export const DEFAULT_PAGE_TEXT = 'Synthetic schedule: room rent limit is 5000.';

export function mockOutput(agentId, input) {
  const citation = input.sources[0].id;
  if (agentId.endsWith('question_drafting')) {
    const unresolvedSourceIds = input.sources.filter(source => source.status !== 'known').map(source => source.id);
    return {
      questions: unresolvedSourceIds.map((id, index) => ({ id: `q-${index}`, text: 'What does the authorised institution confirm?', authorityOwner: 'insurer', citations: [id] })),
      unresolvedSourceIds,
    };
  }
  if (agentId.endsWith('evidence_synthesis')) {
    return { statements: [{ id: 's-1', text: 'Reviewed evidence remains subject to institutional confirmation.', kind: 'observation', citations: [citation] }], unknowns: [], summary: 'Reviewed evidence is structured; deterministic gates retain authority.' };
  }
  return {
    facts: [{ id: 'f-1', field: input.context.requestedFields[0], value: 'model extracted value', status: 'known', citations: [citation] }],
    summary: 'One requested source-linked field was extracted.',
  };
}

// In-process stand-in for the Gemini SDK. Records every provider request
// (agent id, system instructions and evidence prompt) so tests can inspect
// exactly what would have left the process.
export function stubModelDriver({ modelRequests = [], loadedModels = [], onGenerate, output = mockOutput } = {}) {
  return {
    loadModel: async descriptor => { loadedModels.push(descriptor); return { mocked: true }; },
    createAgent: settings => ({
      generate: async ({ prompt }) => {
        const request = { agentId: settings.id, instructions: settings.instructions, prompt };
        modelRequests.push(request);
        await onGenerate?.(request, modelRequests.length);
        return { output: output(settings.id, JSON.parse(prompt)), totalUsage: { inputTokens: 10, outputTokens: 5 } };
      },
    }),
  };
}

export async function startLiveServer(t, driverOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'knowvia-live-analysis-'));
  const { db: database } = await freshDatabase(t);
  const server = createApiServer({ database, env: liveEnv, analysisLiveModelDriver: stubModelDriver(driverOptions) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    database,
    async call(path, { method = 'GET', body, token, idempotencyKey } = {}) {
      const response = await fetch(base + path, {
        method,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, raw: await response.clone().text(), data: await response.json() };
    },
  };
}

async function insertDocument(database, { suffix, householdId, caseId, adultId, consentGrantId, pageText, at, pageNumber = 1, sourceVersion = '1' }) {
  const documentId = `document-${suffix}`;
  await database.prepare(`INSERT INTO document_uploads
    (id, household_id, case_id, uploaded_by_adult_id, consent_grant_id, document_kind,
     original_filename, storage_path, content_sha256, mime_type, byte_size, malware_status,
     encryption_status, lifecycle_state, uploaded_at, logical_document_id, source_version)
    VALUES (?, ?, ?, ?, ?, 'policy_schedule', 'synthetic.pdf',
      ?, ?, 'application/pdf', 128, 'clean', 'encrypted_local',
      'active', ?, ?, ?)`)
    .run(documentId, householdId, caseId, adultId, consentGrantId, `protected/${documentId}`, suffix.padEnd(64, 'a').slice(0, 64), at, `logical-${suffix}`, sourceVersion);
  await database.prepare(`INSERT INTO ocr_jobs
    (id, document_upload_id, provider, provider_job_ref, status, attempt_count, requested_at,
     completed_at, contract_version, authorization_json, result_json, result_digest, updated_at)
    VALUES (?, ?, 'fixture', ?, 'succeeded', 1, ?, ?,
      'knowvia.ocr.v1', '{}', '{}', ?, ?)`)
    .run(`ocr-${suffix}`, documentId, `fixture-${suffix}`, at, at, 'b'.repeat(64), at);
  await database.prepare(`INSERT INTO source_pages
    (id, document_upload_id, ocr_job_id, page_number, source_version, page_sha256,
     extracted_text, extraction_status, confidence_basis_points, created_at,
     output_contract_version, text_sha256, provider_page_ref, provenance_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'extracted', 9000, ?,
      'knowvia.ocr.v1', ?, ?, '{}')`)
    .run(`page-${suffix}`, documentId, `ocr-${suffix}`, pageNumber, sourceVersion, 'c'.repeat(64), pageText, at, 'd'.repeat(64), `fixture-page-${suffix}`);
  return { documentId, pageId: `page-${suffix}`, pageNumber, sourceVersion };
}

// Adds a further OCR page to a document created by insertDocument.
async function insertPage(database, { documentId, pageNumber, sourceVersion = '1', text, at }) {
  const suffix = documentId.replace(/^document-/, '');
  const pageId = `page-${suffix}-p${pageNumber}`;
  await database.prepare(`INSERT INTO source_pages
    (id, document_upload_id, ocr_job_id, page_number, source_version, page_sha256,
     extracted_text, extraction_status, confidence_basis_points, created_at,
     output_contract_version, text_sha256, provider_page_ref, provenance_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'extracted', 9000, ?,
      'knowvia.ocr.v1', ?, ?, '{}')`)
    .run(pageId, documentId, `ocr-${suffix}`, pageNumber, sourceVersion, 'c'.repeat(64), text, at, 'd'.repeat(64), `fixture-page-${suffix}-p${pageNumber}`);
  return { documentId, pageId, pageNumber, sourceVersion };
}

// Creates a household, a processing case, the case-level coverage consent and
// one OCR'd document whose derive scope names `recipient` (null = no named
// recipient). Extra documents may be added with `addDocument`.
export async function setupLiveCase(app, { pageText = DEFAULT_PAGE_TEXT, recipient = 'google-gemini', suffix = 'live' } = {}) {
  const { database } = app;
  const identity = await app.call('/api/v1/households', { method: 'POST', token: bootstrapToken, body: { displayName: 'Synthetic live household', owner: { displayName: 'Synthetic owner' } } });
  const token = identity.data.session.token;
  const householdId = identity.data.household.id;
  const ownerId = identity.data.owner.id;
  const created = await app.call('/api/v1/cases', { method: 'POST', token, body: { householdId, subjectMemberId: identity.data.ownerMember.id, openedByAdultId: ownerId, triggerType: 'renewal' } });
  const collecting = await app.call(`/api/v1/cases/${created.data.id}/transitions`, { method: 'POST', token, body: { toStatus: 'collecting', expectedRevision: created.data.revision, actorId: ownerId } });
  await app.call(`/api/v1/cases/${created.data.id}/transitions`, { method: 'POST', token, body: { toStatus: 'processing', expectedRevision: collecting.data.revision, actorId: ownerId } });
  const coverageConsent = await app.call('/api/v1/consents', {
    method: 'POST', token,
    body: { householdId, subjectAdultId: ownerId, purpose: 'coverage_reconstruction', scopes: [{ resourceType: 'case', resourceId: created.data.id, action: 'derive', dataCategory: 'insurance_document' }, { resourceType: 'case', resourceId: created.data.id, action: 'read', dataCategory: 'analysis_summary', recipient: ownerId }] },
  });
  const documentConsent = await app.call('/api/v1/consents', {
    method: 'POST', token,
    body: { householdId, subjectAdultId: ownerId, purpose: 'document_processing', scopes: [{ resourceType: 'document', action: 'collect', dataCategory: 'insurance_document' }] },
  });
  const at = new Date().toISOString();
  const addDocument = async ({ suffix: documentSuffix, text = DEFAULT_PAGE_TEXT, scopeRecipient = 'google-gemini', grantId = documentConsent.data.id, pageNumber, sourceVersion } = {}) => {
    const document = await insertDocument(database, { suffix: documentSuffix, householdId, caseId: created.data.id, adultId: ownerId, consentGrantId: grantId, pageText: text, at, pageNumber, sourceVersion });
    const scopeId = `scope-${documentSuffix}`;
    await database.prepare(`INSERT INTO consent_scopes
      (id, consent_grant_id, resource_type, resource_id, action, data_category, recipient, created_at)
      VALUES (?, ?, 'document', ?, 'derive', 'insurance_document', ?, ?)`).run(scopeId, grantId, document.documentId, scopeRecipient, at);
    return { ...document, scopeId };
  };
  const document = await addDocument({ suffix, text: pageText, scopeRecipient: recipient });
  return {
    token,
    householdId,
    ownerId,
    ownerMemberId: identity.data.ownerMember.id,
    caseId: created.data.id,
    coverageConsentId: coverageConsent.data.id,
    documentConsentId: documentConsent.data.id,
    ...document,
    addDocument,
    addPage: (document, { pageNumber, text, sourceVersion }) => insertPage(database, { documentId: document.documentId, pageNumber, sourceVersion: sourceVersion ?? document.sourceVersion, text, at }),
    startLiveRun(idempotencyKey = `live-${suffix}`) {
      return app.call(`/api/v1/cases/${created.data.id}/analysis-runs`, { method: 'POST', token, idempotencyKey, body: { consentGrantId: coverageConsent.data.id, executionMode: 'live', modelPermission: true } });
    },
  };
}

export async function auditActions(database, action) {
  return (await database.prepare('SELECT id, resource_id, event_payload_json FROM audit_events WHERE action = ? ORDER BY id').all(action))
    .map(row => ({ id: row.id, resourceId: row.resource_id, payload: JSON.parse(row.event_payload_json) }));
}
