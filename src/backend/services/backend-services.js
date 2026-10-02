import { AuthRepository, AuditRepository, CaseRepository, ConsentRepository, HouseholdRepository, OcrRepository, WorkflowRepository } from '../repositories/index.js';
import { emergencyInstruction } from '../state/case-state-machine.js';
import { TenantAccessService } from './tenant-access-service.js';

export function createBackendServices(database, options = {}) {
  const audit = new AuditRepository(database, options);
  const shared = { ...options, audit };
  const households = new HouseholdRepository(database, shared);
  const consents = new ConsentRepository(database, shared);
  const cases = new CaseRepository(database, shared);
  const workflows = new WorkflowRepository(database, shared);
  const auth = new AuthRepository(database, shared);
  const ocr = new OcrRepository(database, shared);
  const access = new TenantAccessService(database, { auth, households, consents, env: options.env ?? {} });

  return {
    access, audit, auth, households, consents, cases, workflows, ocr,
    emergencyInstruction,
    requireDocumentProcessingConsent({ consentGrantId, subjectAdultId, documentId = null }) {
      return consents.requireActive(consentGrantId, {
        subjectAdultId,
        purpose: 'document_processing',
        resourceType: 'document',
        resourceId: documentId,
        action: 'collect',
        dataCategory: 'insurance_document',
      });
    },
  };
}
