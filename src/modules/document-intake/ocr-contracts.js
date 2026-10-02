import { createHash } from 'node:crypto';
import { DocumentIntakeError } from './contracts.js';

export const OCR_OUTPUT_VERSION = 'knowvia.ocr.v1';
export const OCR_JOB_STATES = Object.freeze(['queued', 'submitted', 'processing', 'succeeded', 'failed', 'cancelled']);
export const OCR_LIMITS = Object.freeze({ maxPages: 500, maxTextCharactersPerPage: 200_000, maxWarnings: 100 });

const sha256 = value => createHash('sha256').update(value).digest('hex');
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function boundedString(value, name, max = 500) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new DocumentIntakeError('OCR_SCHEMA_INVALID', `${name} must be a non-empty string no longer than ${max} characters.`);
  }
  return value.trim();
}

function nullableConfidence(value) {
  if (value == null) return null;
  if (!Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new DocumentIntakeError('OCR_SCHEMA_INVALID', 'Provider-reported confidence must be null or an integer from 0 to 10000.');
  }
  return value;
}

export function validateOcrOutput(value, expected = {}) {
  if (!plainObject(value) || value.schemaVersion !== OCR_OUTPUT_VERSION) {
    throw new DocumentIntakeError('OCR_SCHEMA_INVALID', `OCR output must use ${OCR_OUTPUT_VERSION}.`);
  }
  if (!plainObject(value.document) || !plainObject(value.provider) || !Array.isArray(value.pages)) {
    throw new DocumentIntakeError('OCR_SCHEMA_INVALID', 'OCR output requires document, provider and pages.');
  }
  const documentId = boundedString(value.document.id, 'document.id');
  const sourceVersion = boundedString(value.document.sourceVersion, 'document.sourceVersion', 100);
  const contentSha256 = boundedString(value.document.contentSha256, 'document.contentSha256', 64);
  if (!/^[a-f0-9]{64}$/.test(contentSha256)) throw new DocumentIntakeError('OCR_SCHEMA_INVALID', 'document.contentSha256 must be a SHA-256 digest.');
  if (expected.documentId && documentId !== expected.documentId) throw new DocumentIntakeError('OCR_SOURCE_MISMATCH', 'OCR output document does not match the requested document.');
  if (expected.sourceVersion && sourceVersion !== expected.sourceVersion) throw new DocumentIntakeError('OCR_SOURCE_MISMATCH', 'OCR output source version does not match the requested document.');
  if (expected.contentSha256 && contentSha256 !== expected.contentSha256) throw new DocumentIntakeError('OCR_SOURCE_MISMATCH', 'OCR output digest does not match the requested document.');
  if (value.pages.length === 0 || value.pages.length > OCR_LIMITS.maxPages) {
    throw new DocumentIntakeError('OCR_SCHEMA_INVALID', `OCR output must contain 1 to ${OCR_LIMITS.maxPages} pages.`);
  }

  const seen = new Set();
  const pages = value.pages.map((page, index) => {
    if (!plainObject(page) || !Number.isInteger(page.pageNumber) || page.pageNumber < 1) {
      throw new DocumentIntakeError('OCR_SCHEMA_INVALID', `pages[${index}].pageNumber must be a positive integer.`);
    }
    if (seen.has(page.pageNumber)) throw new DocumentIntakeError('OCR_SCHEMA_INVALID', 'OCR page numbers must be unique.');
    seen.add(page.pageNumber);
    if (typeof page.text !== 'string' || page.text.length > OCR_LIMITS.maxTextCharactersPerPage) {
      throw new DocumentIntakeError('OCR_SCHEMA_INVALID', `pages[${index}].text exceeds the bounded text contract.`);
    }
    const extractionStatus = page.extractionStatus ?? (page.text.trim() ? 'extracted' : 'failed');
    if (!['extracted', 'failed'].includes(extractionStatus) || (extractionStatus === 'extracted' && !page.text.trim())) {
      throw new DocumentIntakeError('OCR_SCHEMA_INVALID', 'Each page must be extracted with text or explicitly failed.');
    }
    const text = page.text;
    return Object.freeze({
      pageNumber: page.pageNumber,
      text,
      textSha256: sha256(text),
      extractionStatus,
      confidenceBasisPoints: nullableConfidence(page.confidenceBasisPoints),
      providerPageRef: page.providerPageRef == null ? null : boundedString(page.providerPageRef, 'providerPageRef', 200),
      provenance: Object.freeze({
        documentId,
        sourceVersion,
        contentSha256,
        pageNumber: page.pageNumber,
        locator: `document:${documentId}:version:${sourceVersion}:page:${page.pageNumber}`,
      }),
    });
  }).sort((left, right) => left.pageNumber - right.pageNumber);

  const warnings = value.warnings ?? [];
  if (!Array.isArray(warnings) || warnings.length > OCR_LIMITS.maxWarnings || warnings.some(item => typeof item !== 'string' || item.length > 500)) {
    throw new DocumentIntakeError('OCR_SCHEMA_INVALID', 'OCR warnings must be a bounded string array.');
  }
  return Object.freeze({
    schemaVersion: OCR_OUTPUT_VERSION,
    document: Object.freeze({ id: documentId, sourceVersion, contentSha256 }),
    provider: Object.freeze({
      name: boundedString(value.provider.name, 'provider.name', 100),
      jobRef: value.provider.jobRef == null ? null : boundedString(value.provider.jobRef, 'provider.jobRef', 200),
    }),
    pages: Object.freeze(pages),
    warnings: Object.freeze([...warnings]),
    assessment: Object.freeze({
      complete: pages.every(page => page.extractionStatus === 'extracted'),
      humanReviewRequired: true,
      authority: 'unverified_evidence_only',
    }),
  });
}

export function assertOcrProvider(provider, mode) {
  const methods = ['health', 'createJob', 'getJob', 'cancelJob', 'normalizeResult'];
  if (!provider || methods.some(method => typeof provider[method] !== 'function')) {
    throw new TypeError(`OCR provider must implement: ${methods.join(', ')}.`);
  }
  if (provider.mode !== mode) throw new DocumentIntakeError('OCR_PROVIDER_MODE_MISMATCH', `OCR ${mode} mode requires an explicitly ${mode} provider.`);
  return provider;
}

export function assertOcrRepository(repository) {
  const methods = ['getReadyDocument', 'createJob', 'getJob', 'updateJob', 'completeJob'];
  if (!repository || methods.some(method => typeof repository[method] !== 'function')) {
    throw new TypeError(`OCR repository must implement: ${methods.join(', ')}.`);
  }
  return repository;
}
