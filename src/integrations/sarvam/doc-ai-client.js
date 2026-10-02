// Sarvam Document AI (Digitise) client, written against the public reference verified on 2026-10-02:
//   POST {base}/job/digitise          multipart: file, language, output_format     → { job_id, status, run_id }
//   GET  {base}/job/{job_id}/status                                                  → { status, usage }
//   GET  {base}/job/{job_id}/download-url                                            → { method, url }
// Limits: ≤10 pages per PDF/ZIP, ≤200 MB, 10 requests per minute.
// UNVERIFIED: the per-page metadata shape inside the result ZIP. Parsing below is defensive and fails
// closed (SARVAM_PAGE_MAPPING_UNVERIFIED) rather than guessing page boundaries.

// PDF splitting and ZIP reading are injected by the caller (splitPdf, readZip) so this integration stays
// independent of application modules.

export const SARVAM_DOC_AI_BASE_URL = 'https://api.sarvam.ai/doc-ai/v1';
export const SARVAM_LIMITS = Object.freeze({ maxPagesPerJob: 10, maxBytes: 200 * 1024 * 1024, requestsPerMinute: 10, maxResultBytes: 100 * 1024 * 1024 });
const TERMINAL = new Set(['completed', 'partially_completed', 'failed', 'rejected']);

export class SarvamError extends Error {
  constructor(code, message, { status = null, retryable = false } = {}) {
    super(message);
    this.name = 'SarvamError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.statusCode = 502;
  }
}

/** Sliding-window limiter shared by every Sarvam request from this process. */
export function createRequestLimiter({ perMinute = SARVAM_LIMITS.requestsPerMinute, now = () => Date.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const stamps = [];
  return async function acquire() {
    for (;;) {
      const current = now();
      while (stamps.length && current - stamps[0] >= 60_000) stamps.shift();
      if (stamps.length < perMinute) { stamps.push(current); return; }
      await sleep(60_000 - (current - stamps[0]) + 50);
    }
  };
}

function safeDownloadUrl(value, allowedHostSuffixes = []) {
  let url;
  try { url = new URL(value); } catch { throw new SarvamError('SARVAM_DOWNLOAD_URL_INVALID', 'Sarvam returned an invalid download URL.'); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || host === 'localhost' || /^(\d+\.){3}\d+$/.test(host) || host.endsWith('.local') || host.includes(':')) {
    throw new SarvamError('SARVAM_DOWNLOAD_URL_REJECTED', 'Sarvam download URL is not a public HTTPS URL.');
  }
  if (allowedHostSuffixes.length && !allowedHostSuffixes.some(suffix => host === suffix || host.endsWith(`.${suffix}`))) {
    throw new SarvamError('SARVAM_DOWNLOAD_URL_REJECTED', `Sarvam download host ${host} is not in the allowlist.`);
  }
  return url;
}

function collectText(node, out) {
  if (node == null) return;
  if (typeof node === 'string') return;
  if (Array.isArray(node)) { for (const item of node) collectText(item, out); return; }
  if (typeof node === 'object') {
    if (typeof node.text === 'string' && node.text.trim()) out.push(node.text);
    for (const [key, value] of Object.entries(node)) {
      if (key === 'text' || key === 'bbox' || key === 'bounding_box' || key === 'coordinates') continue;
      if (typeof value === 'object') collectText(value, out);
    }
  }
}

/**
 * Turns one result ZIP into page texts for a chunk. Strategy, in order:
 *  1. metadata/page_NNN.json files → text gathered from their blocks; NNN gives the page order.
 *  2. a JSON primary file with a `pages` array.
 * Anything else fails closed.
 */
export function pagesFromResultZip(zipBuffer, { expectedPages, readZip }) {
  if (typeof readZip !== 'function') throw new TypeError('readZip is required.');
  const entries = readZip(zipBuffer);
  const pageFiles = [...entries.keys()]
    .map(name => ({ name, match: name.match(/(?:^|\/)page_(\d+)\.json$/i) }))
    .filter(item => item.match)
    .sort((left, right) => Number(left.match[1]) - Number(right.match[1]));
  const fromPageFiles = pageFiles.map(({ name, match }) => {
    const parsed = JSON.parse(entries.get(name).toString('utf8'));
    const parts = [];
    collectText(parsed, parts);
    return { localIndex: Number(match[1]), text: parts.join('\n'), ref: name };
  });
  const contiguous = fromPageFiles.every((page, index) => index === 0 || page.localIndex === fromPageFiles[index - 1].localIndex + 1);
  if (fromPageFiles.length && !contiguous) throw new SarvamError('SARVAM_PAGE_MAPPING_UNVERIFIED', 'Sarvam per-page metadata has gaps in page numbering.');
  if (fromPageFiles.length === expectedPages && fromPageFiles.some(page => page.text.trim())) {
    const base = Math.min(...fromPageFiles.map(page => page.localIndex));
    return fromPageFiles.map(page => ({ localPage: page.localIndex - base + 1, text: page.text, ref: page.ref }));
  }
  for (const [name, content] of entries) {
    if (!name.endsWith('.json') || /manifest\.json$/i.test(name) || /page_\d+\.json$/i.test(name)) continue;
    const parsed = JSON.parse(content.toString('utf8'));
    const pages = Array.isArray(parsed?.pages) ? parsed.pages : null;
    if (pages && pages.length === expectedPages) {
      return pages.map((page, index) => {
        const parts = [];
        collectText(page, parts);
        return { localPage: index + 1, text: parts.join('\n'), ref: `${name}#${index + 1}` };
      });
    }
  }
  throw new SarvamError('SARVAM_PAGE_MAPPING_UNVERIFIED', `Sarvam result did not expose ${expectedPages} per-page texts in a recognised shape.`);
}

export function createSarvamDocAiClient({
  apiKey,
  baseUrl = SARVAM_DOC_AI_BASE_URL,
  fetchImpl = globalThis.fetch,
  limiter = createRequestLimiter(),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  pollIntervalMs = 5_000,
  maxWaitMs = 10 * 60_000,
  requestTimeoutMs = 60_000,
  language = 'en-IN',
  splitPdf,
  readZip,
  downloadHostSuffixes = [],
} = {}) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new SarvamError('SARVAM_NOT_CONFIGURED', 'SARVAM_API_KEY is not configured.');
  if (typeof splitPdf !== 'function' || typeof readZip !== 'function') throw new TypeError('splitPdf and readZip are required.');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch is required.');

  async function request(path, init = {}, options = {}) {
    // Retries only failures Sarvam marks as transient (429, 5xx, network), with growing waits.
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await requestOnce(path, init, options);
      } catch (error) {
        if (!error.retryable || attempt >= 4 || init.signal?.aborted) throw error;
        await sleep(Math.min(2_000 * 2 ** (attempt - 1), 30_000));
      }
    }
  }

  async function requestOnce(path, init = {}, { absoluteUrl = null } = {}) {
    await limiter();
    const url = absoluteUrl ?? `${baseUrl}${path}`;
    let response;
    try {
      response = await fetchImpl(url, {
        ...init,
        headers: absoluteUrl ? {} : { 'api-subscription-key': apiKey, ...(init.headers ?? {}) },
        redirect: 'error',
        signal: AbortSignal.any([init.signal, AbortSignal.timeout(requestTimeoutMs)].filter(Boolean)),
      });
    } catch (error) {
      throw new SarvamError('SARVAM_NETWORK_ERROR', `Sarvam request failed: ${error?.name ?? 'error'}.`, { retryable: true });
    }
    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      let detail = '';
      try { detail = String((await response.json())?.detail ?? '').slice(0, 200); } catch { /* body not JSON */ }
      throw new SarvamError(`SARVAM_HTTP_${response.status}`, `Sarvam returned HTTP ${response.status}${detail ? `: ${detail}` : ''}.`, { status: response.status, retryable });
    }
    return response;
  }

  async function digitiseChunk({ bytes, filename, mimeType, expectedPages, signal }) {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: mimeType }), filename);
    form.append('language', language);
    form.append('output_format', 'json');
    const created = await (await request('/job/digitise', { method: 'POST', body: form, signal })).json();
    if (typeof created?.job_id !== 'string' || !created.job_id) throw new SarvamError('SARVAM_RESPONSE_INVALID', 'Sarvam did not return a job_id.');
    const jobId = created.job_id;
    const started = Date.now();
    let status = String(created.status ?? 'pending').toLowerCase();
    let usage = null;
    while (!TERMINAL.has(status)) {
      if (Date.now() - started > maxWaitMs) throw new SarvamError('SARVAM_TIMEOUT', `Sarvam job ${jobId} did not finish in time.`, { retryable: true });
      await sleep(pollIntervalMs);
      const body = await (await request(`/job/${encodeURIComponent(jobId)}/status`, { method: 'GET', signal })).json();
      status = String(body?.status ?? '').toLowerCase();
      usage = body?.usage ?? usage;
      if (!status) throw new SarvamError('SARVAM_RESPONSE_INVALID', 'Sarvam status response had no status.');
    }
    if (status === 'failed' || status === 'rejected') throw new SarvamError('SARVAM_JOB_FAILED', `Sarvam job ${jobId} ended as ${status}.`);
    const link = await (await request(`/job/${encodeURIComponent(jobId)}/download-url`, { method: 'GET', signal })).json();
    const url = safeDownloadUrl(link?.url, downloadHostSuffixes);
    const download = await request('', { method: 'GET', signal }, { absoluteUrl: url.toString() });
    const declared = Number(download.headers?.get?.('content-length') ?? 0);
    if (declared > SARVAM_LIMITS.maxResultBytes) throw new SarvamError('SARVAM_RESULT_TOO_LARGE', 'Sarvam result archive is larger than allowed.');
    const zip = Buffer.from(await download.arrayBuffer());
    if (zip.length > SARVAM_LIMITS.maxResultBytes) throw new SarvamError('SARVAM_RESULT_TOO_LARGE', 'Sarvam result archive is larger than allowed.');
    const pages = pagesFromResultZip(zip, { expectedPages, readZip });
    return { jobId, status, usage, pages };
  }

  return Object.freeze({
    name: 'sarvam',
    mode: 'live',
    /**
     * Extracts page-tagged text from a whole document by chunking PDFs into ≤10-page jobs.
     * Returns { pages: [{ pageNumber, text, extractionStatus, confidenceBasisPoints, providerPageRef }], jobRefs, warnings }.
     */
    async extractPages({ bytes, mimeType, filename = 'document', onProgress = () => {}, signal } = {}) {
      if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new TypeError('Document bytes are required.');
      if (bytes.length > SARVAM_LIMITS.maxBytes) throw new SarvamError('SARVAM_FILE_TOO_LARGE', 'The document exceeds Sarvam\'s size limit.');
      const chunks = mimeType === 'application/pdf'
        ? await splitPdf(bytes, { maxPages: SARVAM_LIMITS.maxPagesPerJob })
        : [{ index: 0, firstPage: 1, lastPage: 1, bytes }];
      const pages = [];
      const jobRefs = [];
      const warnings = [];
      for (const chunk of chunks) {
        const expectedPages = chunk.lastPage - chunk.firstPage + 1;
        const result = await digitiseChunk({
          bytes: chunk.bytes,
          filename: mimeType === 'application/pdf' ? `chunk-${chunk.index + 1}.pdf` : filename,
          mimeType,
          expectedPages,
          signal,
        });
        jobRefs.push(result.jobId);
        if (result.status === 'partially_completed') warnings.push(`Sarvam job ${result.jobId} partially completed.`);
        for (const page of result.pages) {
          const text = page.text ?? '';
          pages.push({
            pageNumber: chunk.firstPage + page.localPage - 1,
            text,
            extractionStatus: text.trim() ? 'extracted' : 'failed',
            confidenceBasisPoints: null,
            providerPageRef: `${result.jobId}:${page.ref}`.slice(0, 200),
          });
        }
        onProgress({ chunk: chunk.index + 1, chunks: chunks.length, pagesDone: chunk.lastPage });
      }
      return { pages, jobRefs, warnings };
    },
  });
}
