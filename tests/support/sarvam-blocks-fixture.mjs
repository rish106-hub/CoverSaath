// Synthetic Sarvam digitise output with layout blocks for the stored-block tests. No real data.
// Blocks are listed out of reading order on purpose, carry provider-only fields (ids, coordinates,
// confidences) that must not be stored, and include an image block whose text is a model-written
// description that must not be stored either.
import { createSarvamDocAiTransport } from '../../src/integrations/index.js';

export const IMAGE_DESCRIPTION = 'Synthetic model description of a decorative logo';
const TABLE = '<table><tr><th>Benefit</th><th>Limit</th></tr><tr><td>Room rent</td><td>1% of sum insured</td></tr>'
  + '<tr><td>Ambulance</td><td>Up to 2,000 &amp; actuals</td></tr></table>';

const block = (id, layout_tag, reading_order, text) => ({
  block_id: id, layout_tag, reading_order, text,
  coordinates: { x1: 0.1, y1: 0.2, x2: 0.3, y2: 0.4 }, bbox_norm: [0.1, 0.2, 0.3, 0.4], layout_confidence: 0.9, ocr_confidence: 0.8,
});

function pages() {
  return [
    { page_num: 1, blocks: [
      block('p1-b3', 'paragraph', 3, 'This synthetic policy covers hospitalisation for the insured family.'),
      block('p1-b1', 'header', 1, 'Synthetic Insurer Limited'),
      block('p1-b2', 'headline', 2, 'Policy Schedule'),
      block('p1-b4', 'image', 4, IMAGE_DESCRIPTION),
      block('p1-b5', 'page-number', 5, '1'),
    ] },
    { page_num: 2, blocks: [
      block('p2-b1', 'section-title', 1, 'Section 2: Benefits'),
      block('p2-b2', 'table', 2, TABLE),
      block('p2-b3', null, 3, 'Waiting period of 30 days applies to all illnesses except accidents.'),
      block('p2-b4', 'image-caption', 4, 'Synthetic model caption'),
      block('p2-b5', 'footer', 5, 'Synthetic footer text'),
    ] },
  ];
}

export const BLOCKS_DOCUMENT = Object.freeze({ documentId: 'document-ocr', sourceVersion: '3', contentSha256: 'a'.repeat(64) });

export function rawSarvamResult() {
  return {
    manifest: {
      version: 1, pageCount: 2,
      segments: [{ index: 0, jobId: 'blocks-job', originalPages: [1, 2], segmentSha256: 'b'.repeat(64), lastStatus: 'completed' }],
    },
    results: [{
      type: 'digitise', job_id: 'blocks-job', status: 'completed',
      usage: { pages_total: 2, pages_processed: 2, pages_succeeded: 2, pages_failed: 0 },
      documents: [{ pages: pages() }],
    }],
  };
}

// In-memory block view used by scripts/structure-policy.mjs: [{ page, blocks: [{ text, tag }] }].
export function inMemoryBlockPages(raw = rawSarvamResult()) {
  return raw.results.flatMap(result => result.documents[0].pages).map((page, index) => ({
    page: index + 1,
    blocks: [...page.blocks].sort((a, b) => a.reading_order - b.reading_order).map(b => ({ text: b.text, tag: b.layout_tag ?? null })),
  }));
}

export const sarvamTransport = () => createSarvamDocAiTransport({
  apiKey: 'test-only', segmenter: { async segment() { throw new Error('not used'); } },
  fetchImpl: async () => { throw new Error('no network in tests'); },
});

// Fixture-mode provider whose result is the synthetic Sarvam output, normalised by the real transport.
export function sarvamShapedFixtureProvider(raw = rawSarvamResult()) {
  const transport = sarvamTransport();
  return Object.freeze({
    name: 'fixture',
    mode: 'fixture',
    health: () => ({ provider: 'fixture', networkAttempted: false, calls: 0 }),
    async createJob() { return { status: 'succeeded', jobRef: 'blocks-job', result: raw }; },
    async getJob() { throw new Error('Fixture OCR jobs finish synchronously.'); },
    async cancelJob() { return { status: 'cancelled' }; },
    normalizeResult(result, expected) { return transport.normalizeResult(result, expected); },
  });
}
