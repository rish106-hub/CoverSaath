import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DocumentIntakeError, MAX_DOCUMENT_BYTES } from './contracts.js';
import { buildSandboxArgs } from './sandboxed-pdf-inspection.js';

const CHILD_ENTRY = fileURLToPath(new URL('./pdf-segmentation-child.mjs', import.meta.url));
const packageDirectory = name => {
  const resolved = fileURLToPath(import.meta.resolve(name));
  const marker = `${sep}node_modules${sep}${name.split('/').join(sep)}${sep}`;
  const end = resolved.indexOf(marker);
  if (end < 0) throw new TypeError(`Cannot isolate package ${name}.`);
  return resolved.slice(0, end + marker.length);
};
const CHILD_READ_PATHS = Object.freeze([
  CHILD_ENTRY,
  packageDirectory('pdf-lib'),
  packageDirectory('@pdf-lib/standard-fonts'),
  packageDirectory('@pdf-lib/upng'),
  packageDirectory('pako'),
  packageDirectory('tslib'),
]);

export const PDF_SEGMENTATION_LIMITS = Object.freeze({
  pagesPerSegment: 10,
  maxPages: 500,
  maxInputBytes: MAX_DOCUMENT_BYTES,
  maxOutputBytes: 64 * 1024 * 1024,
  timeoutMs: 30_000,
  maxOldSpaceMb: 256,
});

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const failure = (code, message, retryable = false) => Object.assign(new DocumentIntakeError(code, message), { retryable });

function validateResult(value, limits) {
  if (!value || value.ok !== true || !Number.isInteger(value.pageCount) || !Array.isArray(value.segments)) return null;
  if (value.pageCount < 1 || value.pageCount > limits.maxPages) return null;
  const expectedCount = Math.ceil(value.pageCount / limits.pagesPerSegment);
  if (value.segments.length !== expectedCount) return null;
  const seen = [];
  const segments = value.segments.map((segment, index) => {
    if (segment?.index !== index || !Array.isArray(segment.originalPages) || typeof segment.bytes !== 'string') return null;
    const expectedStart = index * limits.pagesPerSegment + 1;
    const expectedEnd = Math.min(expectedStart + limits.pagesPerSegment - 1, value.pageCount);
    const expectedPages = Array.from({ length: expectedEnd - expectedStart + 1 }, (_, offset) => expectedStart + offset);
    if (segment.originalPages.length !== expectedPages.length || segment.originalPages.some((page, offset) => page !== expectedPages[offset])) return null;
    let bytes;
    try { bytes = Buffer.from(segment.bytes, 'base64'); } catch { return null; }
    if (bytes.length === 0 || bytes.length > limits.maxInputBytes || bytes.subarray(0, 5).toString() !== '%PDF-') return null;
    seen.push(...segment.originalPages);
    return Object.freeze({ index, originalPages: Object.freeze(expectedPages), bytes, contentSha256: sha256(bytes) });
  });
  if (segments.some(segment => segment === null) || seen.length !== value.pageCount || seen.some((page, index) => page !== index + 1)) return null;
  return Object.freeze({ pageCount: value.pageCount, segments: Object.freeze(segments) });
}

export function createSandboxedPdfSegmenter({ limits = {}, onEvent = () => {} } = {}) {
  const resolved = Object.freeze({ ...PDF_SEGMENTATION_LIMITS, ...limits });
  if (resolved.pagesPerSegment !== 10 || resolved.maxPages > 500 || resolved.maxInputBytes > MAX_DOCUMENT_BYTES) {
    throw new TypeError('PDF segmentation limits cannot exceed the OCR contract.');
  }
  const args = buildSandboxArgs({ entry: CHILD_ENTRY, readPaths: CHILD_READ_PATHS, maxOldSpaceMb: resolved.maxOldSpaceMb });
  return Object.freeze({
    async segment(bytes) {
      if (!(bytes instanceof Uint8Array)) throw failure('INVALID_BYTES', 'PDF bytes are required.');
      if (bytes.length > resolved.maxInputBytes) throw failure('FILE_TOO_LARGE', 'The PDF exceeds the document limit.');
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
          try { onEvent({ type: error ? 'pdf_segmentation_failed' : 'pdf_segmentation_completed', reason, durationMs: Date.now() - startedAt }); } catch {}
          if (error) reject(error); else resolve(result);
        };
        try {
          child = spawn(process.execPath, args, { cwd: dirname(CHILD_ENTRY), env: {}, stdio: ['pipe', 'pipe', 'ignore'], shell: false, windowsHide: true });
        } catch {
          reject(failure('OCR_SEGMENTATION_UNAVAILABLE', 'PDF segmentation is unavailable.', true));
          return;
        }
        const timer = setTimeout(() => { reason = 'timeout'; child.kill('SIGKILL'); }, resolved.timeoutMs);
        child.once('error', () => { reason = 'spawn_error'; finish(failure('OCR_SEGMENTATION_UNAVAILABLE', 'PDF segmentation is unavailable.', true)); });
        child.stdout.on('data', chunk => {
          outputBytes += chunk.length;
          if (outputBytes > resolved.maxOutputBytes) { reason = 'output_too_large'; output = []; child.kill('SIGKILL'); return; }
          output.push(chunk);
        });
        child.stdin.on('error', () => {});
        child.once('close', (code, signal) => {
          if (settled) return;
          if (reason || code !== 0 || signal !== null) return finish(failure('OCR_SEGMENTATION_FAILED', 'The PDF could not be split safely.'));
          let parsed;
          try { parsed = validateResult(JSON.parse(Buffer.concat(output).toString('utf8')), resolved); } catch { parsed = null; }
          if (!parsed) return finish(failure('OCR_SEGMENTATION_FAILED', 'The PDF could not be split safely.'));
          finish(null, parsed);
        });
        child.stdin.end(bytes);
      });
    },
  });
}

export const PDF_SEGMENTATION_CHILD = Object.freeze({ entry: CHILD_ENTRY, readPaths: CHILD_READ_PATHS });
