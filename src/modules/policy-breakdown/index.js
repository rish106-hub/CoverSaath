import { createPolicyBreakdownService } from './service.js';
import { createLiveModelRunner } from './agents/model-runner.js';
import { createEncryptedLocalByteStorage } from '../document-intake/encrypted-local-storage.js';
import { createSarvamDocAiClient } from '../../integrations/index.js';
import { chunkPdf } from './ocr/pdf-tools.js';
import { readZip } from './ocr/zip-reader.js';
import { createReferenceProvider } from './references/reference-store.js';

export { createPolicyBreakdownService } from './service.js';
export { SECTIONS, PARAMETER_INDEX, EXTRACTION_SECTIONS, ANALYSIS_SECTIONS, sectionByNumber, criticalParameters } from './sections/index.js';
export { BREAKDOWN_CONTRACT_VERSION, EVIDENCE_STATES } from './contracts.js';
export { createFixtureModelRunner, createLiveModelRunner, readBreakdownModelConfig } from './agents/model-runner.js';

const unavailable = (code, message) => { throw Object.assign(new Error(message), { code, statusCode: 503 }); };

/**
 * Builds the policy breakdown service from environment configuration.
 * Live providers are created lazily, so a server without keys still starts and fails closed per request.
 * `overrides` lets tests inject fixture storage, page-text providers and model runners.
 */
export function createPolicyBreakdownFromEnv({ database, services, env = process.env, overrides = {} } = {}) {
  let storage = overrides.storage ?? null;
  if (!storage && env.DOCUMENT_ENCRYPTION_KEY_BASE64) {
    storage = createEncryptedLocalByteStorage({ baseDirectory: env.DOCUMENT_STORAGE_PATH || '.local/documents', key: env.DOCUMENT_ENCRYPTION_KEY_BASE64 });
  }
  let liveRunner = null;
  let liveOcr = null;
  const modelRunner = mode => {
    if (overrides.modelRunner) return overrides.modelRunner(mode);
    if (mode !== 'live') unavailable('FIXTURE_MODE_UNAVAILABLE', 'Fixture execution is available only in tests and evaluation.');
    liveRunner ||= createLiveModelRunner({ env });
    return liveRunner;
  };
  const pageTextProvider = mode => {
    if (overrides.pageTextProvider) return overrides.pageTextProvider(mode);
    if (mode !== 'live') unavailable('FIXTURE_MODE_UNAVAILABLE', 'Fixture execution is available only in tests and evaluation.');
    if (!env.SARVAM_API_KEY) unavailable('SARVAM_NOT_CONFIGURED', 'SARVAM_API_KEY is not configured in .env.local.');
    liveOcr ||= createSarvamDocAiClient({ apiKey: env.SARVAM_API_KEY, language: env.SARVAM_DOCUMENT_LANGUAGE || 'en-IN', splitPdf: chunkPdf, readZip, downloadHostSuffixes: (env.SARVAM_DOWNLOAD_HOST_SUFFIXES || '').split(',').map(item => item.trim().toLowerCase()).filter(Boolean) });
    return liveOcr;
  };
  return createPolicyBreakdownService({
    database,
    services,
    storage,
    pageTextProvider,
    modelRunner,
    clock: overrides.clock,
    schedule: overrides.schedule,
    references: overrides.references ?? createReferenceProvider({ directory: env.BREAKDOWN_REFERENCE_DIR || null }),
    scanMode: overrides.scanMode ?? (env.DOCUMENT_SCAN_MODE === 'structural_only' ? 'structural_only' : 'antivirus_required'),
  });
}
