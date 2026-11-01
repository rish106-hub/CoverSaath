import { AuthIdentityRepository, AuthRepository, AuditRepository, CaseRepository, ConsentRepository, CoverageParameterRepository, DocumentRepository, ClauseRepository, CatalogueReviewRepository, CuratedProductRepository, HouseholdRepository, OcrRepository, PolicyStructuringRepository, ProfileAnswerRepository, WorkflowRepository } from '../repositories/index.js';
import { emergencyInstruction } from '../state/case-state-machine.js';
import { TenantAccessService } from './tenant-access-service.js';
import { resolveColumnCrypto } from '../security/column-crypto.js';

export function createBackendServices(database, options = {}) {
  const audit = new AuditRepository(database, options);
  // One column-encryption instance for every repository (ADR 0013). It fails closed when a production deployment has no key.
  const columnCrypto = resolveColumnCrypto(options);
  const shared = { ...options, audit, columnCrypto };
  const households = new HouseholdRepository(database, shared);
  const coverageParameters = new CoverageParameterRepository(database, shared);
  // Consent revocation appends an explicit redaction audit event through the
  // parameter repository, inside the revocation transaction.
  const policyStructuring = new PolicyStructuringRepository(database, { ...shared, coverageParameters });
  // Revocation and document erasure also erase structuring proposals and runs (counts-only audit).
  // Clauses and answers are derived stores (ADR 0008) erased by the same paths.
  const clauses = new ClauseRepository(database, shared);
  const catalogueReviews = new CatalogueReviewRepository(database, shared);
  const curatedProducts = new CuratedProductRepository(database, shared);
  const consents = new ConsentRepository(database, { ...shared, coverageParameters, policyStructuring, clauses });
  const cases = new CaseRepository(database, shared);
  const workflows = new WorkflowRepository(database, shared);
  const auth = new AuthRepository(database, shared);
  const identities = new AuthIdentityRepository(database, { ...shared, households, auth });
  const ocr = new OcrRepository(database, shared);
  const profileAnswers = new ProfileAnswerRepository(database, shared);
  const documents = new DocumentRepository(database, { ...shared, coverageParameters, consents });
  const access = new TenantAccessService(database, { auth, households, consents, env: options.env ?? {} });

  return {
    access, audit, auth, columnCrypto, identities, profileAnswers, households, consents, cases, workflows, ocr, coverageParameters, policyStructuring, clauses, catalogueReviews, curatedProducts, documents,
    emergencyInstruction,
    // Async: callers await it, so a denial (a rejection) stops the request.
    async requireDocumentProcessingConsent({ consentGrantId, subjectAdultId, documentId = null }) {
      return await consents.requireActive(consentGrantId, {
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
