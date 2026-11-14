import { spawn } from 'node:child_process';
import { dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DocumentIntakeError, MAX_DOCUMENT_BYTES } from './contracts.js';
import { PdfSandboxError, PDF_SANDBOX_EXIT_CODES, buildSandboxArgs } from './sandboxed-pdf-inspection.js';

// Sandboxed PDF sanitiser and insurance gate (ADR 0035). Same isolation as the inspector: a child Node process with
// the permission model, scoped reads (own code plus pdf-lib), an empty environment, a heap cap, a timeout and bounded
// output. Any failure rejects the upload; nothing is ever treated as sanitised or insurance without a valid child result.

const fileOf = name => fileURLToPath(new URL(name, import.meta.url));
const packageDirectory = name => {
  const resolved = fileURLToPath(import.meta.resolve(name));
  const marker = `${sep}node_modules${sep}${name.split('/').join(sep)}${sep}`;
  const end = resolved.indexOf(marker);
  if (end < 0) throw new TypeError(`Cannot isolate package ${name}.`);
  return resolved.slice(0, end + marker.length);
};
const PDF_LIB_PATHS = () => [packageDirectory('pdf-lib'), packageDirectory('@pdf-lib/standard-fonts'), packageDirectory('@pdf-lib/upng'), packageDirectory('pako'), packageDirectory('tslib')];

export const PDF_UPLOAD_CHECK_LIMITS = Object.freeze({ timeoutMs: 15_000, maxOldSpaceMb: 256, maxConcurrent: 2, maxQueued: 8 });
const MAX_OUTPUT_BYTES = MAX_DOCUMENT_BYTES + 64 * 1024;
const EXIT_REJECTED = 66;

const busy = () => new PdfSandboxError('PDF_INSPECTION_BUSY', 'PDF checks are busy. Try the upload again shortly.', 429, true);
const unavailable = () => new PdfSandboxError('PDF_INSPECTION_UNAVAILABLE', 'PDF checks are unavailable. Try the upload again later.', 503, true);
const failed = () => new PdfSandboxError('PDF_INSPECTION_FAILED', 'The PDF could not be checked and was not accepted.', 422, false);

function createRunner({ entry, readPaths, limits = {}, maxOutputBytes }) {
  const resolved = { ...PDF_UPLOAD_CHECK_LIMITS, ...limits };
  const args = buildSandboxArgs({ entry, readPaths, maxOldSpaceMb: resolved.maxOldSpaceMb });
  const active = new Set();
  const queue = [];
  let closed = false;

  function runChild(bytes) {
    return new Promise((resolve, reject) => {
      let child;
      let settled = false;
      let failure = null;
      let timer = null;
      const out = [];
      let outBytes = 0;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        active.delete(child);
        if (error) reject(error); else resolve(value);
      };
      const kill = reason => { failure ??= reason; try { child?.kill('SIGKILL'); } catch { /* already gone */ } };
      try {
        child = spawn(process.execPath, args, { cwd: dirname(entry), env: {}, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, shell: false });
      } catch { finish(unavailable()); return; }
      active.add(child);
      timer = setTimeout(() => kill('timeout'), resolved.timeoutMs);
      child.once('error', () => { kill('spawn_error'); finish(unavailable()); });
      child.stdout.on('data', chunk => {
        if (failure) return;
        outBytes += chunk.length;
        if (outBytes > maxOutputBytes) { out.length = 0; kill('output_too_large'); return; }
        out.push(chunk);
      });
      child.stdin.on('error', () => {});
      child.once('close', (exitCode, signal) => {
        if (failure === 'closed') return finish(unavailable());
        if (failure) return finish(failed());
        if (exitCode === PDF_SANDBOX_EXIT_CODES.sandboxInactive) return finish(unavailable());
        if (signal !== null || (exitCode !== 0 && exitCode !== EXIT_REJECTED)) return finish(failed());
        return finish(null, { rejected: exitCode === EXIT_REJECTED, output: Buffer.concat(out) });
      });
      child.stdin.end(bytes);
    });
  }

  function pump() {
    while (!closed && active.size < resolved.maxConcurrent && queue.length) {
      const job = queue.shift();
      runChild(job.bytes).then(job.resolve, job.reject).finally(pump);
    }
  }

  return Object.freeze({
    run(bytes) {
      if (!(bytes instanceof Uint8Array)) throw new DocumentIntakeError('INVALID_BYTES', 'File bytes are required.');
      if (bytes.length > MAX_DOCUMENT_BYTES) throw new DocumentIntakeError('FILE_TOO_LARGE', 'The file exceeds the upload limit.');
      if (closed) throw unavailable();
      if (active.size >= resolved.maxConcurrent && queue.length >= resolved.maxQueued) throw busy();
      return new Promise((resolve, reject) => { queue.push({ bytes, resolve, reject }); pump(); });
    },
    close() {
      closed = true;
      for (const job of queue.splice(0)) job.reject(unavailable());
      for (const child of active) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
    },
  });
}

const REMOVED_LABEL = /^[a-z_]{1,40}$/;

/** `sanitise(bytes)` resolves { bytes, removed } or rejects with a DocumentIntakeError / PdfSandboxError. */
export function createSandboxedPdfSanitiser({ limits } = {}) {
  const entry = fileOf('./pdf-sanitise-child.mjs');
  const runner = createRunner({ entry, readPaths: [entry, fileOf('./pdf-sanitise.js'), ...PDF_LIB_PATHS()], limits, maxOutputBytes: MAX_OUTPUT_BYTES });
  return Object.freeze({
    async sanitise(bytes) {
      const { rejected, output } = await runner.run(bytes);
      if (rejected) {
        let code;
        try { code = JSON.parse(output.toString('utf8')).code; } catch { throw failed(); }
        if (code === 'PDF_PASSWORD_REQUIRED') throw new DocumentIntakeError(code, 'The PDF is password protected.');
        if (code === 'PDF_STRUCTURE_INVALID') throw new DocumentIntakeError(code, 'The PDF structure could not be read.');
        throw failed();
      }
      const newline = output.indexOf(0x0a);
      if (newline < 0) throw failed();
      let header;
      try { header = JSON.parse(output.subarray(0, newline).toString('utf8')); } catch { throw failed(); }
      if (!Array.isArray(header?.removed) || header.removed.length > 20 || !header.removed.every(label => typeof label === 'string' && REMOVED_LABEL.test(label))) throw failed();
      const sanitised = output.subarray(newline + 1);
      if (sanitised.length < 8 || sanitised.length > MAX_DOCUMENT_BYTES) throw failed();
      return { bytes: new Uint8Array(sanitised), removed: header.removed };
    },
    close: runner.close,
  });
}

/** `assess(bytes)` resolves 'insurance' | 'not_insurance' | 'undetermined'. */
export function createSandboxedInsuranceGate({ limits } = {}) {
  const entry = fileOf('./insurance-pdf-gate-child.mjs');
  const runner = createRunner({
    entry,
    readPaths: [entry, fileOf('./insurance-pdf-gate.js'), fileOf('./pdf-text-extraction.js'), ...PDF_LIB_PATHS()],
    limits,
    maxOutputBytes: 256,
  });
  return Object.freeze({
    async assess(bytes) {
      const { rejected, output } = await runner.run(bytes);
      if (rejected) throw failed();
      let verdict;
      try { verdict = JSON.parse(output.toString('utf8')).verdict; } catch { throw failed(); }
      if (!['insurance', 'not_insurance', 'undetermined'].includes(verdict)) throw failed();
      return verdict;
    },
    close: runner.close,
  });
}
