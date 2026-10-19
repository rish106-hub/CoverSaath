import { createHash, randomUUID } from 'node:crypto';
import { DocumentIntakeError } from './contracts.js';
import { OCR_OUTPUT_VERSION, assertOcrProvider, assertOcrRepository, validateOcrOutput } from './ocr-contracts.js';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function assertAuthorization(value, document, provider, mode) {
  const expectedConsent = mode === 'live' ? document.providerConsentGrantId : document.consentGrantId;
  if (value?.authorized !== true || value.consentGrantId !== expectedConsent ||
      value.requestedByAdultId !== document.uploadedByAdultId || value.purpose !== 'document_processing'
      || (mode === 'live' && value.recipient !== provider.name)) {
    throw new DocumentIntakeError('OCR_AUTHORIZATION_REQUIRED', 'Current document-specific OCR authorization is required.');
  }
  return {
    authorized: true,
    consentGrantId: value.consentGrantId,
    requestedByAdultId: value.requestedByAdultId,
    purpose: value.purpose,
    ...(mode === 'live' ? { recipient: provider.name, settings: value.settings ?? {} } : {}),
  };
}

export function createOcrService({
  repository,
  provider,
  byteReader,
  mode = 'live',
  now = () => new Date(),
  pollIntervalMs = 2_000,
  jobDeadlineMs = 15 * 60_000,
} = {}) {
  if (!['live', 'fixture'].includes(mode)) throw new TypeError('OCR mode must be live or fixture.');
  assertOcrRepository(repository);
  assertOcrProvider(provider, mode);
  if (mode === 'live' && typeof byteReader !== 'function') throw new TypeError('Live OCR requires an authorized protected-byte reader.');
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 0 || pollIntervalMs > 60_000) throw new TypeError('Invalid OCR poll interval.');
  if (!Number.isInteger(jobDeadlineMs) || jobDeadlineMs < 60_000 || jobDeadlineMs > 24 * 60 * 60_000) throw new TypeError('Invalid OCR job deadline.');

  async function persistSuccess(job, document, rawResult) {
    const currentDocument = await repository.getReadyDocument(document.documentId, now().toISOString(), mode === 'live' ? {
      consentGrantId: job.authorization.consentGrantId,
      requestedByAdultId: job.authorization.requestedByAdultId,
      recipient: provider.name,
    } : null);
    if (!currentDocument) throw new DocumentIntakeError('OCR_AUTHORIZATION_REQUIRED', 'OCR authorization changed before results could be saved.');
    const normalized = validateOcrOutput(provider.normalizeResult(rawResult, document), document);
    if (!normalized.assessment.complete) throw new DocumentIntakeError('OCR_PROVIDER_PARTIAL', 'Incomplete OCR results cannot be persisted as complete.');
    const completedAt = now().toISOString();
    const pages = normalized.pages.map(page => ({
      ...page,
      documentUploadId: document.documentId,
      sourceVersion: document.sourceVersion,
      outputContractVersion: OCR_OUTPUT_VERSION,
      createdAt: completedAt,
    }));
    try {
      return await repository.completeJob(job.id, pages, {
        status: 'succeeded',
        providerJobRef: normalized.provider.jobRef,
        result: normalized,
        resultDigest: digest(normalized),
        completedAt,
        updatedAt: completedAt,
        errorCode: null,
        errorMessage: null,
      });
    } catch (error) {
      if (typeof error?.code === 'string' && error.code.startsWith('OCR_')) throw error;
      const failure = new DocumentIntakeError('OCR_PERSISTENCE_FAILED', 'OCR results could not be stored.');
      failure.providerJobRef = normalized.provider.jobRef;
      throw failure;
    }
  }

  return Object.freeze({
    async start({ documentId, authorization, retryFailed = false }) {
      const disclosure = mode === 'live' ? {
        consentGrantId: authorization?.consentGrantId,
        requestedByAdultId: authorization?.requestedByAdultId,
        recipient: provider.name,
      } : null;
      const document = await repository.getReadyDocument(documentId, now().toISOString(), disclosure);
      if (!document) throw new DocumentIntakeError('DOCUMENT_NOT_OCR_READY', 'OCR requires an active protected document, clean scan and current processing consent.');
      if (mode === 'live' && document.mimeType !== 'application/pdf') {
        throw new DocumentIntakeError('OCR_UNSUPPORTED_MEDIA_TYPE', 'Live OCR currently accepts PDF documents only.');
      }
      const safeAuthorization = assertAuthorization(authorization, document, provider, mode);
      const requestedAt = now().toISOString();
      const claimed = await repository.createOrGetJob({
        id: `ocr-${randomUUID()}`,
        documentUploadId: document.documentId,
        provider: provider.name,
        status: 'queued',
        contractVersion: OCR_OUTPUT_VERSION,
        authorization: safeAuthorization,
        requestedAt,
        updatedAt: requestedAt,
      }, { retryFailed });
      let job = claimed.job;
      if (claimed.retryBlocked) {
        throw new DocumentIntakeError(
          'OCR_RECONCILIATION_REQUIRED',
          'This OCR attempt may have reached the provider and must be reconciled before retry.',
        );
      }
      if (!claimed.created) return job;
      try {
        const bytes = mode === 'live' ? await byteReader(document.storageReference, document.documentId) : undefined;
        // Mark the outbound boundary before calling the provider. A concurrent deletion can then
        // distinguish an in-flight submission from a queued job that never left this process.
        job = await repository.updateJob(job.id, { startedAt: requestedAt, updatedAt: requestedAt });
        if (job?.status === 'cancelled') return job;
        const submission = await provider.createJob({
          document, bytes, authorization: safeAuthorization, requestId: job.id,
          beforeSegmentSubmit: async () => {
            const currentJob = await repository.getJob(job.id);
            const currentDocument = await repository.getReadyDocument(document.documentId, now().toISOString(), {
              consentGrantId: safeAuthorization.consentGrantId,
              requestedByAdultId: safeAuthorization.requestedByAdultId,
              recipient: provider.name,
            });
            if (currentJob?.status === 'cancelled' || !currentDocument) {
              throw new DocumentIntakeError('OCR_AUTHORIZATION_REQUIRED', 'OCR authorization changed before provider dispatch.');
            }
          },
        });
        const cancelled = await repository.getJob(job.id);
        if (cancelled?.status === 'cancelled') {
          const returnedRef = submission?.jobRef ?? submission?.result?.provider?.jobRef ?? null;
          if (returnedRef) await repository.recordCancellationReference(job.id, returnedRef);
          const cancellation = await provider.cancelJob({
            jobRef: returnedRef, requestId: job.id, authorization: safeAuthorization,
          });
          return repository.completeCancellation(job.id, cancellation);
        }
        if (submission?.status === 'succeeded') return await persistSuccess(job, document, submission.result);
        if (!submission?.jobRef || !['submitted', 'processing'].includes(submission.status)) {
          throw new DocumentIntakeError('OCR_PROVIDER_RESPONSE_INVALID', 'OCR provider submission returned an unsupported lifecycle response.');
        }
        const updated = await repository.updateJob(job.id, {
          status: submission.status,
          providerJobRef: submission.jobRef,
          startedAt: requestedAt,
          updatedAt: requestedAt,
        });
        if (updated?.status === 'cancelled') {
          await repository.recordCancellationReference(job.id, submission.jobRef);
          const cancellation = await provider.cancelJob({ jobRef: submission.jobRef, requestId: job.id, authorization: safeAuthorization });
          return repository.completeCancellation(job.id, cancellation);
        }
        return updated;
      } catch (error) {
        if (error.providerJobRef) {
          const current = await repository.getJob(job.id);
          if (current?.status === 'cancelled') await repository.recordCancellationReference(job.id, error.providerJobRef);
          else await repository.updateJob(job.id, { providerJobRef: error.providerJobRef });
        }
        await repository.updateJob(job.id, {
          status: 'failed',
          errorCode: error.code ?? 'OCR_SUBMISSION_FAILED',
          errorMessage: 'OCR provider submission failed.',
          completedAt: now().toISOString(),
          updatedAt: now().toISOString(),
        });
        throw error;
      }
    },

    async refresh(jobId, { authorization }) {
      const job = await repository.getJob(jobId);
      if (!job) throw new DocumentIntakeError('OCR_JOB_NOT_FOUND', 'OCR job was not found.');
      const persistenceReconciliation = job.status === 'failed'
        && job.errorCode === 'OCR_PERSISTENCE_FAILED' && Boolean(job.providerJobRef);
      if (!['submitted', 'processing'].includes(job.status) && !persistenceReconciliation) return job;
      const checkedAt = now();
      if (!persistenceReconciliation && checkedAt.getTime() - Date.parse(job.requestedAt) > jobDeadlineMs) {
        return repository.updateJob(job.id, {
          status: 'failed', errorCode: 'OCR_PROVIDER_DEADLINE_EXCEEDED',
          errorMessage: 'OCR processing exceeded its deadline.', completedAt: checkedAt.toISOString(), updatedAt: checkedAt.toISOString(),
        });
      }
      if (!persistenceReconciliation && checkedAt.getTime() - Date.parse(job.updatedAt) < pollIntervalMs) return job;
      const document = await repository.getReadyDocument(job.documentUploadId, now().toISOString(), mode === 'live' ? {
        consentGrantId: authorization?.consentGrantId,
        requestedByAdultId: authorization?.requestedByAdultId,
        recipient: provider.name,
      } : null);
      if (!document) throw new DocumentIntakeError('DOCUMENT_NOT_OCR_READY', 'OCR continuation requires current consent and an available document.');
      const safeAuthorization = assertAuthorization(authorization, document, provider, mode);
      const result = await provider.getJob({ jobRef: job.providerJobRef, authorization: safeAuthorization });
      if (result?.status === 'succeeded') {
        try {
          return await persistSuccess(job, document, result.result);
        } catch (error) {
          await repository.updateJob(job.id, {
            providerJobRef: error.providerJobRef ?? result.jobRef ?? job.providerJobRef,
            status: 'failed', errorCode: error.code ?? 'OCR_PERSISTENCE_FAILED',
            errorMessage: 'OCR results could not be stored.',
            completedAt: now().toISOString(), updatedAt: now().toISOString(),
          });
          throw error;
        }
      }
      if (result?.status === 'failed') {
        return repository.updateJob(job.id, {
          providerJobRef: result.jobRef ?? job.providerJobRef,
          status: 'failed', errorCode: result.errorCode ?? 'OCR_PROVIDER_FAILED',
          errorMessage: result.errorMessage ?? 'OCR provider reported failure.',
          completedAt: now().toISOString(), updatedAt: now().toISOString(),
        });
      }
      if (result?.status !== 'processing') throw new DocumentIntakeError('OCR_PROVIDER_RESPONSE_INVALID', 'OCR provider status response is invalid.');
      return repository.updateJob(job.id, {
        status: 'processing', providerJobRef: result.jobRef ?? job.providerJobRef, updatedAt: now().toISOString(),
      });
    },

    async cancel(jobId, { authorization }) {
      const job = await repository.getJob(jobId);
      if (!job) throw new DocumentIntakeError('OCR_JOB_NOT_FOUND', 'OCR job was not found.');
      if (['succeeded', 'failed', 'cancelled'].includes(job.status)) return job;
      const document = await repository.getReadyDocument(job.documentUploadId, now().toISOString(), mode === 'live' ? {
        consentGrantId: authorization?.consentGrantId,
        requestedByAdultId: authorization?.requestedByAdultId,
        recipient: provider.name,
      } : null);
      if (!document) throw new DocumentIntakeError('DOCUMENT_NOT_OCR_READY', 'OCR cancellation requires current document authorization.');
      const safeAuthorization = assertAuthorization(authorization, document, provider, mode);
      const cancellation = job.providerJobRef ? await provider.cancelJob({
        jobRef: job.providerJobRef, requestId: job.id, authorization: safeAuthorization,
      }) : null;
      return repository.updateJob(job.id, {
        status: 'cancelled',
        errorCode: cancellation?.remoteCancellation === false ? 'OCR_PROVIDER_CANCELLATION_UNSUPPORTED' : null,
        completedAt: now().toISOString(), updatedAt: now().toISOString(),
      });
    },

    getJob(jobId) { return repository.getJob(jobId); },
  });
}
