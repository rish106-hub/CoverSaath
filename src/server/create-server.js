import http from 'node:http';
import { publicError } from './http/errors.js';
import { prepareJsonResponse, sendJson } from './http/request.js';
import { assertLocalRequest } from './http/security.js';
import { createRateLimiter } from '../shared/http/index.js';
import { openDatabase } from '../backend/database/index.js';
import { createBackendServices, createCoverageAnalysisPort, createDocumentUploadService } from '../backend/services/index.js';
import {
  createClamdScanner,
  createDocumentScanWorker,
  createEncryptedLocalByteStorage,
  inspectPdf,
} from '../modules/document-intake/index.js';
import {
  createEmailProvider,
  createGnaniVoiceProvider,
  createPineLabsPaymentProvider,
  createSarvamOcrProvider,
} from '../integrations/index.js';
import { handleV1BackendRoute } from './routes/v1-backend-routes.js';
import { readServerConfig } from './config.js';
import { createGeminiCoverageRegistryFactory } from '../modules/ai-analysis/index.js';

export function createApiServer({
  env = process.env,
  database: injectedDatabase,
  databasePath,
  backendServices,
  analysisLiveModelDriver,
  documentScanner,
} = {}) {
  const config = readServerConfig(env);
  // Built at startup so an invalid encryption key or scanner setting fails before listening.
  const documentStorage = config.documents.encryptionKeyBase64
    ? createEncryptedLocalByteStorage({ baseDirectory: config.documents.storagePath, key: config.documents.encryptionKeyBase64 })
    : null;
  const scanner = documentScanner
    ?? (config.documents.clamd ? createClamdScanner(config.documents.clamd) : null);
  const rateLimiter = createRateLimiter({ limit: config.rateLimitPerMinute });
  // The live path always re-checks current document consent from the database
  // immediately before every provider call and always runs the privacy gate.
  // Only the model driver (loadModel/createAgent) may be injected; there is no
  // option to replace the registry, the validator or the parameter policy.
  const modelDispatchValidator = request => createCoverageAnalysisPort(getBackend()).authorizeModelDispatch(request);
  const liveRegistryFactory = createGeminiCoverageRegistryFactory({
    env,
    ...(analysisLiveModelDriver?.loadModel ? { loadModel: analysisLiveModelDriver.loadModel } : {}),
    ...(analysisLiveModelDriver?.createAgent ? { createAgent: analysisLiveModelDriver.createAgent } : {}),
    preDispatchValidator: modelDispatchValidator,
    // The household's own identifiers are reloaded server-side for every model
    // request and redacted by the privacy gate; a loader failure stops dispatch.
    knownIdentifierLoader: caseId => createCoverageAnalysisPort(getBackend()).loadKnownIdentifiers(caseId),
  });
  const ownsDatabase = !injectedDatabase;
  let database = injectedDatabase ?? null;
  let services = backendServices ?? null;
  let documentUploads = null;
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
      inspectFile: validated => (validated.detectedMimeType === 'application/pdf' ? inspectPdf(validated.bytes) : null),
      limits: {
        maxDocumentsPerCase: config.documents.maxDocumentsPerCase,
        maxPendingPerHousehold: config.documents.maxPendingPerHousehold,
      },
    });
    return { database, services, documentUploads };
  };
  const integrations = {
    sarvam: createSarvamOcrProvider({ env }),
    gnani: createGnaniVoiceProvider({ env }),
    pineLabs: createPineLabsPaymentProvider({ env }),
    email: createEmailProvider({ env }),
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
        const backendResult = await handleV1BackendRoute({ req, url, ...backend, integrations, config, liveRegistryFactory });
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
  // The database closes only after in-flight document work has finished.
  if (ownsDatabase) server.once('close', () => { workerStopped.then(() => database?.close()); });
  return server;
}
