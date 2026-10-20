import http from 'node:http';
import { publicError } from './http/errors.js';
import { prepareJsonResponse, sendJson } from './http/request.js';
import { assertLocalRequest } from './http/security.js';
import { createRateLimiter } from '../shared/http/index.js';
import { openDatabase } from '../backend/database/index.js';
import { createBackendServices, createCoverageAnalysisPort, createDecisionCatalogueService, createDocumentUploadService, createPolicyEvidenceService, createPolicyStructuringService } from '../backend/services/index.js';
import {
  createClamdScanner,
  createDocumentScanWorker,
  createEncryptedLocalByteStorage,
  createOcrService,
  createSandboxedPdfInspector,
  createSandboxedPdfSegmenter,
} from '../features/input/index.js';
import {
  createEmailProvider,
  createGnaniVoiceProvider,
  createPineLabsPaymentProvider,
  createSarvamOcrProvider,
} from '../integrations/index.js';
import { handleV1BackendRoute } from './routes/v1-backend-routes.js';
import { readServerConfig } from './config.js';
import { createGeminiCoverageRegistryFactory, createSharedProjectBudget, createStructuringModelCallFactory } from '../features/ai-analysis/index.js';

export function createApiServer({
  env = process.env,
  database: injectedDatabase,
  databasePath,
  backendServices,
  analysisLiveModelDriver,
  documentScanner,
  sarvamFetch,
} = {}) {
  const config = readServerConfig(env);
  // Built at startup so an invalid encryption key or scanner setting fails before listening.
  const documentStorage = config.documents.encryptionKeyBase64
    ? createEncryptedLocalByteStorage({ baseDirectory: config.documents.storagePath, key: config.documents.encryptionKeyBase64 })
    : null;
  const scanner = documentScanner
    ?? (config.documents.clamd ? createClamdScanner(config.documents.clamd) : null);
  // Untrusted PDF structure is parsed only in a permission-restricted child process (ADR 0005).
  // Events carry reason codes and numbers only, never document content.
  const pdfInspector = documentStorage
    ? createSandboxedPdfInspector({
      onEvent: event => {
        if (event.type === 'pdf_inspection_busy' || (event.type === 'pdf_inspection_failed' && event.reason !== 'rejected')) {
          console.warn(JSON.stringify({ event: event.type, reason: event.reason ?? null, exitCode: event.exitCode ?? null, signal: event.signal ?? null }));
        }
      },
    })
    : null;
  const pdfSegmenter = documentStorage ? createSandboxedPdfSegmenter() : null;
  const rateLimiter = createRateLimiter({ limit: config.rateLimitPerMinute });
  // The live path always re-checks current document consent from the database
  // immediately before every provider call and always runs the privacy gate.
  // Only the model driver (loadModel/createAgent) may be injected; there is no
  // option to replace the registry, the validator or the parameter policy.
  const modelDispatchValidator = request => createCoverageAnalysisPort(getBackend()).authorizeModelDispatch(request);
  // Analysis and structuring share one project budget, so the configured cap bounds their total spend.
  const projectBudget = createSharedProjectBudget();
  const liveRegistryFactory = createGeminiCoverageRegistryFactory({
    env,
    projectBudget,
    ...(analysisLiveModelDriver?.loadModel ? { loadModel: analysisLiveModelDriver.loadModel } : {}),
    ...(analysisLiveModelDriver?.createAgent ? { createAgent: analysisLiveModelDriver.createAgent } : {}),
    preDispatchValidator: modelDispatchValidator,
    // The household's own identifiers are reloaded server-side for every model
    // request and redacted by the privacy gate; a loader failure stops dispatch.
    knownIdentifierLoader: caseId => createCoverageAnalysisPort(getBackend()).loadKnownIdentifiers(caseId),
  });
  // Policy structuring (ADR 0006) calls Gemini only through the model gateway with a document-specific
  // consent check before every call. Same injectable model driver as live analysis, nothing else.
  const createStructuringModelCall = createStructuringModelCallFactory({
    env,
    projectBudget,
    ...(analysisLiveModelDriver?.loadModel ? { loadModel: analysisLiveModelDriver.loadModel } : {}),
    ...(analysisLiveModelDriver?.createAgent ? { createAgent: analysisLiveModelDriver.createAgent } : {}),
  });
  let structuringService = null;
  const getStructuringService = () => {
    structuringService ||= createPolicyStructuringService({
      services: getBackend().services,
      loadKnownIdentifiers: caseId => createCoverageAnalysisPort(getBackend()).loadKnownIdentifiers(caseId),
      createModelCall: createStructuringModelCall,
      env,
      onError: event => console.warn(JSON.stringify({ event: 'policy_structuring_failed', code: event.code })),
    });
    return structuringService;
  };
  // Question-time Gemini use (ADR 0008) goes through the same gateway, budget and privacy gate as structuring.
  let evidenceService = null;
  const getEvidenceService = () => {
    evidenceService ||= createPolicyEvidenceService({
      services: getBackend().services,
      loadKnownIdentifiers: caseId => createCoverageAnalysisPort(getBackend()).loadKnownIdentifiers(caseId),
      createModelCall: createStructuringModelCall,
      env,
    });
    return evidenceService;
  };
  let catalogueService = null;
  const getCatalogueService = () => {
    catalogueService ||= createDecisionCatalogueService({ services: getBackend().services, evidence: getEvidenceService(), env });
    return catalogueService;
  };
  const ownsDatabase = !injectedDatabase;
  let database = injectedDatabase ?? null;
  let services = backendServices ?? null;
  let documentUploads = null;
  let ocrService = null;
  const getBackend = () => {
    database ||= openDatabase({ path: databasePath ?? env.DATABASE_PATH ?? '.local/knowvia.sqlite' });
    services ||= createBackendServices(database, {
      env,
      sessionDurationMs: config.sessionTtlMs,
      maxActiveSessions: config.maxSessions,
    });
    documentUploads ||= createDocumentUploadService({
      services,
      repository: services.documents,
      storage: documentStorage,
      scanner,
      cancelOcrJob: async ({ provider, jobRef, requestId }) => {
        const integration = integrations[provider];
        if (!integration || typeof integration.cancelJob !== 'function') {
          throw Object.assign(new Error('OCR cancellation provider is unavailable.'), { code: 'OCR_PROVIDER_NOT_CONFIGURED' });
        }
        return integration.cancelJob({
          jobRef,
          requestId,
          authorization: { authorized: true, purpose: 'document_erasure' },
        });
      },
      inspectFile: validated => (validated.detectedMimeType === 'application/pdf' ? pdfInspector.inspect(validated.bytes) : null),
      limits: {
        maxDocumentsPerCase: config.documents.maxDocumentsPerCase,
        maxPendingPerHousehold: config.documents.maxPendingPerHousehold,
      },
    });
    return { database, services, documentUploads };
  };
  const integrations = {
    sarvam: createSarvamOcrProvider({ env, segmenter: pdfSegmenter, fetchImpl: sarvamFetch }),
    gnani: createGnaniVoiceProvider({ env }),
    pineLabs: createPineLabsPaymentProvider({ env }),
    email: createEmailProvider({ env }),
  };
  const getOcrService = () => {
    if (!documentStorage) {
      throw Object.assign(new Error('Document storage is not configured.'), { code: 'DOCUMENT_STORAGE_NOT_CONFIGURED', statusCode: 503 });
    }
    ocrService ||= createOcrService({
      repository: getBackend().services.ocr,
      provider: integrations.sarvam,
      byteReader: (storageReference, documentId) => documentStorage.read({ documentId, storageKey: storageReference }),
      mode: 'live',
      pollIntervalMs: env.SARVAM_OCR_POLL_INTERVAL_MS === undefined ? 2_000 : Number(env.SARVAM_OCR_POLL_INTERVAL_MS),
      jobDeadlineMs: env.SARVAM_OCR_JOB_DEADLINE_MS === undefined ? 15 * 60_000 : Number(env.SARVAM_OCR_JOB_DEADLINE_MS),
    });
    return ocrService;
  };
  const server = http.createServer(async (req, res) => {
    prepareJsonResponse(res);
    const send = (status, value) => sendJson(res, status, value);
    try {
      // Local-only isolation. Host checks also reduce DNS-rebinding exposure.
      assertLocalRequest(req);
      rateLimiter.check(req.socket.remoteAddress ?? 'local-unknown');
      const url = new URL(req.url, 'http://127.0.0.1:8787');
      if (url.pathname.startsWith('/api/v1/')) {
        const backend = getBackend();
        const backendResult = await handleV1BackendRoute({ req, url, ...backend, integrations, config, liveRegistryFactory, getOcrService, getStructuringService, getEvidenceService, getCatalogueService });
        // A body refused mid-stream is never drained: close the connection after answering so the
        // client gets the 413 and the server stops receiving bytes.
        if (backendResult.status === 413) res.setHeader('Connection', 'close');
        return send(backendResult.status, backendResult.body);
      }
      return send(404, { error: { code: 'ROUTE_NOT_FOUND', message: 'Use the authenticated /api/v1 API.' } });
    } catch (error) {
      const result = publicError(error);
      send(result.status, result.body);
    }
  });
  // Background document work (malware scans, deletion of bytes after revocation or a malware hit)
  // runs only when encrypted storage is configured. The database row is the durable queue.
  let workerStopped = Promise.resolve();
  if (documentStorage) {
    let worker = null;
    let orphanTimer = null;
    const warn = event => console.warn(JSON.stringify(event));
    server.once('listening', () => {
      try {
        const { documentUploads: uploads } = getBackend();
        worker = createDocumentScanWorker({
          listPendingDocumentIds: async limit => uploads.listWorkDocumentIds(limit),
          scanDocument: documentId => uploads.processDocument(documentId),
          sweepIntervalMs: config.documents.workerSweepMs,
          onEvent: event => {
            if (event.type === 'scan_exhausted' || event.type === 'sweep_failed') {
              warn({ event: `document_${event.type}`, code: event.code ?? null, attempts: event.attempts ?? null });
            }
          },
        });
        uploads.setOnStored(documentId => worker.schedule(documentId));
        worker.start();
        const sweepOrphans = () => uploads.sweepOrphans().catch(() => warn({ event: 'document_orphan_sweep_failed' }));
        sweepOrphans();
        orphanTimer = setInterval(sweepOrphans, 60 * 60 * 1000);
        orphanTimer.unref?.();
        if (scanner) {
          scanner.ping().then(ok => { if (!ok) warn({ event: 'document_scanner_unreachable' }); }, () => warn({ event: 'document_scanner_unreachable' }));
        }
      } catch {
        warn({ event: 'document_worker_start_failed' });
      }
    });
    server.once('close', () => {
      clearInterval(orphanTimer);
      workerStopped = worker ? worker.stop().catch(() => {}) : Promise.resolve();
    });
  }
  if (pdfInspector) server.once('close', () => pdfInspector.close());
  // The database closes only after in-flight document work has finished.
  if (ownsDatabase) server.once('close', () => { workerStopped.then(() => database?.close()); });
  server.structuring = { settle: (documentId, workflowRunId) => structuringService?.settle(documentId, workflowRunId) };
  return server;
}
