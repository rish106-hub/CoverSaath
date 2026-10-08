import { createPolicyBreakdownService } from './service.js';
import { createLiveModelRunner } from './agents/model-runner.js';
import { createEncryptedLocalByteStorage } from '../document-intake/encrypted-local-storage.js';
import { createSarvamDocAiClient } from '../../integrations/index.js';
import { chunkPdf } from './ocr/pdf-tools.js';
import { readZip } from './ocr/zip-reader.js';
import { createReferenceProvider } from './references/reference-store.js';
import { createInsurerDisclosureRefresher } from './references/insurer-reported-disclosures.js';
import { createNetworkCountRefresher, NETWORK_LOCATOR_DISCOVERY_SOURCES } from './references/network-counts.js';
import { createLiveOfficialSourceAdapter } from './references/official/live-adapter.js';
import { OFFICIAL_SOURCE_REGISTRY } from './references/official/registry.js';
import { createOfficialWordingService, insurerSiteWordingLocator, irdaiWordingLocator, registryWordingLocator } from './references/official/wording-service.js';
import { INSURER_SITE_SOURCES } from './references/official/insurer-site-sources.js';
import { createIrdaiProductRepository, IRDAI_DISCOVERY_SOURCES } from './references/official/irdai-product-repository.js';

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
  // Official sources: network use only with OFFICIAL_SOURCE_FETCH_ENABLED=true (kill switch), only to registry URLs.
  const fetchEnabled = env.OFFICIAL_SOURCE_FETCH_ENABLED === 'true';
  const sourceAdapter = overrides.officialSourceAdapter ?? createLiveOfficialSourceAdapter({ registry: OFFICIAL_SOURCE_REGISTRY, discoverySources: [...IRDAI_DISCOVERY_SOURCES, ...NETWORK_LOCATOR_DISCOVERY_SOURCES, ...INSURER_SITE_SOURCES], enabled: fetchEnabled });
  const wordingCache = env.OFFICIAL_WORDING_CACHE_DIR || '.local/official-wordings';
  const log = entry => console.warn(JSON.stringify({ level: 'warn', ...entry }));
  const officialWording = overrides.officialWording !== undefined ? overrides.officialWording
    : fetchEnabled ? createOfficialWordingService({
      adapter: sourceAdapter,
      cacheDirectory: wordingCache,
      // Exact UIN only: the operator registry, then IRDAI's central product repository (all insurers, filed to mid-2022),
      locators: [
        registryWordingLocator({ adapter: sourceAdapter, registry: OFFICIAL_SOURCE_REGISTRY }),
        irdaiWordingLocator({ repository: createIrdaiProductRepository({ adapter: sourceAdapter, cacheDirectory: `${wordingCache}/irdai-index` }) }),
        // Then the insurer's own site (32 insurers in the directory; 19 have server-rendered wording pages).
        insurerSiteWordingLocator({ adapter: sourceAdapter, log }),
      ],
      log,
    }) : null;
  const referenceProvider = overrides.references ?? createReferenceProvider({ directory: env.BREAKDOWN_REFERENCE_DIR || null });
  const refresher = !overrides.references && fetchEnabled && env.BREAKDOWN_REFERENCE_DIR
    ? createInsurerDisclosureRefresher({ adapter: sourceAdapter, registry: OFFICIAL_SOURCE_REGISTRY, directory: env.BREAKDOWN_REFERENCE_DIR, log, onUpdated: () => referenceProvider.invalidate?.() })
    : null;
  const networkCounts = overrides.networkCounts !== undefined ? overrides.networkCounts
    : !overrides.references && fetchEnabled && env.BREAKDOWN_REFERENCE_DIR
      ? createNetworkCountRefresher({ adapter: sourceAdapter, directory: env.BREAKDOWN_REFERENCE_DIR, log, onUpdated: () => referenceProvider.invalidate?.() })
      : null;
  // Each read starts a background refresh when a source is due; the provider picks the new file up on its next reload.
  const references = refresher ? () => { refresher.refreshIfStale(); return referenceProvider(); } : referenceProvider;
  return createPolicyBreakdownService({
    database,
    services,
    storage,
    pageTextProvider,
    modelRunner,
    clock: overrides.clock,
    schedule: overrides.schedule,
    references,
    officialWording,
    networkCounts,
    scanMode: overrides.scanMode ?? (env.DOCUMENT_SCAN_MODE === 'structural_only' ? 'structural_only' : 'antivirus_required'),
  });
}
