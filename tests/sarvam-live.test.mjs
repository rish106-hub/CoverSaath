import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { createSarvamOcrProvider } from '../src/integrations/index.js';
import { createSandboxedPdfSegmenter } from '../src/modules/document-intake/index.js';

const liveEnabled = process.env.RUN_SARVAM_LIVE === '1';
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function syntheticInsurancePdf() {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage([595, 842]);
  const lines = [
    'COVERSAATH SYNTHETIC INSURANCE DOCUMENT',
    'Policy reference: SYNTHETIC-ONLY-001',
    'Sum insured: INR 500000',
    'Room rent: INR 5000 per day',
    'Co-payment: 20 percent',
    'This document contains no real person or health information.',
  ];
  lines.forEach((line, index) => page.drawText(line, {
    x: 54, y: 770 - index * 34, size: index === 0 ? 16 : 12, font,
    color: rgb(0, 0, 0),
  }));
  return Buffer.from(await document.save({ useObjectStreams: false }));
}

test('opt-in live Sarvam Digitise returns and normalizes one synthetic source page', {
  skip: liveEnabled ? false : 'set RUN_SARVAM_LIVE=1 and SARVAM_API_KEY to run the billable live check',
  timeout: 6 * 60_000,
}, async context => {
  assert.ok(process.env.SARVAM_API_KEY, 'SARVAM_API_KEY is required for the opt-in live check.');
  const bytes = await syntheticInsurancePdf();
  const source = {
    documentId: 'live-synthetic-document',
    sourceVersion: '1',
    contentSha256: createHash('sha256').update(bytes).digest('hex'),
  };
  const provider = createSarvamOcrProvider({
    env: { ...process.env, SARVAM_OCR_ENABLED: 'true' },
    segmenter: createSandboxedPdfSegmenter(),
  });
  const authorization = {
    authorized: true,
    consentGrantId: 'live-synthetic-consent',
    requestedByAdultId: 'live-synthetic-adult',
    purpose: 'document_processing',
    recipient: 'sarvam',
    settings: { language: 'en-IN', contentType: 'printed' },
  };

  const startedAt = Date.now();
  const submitted = await provider.createJob({
    document: source, bytes, authorization, requestId: 'live-synthetic-request',
  });
  assert.equal(submitted.status, 'submitted');

  let result;
  for (let poll = 0; poll < 150; poll += 1) {
    result = await provider.getJob({ jobRef: result?.jobRef ?? submitted.jobRef, authorization });
    if (result.status !== 'processing') break;
    await wait(2_000);
  }
  assert.equal(result?.status, 'succeeded', 'Sarvam live job did not succeed before the test deadline.');

  const normalized = provider.normalizeResult(result.result, source);
  assert.equal(normalized.schemaVersion, 'knowvia.ocr.v2');
  assert.equal(normalized.document.id, source.documentId);
  assert.equal(normalized.document.sourceVersion, source.sourceVersion);
  assert.equal(normalized.document.contentSha256, source.contentSha256);
  assert.equal(normalized.pages.length, 1);
  assert.equal(normalized.pages[0].pageNumber, 1);
  assert.equal(normalized.pages[0].text.includes('COVERSAATH'), true);
  assert.equal(JSON.stringify(normalized).includes(process.env.SARVAM_API_KEY), false);

  context.diagnostic(JSON.stringify({
    provider: 'sarvam', operation: 'digitise', pages: 1,
    durationMs: Date.now() - startedAt, normalizedCharacters: normalized.pages[0].text.length,
    estimatedListCostInr: 0.5, syntheticDataOnly: true,
  }));
});
