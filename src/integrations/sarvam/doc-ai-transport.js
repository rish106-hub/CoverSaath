const API_BASE = 'https://api.sarvam.ai';
const TERMINAL = new Set(['completed', 'partially_completed', 'failed', 'rejected']);
const ACTIVE = new Set(['pending', 'running']);
const JOB_STATES = new Set([...TERMINAL, ...ACTIVE]);
const LANGUAGES = new Set([
  'as-IN', 'bn-IN', 'brx-IN', 'doi-IN', 'en-IN', 'gu-IN', 'hi-IN', 'kn-IN', 'kok-IN',
  'ks-IN', 'mai-IN', 'ml-IN', 'mni-IN', 'mr-IN', 'ne-IN', 'od-IN', 'pa-IN', 'sa-IN',
  'sat-IN', 'sd-IN', 'ta-IN', 'te-IN', 'ur-IN',
]);
const CONTENT_TYPES = new Set(['printed', 'handwritten', 'mixed']);
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_JOB_REF_BYTES = 16_384;
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const boundedString = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max;
const fail = (code, message, retryable = false, statusCode = null) => Object.assign(new Error(message), { code, retryable, statusCode });

function completedUsageMatches(usage, pageCount) {
  if (!plainObject(usage)) return false;
  const fields = ['pages_total', 'pages_processed', 'pages_succeeded', 'pages_failed'];
  if (fields.some(field => !Number.isInteger(usage[field]) || usage[field] < 0)) return false;
  return usage.pages_total === pageCount
    && usage.pages_processed === pageCount
    && usage.pages_succeeded === pageCount
    && usage.pages_failed === 0;
}

function encodeRef(manifest) {
  const encoded = Buffer.from(JSON.stringify(manifest)).toString('base64url');
  if (encoded.length > MAX_JOB_REF_BYTES) throw fail('OCR_PROVIDER_RESPONSE_INVALID', 'Sarvam job manifest is too large.');
  return `sarvam-v1.${encoded}`;
}

function decodeRef(value) {
  if (!boundedString(value, MAX_JOB_REF_BYTES) || !value.startsWith('sarvam-v1.')) {
    throw fail('OCR_PROVIDER_RESPONSE_INVALID', 'Sarvam job reference is invalid.');
  }
  let parsed;
  try { parsed = JSON.parse(Buffer.from(value.slice(10), 'base64url').toString('utf8')); } catch { parsed = null; }
  if (!plainObject(parsed) || parsed.version !== 1 || !Number.isInteger(parsed.pageCount) || !Array.isArray(parsed.segments)) {
    throw fail('OCR_PROVIDER_RESPONSE_INVALID', 'Sarvam job reference is invalid.');
  }
  const pages = [];
  for (const [index, segment] of parsed.segments.entries()) {
    if (!plainObject(segment) || segment.index !== index || !boundedString(segment.jobId, 200)
      || !Array.isArray(segment.originalPages) || segment.originalPages.length < 1 || segment.originalPages.length > 10
      || segment.originalPages.some(page => !Number.isInteger(page) || page < 1)
      || (segment.segmentSha256 !== undefined && !/^[a-f0-9]{64}$/.test(segment.segmentSha256))
      || (segment.lastStatus !== undefined && !JOB_STATES.has(segment.lastStatus))) {
      throw fail('OCR_PROVIDER_RESPONSE_INVALID', 'Sarvam job reference is invalid.');
    }
    pages.push(...segment.originalPages);
  }
  if (pages.length !== parsed.pageCount || pages.some((page, index) => page !== index + 1)) {
    throw fail('OCR_PROVIDER_RESPONSE_INVALID', 'Sarvam page manifest is incomplete.');
  }
  return parsed;
}

function providerError(status) {
  if (status === 401) return fail('OCR_PROVIDER_AUTHENTICATION_FAILED', 'Sarvam rejected the server credential.', false, 503);
  if (status === 403) return fail('OCR_PROVIDER_FORBIDDEN', 'Sarvam refused this request.', false, 403);
  if (status === 429) return fail('OCR_PROVIDER_RATE_LIMITED', 'Sarvam rate limit reached.', true, 429);
  if (status === 503) return fail('OCR_PROVIDER_UNAVAILABLE', 'Sarvam is unavailable.', true, 503);
  if (status === 402) return fail('OCR_PROVIDER_ENTITLEMENT_REQUIRED', 'Sarvam billing or entitlement rejected the request.', false, 403);
  if (status === 413) return fail('OCR_PROVIDER_FILE_TOO_LARGE', 'Sarvam rejected the segment size.', false, 413);
  if (status === 422 || status === 400) return fail('OCR_PROVIDER_INPUT_REJECTED', 'Sarvam rejected the document segment.', false, 422);
  if (status === 404) return fail('OCR_PROVIDER_JOB_NOT_FOUND', 'Sarvam job was not found.', false, 502);
  if (status === 409) return fail('OCR_PROVIDER_NOT_READY', 'Sarvam results are not ready.', true, 409);
  return fail('OCR_PROVIDER_FAILED', 'Sarvam request failed.', status >= 500, 502);
}

async function readJson(response) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) throw fail('OCR_PROVIDER_RESPONSE_TOO_LARGE', 'Sarvam response is too large.');
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_JSON_BYTES) throw fail('OCR_PROVIDER_RESPONSE_TOO_LARGE', 'Sarvam response is too large.');
  try { return JSON.parse(text); } catch { throw fail('OCR_PROVIDER_RESPONSE_INVALID', 'Sarvam returned malformed JSON.'); }
}

export function createSarvamDocAiTransport({
  apiKey,
  segmenter,
  fetchImpl = globalThis.fetch,
  baseUrl = API_BASE,
  timeoutMs = 30_000,
  maxConcurrent = 2,
  maxRetries = 2,
  retryDelayMs = 250,
  maxDocumentPages = 100,
} = {}) {
  if (!boundedString(apiKey, 1_000)) throw new TypeError('Sarvam API key is required.');
  if (!segmenter || typeof segmenter.segment !== 'function') throw new TypeError('A PDF segmenter is required.');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch is required.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) throw new TypeError('Invalid Sarvam timeout.');
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 4) throw new TypeError('Invalid Sarvam concurrency.');
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 3) throw new TypeError('Invalid Sarvam retry limit.');
  if (!Number.isInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 5_000) throw new TypeError('Invalid Sarvam retry delay.');
  if (!Number.isInteger(maxDocumentPages) || maxDocumentPages < 1 || maxDocumentPages > 500) throw new TypeError('Invalid OCR document page limit.');

  async function request(path, options = {}, { retrySafe = false } = {}) {
    for (let attempt = 0; ; attempt += 1) {
      const signal = AbortSignal.timeout(timeoutMs);
      try {
        const response = await fetchImpl(`${baseUrl}${path}`, {
          ...options,
          signal,
          headers: { 'api-subscription-key': apiKey, ...(options.headers ?? {}) },
        });
        if (!response.ok) {
          const error = providerError(response.status);
          if (!retrySafe || !error.retryable || attempt >= maxRetries) throw error;
        } else {
          return readJson(response);
        }
      } catch (error) {
        if (error?.code?.startsWith('OCR_PROVIDER_')) {
          if (!retrySafe || !error.retryable || attempt >= maxRetries) throw error;
        } else if (!retrySafe || attempt >= maxRetries) {
          throw fail('OCR_PROVIDER_NETWORK_UNCERTAIN', 'Sarvam request outcome is unknown.', false, 503);
        }
      }
      await wait(retryDelayMs * (2 ** attempt));
    }
  }

  async function mapConcurrent(items, work) {
    const results = new Array(items.length);
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(maxConcurrent, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        results[index] = await work(items[index], index);
      }
    }));
    return results;
  }

  return Object.freeze({
    async createJob({ document, bytes, settings = {}, beforeSegmentSubmit = null }) {
      const language = settings.language ?? 'en-IN';
      const contentType = settings.contentType ?? 'mixed';
      if (!LANGUAGES.has(language)) throw fail('OCR_LANGUAGE_UNSUPPORTED', 'OCR language is not supported.');
      if (!CONTENT_TYPES.has(contentType)) throw fail('OCR_CONTENT_TYPE_UNSUPPORTED', 'OCR content type is not supported.');
      const split = await segmenter.segment(bytes);
      if (split.pageCount > maxDocumentPages) throw fail('OCR_PAGE_LIMIT', 'The document exceeds the configured OCR page limit.', false, 422);
      const submitted = [];
      try {
        for (const segment of split.segments) {
          if (beforeSegmentSubmit) await beforeSegmentSubmit({
            segmentIndex: segment.index,
            originalPages: [...segment.originalPages],
          });
          const form = new FormData();
          form.append('file', new Blob([segment.bytes], { type: 'application/pdf' }), `document-${segment.index + 1}.pdf`);
          form.append('language', language);
          form.append('output_format', 'json');
          form.append('content_type', contentType);
          const response = await request('/doc-ai/v1/job/digitise', { method: 'POST', body: form });
          if (!plainObject(response) || !boundedString(response.job_id, 200) || !['pending', 'running'].includes(response.status)) {
            throw fail('OCR_PROVIDER_RESPONSE_INVALID', 'Sarvam submission response is invalid.');
          }
          submitted.push({ index: segment.index, originalPages: [...segment.originalPages], segmentSha256: segment.contentSha256, jobId: response.job_id });
        }
      } catch (error) {
        if (submitted.length) error.providerJobRef = encodeRef({ version: 1, pageCount: split.pageCount, segments: submitted });
        throw error;
      }
      return { status: 'submitted', jobRef: encodeRef({ version: 1, pageCount: split.pageCount, segments: submitted }) };
    },

    async getJob({ jobRef }) {
      const manifest = decodeRef(jobRef);
      const statuses = await mapConcurrent(manifest.segments, segment => request(
        `/doc-ai/v1/job/${encodeURIComponent(segment.jobId)}/status`, {}, { retrySafe: true },
      ));
      for (const [index, status] of statuses.entries()) {
        if (!plainObject(status) || status.job_id !== manifest.segments[index].jobId || typeof status.status !== 'string') {
          throw fail('OCR_PROVIDER_RESPONSE_INVALID', 'Sarvam status response is invalid.');
        }
        if (!JOB_STATES.has(status.status)) throw fail('OCR_PROVIDER_RESPONSE_INVALID', 'Sarvam status is invalid.');
      }
      const polledManifest = {
        ...manifest,
        segments: manifest.segments.map((segment, index) => ({ ...segment, lastStatus: statuses[index].status })),
      };
      const currentJobRef = encodeRef(polledManifest);
      const failedStatus = statuses.find(status => TERMINAL.has(status.status) && status.status !== 'completed');
      if (failedStatus) {
        return {
          status: 'failed', jobRef: currentJobRef,
          errorCode: failedStatus.status === 'partially_completed' ? 'OCR_PROVIDER_PARTIAL' : 'OCR_PROVIDER_FAILED',
          errorMessage: 'Sarvam did not complete every page.',
        };
      }
      if (statuses.some(status => status.status !== 'completed')) return { status: 'processing', jobRef: currentJobRef };
      const results = await mapConcurrent(polledManifest.segments, segment => request(
        `/doc-ai/v1/job/${encodeURIComponent(segment.jobId)}/results?format=json`, {}, { retrySafe: true },
      ));
      return { status: 'succeeded', jobRef: currentJobRef, result: { manifest: polledManifest, results } };
    },

    async cancelJob() {
      // Modern Document AI docs expose no cancellation or deletion endpoint. Local job state is
      // invalidated locally; late results are never persisted.
      return { status: 'not_supported', remoteCancellation: false };
    },

    normalizeResult(raw, expected) {
      if (!plainObject(raw) || !plainObject(raw.manifest) || !Array.isArray(raw.results)) {
        throw fail('OCR_PROVIDER_RESPONSE_INVALID', 'Sarvam result envelope is invalid.');
      }
      const manifest = decodeRef(encodeRef(raw.manifest));
      if (raw.results.length !== manifest.segments.length) throw fail('OCR_PROVIDER_RESPONSE_INVALID', 'Sarvam result count is incomplete.');
      const pages = [];
      for (const [segmentIndex, result] of raw.results.entries()) {
        const segment = manifest.segments[segmentIndex];
        if (!plainObject(result) || result.type !== 'digitise' || result.status !== 'completed'
          || result.job_id !== segment.jobId || !Array.isArray(result.documents) || result.documents.length !== 1
          || !Array.isArray(result.documents[0]?.pages)
          || !completedUsageMatches(result.usage, segment.originalPages.length)) {
          throw fail('OCR_PROVIDER_RESPONSE_INVALID', 'Sarvam digitise result is invalid.');
        }
        const providerPages = result.documents[0].pages;
        if (providerPages.length !== segment.originalPages.length) throw fail('OCR_PROVIDER_PAGE_MISMATCH', 'Sarvam returned an incomplete page set.');
        const seen = new Set();
        for (const providerPage of providerPages) {
          if (!plainObject(providerPage) || !Number.isInteger(providerPage.page_num)
            || providerPage.page_num < 1 || providerPage.page_num > segment.originalPages.length
            || seen.has(providerPage.page_num) || !validBlocks(providerPage.blocks)) {
            throw fail('OCR_PROVIDER_PAGE_MISMATCH', 'Sarvam page mapping is invalid.');
          }
          seen.add(providerPage.page_num);
          const ordered = [...providerPage.blocks].sort((left, right) => left.reading_order - right.reading_order);
          const text = ordered.map(block => block.text).join('\n');
          const originalPage = segment.originalPages[providerPage.page_num - 1];
          pages.push({
            pageNumber: originalPage,
            text,
            layoutTags: ordered.map(block => block.layout_tag ?? null),
            extractionStatus: text.trim() ? 'extracted' : 'failed',
            confidenceBasisPoints: null,
            providerPageRef: `${segment.jobId}:page:${providerPage.page_num}`,
          });
        }
      }
      if (pages.length !== manifest.pageCount || pages.some((page, index) => page.pageNumber !== index + 1)) {
        throw fail('OCR_PROVIDER_PAGE_MISMATCH', 'Sarvam pages are missing or reordered.');
      }
      return {
        schemaVersion: 'knowvia.ocr.v1',
        document: { id: expected.documentId, sourceVersion: expected.sourceVersion, contentSha256: expected.contentSha256 },
        provider: { name: 'sarvam', jobRef: encodeRef(manifest) },
        pages,
        warnings: [],
      };
    },
  });
}

function validBlocks(blocks) {
  return Array.isArray(blocks) && blocks.every(block => plainObject(block) && typeof block.text === 'string'
    && Number.isFinite(block.reading_order));
}

export const SARVAM_DOCUMENT_AI = Object.freeze({
  endpoint: '/doc-ai/v1/job/digitise',
  outputFormat: 'json',
  maxPagesPerRequest: 10,
  languages: Object.freeze([...LANGUAGES]),
  contentTypes: Object.freeze([...CONTENT_TYPES]),
});
