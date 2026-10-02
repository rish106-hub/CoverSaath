import { randomUUID } from 'node:crypto';
import { validateOcrOutput } from './ocr-contracts.js';

// Fixture mode validates orchestration and schema only. It measures no OCR quality or accuracy.
export function createFixtureOcrProvider({ pages = [{ pageNumber: 1, text: 'Synthetic OCR fixture only.' }] } = {}) {
  return Object.freeze({
    name: 'fixture',
    mode: 'fixture',
    health: () => ({ provider: 'fixture', status: 'fixture_only', networkAttempted: false, calls: 0, accuracyMeasured: false }),
    async createJob({ document }) {
      const jobRef = `fixture-${randomUUID()}`;
      return {
        status: 'succeeded',
        jobRef,
        result: validateOcrOutput({
          schemaVersion: 'knowvia.ocr.v1',
          document: { id: document.documentId, sourceVersion: document.sourceVersion, contentSha256: document.contentSha256 },
          provider: { name: 'fixture', jobRef },
          pages,
          warnings: ['Synthetic fixture output. No provider call or OCR accuracy measurement occurred.'],
        }, document),
      };
    },
    async getJob() { throw new Error('Fixture OCR jobs finish synchronously.'); },
    async cancelJob() { return { status: 'cancelled' }; },
    normalizeResult(result, expected) { return validateOcrOutput(result, expected); },
  });
}
