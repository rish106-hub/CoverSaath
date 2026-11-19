import { randomUUID } from 'node:crypto';
import { createHandoffClient, createInsuranceDataClient, handoffEnabled, verifyNotice, ReferenceDataError } from '../../integrations/index.js';
import { FSS_MAX_ATTEMPTS } from '../repositories/fss-handoff-repository.js';
import { chunkExport, EXPORT_TTL_MS } from './holding-product-service.js';
import { packCacheKey, signatureFor } from './reference-data-port.js';

// FSS handoff service (ADR 0037, docs/contracts/fss-handoff-v1.md). Identifiers only leave this process: an opaque request id, the insurer and
// product name the owner confirmed, and the confirmed UIN (to FSS's server only). No document, person, policy number or text.
//
//   queueForHolding  after the product is confirmed: one open handoff per holding, one outbox job `holding.fss_handoff` per handoff.
//   send             JOB ONLY: posts the handoff to FSS (idempotent on the request id). Retryable failure -> counted, rethrown (queue backoff);
//                    after FSS_MAX_ATTEMPTS the handoff is 'failed' (support list). Permanent failure -> counted, not rethrown.
//   receiveNotice    signed webhook: signature and replay window first, then an idempotent, monotonic apply. Unknown request id -> dropped.
//   poll             hourly fallback for open handoffs that never got a notice. Claims rows with FOR UPDATE SKIP LOCKED (two machines never share one).
//
// The first time a handoff becomes `matched` (send answer, signed notice or poll: one path, `decide`) one outbox job `holding.fss_pull` is queued.
// A repeat of the same state is 'duplicate' and queues nothing. A crash between that commit and the enqueue loses the job until the next poll
// finds the handoff still matched without a pull (known gap, same as queueForHolding).
//   pull             JOB ONLY: reads the UIN pack of the owner-confirmed product (docs/contracts/uin-pack-v1.md, FOR LEGAL REVIEW), checks its version is the one
//                    FSS matched, then writes PUBLIC data only: the holding_fss_links row (ids), the mapped facts and the page chunks in reference_cache
//                    (keyed by version id, never by household), and queues collate. Collate writes the ida_wording rows, so it re-checks the document and
//                    its current consent in its own transaction, and revocation erases the rows and the link. Before any write the holding and the document
//                    consent are re-read; an erased holding or a revoked consent drops the pull (counted, no write). 404 is permanent (outcome
//                    pack_not_available); 5xx, timeout and 429 rethrow for queue backoff.

export const FSS_HANDOFF_JOB_KIND = 'holding.fss_handoff';
export const FSS_PULL_JOB_KIND = 'holding.fss_pull';
export const FSS_PULL_MAX_ATTEMPTS = 5;
export const FSS_POLL_AFTER_MS = 60 * 60_000;
const coded = (code, message, statusCode = 400) => Object.assign(new Error(message), { code, statusCode, retryable: false });

export function createFssHandoffService({
  repository, holdingRepository, jobQueue, referenceCache = null, onPulled = async () => {}, env = process.env, client = null, reader = null, clock = () => new Date(), onEvent = () => {},
}) {
  if (!repository || !holdingRepository || !jobQueue) throw new TypeError('createFssHandoffService needs the handoff repository, the holdings repository and the job queue.');
  const enabled = () => handoffEnabled(env);
  let built = client;
  const api = () => { built ??= createHandoffClient({ env }); return built; };
  let packReader = reader;
  const packs = () => { packReader ??= createInsuranceDataClient({ env }); return packReader; };

  // The one path to a decided state (send answer, notice, poll). Queues the pull job only on the first transition to matched.
  async function decide({ requestId, answer }) {
    const { result, handoff } = await repository.applyNotice({ requestId, fssHandoffId: answer.handoffId, state: answer.state, versionId: answer.versionId });
    if (result === 'applied' && handoff.state === 'matched') await queuePull(handoff);
    return result;
  }

  async function queuePull(handoff) {
    if (!handoff.versionId) { onEvent({ type: 'fss.pull_skipped', reason: 'no_version' }); return; }
    const holding = await holdingRepository.getHolding({ householdId: handoff.householdId, holdingId: handoff.holdingId });
    if (!holding) { onEvent({ type: 'fss.pull_dropped', reason: 'holding_gone' }); return; }
    const document = await holdingRepository.holdingDocument({ householdId: holding.householdId, documentId: holding.documentId });
    await jobQueue.enqueue({
      kind: FSS_PULL_JOB_KIND, householdId: holding.householdId, documentId: holding.documentId, consentGrantId: document?.consentGrantId ?? null,
      payload: { holdingId: holding.id, requestId: handoff.requestId }, dedupeKey: `fss-pull:${handoff.requestId}`, maxAttempts: FSS_PULL_MAX_ATTEMPTS,
    });
  }

  async function queueForHolding({ holding, consentGrantId = null }) {
    if (!enabled()) return { queued: false };
    const { handoff, created } = await repository.queue({ householdId: holding.householdId, holdingId: holding.id });
    if (created) {
      await jobQueue.enqueue({
        kind: FSS_HANDOFF_JOB_KIND, householdId: holding.householdId, documentId: holding.documentId, consentGrantId,
        payload: { holdingId: holding.id, requestId: handoff.requestId }, dedupeKey: `fss-handoff:${handoff.requestId}`, maxAttempts: FSS_MAX_ATTEMPTS,
      });
    }
    return { queued: created, requestId: handoff.requestId };
  }

  async function send({ householdId, holdingId, requestId }) {
    if (!enabled()) throw coded('FSS_HANDOFF_DISABLED', 'FSS handoff is disabled.', 503);
    const handoff = await repository.byRequestId(requestId);
    if (!handoff || handoff.state !== 'queued' || handoff.householdId !== householdId || handoff.holdingId !== holdingId) return 'skipped';
    const holding = await holdingRepository.getHolding({ householdId, holdingId });
    if (!holding) return 'skipped';
    const names = (await holdingRepository.confirmedNames({ householdId, holdings: [holding] })).get(holding.id);
    if (!names?.insurerName || !names?.productName) {
      await repository.recordSendFailure({ requestId, outcome: 'names_missing' });
      return 'names_missing';
    }
    const uin = holding.policyProfileId ? await holdingRepository.confirmedUin({ householdId, policyProfileId: holding.policyProfileId }) : null;
    try {
      const answer = await api().create({ requestId, insurerName: names.insurerName, productName: names.productName, ...(uin ? { uin } : {}) });
      const final = !['accepted', 'working'].includes(answer.state);
      if (final) await decide({ requestId, answer });
      else await repository.recordAccepted({ requestId, fssHandoffId: answer.handoffId, state: answer.state });
      return answer.state;
    } catch (error) {
      if (!(error instanceof ReferenceDataError)) throw error;
      const outcome = String(error.code).toLowerCase().replace(/^reference_data_/, '').slice(0, 59);
      await repository.recordSendFailure({ requestId, outcome });
      onEvent({ type: 'fss.handoff_send_failed', outcome, retryable: error.retryable === true });
      if (error.retryable) throw error;
      return 'failed_send';
    }
  }

  async function receiveNotice({ rawBody, header }) {
    const notice = verifyNotice({ rawBody, header, secret: env.FSS_NOTICE_SECRET, now: clock().getTime() });
    const result = await decide({ requestId: notice.requestId, answer: notice });
    if (result === 'unknown') onEvent({ type: 'fss.notice_dropped' });
    return { result };
  }

  async function poll({ limit = 20 } = {}) {
    if (!enabled()) return { polled: 0 };
    const open = await repository.claimForPoll({ olderThanIso: new Date(clock().getTime() - FSS_POLL_AFTER_MS).toISOString(), limit });
    let polled = 0;
    for (const handoff of open) {
      if (!handoff.fssHandoffId) continue;
      try {
        const answer = await api().get(handoff.fssHandoffId);
        if (answer.requestId === handoff.requestId) { await decide({ requestId: handoff.requestId, answer }); polled += 1; }
      } catch (error) { if (!(error instanceof ReferenceDataError)) throw error; }
    }
    return { polled };
  }

  // Re-reads the holding and the current document consent. Null when either is gone (an erased holding, a revoked or expired consent).
  async function stillAllowed({ householdId, holdingId }) {
    const holding = await holdingRepository.getHolding({ householdId, holdingId });
    if (!holding) return null;
    const readable = await holdingRepository.readableDocuments({ householdId, documentIds: [holding.documentId] });
    return readable.has(holding.documentId) ? holding : null;
  }
  const drop = reason => { onEvent({ type: 'fss.pull_dropped', reason }); return 'dropped'; };

  async function pull({ householdId, holdingId, requestId }) {
    if (!enabled()) throw coded('FSS_HANDOFF_DISABLED', 'FSS handoff is disabled.', 503);
    if (!referenceCache) throw new TypeError('The pull needs the reference cache.');
    const handoff = await repository.byRequestId(requestId);
    if (!handoff || handoff.state !== 'matched' || !handoff.versionId || handoff.householdId !== householdId || handoff.holdingId !== holdingId) return 'skipped';
    const first = await stillAllowed({ householdId, holdingId });
    if (!first) return drop('holding_or_consent_gone');
    const uin = first.policyProfileId ? await holdingRepository.confirmedUin({ householdId, policyProfileId: first.policyProfileId }) : null;
    if (!uin) { await repository.recordOutcome({ requestId, outcome: 'no_uin' }); return 'no_uin'; }

    const factsKey = packCacheKey('facts', handoff.versionId);
    const owner = `fp-${randomUUID()}`;
    if (!await referenceCache.acquireLease({ key: factsKey, owner })) throw Object.assign(coded('FSS_PULL_BUSY', 'The pack is being pulled by another worker.', 503), { retryable: true });
    try {
      let pack;
      try {
        pack = (await packs().read('products.packByUin', { uin })).data;
      } catch (error) {
        if (!(error instanceof ReferenceDataError)) throw error;
        if (error.code === 'REFERENCE_DATA_NOT_FOUND') { await repository.recordOutcome({ requestId, outcome: 'pack_not_available' }); onEvent({ type: 'fss.pull_failed', outcome: 'pack_not_available', retryable: false }); return 'pack_not_available'; }
        if (error.code === 'REFERENCE_DATA_NOT_MODIFIED') return 'not_modified';
        const outcome = String(error.code).toLowerCase().replace(/^reference_data_/, '').slice(0, 59);
        await repository.recordOutcome({ requestId, outcome });
        onEvent({ type: 'fss.pull_failed', outcome, retryable: error.retryable === true });
        if (error.retryable) throw error;
        return 'failed_pull';
      }
      if (pack.version.versionId !== handoff.versionId) {
        await repository.recordOutcome({ requestId, outcome: 'version_mismatch' });
        onEvent({ type: 'fss.pull_failed', outcome: 'version_mismatch', retryable: false });
        return 'version_mismatch';
      }
      // Re-check right before the writes: the pull can take seconds, and the owner may have erased the holding or withdrawn consent meanwhile.
      const holding = await stillAllowed({ householdId, holdingId });
      if (!holding) return drop('holding_or_consent_gone');
      try {
        // Ids only. Matched by the confirmed UIN, and FSS's own match (the version of the handoff) agrees with the pack's version: high.
        await repository.link({ householdId, holdingId, productId: pack.product.productId, versionId: pack.version.versionId, matchedBy: 'uin', confidence: 'high' });
      } catch (error) {
        if (error?.code === 'HOLDING_NOT_FOUND') return drop('holding_gone');
        throw error;
      }
      const factsBody = { versionId: pack.version.versionId, uinRaw: null, wordingVersion: pack.version.wordingVersion, versionSynthetic: false, coverage: {}, facts: pack.facts, nextCursor: null };
      await referenceCache.put({ key: factsKey, etag: null, body: factsBody, signature: signatureFor(factsBody), ttlMs: EXPORT_TTL_MS });
      const pagesBody = {
        packVersion: pack.packVersion, product: pack.product, version: pack.version,
        documents: pack.documents.map(({ sourcePages, ...rest }) => ({ ...rest, pages: sourcePages.map(({ text, ...page }) => page) })),
        chunks: chunkExport(pack.documents),
      };
      await referenceCache.put({ key: packCacheKey('pages', handoff.versionId), etag: null, body: pagesBody, signature: signatureFor(pagesBody), ttlMs: EXPORT_TTL_MS });
      await repository.recordOutcome({ requestId, outcome: 'pulled' });
      // Collate reads the cached facts through the link and writes the ida_wording rows (consent re-checked in its own transaction).
      await onPulled({ holding });
      onEvent({ type: 'fss.pull_stored', facts: pack.facts.length, chunks: pagesBody.chunks.length });
      return 'pulled';
    } finally {
      await referenceCache.releaseLease({ key: factsKey, owner }).catch(() => {});
    }
  }

  return Object.freeze({ enabled, queueForHolding, send, receiveNotice, poll, pull });
}
