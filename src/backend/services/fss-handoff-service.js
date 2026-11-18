import { createHandoffClient, handoffEnabled, verifyNotice, ReferenceDataError } from '../../integrations/index.js';
import { FSS_MAX_ATTEMPTS } from '../repositories/fss-handoff-repository.js';

// FSS handoff service (ADR 0037, docs/contracts/fss-handoff-v1.md). Identifiers only leave this process: an opaque request id, the insurer and
// product name the owner confirmed, and the confirmed UIN (to FSS's server only). No document, person, policy number or text.
//
//   queueForHolding  after the product is confirmed: one open handoff per holding, one outbox job `holding.fss_handoff` per handoff.
//   send             JOB ONLY: posts the handoff to FSS (idempotent on the request id). Retryable failure -> counted, rethrown (queue backoff);
//                    after FSS_MAX_ATTEMPTS the handoff is 'failed' (support list). Permanent failure -> counted, not rethrown.
//   receiveNotice    signed webhook: signature and replay window first, then an idempotent, monotonic apply. Unknown request id -> dropped.
//   poll             hourly fallback for open handoffs that never got a notice.

export const FSS_HANDOFF_JOB_KIND = 'holding.fss_handoff';
export const FSS_POLL_AFTER_MS = 60 * 60_000;
const coded = (code, message, statusCode = 400) => Object.assign(new Error(message), { code, statusCode, retryable: false });

export function createFssHandoffService({ repository, holdingRepository, jobQueue, env = process.env, client = null, clock = () => new Date(), onEvent = () => {} }) {
  if (!repository || !holdingRepository || !jobQueue) throw new TypeError('createFssHandoffService needs the handoff repository, the holdings repository and the job queue.');
  const enabled = () => handoffEnabled(env);
  let built = client;
  const api = () => { built ??= createHandoffClient({ env }); return built; };

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
      if (final) await repository.applyNotice({ requestId, fssHandoffId: answer.handoffId, state: answer.state, versionId: answer.versionId });
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
    const { result } = await repository.applyNotice({ requestId: notice.requestId, fssHandoffId: notice.handoffId, state: notice.state, versionId: notice.versionId });
    if (result === 'unknown') onEvent({ type: 'fss.notice_dropped' });
    return { result };
  }

  async function poll({ limit = 20 } = {}) {
    if (!enabled()) return { polled: 0 };
    const open = await repository.openForPoll({ olderThanIso: new Date(clock().getTime() - FSS_POLL_AFTER_MS).toISOString(), limit });
    let polled = 0;
    for (const handoff of open) {
      if (!handoff.fssHandoffId) continue;
      try {
        const answer = await api().get(handoff.fssHandoffId);
        if (answer.requestId === handoff.requestId) { await repository.applyNotice({ requestId: handoff.requestId, fssHandoffId: answer.handoffId, state: answer.state, versionId: answer.versionId }); polled += 1; }
      } catch (error) { if (!(error instanceof ReferenceDataError)) throw error; }
    }
    return { polled };
  }

  return Object.freeze({ enabled, queueForHolding, send, receiveNotice, poll });
}
