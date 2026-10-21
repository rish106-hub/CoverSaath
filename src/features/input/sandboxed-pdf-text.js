import { spawn } from 'node:child_process';
import { dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DocumentIntakeError } from './contracts.js';
import { PDF_TEXT_EXTRACTOR_VERSION, PDF_TEXT_LIMITS } from './pdf-text-extraction.js';
import { buildSandboxArgs } from './sandboxed-pdf-inspection.js';

// Byte-derived page text in a permission-restricted child: no network, no writes, reads only its own code and pdf-lib.
// The parent re-validates the child's JSON shape and bounds; anything off is a failure, never partial text.
const CHILD_ENTRY = fileURLToPath(new URL('./pdf-text-child.mjs', import.meta.url));
const EXTRACTOR = fileURLToPath(new URL('./pdf-text-extraction.js', import.meta.url));
const packageDirectory = name => {
  const resolved = fileURLToPath(import.meta.resolve(name));
  const marker = `${sep}node_modules${sep}${name.split('/').join(sep)}${sep}`;
  const end = resolved.indexOf(marker);
  if (end < 0) throw new TypeError(`Cannot isolate package ${name}.`);
  return resolved.slice(0, end + marker.length);
};
const CHILD_READ_PATHS = Object.freeze([
  CHILD_ENTRY, EXTRACTOR,
  packageDirectory('pdf-lib'), packageDirectory('@pdf-lib/standard-fonts'), packageDirectory('@pdf-lib/upng'), packageDirectory('pako'), packageDirectory('tslib'),
]);

export const PDF_TEXT_SANDBOX_LIMITS = Object.freeze({
  maxInputBytes: 20 * 1024 * 1024,
  maxOutputBytes: 160 * 1024 * 1024,
  timeoutMs: 30_000,
  maxOldSpaceMb: 384,
});

const REASON = /^[a-z_]{1,40}$/;
const failure = (code, message) => new DocumentIntakeError(code, message);

function validateResult(value) {
  if (!value || value.extractor !== PDF_TEXT_EXTRACTOR_VERSION || !['established', 'unestablished'].includes(value.status)) return null;
  if (!Number.isSafeInteger(value.pageCount) || value.pageCount < 0 || value.pageCount > PDF_TEXT_LIMITS.maxPages || !Array.isArray(value.pages)) return null;
  if (value.pages.length && value.pages.length !== value.pageCount) return null;
  if (value.reason !== undefined && !REASON.test(value.reason)) return null;
  const pages = value.pages.map((page, i) => {
    if (page?.page !== i + 1) return null;
    if (page.status === 'established' && typeof page.text === 'string' && page.text.trim() && page.text.length <= PDF_TEXT_LIMITS.maxPageChars) return Object.freeze({ page: i + 1, status: 'established', text: page.text });
    if (page.status === 'unestablished' && REASON.test(page.reason)) return Object.freeze({ page: i + 1, status: 'unestablished', reason: page.reason });
    return null;
  });
  if (pages.some(page => page === null)) return null;
  const established = pages.length > 0 && pages.every(page => page.status === 'established');
  if ((value.status === 'established') !== established) return null;
  return Object.freeze({ extractor: value.extractor, status: value.status, pageCount: value.pageCount, pages: Object.freeze(pages), ...(value.reason ? { reason: value.reason } : {}) });
}

/** `extract(bytes)` resolves to the validated result, or rejects with PDF_TEXT_FAILED / PDF_TEXT_UNAVAILABLE. */
export function createSandboxedPdfTextExtractor({ limits = {}, onEvent = () => {} } = {}) {
  const resolved = Object.freeze({ ...PDF_TEXT_SANDBOX_LIMITS, ...limits });
  if (resolved.maxInputBytes > PDF_TEXT_SANDBOX_LIMITS.maxInputBytes) throw new TypeError('PDF text input limit cannot exceed the curated source cap.');
  const args = buildSandboxArgs({ entry: CHILD_ENTRY, readPaths: CHILD_READ_PATHS, maxOldSpaceMb: resolved.maxOldSpaceMb });
  return Object.freeze({
    version: PDF_TEXT_EXTRACTOR_VERSION,
    async extract(bytes) {
      if (!(bytes instanceof Uint8Array)) throw failure('INVALID_BYTES', 'PDF bytes are required.');
      if (bytes.length > resolved.maxInputBytes) throw failure('FILE_TOO_LARGE', 'The PDF exceeds the text extraction limit.');
      const startedAt = Date.now();
      return new Promise((resolve, reject) => {
        let child;
        let output = [];
        let outputBytes = 0;
        let reason = null;
        let settled = false;
        const finish = (error, result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try { onEvent({ type: error ? 'pdf_text_failed' : 'pdf_text_completed', reason, durationMs: Date.now() - startedAt }); } catch {}
          if (error) reject(error); else resolve(result);
        };
        try {
          child = spawn(process.execPath, args, { cwd: dirname(CHILD_ENTRY), env: {}, stdio: ['pipe', 'pipe', 'ignore'], shell: false, windowsHide: true });
        } catch {
          reject(failure('PDF_TEXT_UNAVAILABLE', 'PDF text extraction is unavailable.'));
          return;
        }
        const timer = setTimeout(() => { reason = 'timeout'; child.kill('SIGKILL'); }, resolved.timeoutMs);
        child.once('error', () => { reason = 'spawn_error'; finish(failure('PDF_TEXT_UNAVAILABLE', 'PDF text extraction is unavailable.')); });
        child.stdout.on('data', chunk => {
          outputBytes += chunk.length;
          if (outputBytes > resolved.maxOutputBytes) { reason = 'output_too_large'; output = []; child.kill('SIGKILL'); return; }
          output.push(chunk);
        });
        child.stdin.on('error', () => {});
        child.once('close', (code, signal) => {
          if (settled) return;
          if (reason || code !== 0 || signal !== null) return finish(failure('PDF_TEXT_FAILED', 'The PDF text could not be derived safely.'));
          let parsed;
          try { parsed = validateResult(JSON.parse(Buffer.concat(output).toString('utf8'))); } catch { parsed = null; }
          if (!parsed) return finish(failure('PDF_TEXT_FAILED', 'The PDF text could not be derived safely.'));
          finish(null, parsed);
        });
        child.stdin.end(bytes);
      });
    },
  });
}

export const PDF_TEXT_CHILD = Object.freeze({ entry: CHILD_ENTRY, readPaths: CHILD_READ_PATHS });
