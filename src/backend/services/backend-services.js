import { AuthRepository, AuditRepository, CaseRepository, ConsentRepository, CoverageParameterRepository, DocumentRepository, HouseholdRepository, OcrRepository, WorkflowRepository } from '../repositories/index.js';
import { emergencyInstruction } from '../state/case-state-machine.js';
import { TenantAccessService } from './tenant-access-service.js';

export function createBackendServices(database, options = {}) {
  const audit = new AuditRepository(database, options);
  const shared = { ...options, audit };
  const households = new HouseholdRepository(database, shared);
  const coverageParameters = new CoverageParameterRepository(database, shared);
  // Consent revocation appends an explicit redaction audit event through the
  // parameter repository, inside the revocation transaction.
  const consents = new ConsentRepository(database, { ...shared, coverageParameters });
  const cases = new CaseRepository(database, shared);
  const workflows = new WorkflowRepository(database, shared);
  const auth = new AuthRepository(database, shared);
  const ocr = new OcrRepository(database, shared);
  const documents = new DocumentRepository(database, shared);
  const access = new TenantAccessService(database, { auth, households, consents, env: options.env ?? {} });

  return {
    access, audit, auth, households, consents, cases, workflows, ocr, coverageParameters, documents,
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
