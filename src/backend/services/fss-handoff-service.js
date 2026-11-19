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
// The first time a handoff becomes `matched` (send answer, signed notice or poll: one path, `decide`) one outbox job `holding.fss_pull` is queued IN THE
// SAME TRANSACTION as the state change (repository.applyNotice `afterApply`): a crash or a failed enqueue rolls the state change back, so FSS's notice
// retry (or the hourly poll) replays it and a matched handoff never exists without its job. A repeat of the same state is 'duplicate' and queues nothing.
//   pull             JOB ONLY: reads the UIN pack of the MATCHED handoff (GET /v1/handoffs/{id}/pack, version-pinned and re-gated by FSS; docs/contracts/uin-pack-v1.md,
//                    FOR LEGAL REVIEW), checks its version is the one FSS matched, then writes PUBLIC data only: the holding_fss_links row (ids; the consent re-check
//                    and the link are ONE transaction under the household lock), the mapped facts and the page chunks in reference_cache
//                    (keyed by version id, never by household), and queues collate. Collate writes the ida_wording rows, so it re-checks the document and
//                    its current consent in its own transaction, and revocation erases the rows and the link. Before any write the holding and the document
//                    consent are re-read; an erased holding or a revoked consent drops the pull (counted, no write). 404 pack_not_available is permanent (recorded, never
//                    retried: a gate no longer holds); 409 handoff_not_matched, 5xx, timeout and 429 rethrow for queue backoff. No UIN is read or sent: the handoff id is the key.

export const FSS_HANDOFF_JOB_KIND = 'holding.fss_handoff';
export const FSS_PULL_JOB_KIND = 'holding.fss_pull';
// Queue backoff is 5 s doubling (15 min cap): 8 attempts span about ten minutes, enough for a 409 (FSS not yet matched) to settle.
export const FSS_PULL_MAX_ATTEMPTS = 8;
export const FSS_POLL_AFTER_MS = 60 * 60_000;
// A pulled pack's cache rows live EXPORT_TTL_MS (24 h); the poll re-pulls a linked holding's pack once its cached facts are no longer fresh.
export const FSS_PACK_REFRESH_AFTER_MS = EXPORT_TTL_MS;
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
    const { result } = await repository.applyNotice({
      requestId, fssHandoffId: answer.handoffId, state: answer.state, versionId: answer.versionId, reason: answer.reason ?? null,
      afterApply: async handoff => { if (handoff.state === 'matched') await queuePull(handoff); },
    });
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

  // One row failing (any error) never stops the others: the code only is reported (no id, name or text), the row is looked at again next window.
  const rowFailed = (stage, error) => onEvent({ type: 'fss.poll_row_failed', stage, code: typeof error?.code === 'string' ? error.code.slice(0, 60) : 'FSS_POLL_ROW_FAILED' });

  /**
   * Hourly fallback. Three jobs, each claimed with FOR UPDATE SKIP LOCKED so two machines never share a row:
   *   1. open handoffs FSS never reported on: ask FSS (Get) and apply the answer through `decide`.
   *   2. matched handoffs whose pull never finished (the job died): re-queue the pull (same dedupe key, so a live job is never doubled), at most
   *      FSS_PULL_REDRIVE_MAX times, then the outcome 'pull_gave_up'.
   *   3. matched handoffs already pulled, whose cached facts are no longer fresh (24 h): re-queue the pull, so a rights gate that closed is noticed
   *      (the pull's 404 pack_not_available then deletes the cached rows and re-collates).
   */
  async function poll({ limit = 20 } = {}) {
    if (!enabled()) return { polled: 0 };
    const now = clock().getTime();
    const open = await repository.claimForPoll({ olderThanIso: new Date(now - FSS_POLL_AFTER_MS).toISOString(), limit });
    let polled = 0;
    for (const handoff of open) {
      if (!handoff.fssHandoffId) continue;
      try {
        const answer = await api().get(handoff.fssHandoffId);
        if (answer.requestId === handoff.requestId) { await decide({ requestId: handoff.requestId, answer }); polled += 1; }
      } catch (error) { rowFailed('open', error); }
    }
    let requeued = 0;
    let gaveUp = 0;
    try {
      const redrive = await repository.claimPullRedrive({ olderThanIso: new Date(now - FSS_POLL_AFTER_MS).toISOString(), limit });
      gaveUp = redrive.gaveUp;
      for (const handoff of redrive.claimed) {
        try { await queuePull(handoff); requeued += 1; } catch (error) { rowFailed('redrive', error); }
      }
    } catch (error) { rowFailed('redrive_claim', error); }
    if (referenceCache) {
      try {
        const pulled = await repository.claimPullRefresh({ olderThanIso: new Date(now - FSS_PACK_REFRESH_AFTER_MS).toISOString(), limit });
        for (const handoff of pulled) {
          try {
            const row = handoff.versionId ? await referenceCache.get(packCacheKey('facts', handoff.versionId)) : null;
            if (row?.fresh) continue;
            await queuePull(handoff);
            requeued += 1;
          } catch (error) { rowFailed('refresh', error); }
        }
      } catch (error) { rowFailed('refresh_claim', error); }
    }
    if (gaveUp > 0) onEvent({ type: 'fss.pull_gave_up', count: gaveUp });
    return { polled, requeued, gaveUp };
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
    if (!handoff.fssHandoffId) { await repository.recordOutcome({ requestId, outcome: 'no_handoff_id' }); return 'no_handoff_id'; }

    const factsKey = packCacheKey('facts', handoff.versionId);
    const owner = `fp-${randomUUID()}`;
    if (!await referenceCache.acquireLease({ key: factsKey, owner })) throw Object.assign(coded('FSS_PULL_BUSY', 'The pack is being pulled by another worker.', 503), { retryable: true });
    try {
      let pack;
      try {
        pack = (await packs().read('handoff.pack', { handoffId: handoff.fssHandoffId })).data;
      } catch (error) {
        if (!(error instanceof ReferenceDataError)) throw error;
        if (error.code === 'REFERENCE_DATA_NOT_FOUND') {
          await repository.recordOutcome({ requestId, outcome: 'pack_not_available' });
          onEvent({ type: 'fss.pull_failed', outcome: 'pack_not_available', retryable: false });
          // A gate no longer holds: the public rows cached for this version go (facts and pages), and collate runs again so the ida_wording rows
          // written from them drop. Nothing to re-collate for a first pull that 404s (nothing was cached or written). The cache rows are per version, so
          // another holding's 404 may have removed them already: a handoff that had pulled before re-collates either way.
          const removed = [await referenceCache.remove(factsKey), await referenceCache.remove(packCacheKey('pages', handoff.versionId))];
          if (removed.some(Boolean) || handoff.lastOutcome === 'pulled') await onPulled({ holding: first });
          return 'pack_not_available';
        }
        if (error.code === 'REFERENCE_DATA_NOT_MODIFIED') return 'not_modified';
        const outcome = error.code === 'REFERENCE_DATA_CONFLICT' ? 'handoff_not_matched' : String(error.code).toLowerCase().replace(/^reference_data_/, '').slice(0, 59);
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
      // Public data first (keyed by version, never by household; nothing here is consent-bound), so the household lock below is held only for the
      // consent re-check and the link, not for these writes.
      const factsBody = { versionId: pack.version.versionId, uinRaw: null, wordingVersion: pack.version.wordingVersion, versionSynthetic: false, coverage: {}, facts: pack.facts, nextCursor: null };
      await referenceCache.put({ key: factsKey, etag: null, body: factsBody, signature: signatureFor(factsBody), ttlMs: EXPORT_TTL_MS });
      const pagesBody = {
        packVersion: pack.packVersion, product: pack.product, version: pack.version,
        documents: pack.documents.map(({ sourcePages, ...rest }) => ({ ...rest, pages: sourcePages.map(({ text, ...page }) => page) })),
        chunks: chunkExport(pack.documents),
      };
      await referenceCache.put({ key: packCacheKey('pages', handoff.versionId), etag: null, body: pagesBody, signature: signatureFor(pagesBody), ttlMs: EXPORT_TTL_MS });
      // The consent re-check and the link are one transaction under the household lock: a revocation takes the same lock, so it commits wholly before
      // (the link is never written) or wholly after (its erasure removes the link). The pull can take seconds, so this re-read is not the first one.
      // Ids only. Matched by FSS's own handoff match (the pack is of the version FSS matched, checked above): high.
      const holding = await repository.withHousehold(householdId, async () => {
        const current = await stillAllowed({ householdId, holdingId });
        if (!current) return null;
        try {
          await repository.link({ householdId, holdingId, productId: pack.product.productId, versionId: pack.version.versionId, matchedBy: 'uin', confidence: 'high' });
        } catch (error) {
          if (error?.code === 'HOLDING_NOT_FOUND') return null;
          throw error;
        }
        return current;
      });
      if (!holding) return drop('holding_or_consent_gone');
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
