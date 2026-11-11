import { holdingsEnabled } from './holdings-flag.js';
import { JobQueueRepository, ErasureRepository, AppEventRepository, RuntimeLimitsRepository, AuthIdentityRepository, AuthRepository, AuthTokenRepository, AuditRepository, CaseRepository, ConsentRepository, CoverageParameterRepository, DocumentRepository, ClauseRepository, CatalogueReviewRepository, CuratedProductRepository, HouseholdRepository, HouseholdAppRepository, UserDataRepository, SyncRepository, ProfileAnswerRepository, PolicyProfileRepository, PolicyFactsRepository, OcrRepository, PolicyStructuringRepository, WorkflowRepository, PersonRecordRepository, HoldingProductRepository, ReferenceCacheRepository, PolicyHoldingRepository, MemoryFactRepository, DeclarationRepository, PremiumRepository, ProviderCallRepository, MemoryChunkRepository, ChatRepository } from '../repositories/index.js';
import { createChatModelGateway, createHouseholdDayBudget } from '../../features/ai-analysis/index.js';
import { createModelRouter, createVoyageEmbedClient } from '../../integrations/index.js';
import { createHouseholdIdentifierLoader } from './household-identifiers.js';
import { createMemoryService } from './memory-service.js';
import { createChatV1Service } from './chat-v1-service.js';
import { emergencyInstruction } from '../state/case-state-machine.js';
import { createHouseholdAppService } from './household-app-service.js';
import { createUserDataService } from './user-data-service.js';
import { createPersonRecordService } from './person-record-service.js';
import { createPolicyProfileService, policyFactsEnabled } from './policy-profile-service.js';
import { HoldingPipelineRepository } from '../repositories/holding-pipeline-repository.js';
import { createHoldingsService } from './holdings-service.js';
import { createPolicyFactsService, POLICY_FACTS_JOB_KIND, policyFactsDedupeKey } from './policy-facts-service.js';
import { NORMALISER_VERSION } from '../../features/policy-facts/normalisers.js';
import { createNetworkHospitalService } from './network-hospital-service.js';
import { NetworkHospitalRepository } from '../repositories/network-hospital-repository.js';
import { createHoldingProductService, DETECT_INSURER_JOB_KIND } from './holding-product-service.js';
import { HOLDING_JOB_MAX_ATTEMPTS } from '../../contracts/holdings.js';
import { createHash } from 'node:crypto';
import { createAuthTokenService } from './auth-token-service.js';
import { createSyncService } from './sync-service.js';
import { TenantAccessService } from './tenant-access-service.js';
import { createJwtTokens, readJwtIssuer, readJwtPrivateKeys } from '../security/jwt-tokens.js';
import { resolveColumnCrypto } from '../security/column-crypto.js';
import { createAnalyticsService } from './analytics-service.js';

// Document kinds that start a holding on upload (a policy wording or schedule).
const HOLDING_DOCUMENT_KINDS = Object.freeze(['policy_wording', 'policy_schedule']);

export function createBackendServices(database, options = {}) {
  const audit = new AuditRepository(database, options);
  // One column-encryption instance for every repository (ADR 0013). It fails closed when a production deployment has no key.
  const columnCrypto = resolveColumnCrypto(options);
  // Activity events and shared runtime limits (ADR 0014). Event payloads are sealed with the same column crypto.
  const appEvents = new AppEventRepository(database, { clock: options.clock, columnCrypto });
  const providerCalls = new ProviderCallRepository(database, { clock: options.clock });
  const runtimeLimits = new RuntimeLimitsRepository(database);
  // Product analytics outbox (migration 057, ADR 0033): off unless ANALYTICS_ENABLED is exactly "true" and the household consented.
  const analytics = createAnalyticsService({ database, env: options.env ?? process.env });
  // Postgres job queue for the worker process group (migration 034). Revocation erases its rows through ConsentRepository.
  const jobQueue = new JobQueueRepository(database, { clock: options.clock });
  const shared = { ...options, audit, columnCrypto };
  const households = new HouseholdRepository(database, shared);
  const coverageParameters = new CoverageParameterRepository(database, shared);
  // Consent revocation appends an explicit redaction audit event through the
  // parameter repository, inside the revocation transaction.
  // Policy facts (ADR 0025): when a structuring run commits, queue the identifiers-only extraction job in the same transaction.
  // Off unless POLICY_FACTS_ENABLED=true. The repository runs this in a savepoint, so a queue failure never undoes a structuring commit.
  const afterStructuringCommit = async ({ householdId, documentId, sourceVersion, consentGrantId }) => {
    if (!policyFactsEnabled(options.env ?? process.env)) return;
    await jobQueue.enqueue({
      kind: POLICY_FACTS_JOB_KIND, householdId, documentId, consentGrantId, payload: { normaliserVersion: NORMALISER_VERSION },
      dedupeKey: policyFactsDedupeKey({ documentId, sourceVersion }),
    });
  };
  const policyStructuring = new PolicyStructuringRepository(database, { ...shared, coverageParameters, afterCommit: afterStructuringCommit });
  // Revocation and document erasure also erase structuring proposals and runs (counts-only audit).
  // Clauses and answers are derived stores (ADR 0008) erased by the same paths.
  const clauses = new ClauseRepository(database, shared);
  const catalogueReviews = new CatalogueReviewRepository(database, shared);
  const curatedProducts = new CuratedProductRepository(database, shared);
  const consents = new ConsentRepository(database, { ...shared, coverageParameters, policyStructuring, clauses, appEvents, jobQueue });
  const cases = new CaseRepository(database, shared);
  const workflows = new WorkflowRepository(database, shared);
  const auth = new AuthRepository(database, shared);
  // Web sessions and JWT access tokens (ADR 0027). Inert unless KNOWVIA_JWT_ISSUER and a private key are configured;
  // opaque bearer sessions never depend on it. `options.jwt` lets a test inject keys without touching the environment.
  const authTokenRepository = new AuthTokenRepository(database, shared);
  const jwtTokens = createJwtTokens({
    issuer: options.jwt?.issuer ?? readJwtIssuer(options.env ?? {}),
    privateKeys: options.jwt?.privateKeys ?? readJwtPrivateKeys(options.env ?? {}),
    keyStore: { getActive: () => authTokenRepository.getActiveKey(), find: kid => authTokenRepository.findKey(kid) },
    clock: options.clock,
  });
  const authTokens = createAuthTokenService({ repository: authTokenRepository, tokens: jwtTokens, clock: options.clock });
  const identities = new AuthIdentityRepository(database, { ...shared, households, auth, authTokens: authTokenRepository });
  // Holdings (complete.md 3.2 step 1): when OCR of a policy document completes, create its holding (status uploaded) and queue insurer
  // detection. One holding per document and one live job per holding; off unless HOLDINGS_ENABLED is exactly "true". `policyHoldings` is built below.
  const afterOcrComplete = async ({ householdId, documentId, documentKind, consentGrantId }) => {
    if (!holdingsEnabled(options.env ?? process.env) || !HOLDING_DOCUMENT_KINDS.includes(documentKind)) return;
    const existing = await database.one('SELECT id FROM policy_holdings WHERE household_id = ? AND document_id = ?', [householdId, documentId]);
    if (existing) return;
    const holding = await policyHoldings.create({ householdId, adultId: null, documentId, kind: 'retail_health' });
    await jobQueue.enqueue({
      kind: DETECT_INSURER_JOB_KIND, householdId, documentId, consentGrantId, payload: { holdingId: holding.id },
      dedupeKey: createHash('sha256').update(`${DETECT_INSURER_JOB_KIND}\u0000${holding.id}\u0000${documentId}`).digest('hex'), maxAttempts: HOLDING_JOB_MAX_ATTEMPTS,
    });
  };
  const ocr = new OcrRepository(database, { ...shared, afterComplete: afterOcrComplete });
  const profileAnswers = new ProfileAnswerRepository(database, shared);
  // Policy profile (migration 043, ADR 0024): identity of a policy and its owner confirmation. Off unless POLICY_FACTS_ENABLED=true.
  const policyProfiles = new PolicyProfileRepository(database, shared);
  const policyProfile = createPolicyProfileService({ repository: policyProfiles, ocr, env: options.env ?? process.env, clock: options.clock });
  // Policy facts (migration 044, ADR 0025): datapoints read from a document, each with verified evidence. Same switch as the profile.
  const policyFactsRepository = new PolicyFactsRepository(database, shared);
  const policyFacts = createPolicyFactsService({ repository: policyFactsRepository, ocr, env: options.env ?? process.env, clock: options.clock });
  // Holdings pipeline (complete.md 3.2, migrations 048-050): collate, conflicts, status. Off unless HOLDINGS_ENABLED=true. No model call.
  const holdingPipelineRepository = new HoldingPipelineRepository(database, shared);
  // Memory and chat v1 (migrations 053-054, ADR 0031). Off unless MEMORY_ENABLED=true; the model path is off unless CHAT_MODEL_ENABLED=true.
  // The gateway is the existing one (privacy gate, per-household daily budget, provider_calls); `options.modelGateway` lets a test inject a fixture.
  const env = options.env ?? process.env;
  const memoryChunks = new MemoryChunkRepository(database, shared);
  const loadKnownIdentifiers = createHouseholdIdentifierLoader({ database, columnCrypto });
  const modelGateway = options.modelGateway ?? createChatModelGateway({
    env, router: createModelRouter({ env }), providerCalls,
    budgetFor: createHouseholdDayBudget({ ledger: runtimeLimits, maxUsd: Number(env.CHAT_DAILY_BUDGET_USD) > 0 ? Number(env.CHAT_DAILY_BUDGET_USD) : 0.5 }),
    embedClientFor: route => createVoyageEmbedClient({ apiKey: route.apiKey, model: route.model, fetchImpl: options.fetchImpl }),
  });
  const memory = createMemoryService({ holdingRepository: holdingPipelineRepository, chunks: memoryChunks, clauses, database, gateway: modelGateway, loadKnownIdentifiers, env });
  const holdings = createHoldingsService({ repository: holdingPipelineRepository, jobQueue, policyFacts, referenceFacts: options.referenceFacts, memory, analytics, env });
  const chatRepository = new ChatRepository(database, { ...shared, households });
  const chatV1 = createChatV1Service({ chatRepository, holdingRepository: holdingPipelineRepository, chunks: memoryChunks, clauses, database, memory, gateway: modelGateway, loadKnownIdentifiers, env, clock: options.clock });
  const documents = new DocumentRepository(database, { ...shared, coverageParameters, consents });
  const access = new TenantAccessService(database, { auth, authTokens, households, consents, env: options.env ?? {}, columnCrypto });
  const householdApp = new HouseholdAppRepository(database, shared);
  const app = createHouseholdAppService({ access, appRepository: householdApp, consents, clock: options.clock });
  const userDataRepository = new UserDataRepository(database, { ...shared, households, auth });
  const userData = createUserDataService({ access, repository: userDataRepository, clock: options.clock });
  // Change log, snapshot and batched push (ADR 0028). Writes go through `userData`; reads through the existing readers.
  const syncRepository = new SyncRepository(database, { clock: options.clock, audit });
  const sync = createSyncService({ database, access, userData, userDataRepository, app, repository: syncRepository, audit, columnCrypto, clock: options.clock, limits: options.syncLimits });

  // Erasure of a case, member or household (S3). Reuses the document, run, structuring and clause erasure paths above.
  const erasure = new ErasureRepository(database, { clock: options.clock, audit, consents, documents, profileAnswers, userData: userDataRepository, appEvents, policyStructuring, clauses });

  const personRecordRepository = new PersonRecordRepository(database, { ...shared, households });
  // Holdings and memory (migrations 048-052, ADR 0032). Behaviour behind them is off unless HOLDINGS_ENABLED is exactly "true".
  const policyHoldings = new PolicyHoldingRepository(database, { ...shared, households });
  const memoryFacts = new MemoryFactRepository(database, { ...shared, households });
  const declarations = new DeclarationRepository(database, { ...shared, households });
  const premiums = new PremiumRepository(database, { ...shared, households });
  const personRecords = createPersonRecordService({ access, repository: personRecordRepository, clock: options.clock });

  // Holdings (migration 048): product detection, owner confirmation and the reference import. Off unless HOLDINGS_ENABLED=true.
  const holdingProductRepository = new HoldingProductRepository(database, shared);
  const holdingProducts = createHoldingProductService({
    repository: holdingProductRepository, policyHoldings, policyProfiles, referenceCache: new ReferenceCacheRepository(database), jobQueue, ocr, pipeline: holdings, env: options.env ?? process.env, clock: options.clock, client: options.referenceClient ?? null,
  });

  const networkHospitals = createNetworkHospitalService({ repository: new NetworkHospitalRepository(database), holdingRepository: holdingProductRepository, policyHoldings, env: options.env ?? process.env, client: options.referenceClient ?? null });

  return {
    analytics, networkHospitals, holdingProducts, holdingProductRepository, policyHoldings, memoryFacts, declarations, premiums, holdingsEnabled: () => holdingsEnabled(options.env ?? process.env),
    personRecords, personRecordRepository, erasure, jobQueue, sync, syncRepository, access, app, householdApp, userData, userDataRepository, audit, appEvents, providerCalls, runtimeLimits, auth, authTokens, authTokenRepository, columnCrypto, identities, profileAnswers, policyProfiles, policyProfile, policyFactsRepository, policyFacts, households, consents, cases, workflows, ocr, coverageParameters, policyStructuring, clauses, catalogueReviews, curatedProducts, documents,
    holdings, holdingPipelineRepository, memory, memoryChunks, chatRepository, chatV1, modelGateway,
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
