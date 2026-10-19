import { FIELD_NAMES, extractFields } from '../../modules/ai-analysis/eval-extractor.js';
import { getPolicyParameterDefinition, POLICY_PARAMETER_REGISTRY_VERSION } from '../../modules/coverage-analysis/policy-parameter-registry.js';
import {
  POLICY_STRUCTURING_VERSION, documentGrantCheck, isConflict, structurePolicyDocument, structuringEnabled,
} from '../../modules/policy-structuring/index.js';

// Runs whole-document policy structuring (ADR 0006) for one stored, OCR'd document inside the application:
// stored Sarvam blocks in, privacy gate, gateway-backed Gemini calls, deterministic validation, one commit.
// The run executes in this process after the start request returns. In-progress state is in memory only:
// after a restart an uncommitted run is gone (nothing was stored) and the household starts it again.
// A committed run is durable and is never paid for twice (idempotent replay by pipeline version).

const MAX_KNOWN_IDENTIFIERS = 200;
const MAX_JOBS = 200;
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

const label = (registryVersion, key) => { try { return getPolicyParameterDefinition(registryVersion, key).label; } catch { return key; } };

export function createPolicyStructuringService({ services, loadKnownIdentifiers, createModelCall, env = process.env, onError = () => {} } = {}) {
  if (!services || typeof loadKnownIdentifiers !== 'function' || typeof createModelCall !== 'function') {
    throw new TypeError('services, loadKnownIdentifiers and createModelCall are required.');
  }
  const jobs = new Map();
  const jobKey = (documentId, workflowRunId) => `${documentId}\u0000${workflowRunId}`;

  function scopeOf(document, workflowRunId) {
    if (typeof workflowRunId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(workflowRunId)) {
      throw coded('VALIDATION_ERROR', 'workflowRunId is required.', 400);
    }
    // Same scope check the commit uses: the run and the document must share the household and case.
    const stored = services.policyStructuring.getStructuringRun({ householdId: document.householdId, workflowRunId, documentId: document.id });
    const pin = services.coverageParameters.getRegistryPin(workflowRunId);
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
      alreadyStored: () => current(services.policyStructuring.getStructuringRun({ householdId: document.householdId, workflowRunId, documentId: document.id })),
      commit: async ({ decisions, proposals, coverage }) => services.policyStructuring.commitStructuring({
        householdId: document.householdId, workflowRunId, documentId: document.id, sourceVersion: stored.sourceVersion,
        pipelineVersion: POLICY_STRUCTURING_VERSION, registryVersion, recordedBy: RECORDED_BY, decisions, proposals,
        coverage: { ...coverage, costUsd }, consentCheck,
      }),
    });
  }

  return Object.freeze({
    /**
     * Starts structuring of an owned document for one analysis run. Returns { status } where status is
     * 'completed' (already stored), 'running' (started now or earlier in this process).
     */
    start({ document, workflowRunId, consentGrantId, subjectAdultId }) {
      if (!structuringEnabled(env)) throw coded('STRUCTURING_DISABLED', 'Policy structuring is disabled.', 503);
      if (typeof consentGrantId !== 'string' || !consentGrantId) throw coded('VALIDATION_ERROR', 'consentGrantId is required.', 400);
      const { stored: existing, registryVersion } = scopeOf(document, workflowRunId);
      if (current(existing)) return { status: 'completed' };
      const key = jobKey(document.id, workflowRunId);
      if (jobs.get(key)?.status === 'running') return { status: 'running' };
      // Bounded in-process state: settled entries go first, oldest first.
      if (jobs.size >= MAX_JOBS) {
        for (const [entryKey, entry] of jobs) {
          if (entry.status !== 'running') jobs.delete(entryKey);
          if (jobs.size < MAX_JOBS) break;
        }
        if (jobs.size >= MAX_JOBS) throw coded('STRUCTURING_BUSY', 'Too many structuring runs are in progress.', 503);
      }
      // Checked before any work so a missing grant or missing blocks fails the request, not the background run.
      documentGrantCheck({ consents: services.consents, grantId: consentGrantId, subjectAdultId, documentId: document.id, householdId: document.householdId })();
      const stored = services.ocr.getDocumentBlockPages({ documentId: document.id, householdId: document.householdId });
      if (!stored.complete) throw coded('STRUCTURING_BLOCKS_UNAVAILABLE', 'Some pages have no stored blocks. Run OCR again.', 409);
      const job = { status: 'running', errorCode: null };
      jobs.set(key, job);
      job.promise = execute({ document, workflowRunId, consentGrantId, subjectAdultId, registryVersion, stored })
        .then(() => { job.status = 'completed'; })
        .catch(error => {
          job.status = 'failed';
          job.errorCode = clientCode(error);
          onError({ code: job.errorCode });
        });
      return { status: 'running' };
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
    result({ document, workflowRunId }) {
      const { stored, registryVersion } = scopeOf(document, workflowRunId);
      const job = jobs.get(jobKey(document.id, workflowRunId));
      if (job?.status === 'running') return { status: 'running', errorCode: null };
      if (!stored || stored.erasedAt) {
        return { status: job?.status === 'failed' ? 'failed' : stored?.erasedAt ? 'erased' : 'not_started', errorCode: job?.errorCode ?? null };
      }
      const records = services.coverageParameters.listForRun(workflowRunId, { limit: 1000 });
      const parameters = [];
      const missing = [];
      for (const record of records) {
        const readings = services.coverageParameters.listObservations(record.id, { limit: 500 })
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
      const proposals = services.policyStructuring.listProposals({ householdId: document.householdId, documentId: document.id, limit: 500 })
        .map(proposal => ({
          proposedKey: proposal.proposedKey, category: proposal.category, label: proposal.label,
          value: proposal.value?.text ?? null, page: proposal.page, blockIndex: proposal.blockIndex,
          quote: proposal.value?.evidenceQuote ?? null, status: proposal.status,
        }));
      return {
        status: 'completed',
        structuringRun: {
          id: stored.id, pipelineVersion: stored.pipelineVersion, registryVersion, createdAt: stored.createdAt,
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
