import { createHash } from 'node:crypto';
import { createInsuranceDataClient, referenceDataEnabled, ReferenceDataError } from '../../integrations/index.js';
import { detectInsurerCandidates, DETECTION_PAGES } from '../../features/insurer-detection/index.js';
import { flattenBlock } from '../../features/ai-analysis/eval-extractor.js';
import { createStoredPagesReader } from './readable-document.js';
import { cacheKeyFor, signatureFor } from './reference-data-port.js';
import { holdingsEnabled } from './holdings-flag.js';

// Holding product service (S-A3). Off unless HOLDINGS_ENABLED is exactly "true".
//
//   candidates()      local detection: pages 1 to 3 of the stored OCR text against the cached public registry names. Returns at most
//                     three { candidateId, insurerName, productName, rank }. The text is read through the shared consent gate and
//                     never leaves this process. No UIN is ever returned.
//   confirmProduct()  the owner picks a candidate. The server resolves the product and its UIN from the registry and writes the
//                     insurer and plan to policy_profiles as the owner's own statement (state 'reported', ADR 0009/0024), then links
//                     the holding and queues a reference import. The response carries the holding id, status and profile version.
//   importRegistry()  job: pages the registry listing into reference_cache ('registry/snapshot-v1').
//   importReference() job: fetches the export for one confirmed UIN into reference_cache. The job carries identifiers only; the UIN
//                     is read from the household's own policy_profiles row. reference_cache never gets a household column.
// UIN rule: the UIN stays in backend rows and in calls to the reference service. It is in no response body.

export { holdingsEnabled };
export const REFERENCE_IMPORT_JOB_KIND = 'reference.import';
export const DETECT_INSURER_JOB_KIND = 'holding.detect_insurer';
export const REGISTRY_CACHE_KEY = 'registry/snapshot-v1';
export const REGISTRY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const EXPORT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_REGISTRY_PAGES = 50;
const MAX_REGISTRY_PRODUCTS = 5000;
const CHUNK_CHARS = 1200;
const MAX_CHUNKS = 3000;
const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex');

const coded = (code, message, statusCode, extra = {}) => Object.assign(new Error(message), { code, statusCode, ...extra });
const notFound = () => coded('HOLDING_NOT_FOUND', 'Holding was not found.', 404);

/** Queue dedupe key: sha256 hex (64 characters) of kind, scope, identifier and version. One live job per tuple. */
export const referenceImportDedupeKey = ({ scope, identifier, version = 'v1' }) => sha256(`${REFERENCE_IMPORT_JOB_KIND}\u0000${scope}\u0000${identifier}\u0000${version}`);

/** The export key in reference_cache: a digest of the UIN, so the key shape is fixed and carries nothing else. */
export const exportCacheKey = uin => cacheKeyFor('products.exportByUin', { uin });

// UINs on policy documents are letters and digits only; registry rows may carry separators.
const profileUin = value => (typeof value === 'string' ? value.toUpperCase().replace(/[\s/._-]/g, '') : '');

/** Deterministic chunks of the exported pages (no model, no embedding): paragraphs packed up to CHUNK_CHARS. */
export function chunkExport(documents) {
  const chunks = [];
  for (const document of documents) {
    for (const page of document.sourcePages) {
      let current = '';
      let index = 0;
      const flush = () => {
        if (current.trim() && chunks.length < MAX_CHUNKS) {
          chunks.push({ id: `${document.documentId}:p${page.pageNumber}:c${index}`, documentId: document.documentId, pageNumber: page.pageNumber, text: current.trim() });
          index += 1;
        }
        current = '';
      };
      for (const paragraph of page.text.split(/\n{2,}|\r\n{2,}/)) {
        for (let start = 0; start < paragraph.length; start += CHUNK_CHARS) {
          const part = paragraph.slice(start, start + CHUNK_CHARS);
          if (current.length + part.length + 1 > CHUNK_CHARS) flush();
          current += `${current ? '\n' : ''}${part}`;
        }
      }
      flush();
    }
  }
  return chunks;
}

export function createHoldingProductService({
  repository, policyHoldings, policyProfiles, referenceCache, jobQueue, ocr, pipeline = null, env = process.env, clock = () => new Date(), client = null,
}) {
  for (const [name, dep] of Object.entries({ repository, policyHoldings, policyProfiles, referenceCache, jobQueue, ocr })) {
    if (!dep) throw new TypeError(`createHoldingProductService needs ${name}.`);
  }
  const enabled = () => holdingsEnabled(env);
  const requireEnabled = () => { if (!enabled()) throw coded('HOLDINGS_DISABLED', 'Holdings are disabled.', 503); };
  const readStoredPages = createStoredPagesReader({ ocr, clock });
  let built = client;
  const reference = () => { built ??= createInsuranceDataClient({ env }); return built; };

  async function readRegistry() {
    const row = await referenceCache.get(REGISTRY_CACHE_KEY);
    if (!row || row.signature !== signatureFor(row.body)) return null;
    return row.body;
  }

  async function enqueueRegistryRefresh(householdId) {
    if (!referenceDataEnabled(env)) return;
    await jobQueue.enqueue({
      kind: REFERENCE_IMPORT_JOB_KIND, householdId, payload: { scope: 'registry' },
      dedupeKey: referenceImportDedupeKey({ scope: 'registry', identifier: 'snapshot-v1' }),
    });
  }

  // First pages only, flattened to text. Null when the text may not be read now.
  async function firstPagesText(document) {
    const stored = await readStoredPages(document);
    if (!stored) return null;
    let text = '';
    for (const page of stored.pages) {
      if (page.page > DETECTION_PAGES) continue;
      for (const block of page.blocks ?? []) text += `${flattenBlock(block)}\n`;
    }
    return text;
  }

  // uploaded -> insurer_pending only; later statuses stay (the flow never moves backwards). The repository audits the change.
  async function markInsurerPending({ householdId, adultId, holdingId }) {
    if ((await repository.get(holdingId))?.status !== 'uploaded') return;
    await policyHoldings.setStatus({ householdId, adultId, holdingId, status: 'insurer_pending' });
  }

  async function detect({ householdId, document }) {
    const text = await firstPagesText(document);
    if (text === null) throw coded('HOLDING_DOCUMENT_NOT_READABLE', 'The document text is not available yet.', 409);
    const registry = await readRegistry();
    if (!registry) {
      await enqueueRegistryRefresh(householdId);
      throw coded('HOLDING_REGISTRY_UNAVAILABLE', 'The product list is not ready yet. Try again shortly.', 503, { retryable: true });
    }
    return detectInsurerCandidates({ text, registry });
  }

  return Object.freeze({
    enabled,

    /** Owner read: up to three candidates for the holding's document. */
    async candidates({ holding, document, adultUserId = null }) {
      requireEnabled();
      const candidates = await detect({ householdId: holding.householdId, document });
      if (candidates.length > 0) await markInsurerPending({ householdId: holding.householdId, adultId: adultUserId, holdingId: holding.id });
      const profile = await policyProfiles.get({ householdId: holding.householdId, documentId: document.id, sourceVersion: document.sourceVersion });
      return { holdingId: holding.id, profileVersion: profile?.version ?? 0, candidates };
    },

    /** Job: the same detection for a queued holding. Only the status moves; no candidate is stored. Returns the candidate count. */
    async runDetection({ householdId, documentId, holdingId }) {
      requireEnabled();
      const candidates = await detect({ householdId, document: { id: documentId, householdId } });
      if (candidates.length > 0) await markInsurerPending({ householdId, adultId: null, holdingId });
      return { candidates: candidates.length };
    },

    /** Owner statement: pick one candidate. `body` is { candidateId, expectedVersion }; nothing else is accepted. */
    async confirmProduct({ holding, document, adultUserId, body, idempotencyKey }) {
      requireEnabled();
      if (body === null || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['candidateId', 'expectedVersion'].includes(key))) {
        throw coded('HOLDING_PRODUCT_INVALID', 'Send candidateId and expectedVersion.', 400);
      }
      const { candidateId } = body;
      if (typeof candidateId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(candidateId)) throw coded('HOLDING_PRODUCT_INVALID', 'candidateId is invalid.', 400);
      // Required, so a retry of the same request carries the same statement and replays (the profile digest includes it).
      if (!Number.isInteger(body.expectedVersion) || body.expectedVersion < 0 || body.expectedVersion > 1_000_000) {
        throw coded('HOLDING_PRODUCT_INVALID', 'expectedVersion must be a whole number.', 400);
      }
      if (!referenceDataEnabled(env)) throw coded('REFERENCE_DATA_NOT_CONFIGURED', 'Reference data is not configured.', 503);
      // Server-side resolution: the product, its insurer and its UIN come from the registry, never from the request.
      let resolved;
      try {
        const product = (await reference().read('products.get', { productId: candidateId })).data;
        const matches = (await reference().read('products.nameSearch', { q: product.productName.slice(0, 80) })).data.products;
        const named = matches.find(item => item.productId === product.productId);
        if (!named || !product.uinRaw) throw coded('HOLDING_PRODUCT_NOT_FOUND', 'That product was not found.', 404);
        resolved = { productName: product.productName, insurerName: named.insurerName, uin: profileUin(product.uinRaw) };
      } catch (error) {
        if (error instanceof ReferenceDataError) {
          throw error.code === 'REFERENCE_DATA_NOT_FOUND' ? coded('HOLDING_PRODUCT_NOT_FOUND', 'That product was not found.', 404) : coded('HOLDING_REGISTRY_UNAVAILABLE', 'The product list is not ready yet. Try again shortly.', 503, { retryable: true });
        }
        throw error;
      }
      const sourceVersion = document.sourceVersion;
      const { expectedVersion } = body;
      let outcome;
      try {
        outcome = await policyProfiles.confirm({
          householdId: holding.householdId, documentId: document.id, adultUserId, idempotencyKey,
          statement: Object.freeze({ uin: resolved.uin, insurerName: resolved.insurerName, policyName: resolved.productName, expectedVersion }),
        });
      } catch (error) {
        if (error?.code === 'POLICY_PROFILE_INVALID_UIN') throw coded('HOLDING_PRODUCT_UNSUPPORTED', 'That product cannot be confirmed.', 422);
        throw error;
      }
      const profile = await policyProfiles.get({ householdId: holding.householdId, documentId: document.id, sourceVersion });
      await policyHoldings.link({ householdId: holding.householdId, adultId: adultUserId, holdingId: holding.id, policyProfileId: profile.id });
      if (['uploaded', 'insurer_pending'].includes((await repository.get(holding.id))?.status)) {
        await policyHoldings.setStatus({ householdId: holding.householdId, adultId: adultUserId, holdingId: holding.id, status: 'product_reported' });
      }
      // Identifiers only: the job reads the UIN from the profile row, so no UIN, name or text is queued.
      await jobQueue.enqueue({
        kind: REFERENCE_IMPORT_JOB_KIND, householdId: holding.householdId, documentId: document.id, payload: { scope: 'product', policyProfileId: profile.id },
        dedupeKey: referenceImportDedupeKey({ scope: 'product', identifier: profile.id, version: String(outcome.version) }),
      });
      // Collate pipeline (A4): parse_own_pdf and fetch_reference, deduped by (holding, step, input). Only after the product is confirmed.
      if (pipeline) await pipeline.startPipeline({ householdId: holding.householdId, holdingId: holding.id });
      return { holdingId: holding.id, status: 'product_reported', profileVersion: outcome.version, replay: outcome.replay };
    },

    /** Job: rebuild the public registry snapshot. Idempotent: the same listing writes the same body. */
    async importRegistry() {
      requireEnabled();
      if (!referenceDataEnabled(env)) throw coded('REFERENCE_DATA_DISABLED', 'Reference data is disabled.', 503, { retryable: false });
      const insurers = [];
      const products = [];
      for (const [endpoint, target, field] of [['registry.insurers', insurers, 'insurers'], ['registry.products', products, 'products']]) {
        let cursor;
        for (let page = 0; page < MAX_REGISTRY_PAGES; page += 1) {
          const { data } = await reference().read(endpoint, cursor === undefined ? {} : { cursor });
          target.push(...data[field]);
          cursor = data.nextCursor ?? undefined;
          if (cursor === undefined || target.length >= MAX_REGISTRY_PRODUCTS) break;
        }
      }
      const body = {
        insurers: insurers.map(item => ({ id: item.id, canonicalName: item.canonicalName, aliases: item.aliases })),
        products: products.slice(0, MAX_REGISTRY_PRODUCTS).map(item => ({ productId: item.productId, insurerId: item.insurerId, productName: item.productName, uinRaw: item.uinRaw })),
      };
      await referenceCache.put({ key: REGISTRY_CACHE_KEY, etag: null, body, signature: signatureFor(body), ttlMs: REGISTRY_TTL_MS });
      return { insurers: body.insurers.length, products: body.products.length };
    },

    /** Job: fetch the export for the UIN of one of the household's profiles into reference_cache. A fresh copy is a no-op. */
    async importReference({ householdId, policyProfileId }) {
      requireEnabled();
      if (!referenceDataEnabled(env)) throw coded('REFERENCE_DATA_DISABLED', 'Reference data is disabled.', 503, { retryable: false });
      const uin = await repository.profileUin({ householdId, policyProfileId });
      if (!uin) return { stored: false, reason: 'no_uin' };
      const key = exportCacheKey(uin);
      const existing = await referenceCache.get(key);
      if (existing?.fresh && existing.signature === signatureFor(existing.body)) return { stored: false, reason: 'fresh' };
      const owner = `ri-${sha256(`${policyProfileId}${Date.now()}`).slice(0, 32)}`;
      if (!await referenceCache.acquireLease({ key, owner })) return { stored: false, reason: 'leased' };
      try {
        let result;
        try {
          result = await reference().read('products.exportByUin', { uin });
        } catch (error) {
          if (error instanceof ReferenceDataError && error.code === 'REFERENCE_DATA_NOT_FOUND') return { stored: false, reason: 'not_available' };
          throw error;
        }
        const { exportVersion, product, documents } = result.data;
        const body = {
          exportVersion,
          product,
          documents: documents.map(({ sourcePages, ...rest }) => ({ ...rest, pages: sourcePages.map(({ text, ...page }) => page) })),
          chunks: chunkExport(documents),
        };
        await referenceCache.put({ key, etag: result.etag, body, signature: signatureFor(body), ttlMs: EXPORT_TTL_MS });
        return { stored: true, chunks: body.chunks.length, exportVersion };
      } finally {
        await referenceCache.releaseLease({ key, owner }).catch(() => {});
      }
    },
  });
}
