import { randomUUID } from 'node:crypto';
import { OCR_BLOCKS_VERSION } from './ocr-blocks.js';
import { validateOcrOutput } from './ocr-contracts.js';

// Fixture mode validates orchestration and schema only. It measures no OCR quality or accuracy.
// Pages without blocks get one synthetic paragraph block, so the fixture path stores blocks too.
const withBlocks = page => ({ ...page, blocks: page.blocks ?? [{ text: page.text, tag: 'paragraph', readingOrder: 1 }] });

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
          schemaVersion: OCR_BLOCKS_VERSION,
          document: { id: document.documentId, sourceVersion: document.sourceVersion, contentSha256: document.contentSha256 },
          provider: { name: 'fixture', jobRef },
          pages: pages.map(withBlocks),
          warnings: ['Synthetic fixture output. No provider call or OCR accuracy measurement occurred.'],
        }, document),
      };
    },
    async getJob() { throw new Error('Fixture OCR jobs finish synchronously.'); },
    async cancelJob() { return { status: 'cancelled' }; },
    normalizeResult(result, expected) { return validateOcrOutput(result, expected); },
  });
}
