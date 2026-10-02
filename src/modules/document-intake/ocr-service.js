import { createHash, randomUUID } from 'node:crypto';
import { DocumentIntakeError } from './contracts.js';
import { OCR_OUTPUT_VERSION, assertOcrProvider, assertOcrRepository, validateOcrOutput } from './ocr-contracts.js';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function assertAuthorization(value, document) {
  if (value?.authorized !== true || value.consentGrantId !== document.consentGrantId ||
      value.requestedByAdultId !== document.uploadedByAdultId || value.purpose !== 'document_processing') {
    throw new DocumentIntakeError('OCR_AUTHORIZATION_REQUIRED', 'Current document-specific OCR authorization is required.');
  }
  return {
    authorized: true,
    consentGrantId: value.consentGrantId,
    requestedByAdultId: value.requestedByAdultId,
    purpose: value.purpose,
  };
}

export function createOcrService({ repository, provider, byteReader, mode = 'live', now = () => new Date() } = {}) {
  if (!['live', 'fixture'].includes(mode)) throw new TypeError('OCR mode must be live or fixture.');
  assertOcrRepository(repository);
  assertOcrProvider(provider, mode);
  if (mode === 'live' && typeof byteReader !== 'function') throw new TypeError('Live OCR requires an authorized protected-byte reader.');

  async function persistSuccess(job, document, rawResult) {
    const normalized = validateOcrOutput(provider.normalizeResult(rawResult, document), document);
    const completedAt = now().toISOString();
    const pages = normalized.pages.map(page => ({
      ...page,
      documentUploadId: document.documentId,
      sourceVersion: document.sourceVersion,
      outputContractVersion: OCR_OUTPUT_VERSION,
      createdAt: completedAt,
    }));
    return repository.completeJob(job.id, pages, {
      status: 'succeeded',
      providerJobRef: normalized.provider.jobRef,
      result: normalized,
      resultDigest: digest(normalized),
      completedAt,
      updatedAt: completedAt,
      errorCode: null,
      errorMessage: null,
    });
  }

  return Object.freeze({
    async start({ documentId, authorization }) {
      const document = await repository.getReadyDocument(documentId, now().toISOString());
      if (!document) throw new DocumentIntakeError('DOCUMENT_NOT_OCR_READY', 'OCR requires an active protected document, clean scan and current processing consent.');
      const safeAuthorization = assertAuthorization(authorization, document);
      const requestedAt = now().toISOString();
      let job = await repository.createJob({
        id: `ocr-${randomUUID()}`,
        documentUploadId: document.documentId,
        provider: provider.name,
        status: 'queued',
        contractVersion: OCR_OUTPUT_VERSION,
        authorization: safeAuthorization,
        requestedAt,
        updatedAt: requestedAt,
      });
      try {
        const bytes = mode === 'live' ? await byteReader(document.documentId) : undefined;
        const submission = await provider.createJob({ document, bytes, authorization: safeAuthorization });
        if (submission?.status === 'succeeded') return persistSuccess(job, document, submission.result);
        if (!submission?.jobRef || !['submitted', 'processing'].includes(submission.status)) {
          throw new DocumentIntakeError('OCR_PROVIDER_RESPONSE_INVALID', 'OCR provider submission returned an unsupported lifecycle response.');
        }
        return repository.updateJob(job.id, {
          status: submission.status,
          providerJobRef: submission.jobRef,
          startedAt: requestedAt,
          updatedAt: requestedAt,
        });
      } catch (error) {
        await repository.updateJob(job.id, {
          status: 'failed',
          errorCode: error.code ?? 'OCR_SUBMISSION_FAILED',
          errorMessage: error.message,
          completedAt: now().toISOString(),
          updatedAt: now().toISOString(),
        });
        throw error;
      }
    },

    async refresh(jobId, { authorization }) {
      const job = await repository.getJob(jobId);
      if (!job) throw new DocumentIntakeError('OCR_JOB_NOT_FOUND', 'OCR job was not found.');
      if (!['submitted', 'processing'].includes(job.status)) return job;
      const document = await repository.getReadyDocument(job.documentUploadId, now().toISOString());
      if (!document) throw new DocumentIntakeError('DOCUMENT_NOT_OCR_READY', 'OCR continuation requires current consent and an available document.');
      const safeAuthorization = assertAuthorization(authorization, document);
      const result = await provider.getJob({ jobRef: job.providerJobRef, authorization: safeAuthorization });
      if (result?.status === 'succeeded') return persistSuccess(job, document, result.result);
      if (result?.status === 'failed') {
        return repository.updateJob(job.id, {
          status: 'failed', errorCode: result.errorCode ?? 'OCR_PROVIDER_FAILED',
          errorMessage: result.errorMessage ?? 'OCR provider reported failure.',
          completedAt: now().toISOString(), updatedAt: now().toISOString(),
        });
      }
      if (result?.status !== 'processing') throw new DocumentIntakeError('OCR_PROVIDER_RESPONSE_INVALID', 'OCR provider status response is invalid.');
      return repository.updateJob(job.id, { status: 'processing', updatedAt: now().toISOString() });
    },

    async cancel(jobId, { authorization }) {
      const job = await repository.getJob(jobId);
      if (!job) throw new DocumentIntakeError('OCR_JOB_NOT_FOUND', 'OCR job was not found.');
      if (['succeeded', 'failed', 'cancelled'].includes(job.status)) return job;
      const document = await repository.getReadyDocument(job.documentUploadId, now().toISOString());
      if (!document) throw new DocumentIntakeError('DOCUMENT_NOT_OCR_READY', 'OCR cancellation requires current document authorization.');
      const safeAuthorization = assertAuthorization(authorization, document);
      if (job.providerJobRef) await provider.cancelJob({ jobRef: job.providerJobRef, authorization: safeAuthorization });
      return repository.updateJob(job.id, { status: 'cancelled', completedAt: now().toISOString(), updatedAt: now().toISOString() });
    },

    getJob(jobId) { return repository.getJob(jobId); },
  });
}
