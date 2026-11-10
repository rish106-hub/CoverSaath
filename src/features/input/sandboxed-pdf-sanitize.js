import { spawn } from 'node:child_process';
import { dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DocumentIntakeError } from './contracts.js';
import { buildSandboxArgs } from './sandboxed-pdf-inspection.js';

// Runs the sanitizer in a permission-restricted child (no network, no writes, reads only its own code and pdf-lib).
// Any failure rejects with PDF_SANITIZE_FAILED: the caller never falls back to the original bytes.
const CHILD_ENTRY = fileURLToPath(new URL('./pdf-sanitize-child.mjs', import.meta.url));
const SANITIZER = fileURLToPath(new URL('./pdf-sanitize.js', import.meta.url));
const packageDirectory = name => {
  const resolved = fileURLToPath(import.meta.resolve(name));
  const marker = `${sep}node_modules${sep}${name.split('/').join(sep)}${sep}`;
  const end = resolved.indexOf(marker);
  if (end < 0) throw new TypeError(`Cannot isolate package ${name}.`);
  return resolved.slice(0, end + marker.length);
};
const CHILD_READ_PATHS = Object.freeze([
  CHILD_ENTRY, SANITIZER,
  packageDirectory('pdf-lib'), packageDirectory('@pdf-lib/standard-fonts'), packageDirectory('@pdf-lib/upng'), packageDirectory('pako'), packageDirectory('tslib'),
]);

export const PDF_SANITIZE_LIMITS = Object.freeze({
  maxInputBytes: 20 * 1024 * 1024,
  maxOutputBytes: 40 * 1024 * 1024,
  timeoutMs: 30_000,
  maxOldSpaceMb: 384,
  maxConcurrent: 2,
});

const failed = () => new DocumentIntakeError('PDF_SANITIZE_FAILED', 'The PDF could not be cleaned safely.');
const unavailable = () => new DocumentIntakeError('PDF_SANITIZE_UNAVAILABLE', 'PDF cleaning is unavailable. Try again shortly.');

/** `sanitize(bytes)` resolves to a Buffer holding the rebuilt PDF. */
export function createSandboxedPdfSanitizer({ limits = {}, onEvent = () => {} } = {}) {
  const resolved = Object.freeze({ ...PDF_SANITIZE_LIMITS, ...limits });
  if (resolved.maxInputBytes > PDF_SANITIZE_LIMITS.maxInputBytes) throw new TypeError('Sanitizer input limit cannot exceed the document cap.');
  const args = buildSandboxArgs({ entry: CHILD_ENTRY, readPaths: CHILD_READ_PATHS, maxOldSpaceMb: resolved.maxOldSpaceMb });
  let running = 0;
  return Object.freeze({
    async sanitize(bytes) {
      if (!(bytes instanceof Uint8Array)) throw new DocumentIntakeError('INVALID_BYTES', 'File bytes are required.');
      if (bytes.length > resolved.maxInputBytes) throw new DocumentIntakeError('FILE_TOO_LARGE', 'The file exceeds the upload limit.');
      if (running >= resolved.maxConcurrent) throw unavailable();
      running += 1;
      const startedAt = Date.now();
      return new Promise((resolve, reject) => {
        let child;
        let output = [];
        let outputBytes = 0;
        let reason = null;
        let settled = false;
        let timer = null;
        const finish = (error, result) => {
          if (settled) return;
          settled = true;
          running -= 1;
          clearTimeout(timer);
          try { onEvent({ type: error ? 'pdf_sanitize_failed' : 'pdf_sanitize_completed', reason, durationMs: Date.now() - startedAt }); } catch { /* observers cannot break sanitizing */ }
          if (error) reject(error); else resolve(result);
        };
        try {
          child = spawn(process.execPath, args, { cwd: dirname(CHILD_ENTRY), env: {}, stdio: ['pipe', 'pipe', 'ignore'], shell: false, windowsHide: true });
        } catch {
          reason = 'spawn_error';
          finish(unavailable());
          return;
        }
        timer = setTimeout(() => { reason = 'timeout'; child.kill('SIGKILL'); }, resolved.timeoutMs);
        child.once('error', () => { reason = 'spawn_error'; finish(unavailable()); });
        child.stdout.on('data', chunk => {
          outputBytes += chunk.length;
          if (outputBytes > resolved.maxOutputBytes) { reason = 'output_too_large'; output = []; child.kill('SIGKILL'); return; }
          output.push(chunk);
        });
        child.stdin.on('error', () => {});
        child.once('close', (code, signal) => {
          if (settled) return;
          if (code === 78) { reason = 'sandbox_inactive'; return finish(unavailable()); }
          if (reason || code !== 0 || signal !== null || outputBytes === 0) { reason ??= 'abnormal_exit'; return finish(failed()); }
          finish(null, Buffer.concat(output, outputBytes));
        });
        child.stdin.end(bytes);
      });
    },
  });
}

export const PDF_SANITIZE_CHILD = Object.freeze({ entry: CHILD_ENTRY, readPaths: CHILD_READ_PATHS });
