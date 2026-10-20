import test from 'node:test';
import assert from 'node:assert/strict';
import { QUESTION_CONSENT_SCOPE } from '../src/contracts/policy-evidence.js';
import { createPolicyEvidenceService } from '../src/backend/services/policy-evidence-service.js';

// Synthetic stubs. The consent filter must run before the document processing limit.
test('document limit applies after consent filtering', async () => {
  const documents = Array.from({ length: 12 }, (_, index) => ({ id: `doc-${index}`, lifecycleState: 'active' }));
  const granted = new Set(['doc-11']);
  const scope = id => ({ resource_type: QUESTION_CONSENT_SCOPE.resourceType, resource_id: id, action: QUESTION_CONSENT_SCOPE.action, data_category: QUESTION_CONSENT_SCOPE.dataCategory, recipient: QUESTION_CONSENT_SCOPE.recipient });
  const read = [];
  const services = {
    documents: { listForCase: () => documents },
    consents: {
      requireActive: (_grant, { resourceId }) => { if (!granted.has(resourceId)) throw Object.assign(new Error('x'), { code: 'CONSENT_SCOPE_REQUIRED' }); },
      get: () => ({ household_id: 'h', scopes: [...granted].map(scope) }),
    },
    ocr: { getDocumentBlockPages: ({ documentId }) => { read.push(documentId); return { complete: false }; } },
    clauses: { findAnswerByKey: () => null, clauseDocumentIds: () => [] },
  };
  const service = createPolicyEvidenceService({ services, loadKnownIdentifiers: async () => [], createModelCall: () => async () => ({}), env: { POLICY_EVIDENCE_ENABLED: 'true' } });
  await assert.rejects(service.ask({ caseRecord: { id: 'c', household_id: 'h' }, subjectAdultId: 'a', question: 'q?', consentGrantId: 'g', idempotencyKey: 'idem-key-0001' }), { code: 'POLICY_EVIDENCE_UNAVAILABLE' });
  assert.deepEqual(read, ['doc-11'], 'the authorised document beyond position 10 is still read');
});
