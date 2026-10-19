import test from 'node:test';
import assert from 'node:assert/strict';
import { createSarvamDocAiTransport, createSarvamOcrProvider } from '../src/integrations/index.js';
import { validateOcrOutput } from '../src/modules/document-intake/index.js';

const jsonResponse = (value, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: name => name.toLowerCase() === 'content-length' ? String(Buffer.byteLength(JSON.stringify(value))) : null },
  async text() { return JSON.stringify(value); },
});

const segmenter = {
  async segment() {
    return {
      pageCount: 11,
      segments: [
        { index: 0, originalPages: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], bytes: Buffer.from('%PDF- segment one'), contentSha256: 'a'.repeat(64) },
        { index: 1, originalPages: [11], bytes: Buffer.from('%PDF- segment two'), contentSha256: 'b'.repeat(64) },
      ],
    };
  },
};

function completedResult(jobId, pageCount) {
  return {
    type: 'digitise', job_id: jobId, status: 'completed',
    documents: [{ file_name: 'synthetic.pdf', pages: Array.from({ length: pageCount }, (_, index) => ({
      page_number: index + 1, content: `Synthetic page ${index + 1} from ${jobId}`,
    })) }],
    usage: { pages_total: pageCount, pages_processed: pageCount, pages_succeeded: pageCount, pages_failed: 0 },
  };
}

test('Sarvam Document AI uses modern digitise fields and maps segment pages to original pages', async () => {
  const submissions = [];
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/digitise')) {
      submissions.push({
        url, key: options.headers['api-subscription-key'], language: options.body.get('language'),
        format: options.body.get('output_format'), contentType: options.body.get('content_type'),
      });
      return jsonResponse({ job_id: `job-${submissions.length}`, status: 'pending' }, 201);
    }
    const jobId = path.split('/').at(-2);
    if (path.endsWith('/status')) return jsonResponse({ job_id: jobId, status: 'completed' });
    if (path.endsWith('/results')) return jsonResponse(completedResult(jobId, jobId === 'job-1' ? 10 : 1));
    throw new Error(`unexpected URL ${url}`);
  };
  const transport = createSarvamDocAiTransport({ apiKey: 'secret', segmenter, fetchImpl });
  const submitted = await transport.createJob({
    bytes: Buffer.from('%PDF- synthetic'), document: { documentId: 'document-1' },
    settings: { language: 'bn-IN', contentType: 'printed' },
  });
  assert.equal(submissions.length, 2);
  assert.deepEqual(submissions.map(item => ({
    path: new URL(item.url).pathname, key: item.key, language: item.language,
    format: item.format, contentType: item.contentType,
  })), Array.from({ length: 2 }, () => ({
    path: '/doc-ai/v1/job/digitise', key: 'secret', language: 'bn-IN', format: 'json', contentType: 'printed',
  })));
  const polled = await transport.getJob({ jobRef: submitted.jobRef });
  const normalized = transport.normalizeResult(polled.result, {
    documentId: 'document-1', sourceVersion: '4', contentSha256: 'c'.repeat(64),
  });
  assert.equal(polled.status, 'succeeded');
  assert.deepEqual(normalized.pages.map(page => page.pageNumber), Array.from({ length: 11 }, (_, index) => index + 1));
  assert.equal(normalized.pages[10].providerPageRef, 'job-2:page:1');
  assert.equal(JSON.stringify(normalized).includes('usage'), false);
});

test('Sarvam Document AI refuses partial completion and never fetches partial results', async () => {
  let resultsCalls = 0;
  let submissions = 0;
  const transport = createSarvamDocAiTransport({ apiKey: 'secret', segmenter, fetchImpl: async url => {
    const path = new URL(url).pathname;
    if (path.endsWith('/digitise')) return jsonResponse({ job_id: `partial-${++submissions}`, status: 'pending' }, 201);
    if (path.endsWith('/status')) {
      const jobId = path.split('/').at(-2);
      return jsonResponse({ job_id: jobId, status: jobId === 'partial-1' ? 'completed' : 'partially_completed' });
    }
    resultsCalls += 1;
    return jsonResponse({});
  } });
  const submitted = await transport.createJob({ bytes: Buffer.from('%PDF- synthetic') });
  const failed = await transport.getJob({ jobRef: submitted.jobRef });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.errorCode, 'OCR_PROVIDER_PARTIAL');
  const manifest = JSON.parse(Buffer.from(failed.jobRef.slice('sarvam-v1.'.length), 'base64url').toString('utf8'));
  assert.deepEqual(manifest.segments.map(segment => segment.lastStatus), ['completed', 'partially_completed']);
  assert.equal(resultsCalls, 0);
});

test('Sarvam records pending and running states, then fails closed for failed and rejected jobs', async () => {
  for (const terminalStatus of ['failed', 'rejected']) {
    let statusCalls = 0;
    let resultCalls = 0;
    const onePage = { async segment() { return { pageCount: 1, segments: [{
      index: 0, originalPages: [1], bytes: Buffer.from('%PDF- one'), contentSha256: 'a'.repeat(64),
    }] }; } };
    const transport = createSarvamDocAiTransport({
      apiKey: 'secret', segmenter: onePage,
      fetchImpl: async url => {
        const path = new URL(url).pathname;
        if (path.endsWith('/digitise')) return jsonResponse({ job_id: `${terminalStatus}-job`, status: 'pending' }, 201);
        if (path.endsWith('/status')) {
          statusCalls += 1;
          const status = statusCalls === 1 ? 'running' : terminalStatus;
          return jsonResponse({ job_id: `${terminalStatus}-job`, status });
        }
        resultCalls += 1;
        return jsonResponse({});
      },
    });
    const submitted = await transport.createJob({ bytes: Buffer.from('%PDF- synthetic') });
    const running = await transport.getJob({ jobRef: submitted.jobRef });
    assert.equal(running.status, 'processing');
    const failed = await transport.getJob({ jobRef: running.jobRef });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.errorCode, 'OCR_PROVIDER_FAILED');
    assert.equal(resultCalls, 0);
    const manifest = JSON.parse(Buffer.from(failed.jobRef.slice('sarvam-v1.'.length), 'base64url').toString('utf8'));
    assert.equal(manifest.segments[0].lastStatus, terminalStatus);
  }
});

test('Sarvam retries safe polling but does not retry an ambiguous digitise submission', async () => {
  let submitCalls = 0;
  const refusing = createSarvamDocAiTransport({
    apiKey: 'secret', segmenter, retryDelayMs: 0,
    fetchImpl: async () => { submitCalls += 1; return jsonResponse({}, 503); },
  });
  await assert.rejects(refusing.createJob({ bytes: Buffer.from('%PDF- synthetic') }),
    error => error.code === 'OCR_PROVIDER_UNAVAILABLE');
  assert.equal(submitCalls, 1);

  let submissions = 0;
  let firstStatusCalls = 0;
  const polling = createSarvamDocAiTransport({
    apiKey: 'secret', segmenter, retryDelayMs: 0, maxRetries: 2,
    fetchImpl: async url => {
      const path = new URL(url).pathname;
      if (path.endsWith('/digitise')) return jsonResponse({ job_id: `retry-job-${++submissions}`, status: 'pending' }, 201);
      const jobId = path.split('/').at(-2);
      if (path.endsWith('/status')) {
        if (jobId === 'retry-job-1' && firstStatusCalls++ === 0) return jsonResponse({}, 503);
        return jsonResponse({ job_id: jobId, status: 'completed' });
      }
      return jsonResponse(completedResult(jobId, jobId === 'retry-job-1' ? 10 : 1));
    },
  });
  const submitted = await polling.createJob({ bytes: Buffer.from('%PDF- synthetic') });
  assert.equal((await polling.getJob({ jobRef: submitted.jobRef })).status, 'succeeded');
  assert.equal(firstStatusCalls, 2);
});

test('Sarvam maps credentials, credits, rate limits, bad input and oversized responses to safe codes', async () => {
  const onePage = { async segment() { return { pageCount: 1, segments: [{
    index: 0, originalPages: [1], bytes: Buffer.from('%PDF- one'), contentSha256: 'a'.repeat(64),
  }] }; } };
  for (const [status, code] of [
    [401, 'OCR_PROVIDER_AUTHENTICATION_FAILED'],
    [403, 'OCR_PROVIDER_FORBIDDEN'],
    [402, 'OCR_PROVIDER_ENTITLEMENT_REQUIRED'],
    [429, 'OCR_PROVIDER_RATE_LIMITED'],
    [413, 'OCR_PROVIDER_FILE_TOO_LARGE'],
    [400, 'OCR_PROVIDER_INPUT_REJECTED'],
  ]) {
    const transport = createSarvamDocAiTransport({
      apiKey: 'secret', segmenter: onePage, retryDelayMs: 0,
      fetchImpl: async () => jsonResponse({}, status),
    });
    await assert.rejects(transport.createJob({ bytes: Buffer.from('%PDF- synthetic') }), error => error.code === code);
  }
  const malformed = createSarvamDocAiTransport({
    apiKey: 'secret', segmenter: onePage,
    fetchImpl: async () => ({ ok: true, status: 201, headers: { get: () => null }, async text() { return '{not-json'; } }),
  });
  await assert.rejects(malformed.createJob({ bytes: Buffer.from('%PDF- synthetic') }),
    error => error.code === 'OCR_PROVIDER_RESPONSE_INVALID');
  const oversized = createSarvamDocAiTransport({
    apiKey: 'secret', segmenter: onePage,
    fetchImpl: async () => ({
      ok: true, status: 201, headers: { get: () => String(9 * 1024 * 1024) }, async text() { return '{}'; },
    }),
  });
  await assert.rejects(oversized.createJob({ bytes: Buffer.from('%PDF- synthetic') }),
    error => error.code === 'OCR_PROVIDER_RESPONSE_TOO_LARGE');
});

test('normalization preserves exact multilingual policy text, punctuation, negation and table layout', () => {
  const transport = createSarvamDocAiTransport({ apiKey: 'secret', segmenter, fetchImpl: async () => jsonResponse({}) });
  const content = [
    'Room rent: ₹5,000 per day. NOT covered after 30 days.',
    '| सदस्य | सह-भुगतान |',
    '|---|---:|',
    '| অরুণ | 20% |',
    'Footnote: exceptions continue on the next page.',
  ].join('\n');
  const normalized = transport.normalizeResult({
    manifest: {
      version: 1, pageCount: 1,
      segments: [{ index: 0, jobId: 'multilingual-job', originalPages: [1], segmentSha256: 'a'.repeat(64), lastStatus: 'completed' }],
    },
    results: [{
      type: 'digitise', job_id: 'multilingual-job', status: 'completed',
      usage: { pages_total: 1, pages_processed: 1, pages_succeeded: 1, pages_failed: 0 },
      documents: [{ pages: [{ page_number: 1, content }] }],
    }],
  }, { documentId: 'document-1', sourceVersion: '1', contentSha256: 'b'.repeat(64) });
  assert.equal(normalized.pages[0].text, content);
});

test('Sarvam Document AI rejects missing, duplicate and reordered provider pages', () => {
  const transport = createSarvamDocAiTransport({ apiKey: 'secret', segmenter, fetchImpl: async () => jsonResponse({}) });
  const manifest = {
    version: 1, pageCount: 2,
    segments: [{ index: 0, jobId: 'job-pages', originalPages: [1, 2], segmentSha256: 'a'.repeat(64) }],
  };
  const expected = { documentId: 'document-1', sourceVersion: '1', contentSha256: 'b'.repeat(64) };
  for (const pages of [
    [{ page_number: 1, content: 'one' }],
    [{ page_number: 1, content: 'one' }, { page_number: 1, content: 'again' }],
    [{ page_number: 2, content: 'two' }, { page_number: 1, content: 'one' }],
  ]) {
    assert.throws(() => transport.normalizeResult({
      manifest,
      results: [{ type: 'digitise', job_id: 'job-pages', status: 'completed',
        usage: { pages_total: 2, pages_processed: 2, pages_succeeded: 2, pages_failed: 0 }, documents: [{ pages }] }],
    }, expected), error => error.code === 'OCR_PROVIDER_PAGE_MISMATCH');
  }
  assert.throws(() => transport.normalizeResult({
    manifest,
    results: [{ type: 'digitise', job_id: 'wrong-job', status: 'completed',
      usage: { pages_total: 2, pages_processed: 2, pages_succeeded: 2, pages_failed: 0 }, documents: [{ pages: [
      { page_number: 1, content: 'one' }, { page_number: 2, content: 'two' },
    ] }] }],
  }, expected), error => error.code === 'OCR_PROVIDER_RESPONSE_INVALID');
});

test('a blank provider page remains an explicit failed page and cannot look complete', () => {
  const transport = createSarvamDocAiTransport({ apiKey: 'secret', segmenter, fetchImpl: async () => jsonResponse({}) });
  const normalized = transport.normalizeResult({
    manifest: {
      version: 1, pageCount: 1,
      segments: [{ index: 0, jobId: 'blank-job', originalPages: [1], segmentSha256: 'a'.repeat(64), lastStatus: 'completed' }],
    },
    results: [{
      type: 'digitise', job_id: 'blank-job', status: 'completed',
      usage: { pages_total: 1, pages_processed: 1, pages_succeeded: 1, pages_failed: 0 },
      documents: [{ pages: [{ page_number: 1, content: '   ' }] }],
    }],
  }, { documentId: 'document-1', sourceVersion: '1', contentSha256: 'b'.repeat(64) });
  assert.equal(normalized.pages[0].extractionStatus, 'failed');
  assert.equal(validateOcrOutput(normalized).assessment.complete, false);
});

test('Sarvam rejects completed page content when terminal usage reports a failed page', () => {
  const transport = createSarvamDocAiTransport({ apiKey: 'secret', segmenter, fetchImpl: async () => jsonResponse({}) });
  assert.throws(() => transport.normalizeResult({
    manifest: {
      version: 1, pageCount: 1,
      segments: [{ index: 0, jobId: 'usage-job', originalPages: [1], segmentSha256: 'a'.repeat(64), lastStatus: 'completed' }],
    },
    results: [{
      type: 'digitise', job_id: 'usage-job', status: 'completed',
      usage: { pages_total: 1, pages_processed: 1, pages_succeeded: 0, pages_failed: 1 },
      documents: [{ pages: [{ page_number: 1, content: 'Provider returned text despite reporting failure.' }] }],
    }],
  }, { documentId: 'document-1', sourceVersion: '1', contentSha256: 'b'.repeat(64) }),
  error => error.code === 'OCR_PROVIDER_RESPONSE_INVALID');
});

test('Sarvam provider is disabled by default and requires exact provider consent when enabled', async () => {
  const transport = { createJob: async () => ({ status: 'submitted', jobRef: 'job' }), getJob() {}, cancelJob() {}, normalizeResult() {} };
  const disabled = createSarvamOcrProvider({ env: { SARVAM_API_KEY: 'secret' }, transport });
  assert.equal(disabled.health().status, 'disabled');
  await assert.rejects(disabled.createJob({ authorization: { authorized: true, recipient: 'sarvam' } }),
    error => error.code === 'OCR_PROVIDER_DISABLED');
  const enabled = createSarvamOcrProvider({ env: { SARVAM_OCR_ENABLED: 'true', SARVAM_API_KEY: 'secret' }, transport });
  await assert.rejects(enabled.createJob({ authorization: { authorized: true, recipient: 'google-gemini' } }),
    error => error.code === 'PROVIDER_AUTHORIZATION_REQUIRED');
  assert.deepEqual(await disabled.cancelJob({
    authorization: { authorized: true, purpose: 'document_erasure' }, jobRef: 'retained-job', requestId: 'local-job',
  }), { status: 'not_supported', remoteCancellation: false });
});

test('Sarvam cancellation reports the documented local-only cleanup limit', async () => {
  const transport = createSarvamDocAiTransport({ apiKey: 'secret', segmenter, fetchImpl: async () => jsonResponse({}) });
  assert.deepEqual(await transport.cancelJob({ jobRef: 'unused' }), {
    status: 'not_supported', remoteCancellation: false,
  });
});
