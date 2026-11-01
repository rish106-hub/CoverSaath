import http from 'node:http';
import { publicError } from './http/errors.js';
import { prepareJsonResponse, sendJson } from './http/request.js';
import { assertLocalRequest, clientRateKey } from './http/security.js';
import { createRateLimiter } from '../shared/http/index.js';
import { createDatabase } from '../backend/database/postgres/db.js';
import { createPostgresPool, postgresPoolOptionsFromEnv } from '../backend/database/postgres/pool.js';
import { createBackendServices, createCoverageAnalysisPort, createDecisionCatalogueService, createDocumentUploadService, createHouseholdPreviewService, createPolicyEvidenceService, createPolicyStructuringService } from '../backend/services/index.js';
import {
  createClamdScanner,
  createDocumentScanWorker,
  createEncryptedDatabaseByteStorage,
  createEncryptedLocalByteStorage,
  createFallbackByteStorage,
  createOcrService,
  createSandboxedPdfInspector,
  createSandboxedPdfSegmenter,
} from '../features/input/index.js';
import {
  createEmailProvider,
  createGnaniVoiceProvider,
  createIntakeConnectorStubs,
  createPineLabsPaymentProvider,
  createSarvamOcrProvider,
} from '../integrations/index.js';
import { INTAKE_CONNECTORS } from '../contracts/index.js';
import { handleV1BackendRoute } from './routes/v1-backend-routes.js';
import { createColumnCrypto, readDataEncryptionConfig } from '../backend/security/column-crypto.js';
import { createAppEventRecorder, deriveEventHmacKey } from '../backend/services/app-event-recorder.js';
import { createSharedRateLimiter } from './http/shared-rate-limiter.js';
import { pathAttribution, requestEventName, routeTemplate } from './http/event-context.js';
import { readIdentityConfig, readServerConfig } from './config.js';
import { createGeminiCoverageRegistryFactory, createSharedProjectBudget, createStructuringModelCallFactory } from '../features/ai-analysis/index.js';

// `database`, when injected, is an async PostgreSQL interface (createDatabase) that the caller
// owns and closes. Otherwise the server builds one from DATABASE_URL (and the optional
// DATABASE_SSL_CA_PATH) on the first /api/v1 request and ends its pool when the server closes.
export function createApiServer({
  env = process.env,
  database: injectedDatabase,
  backendServices,
  analysisLiveModelDriver,
  documentScanner,
  sarvamFetch,
} = {}) {
  const config = readServerConfig(env);
  const identity = readIdentityConfig(env);
  // Built at startup so an invalid encryption key or scanner setting fails before listening.
  // Document bytes live in the database by default (DOCUMENT_STORAGE_BACKEND=database) or on the server filesystem
  // (=filesystem). Both write the same encrypted CSD1 envelope. Whichever is not the primary stays readable, so documents
  // stored before a switch still open and a rollback loses nothing. The database is built lazily (its pool may not exist yet).
  const ownsDatabase = !injectedDatabase;
  let database = injectedDatabase ?? null;
  const ensureDatabase = () => (database ||= createDatabase(createPostgresPool(postgresPoolOptionsFromEnv(env))));
  const documentStorage = (() => {
    const key = config.documents.encryptionKeyBase64;
    if (!key) return null;
    const filesystem = createEncryptedLocalByteStorage({ baseDirectory: config.documents.storagePath, key });
    const inDatabase = createEncryptedDatabaseByteStorage({ database: ensureDatabase, key });
    return config.documents.storageBackend === 'database'
      ? createFallbackByteStorage({ primary: inDatabase, fallback: filesystem })
      : createFallbackByteStorage({ primary: filesystem, fallback: inDatabase });
  })();
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
  // Activity events and the database-backed limiter both need the data key (payload sealing, keyed client hash). It is read
  // here so a missing key in production stops startup instead of the first request (ADR 0014).
  const needsDataKey = config.events.enabled || config.rateLimitBackend === 'database';
  const dataEncryption = needsDataKey ? readDataEncryptionConfig(env) : null;
  const columnCrypto = dataEncryption ? createColumnCrypto(dataEncryption) : null;
  const eventHmacKey = dataEncryption ? deriveEventHmacKey(dataEncryption) : null;
  let recorder = null;
  let closing = false;
  const recordEvent = event => recorder?.record(event);
  let lastTelemetryWarning = 0;
  const warnTelemetry = event => {
    const now = Date.now();
    if (now - lastTelemetryWarning < 60_000) return;
    lastTelemetryWarning = now;
    console.warn(JSON.stringify(event));
  };
  const localRateLimiter = createRateLimiter({ limit: config.rateLimitPerMinute });
  // Shared limiter: the per-process limiter still runs first and is the fallback if the database is unavailable.
  const rateLimiter = config.rateLimitBackend === 'database'
    ? createSharedRateLimiter({
      local: localRateLimiter,
      store: { consumeRequest: async (keyHash, windowMs) => (await getBackend()).services.runtimeLimits.consumeRequest(keyHash, windowMs) },
      hmacKey: eventHmacKey,
      limit: config.rateLimitPerMinute,
      onFallback: () => warnTelemetry({ event: 'rate_limit_store_unavailable' }),
    })
    : { check: key => localRateLimiter.check(key) };
  // The live path always re-checks current document consent from the database
  // immediately before every provider call and always runs the privacy gate.
  // Only the model driver (loadModel/createAgent) may be injected; there is no
  // option to replace the registry, the validator or the parameter policy.
  const modelDispatchValidator = async request => createCoverageAnalysisPort(await getBackend()).authorizeModelDispatch(request);
  const loadKnownIdentifiers = async caseId => createCoverageAnalysisPort(await getBackend()).loadKnownIdentifiers(caseId);
  // Analysis and structuring share one project budget, so the configured cap bounds their total spend.
  // With MODEL_BUDGET_BACKEND=database the spend cap lives in PostgreSQL: it holds across machines and restarts.
  const projectBudget = createSharedProjectBudget(config.budgetBackend === 'database'
    ? {
      ledger: {
        reserveBudget: async request => (await getBackend()).services.runtimeLimits.reserveBudget(request),
        settleBudget: async request => (await getBackend()).services.runtimeLimits.settleBudget(request),
        budgetSnapshot: async (scope, maxUsd) => (await getBackend()).services.runtimeLimits.budgetSnapshot(scope, maxUsd),
      },
    }
    : {});
  // Metadata-only provider events (outcome, latency, tokens, cost); never prompt or output text.
  const onProviderEvent = event => {
    const outcome = String(event.outcome ?? '').toLowerCase();
    recordEvent({
      name: 'provider_call', provider: 'google', outcome: /^[a-z0-9_.-]{1,64}$/.test(outcome) ? outcome : 'error',
      code: event.outcome === 'ok' ? null : event.outcome, durationMs: event.latencyMs,
      payload: { task: event.task, dispatched: event.dispatched, inputTokens: event.inputTokens, outputTokens: event.outputTokens, costMicroUsd: Math.round((event.costUsd ?? 0) * 1_000_000) },
    });
  };
  const liveRegistryFactory = createGeminiCoverageRegistryFactory({
    env,
    projectBudget,
    onProviderEvent,
    ...(analysisLiveModelDriver?.loadModel ? { loadModel: analysisLiveModelDriver.loadModel } : {}),
    ...(analysisLiveModelDriver?.createAgent ? { createAgent: analysisLiveModelDriver.createAgent } : {}),
    preDispatchValidator: modelDispatchValidator,
    // The household's own identifiers are reloaded server-side for every model
    // request and redacted by the privacy gate; a loader failure stops dispatch.
    knownIdentifierLoader: loadKnownIdentifiers,
  });
  // Policy structuring (ADR 0006) calls Gemini only through the model gateway with a document-specific
  // consent check before every call. Same injectable model driver as live analysis, nothing else.
  const createStructuringModelCall = createStructuringModelCallFactory({
    env,
    projectBudget,
    onProviderEvent,
    ...(analysisLiveModelDriver?.loadModel ? { loadModel: analysisLiveModelDriver.loadModel } : {}),
    ...(analysisLiveModelDriver?.createAgent ? { createAgent: analysisLiveModelDriver.createAgent } : {}),
  });
  // The service getters are async because the backend is. Each awaits the backend first and
  // only then creates its service, so concurrent first requests share one instance.
  let structuringService = null;
  const getStructuringService = async () => {
    const { services } = await getBackend();
    structuringService ||= createPolicyStructuringService({
      services,
      loadKnownIdentifiers,
      createModelCall: createStructuringModelCall,
      env,
      onError: event => console.warn(JSON.stringify({ event: 'policy_structuring_failed', code: event.code })),
    });
    return structuringService;
  };
  // Question-time Gemini use (ADR 0008) goes through the same gateway, budget and privacy gate as structuring.
  let evidenceService = null;
  const getEvidenceService = async () => {
    const { services } = await getBackend();
    evidenceService ||= createPolicyEvidenceService({
      services,
      loadKnownIdentifiers,
      createModelCall: createStructuringModelCall,
      env,
    });
    return evidenceService;
  };
  let catalogueService = null;
  const getCatalogueService = async () => {
    const { services } = await getBackend();
    const evidence = await getEvidenceService();
    catalogueService ||= createDecisionCatalogueService({ services, evidence, env });
    return catalogueService;
  };
  let householdPreviewService = null;
  const getHouseholdPreviewService = async () => {
    const { services } = await getBackend();
    const catalogue = await getCatalogueService();
    householdPreviewService ||= createHouseholdPreviewService({ services, catalogue });
    return householdPreviewService;
  };
  let services = backendServices ?? null;
  let documentUploads = null;
  let ocrService = null;
  // Memoised: every request shares one backend. A failed build (for example a missing
  // DATABASE_URL) is not cached, so the next request tries again.
  let backendPromise = null;
  let housekeepingTimer = null;
  const buildBackend = async () => {
    ensureDatabase();
    services ||= createBackendServices(database, {
      env,
      sessionDurationMs: config.sessionTtlMs,
      maxActiveSessions: config.maxSessions,
      ...(columnCrypto ? { columnCrypto } : {}),
    });
    if (config.events.enabled && !recorder) {
      // An injected `backendServices` may lack the event repository; events are then simply not recorded.
      const eventRepository = services.appEvents;
      if (eventRepository) {
        eventRepository.columnCrypto ??= columnCrypto;
        recorder = createAppEventRecorder({
          repository: eventRepository, hmacKey: eventHmacKey, retentionDays: config.events.retentionDays,
          onError: error => { if (!closing) warnTelemetry({ event: 'app_event_write_failed', code: typeof error?.code === 'string' ? error.code : null }); },
        });
      }
    }
    if (!housekeepingTimer && services.appEvents && services.runtimeLimits) {
      const sweep = () => {
        services.appEvents.purgeExpired().catch(() => {});
        services.runtimeLimits.purgeRequestWindows(10 * 60_000).catch(() => {});
      };
      housekeepingTimer = setInterval(sweep, 60 * 60 * 1000);
      housekeepingTimer.unref?.();
    }
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
  const getBackend = () => {
    backendPromise ??= buildBackend().catch(error => {
      backendPromise = null;
      // A backend that cannot be built (for example a missing DATABASE_URL) is a server condition,
      // not a client error. The cause stays server-side.
      throw Object.assign(new Error('The service is not available.'), { code: 'BACKEND_UNAVAILABLE', statusCode: 503, cause: error });
    });
    return backendPromise;
  };
  const integrations = {
    sarvam: createSarvamOcrProvider({ env, segmenter: pdfSegmenter, fetchImpl: sarvamFetch }),
    gnani: createGnaniVoiceProvider({ env }),
    pineLabs: createPineLabsPaymentProvider({ env }),
    email: createEmailProvider({ env }),
  };
  // Intake connectors that are not built are fail-closed stubs; upload is served by the document route.
  const intakeConnectors = createIntakeConnectorStubs({ ids: INTAKE_CONNECTORS.filter(connector => connector.availability !== 'available').map(connector => connector.id) });
  const getOcrService = async () => {
    if (!documentStorage) {
      throw Object.assign(new Error('Document storage is not configured.'), { code: 'DOCUMENT_STORAGE_NOT_CONFIGURED', statusCode: 503 });
    }
    const { services: backendServicesReady } = await getBackend();
    ocrService ||= createOcrService({
      repository: backendServicesReady.ocr,
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
    const startedAt = performance.now();
    let errorCode = null;
    const send = (status, value) => {
      errorCode = typeof value?.error?.code === 'string' ? value.error.code : null;
      return sendJson(res, status, value);
    };
    // One metadata-only activity event per finished request. The route is a template (ids replaced); the client address
    // is only ever hashed; the household, case or grant id is attributed only when the request succeeded.
    res.once('finish', () => {
      if (!recorder) return;
      const pathname = String(req.url ?? '').split('?')[0];
      const route = routeTemplate(pathname);
      const status = res.statusCode;
      recordEvent({
        name: requestEventName({ status, method: req.method, route }), route, method: req.method, status,
        durationMs: Math.round(performance.now() - startedAt), code: errorCode,
        clientKey: clientRateKey(req, config.network), adultUserId: req.appContext?.adultUserId,
        ...pathAttribution(pathname, status),
      });
    });
    try {
      // Local-only isolation. Host checks also reduce DNS-rebinding exposure.
      assertLocalRequest(req, config.network);
      await rateLimiter.check(clientRateKey(req, config.network), { shared: !/^\/api\/v1\/(?:health|live)(?:\?|$)/.test(req.url ?? '') });
      const url = new URL(req.url, 'http://127.0.0.1:8787');
      if (url.pathname.startsWith('/api/v1/')) {
        const backend = await getBackend();
        const backendResult = await handleV1BackendRoute({ req, url, ...backend, integrations, intakeConnectors, config, identity, liveRegistryFactory, getOcrService, getStructuringService, getEvidenceService, getCatalogueService, getHouseholdPreviewService });
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
    server.once('listening', async () => {
      try {
        const { documentUploads: uploads } = await getBackend();
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
  // Buffered activity events are written before the server's own database pool closes, and before a caller's close
  // callback runs (so an injected database is still open when the last batch is written).
  let eventsFlushed = Promise.resolve();
  server.once('close', () => {
    closing = true;
    clearInterval(housekeepingTimer);
    eventsFlushed = recorder ? recorder.close().catch(() => {}) : Promise.resolve();
  });
  const closeServer = server.close.bind(server);
  server.close = callback => closeServer(error => { eventsFlushed.then(() => callback?.(error)); });
  // The database closes only after in-flight document work and event writes have finished.
  // db.close() ends the pool this server created; an injected database belongs to its caller.
  if (ownsDatabase) server.once('close', () => { Promise.all([workerStopped, eventsFlushed]).then(() => database?.close()).catch(() => {}); });
  server.appEvents = { flush: () => recorder?.flush() ?? Promise.resolve(), stats: () => recorder?.stats() ?? null };
  server.structuring = { settle: (documentId, workflowRunId) => structuringService?.settle(documentId, workflowRunId) };
  return server;
}
