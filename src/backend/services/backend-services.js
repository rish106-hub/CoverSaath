import { AuditRepository, CaseRepository, ConsentRepository, HouseholdRepository, WorkflowRepository } from '../repositories/index.js';
import { emergencyInstruction } from '../state/case-state-machine.js';

export function createBackendServices(database, options = {}) {
  const audit = new AuditRepository(database, options);
  const shared = { ...options, audit };
  const households = new HouseholdRepository(database, shared);
  const consents = new ConsentRepository(database, shared);
  const cases = new CaseRepository(database, shared);
  const workflows = new WorkflowRepository(database, shared);

  return {
    audit, households, consents, cases, workflows,
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

