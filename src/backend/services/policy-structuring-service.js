import { FIELD_NAMES, extractFields } from '../../features/ai-analysis/eval-extractor.js';
import { getPolicyParameterDefinition, POLICY_PARAMETER_REGISTRY_VERSION } from '../../features/coverage-analysis/policy-parameter-registry.js';
import {
  POLICY_STRUCTURING_VERSION, documentGrantCheck, isConflict, storedOutcome, structurePolicyDocument, structuringEnabled,
} from '../../features/policy-structuring/index.js';

// Runs whole-document policy structuring (ADR 0006) for one stored, OCR'd document inside the application:
// stored Sarvam blocks in, privacy gate, gateway-backed Gemini calls, deterministic validation, one commit.
// The run executes in this process after the start request returns. Each attempt is a durable job row
// (identifiers and codes only); the in-memory map keeps only the promise. A running row carries a lease:
// its owning process refreshes `updated_at` every heartbeat interval. Recovery interrupts only rows whose
// lease expired (the owner died), never a live instance's row on a shared database. An interrupted row is
// never re-dispatched: a new paid attempt needs an explicit restart request.
// A committed run is durable and is never paid for twice (idempotent replay by pipeline version).

const MAX_KNOWN_IDENTIFIERS = 200;
const MAX_JOBS = 200;
const DEFAULT_LEASE_MS = 120_000;
const DEFAULT_HEARTBEAT_MS = 30_000;
const RECORDED_BY = 'policy-structuring-service';

function coded(code, message, statusCode) {
  return Object.assign(new Error(message), { code, statusCode });
}

const clientCode = error => (typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(error.code) ? error.code : 'STRUCTURING_FAILED');

// Names printed in the document itself (policyholder, insured members), found by local rules and used only
// as known identifiers for the privacy gate. Never stored, logged or sent.
function documentNames(pages) {
  let fields;
  try { fields = extractFields(pages, FIELD_NAMES); } catch { return []; }
  return [fields.policyholder_name?.value, ...[fields.insured_members?.value].flat()]
    .filter(value => typeof value === 'string' && /\p{L}/u.test(value) && value.length <= 200)
    .map(value => ({ kind: 'NAME', value }));
}

// A stored run counts only while it is not erased and was made by the current pipeline version; an erased
// or older run can be structured again (the commit replays only a live run of the same version).
const current = run => Boolean(run && !run.erasedAt && run.pipelineVersion === POLICY_STRUCTURING_VERSION);

// Processing status (did the run finish) is separate from the evidence outcome (how complete the stored
// readings are). Nothing is ever reported as a bare 'completed'.
function statusBody(processingStatus, { outcome = null, errorCode = null } = {}) {
  return {
    status: processingStatus,
    processingStatus,
    evidenceOutcome: outcome?.evidenceOutcome ?? null,
    outcomeReasons: outcome ? [...outcome.reasons] : [],
    missingCriticalKeys: outcome ? [...outcome.missingCriticalKeys] : [],
    requiresReview: outcome?.evidenceOutcome === 'partial_review_required',
    errorCode,
  };
}

const label = (registryVersion, key) => { try { return getPolicyParameterDefinition(registryVersion, key).label; } catch { return key; } };

// Job row to processing status. A failed row with a failed evidence outcome finished processing; it just
// did not find enough evidence to store.
function jobBody(job) {
  if (job.status === 'running' || job.status === 'queued') return statusBody('running');
  if (job.status === 'interrupted') return statusBody('interrupted', { errorCode: job.errorCode });
  if (job.evidenceOutcome === 'failed') {
    return statusBody('finished', { outcome: { evidenceOutcome: 'failed', reasons: [], missingCriticalKeys: [] }, errorCode: job.errorCode });
  }
  return statusBody('failed_processing', { errorCode: job.errorCode });
}

const NEEDS_RESTART = new Set(['failed', 'interrupted']);

export function createPolicyStructuringService({
  services, loadKnownIdentifiers, createModelCall, env = process.env, onError = () => {},
  leaseMs = DEFAULT_LEASE_MS, heartbeatMs = DEFAULT_HEARTBEAT_MS,
} = {}) {
  if (!services || typeof loadKnownIdentifiers !== 'function' || typeof createModelCall !== 'function') {
    throw new TypeError('services, loadKnownIdentifiers and createModelCall are required.');
  }
  // leaseMs: how long an attempt may go without a heartbeat before it counts as abandoned. 0 treats every
  // active attempt as abandoned (deliberate single-process takeover). heartbeatMs must be well below leaseMs.
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 0) throw new TypeError('leaseMs must be a non-negative integer.');
  if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 1) throw new TypeError('heartbeatMs must be a positive integer.');
  // Attempts whose lease expired (abandoned by a dead process) are interrupted, never resumed. Every public
  // method waits for this first; a failure is not cached, so the next call tries again. An attempt a live
  // process still heartbeats is left alone.
  let lastSweep = 0;
  let interrupted = null;
  const interruptOnce = () => {
    interrupted ??= Promise.resolve()
      .then(() => services.policyStructuring.interruptRunningJobs({ leaseMs }))
      .then(() => { lastSweep = Date.now(); })
      .catch(error => { interrupted = null; throw error; });
    return interrupted;
  };
  // A process that died inside another instance's lease window is recovered by a later sweep, at most
  // once per heartbeat interval, so an abandoned row cannot stay 'running' until the next restart.
  let sweeping = null;
  const sweepExpired = async () => {
    await interruptOnce();
    if (Date.now() - lastSweep < heartbeatMs) return;
    sweeping ??= services.policyStructuring.interruptRunningJobs({ leaseMs })
      .then(() => { lastSweep = Date.now(); })
      .finally(() => { sweeping = null; });
    await sweeping;
  };
  interruptOnce().catch(() => {});
  const jobs = new Map();
  const jobKey = (documentId, workflowRunId) => `${documentId}\u0000${workflowRunId}`;

  async function scopeOf(document, workflowRunId) {
    if (typeof workflowRunId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(workflowRunId)) {
      throw coded('VALIDATION_ERROR', 'workflowRunId is required.', 400);
    }
    // Same scope check the commit uses: the run and the document must share the household and case.
    const stored = await services.policyStructuring.getStructuringRun({ householdId: document.householdId, workflowRunId, documentId: document.id });
    const pin = await services.coverageParameters.getRegistryPin(workflowRunId);
    return { stored, registryVersion: pin?.registryVersion ?? POLICY_PARAMETER_REGISTRY_VERSION };
  }

  async function execute({ document, workflowRunId, consentGrantId, subjectAdultId, registryVersion, stored }) {
    const consentCheck = documentGrantCheck({ consents: services.consents, grantId: consentGrantId, subjectAdultId, documentId: document.id, householdId: document.householdId });
    let costUsd = 0;
    const call = createModelCall({ consentCheck, onCall: event => { costUsd += event.costUsd; } });
    const knownIdentifiers = [...(await loadKnownIdentifiers(document.caseId)), ...documentNames(stored.pages)].slice(0, MAX_KNOWN_IDENTIFIERS);
    return structurePolicyDocument({
      pages: stored.pages.map(({ page, blocks }) => ({ page, blocks })),
      call,
      consentCheck,
      knownIdentifiers,
      registryVersion,
      env,
      alreadyStored: async () => current(await services.policyStructuring.getStructuringRun({ householdId: document.householdId, workflowRunId, documentId: document.id })),
      commit: async ({ decisions, proposals, coverage, outcome }) => services.policyStructuring.commitStructuring({
        householdId: document.householdId, workflowRunId, documentId: document.id, sourceVersion: stored.sourceVersion,
        pipelineVersion: POLICY_STRUCTURING_VERSION, registryVersion, recordedBy: RECORDED_BY, decisions, proposals,
        coverage: { ...coverage, costUsd }, outcome, consentCheck,
      }),
    });
  }

  return Object.freeze({
    /**
     * Starts structuring of an owned document for one analysis run. Returns a status body whose status is
     * 'finished' (already stored, with its evidence outcome) or 'running' (started now or already running).
     * After a failed or interrupted attempt a new paid attempt needs `restart: true`.
     */
    async start({ document, workflowRunId, consentGrantId, subjectAdultId, restart = false }) {
      if (!structuringEnabled(env)) throw coded('STRUCTURING_DISABLED', 'Policy structuring is disabled.', 503);
      if (typeof consentGrantId !== 'string' || !consentGrantId) throw coded('VALIDATION_ERROR', 'consentGrantId is required.', 400);
      if (typeof restart !== 'boolean') throw coded('VALIDATION_ERROR', 'restart must be a boolean.', 400);
      await sweepExpired();
      const { stored: existing, registryVersion } = await scopeOf(document, workflowRunId);
      if (current(existing)) return statusBody('finished', { outcome: storedOutcome(existing.counts) });
      const scope = { householdId: document.householdId, workflowRunId, documentId: document.id };
      const prior = await services.policyStructuring.latestJob(scope);
      // An attempt in flight is never paid for twice, even after its outputs were erased.
      if (prior?.status === 'running' || prior?.status === 'queued') return statusBody('running');
      if (prior && !prior.erasedAt && NEEDS_RESTART.has(prior.status) && restart !== true) {
        throw Object.assign(coded('STRUCTURING_RESTART_REQUIRED', `The previous attempt is ${prior.status}. Send restart: true to start a new paid attempt.`, 409), { priorStatus: prior.status });
      }
      const key = jobKey(document.id, workflowRunId);
      if ([...jobs.values()].filter(entry => entry.running).length >= MAX_JOBS) throw coded('STRUCTURING_BUSY', 'Too many structuring runs are in progress.', 503);
      // Checked before any work so a missing grant or missing blocks fails the request, not the background run.
      await documentGrantCheck({ consents: services.consents, grantId: consentGrantId, subjectAdultId, documentId: document.id, householdId: document.householdId })();
      const stored = await services.ocr.getDocumentBlockPages({ documentId: document.id, householdId: document.householdId });
      if (!stored.complete) {
        throw coded('STRUCTURING_BLOCKS_UNAVAILABLE', 'Some pages have no stored blocks. Request a blocks upgrade: POST /api/v1/documents/:id/ocr-jobs with mode blocks_upgrade and acknowledgeProviderCharge true (a new paid OCR call).', 409);
      }
      // Re-checked after the awaits above: another request may have started this job meanwhile.
      if (jobs.get(key)?.running) return statusBody('running');
      let row;
      try {
        row = await services.policyStructuring.startJob({ ...scope, sourceVersion: stored.sourceVersion, pipelineVersion: POLICY_STRUCTURING_VERSION, consentGrantId });
      } catch (error) {
        if (error?.code === 'STRUCTURING_ALREADY_RUNNING') return statusBody('running');
        throw error;
      }
      const finish = async fields => {
        try { await services.policyStructuring.finishJob({ jobId: row.id, ...fields }); } catch (error) { onError({ code: clientCode(error) }); }
      };
      const entry = { running: true };
      jobs.set(key, entry);
      // Lease heartbeat while this process owns the attempt; stops when the attempt settles.
      let beating = false;
      const heartbeat = setInterval(() => {
        if (beating) return;
        beating = true;
        services.policyStructuring.heartbeatJob({ jobId: row.id })
          .catch(error => onError({ code: clientCode(error) }))
          .finally(() => { beating = false; });
      }, heartbeatMs);
      heartbeat.unref?.();
      entry.promise = execute({ document, workflowRunId, consentGrantId, subjectAdultId, registryVersion, stored })
        .then(async result => {
          if (result?.replayed) {
            const run = await services.policyStructuring.getStructuringRun(scope);
            await finish({ status: 'committed', structuringRunId: run?.id ?? null, evidenceOutcome: run ? storedOutcome(run.counts).evidenceOutcome : null });
          } else if (result?.outcome?.evidenceOutcome === 'failed') {
            await finish({ status: 'failed', evidenceOutcome: 'failed', errorCode: 'STRUCTURING_EVIDENCE_INSUFFICIENT' });
          } else {
            await finish({ status: 'committed', evidenceOutcome: result?.outcome?.evidenceOutcome ?? null, structuringRunId: result?.commit?.structuringRunId ?? null });
          }
        })
        .catch(async error => {
          const code = clientCode(error);
          await finish({ status: 'failed', errorCode: code });
          onError({ code });
        })
        .finally(() => { clearInterval(heartbeat); jobs.delete(key); });
      return statusBody('running');
    },

    /** Waits for an in-process run (tests and graceful shutdown). */
    async settle(documentId, workflowRunId) {
      await jobs.get(jobKey(documentId, workflowRunId))?.promise;
    },

    /**
     * The human-reviewable result: every registry key with its state, readings (value, subject, page,
     * block, verbatim quote), contradictions and variations, proposals pending review, missing keys and
     * skipped chunks. Readings are what the document printed (already stored); nothing here is proven.
     */
    async result({ document, workflowRunId }) {
      await sweepExpired();
      const { stored, registryVersion } = await scopeOf(document, workflowRunId);
      const job = await services.policyStructuring.latestJob({ householdId: document.householdId, workflowRunId, documentId: document.id });
      if (job?.status === 'running' || job?.status === 'queued') return statusBody('running');
      // The latest unerased attempt that stored nothing (failed, interrupted) is what the household sees,
      // unless a current run is stored. A failed evidence outcome stored nothing, so there is nothing to review.
      if (job && !job.erasedAt && job.status !== 'committed' && !current(stored)) return jobBody(job);
      if (!stored || stored.erasedAt) {
        // An erased attempt (consent revoked, document erased) keeps only its code.
        if (stored?.erasedAt || job?.erasedAt) return statusBody('erased', { errorCode: job?.erasedAt ? job.errorCode : null });
        return statusBody('not_started');
      }
      const records = await services.coverageParameters.listForRun(workflowRunId, { limit: 1000 });
      const parameters = [];
      const missing = [];
      for (const record of records) {
        const readings = (await services.coverageParameters.listObservations(record.id, { limit: 500 }))
          .filter(observation => observation.documentId === document.id && !observation.redactedAt && observation.extractionMethod === 'document_extraction')
          .map(observation => ({
            value: observation.value?.text ?? null,
            normalized: observation.value?.normalized ?? null,
            subject: observation.value?.subject ?? null,
            page: /^[1-9][0-9]{0,4}$/.test(String(observation.page)) ? Number(observation.page) : observation.page,
            blockIndex: observation.value?.blockIndex ?? null,
            quote: observation.value?.evidenceQuote ?? null,
            selected: record.resolvedObservationId === observation.id,
          }));
        if (!readings.length) {
          if (record.resolutionState === 'unknown') missing.push(record.parameterKey);
          continue;
        }
        parameters.push({
          key: record.parameterKey,
          label: label(registryVersion, record.parameterKey),
          state: record.resolutionState,
          reasonCode: record.resolutionReasonCode,
          requiresHouseholdConfirmation: true,
          readings,
        });
      }
      const flagged = parameters.filter(parameter => parameter.state === 'conflicting');
      // Proposals of the stored run only, each with the provenance that produced it.
      const proposals = (await services.policyStructuring.listProposals({ householdId: document.householdId, documentId: document.id, structuringRunId: stored.id, limit: 500 }))
        .map(proposal => ({
          proposedKey: proposal.proposedKey, category: proposal.category, label: proposal.label,
          value: proposal.value?.text ?? null, page: proposal.page, blockIndex: proposal.blockIndex,
          quote: proposal.value?.evidenceQuote ?? null, status: proposal.status,
          structuringRunId: proposal.structuringRunId, pipelineVersion: stored.pipelineVersion,
          registryVersion: proposal.registryVersion, sourceVersion: stored.sourceVersion,
        }));
      return {
        ...statusBody('finished', { outcome: storedOutcome(stored.counts) }),
        structuringRun: {
          id: stored.id, pipelineVersion: stored.pipelineVersion, registryVersion, sourceVersion: stored.sourceVersion, createdAt: stored.createdAt,
          counts: stored.counts,
        },
        authority: 'Every value is a reading of the document by a model, checked against a verbatim quote. None is proven; the household confirms.',
        parameters,
        contradictions: flagged.filter(parameter => isConflict({ reasonCode: parameter.reasonCode })).map(parameter => parameter.key),
        variations: flagged.filter(parameter => !isConflict({ reasonCode: parameter.reasonCode })).map(parameter => ({ key: parameter.key, reasonCode: parameter.reasonCode })),
        modelSelections: parameters.filter(parameter => parameter.reasonCode === 'model_selected_from_conflict').map(parameter => parameter.key),
        missing,
        proposals,
        skippedChunks: stored.counts.coverage?.skippedChunks ?? null,
      };
    },
  });
}
