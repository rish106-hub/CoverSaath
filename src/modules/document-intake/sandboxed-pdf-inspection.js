import { spawn } from 'node:child_process';
import { dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DocumentIntakeError, MAX_DOCUMENT_BYTES } from './contracts.js';
import { PDF_INSPECTION_LIMITS } from './pdf-inspection.js';

// Runs inspectPdf in a separate Node process so the API process never parses untrusted PDF
// structure (ADR 0005 amendment). This is process isolation plus the Node permission model,
// not an operating-system sandbox: there is no seccomp, namespace, cgroup or rlimit. Every
// failure (spawn error, crash, signal, non-zero exit, timeout, oversized or malformed output)
// rejects the upload. Nothing here ever reports a file as clean without a valid child result.

export const PDF_SANDBOX_LIMITS = Object.freeze({
  timeoutMs: 5_000,
  maxOldSpaceMb: 128,
  maxOutputBytes: 4_096,
  maxInputBytes: MAX_DOCUMENT_BYTES,
  maxConcurrent: 2,
  maxQueued: 8,
});

export const PDF_SANDBOX_EXIT_CODES = Object.freeze({ sandboxInactive: 78, inputTooLarge: 65, internal: 70 });

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const CHILD_ENTRY = fileURLToPath(new URL('./pdf-inspection-child.mjs', import.meta.url));
// The only files the child may read: its entry and the two modules it imports.
const CHILD_READ_PATHS = Object.freeze([
  CHILD_ENTRY,
  fileURLToPath(new URL('./pdf-inspection.js', import.meta.url)),
  fileURLToPath(new URL('./contracts.js', import.meta.url)),
]);

// Codes the child may report. Messages come from this table, never from the child.
const CHILD_CODE_MESSAGES = Object.freeze({
  PDF_STRUCTURE_INVALID: 'The PDF structure could not be read.',
  PDF_PASSWORD_REQUIRED: 'The PDF is password protected.',
  PDF_ACTIVE_CONTENT: 'The PDF contains active or embedded content.',
  PDF_PAGE_LIMIT: 'The PDF has too many pages.',
  PDF_RESOURCE_LIMIT: 'The PDF exceeds a processing limit.',
  PDF_UNSUPPORTED_ENCODING: 'The PDF uses an unsupported object stream encoding.',
});

export class PdfSandboxError extends Error {
  constructor(code, message, statusCode, retryable) {
    super(message);
    this.name = 'PdfSandboxError';
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = retryable;
  }
}

const busy = () => new PdfSandboxError('PDF_INSPECTION_BUSY', 'PDF checks are busy. Try the upload again shortly.', 429, true);
const unavailable = () => new PdfSandboxError('PDF_INSPECTION_UNAVAILABLE', 'PDF checks are unavailable. Try the upload again later.', 503, true);
const failed = () => new PdfSandboxError('PDF_INSPECTION_FAILED', 'The PDF could not be checked and was not accepted.', 422, false);

/** The permission-model flag of the running Node: --permission (22.13+) or the older experimental name. */
export function permissionFlag(flags = process.allowedNodeEnvironmentFlags) {
  if (flags.has('--permission')) return '--permission';
  if (flags.has('--experimental-permission')) return '--experimental-permission';
  return null;
}

/** Node arguments for a sandboxed child. Grants read access to readPaths only and nothing else. */
export function buildSandboxArgs({ entry, readPaths, maxOldSpaceMb = PDF_SANDBOX_LIMITS.maxOldSpaceMb, flags } = {}) {
  const permission = permissionFlag(flags);
  if (!permission) throw new TypeError('PDF sandbox requires the Node permission model.');
  if (!Number.isSafeInteger(maxOldSpaceMb) || maxOldSpaceMb < 16) throw new TypeError('maxOldSpaceMb must be an integer of at least 16.');
  const paths = [...new Set([entry, ...(readPaths ?? [])])];
  for (const path of paths) {
    // Some Node versions split --allow-fs-read on commas, which would widen or break the grant.
    if (typeof path !== 'string' || !isAbsolute(path) || path.includes(',')) {
      throw new TypeError('PDF sandbox read paths must be absolute and contain no commas.');
    }
  }
  return [
    permission,
    ...paths.map(path => `--allow-fs-read=${path}`),
    `--max-old-space-size=${maxOldSpaceMb}`,
    '--disallow-code-generation-from-strings',
    entry,
  ];
}

function resolveLimits(limits) {
  const merged = { ...PDF_SANDBOX_LIMITS, ...(limits ?? {}) };
  for (const key of Object.keys(PDF_SANDBOX_LIMITS)) {
    if (!Number.isSafeInteger(merged[key]) || merged[key] < (key === 'maxQueued' ? 0 : 1)) {
      throw new TypeError(`PDF sandbox limit ${key} must be a positive integer.`);
    }
  }
  if (merged.maxInputBytes > MAX_DOCUMENT_BYTES) throw new TypeError('PDF sandbox maxInputBytes cannot exceed the document cap.');
  return Object.freeze(merged);
}

function validResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.ok === false) {
    const keys = Object.keys(value);
    if (keys.length !== 2 || typeof value.code !== 'string' || !Object.hasOwn(CHILD_CODE_MESSAGES, value.code)) return null;
    return { rejection: value.code };
  }
  if (value.ok !== true || Object.keys(value).length !== 4) return null;
  const { pageCount, objectStreamCount, pdfVersion } = value;
  if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > PDF_INSPECTION_LIMITS.maxPages) return null;
  if (!Number.isSafeInteger(objectStreamCount) || objectStreamCount < 0 || objectStreamCount > PDF_INSPECTION_LIMITS.maxObjectStreams) return null;
  if (typeof pdfVersion !== 'string' || !/^[12]\.[0-9]$/.test(pdfVersion)) return null;
  return { result: Object.freeze({ pageCount, objectStreamCount, pdfVersion }) };
}

// Shared runner. `entry` and `readPaths` are fixed by createSandboxedPdfInspector; tests use this
// directly with fixture children to exercise timeout, crash and output failures.
export function createPdfSandboxRunner({ entry, readPaths, limits, onEvent = () => {}, flags } = {}) {
  const resolved = resolveLimits(limits);
  const args = buildSandboxArgs({ entry, readPaths, maxOldSpaceMb: resolved.maxOldSpaceMb, flags });
  const cwd = dirname(entry);
  // Running children mapped to the function that kills them for shutdown.
  const active = new Map();
  const queue = [];
  let closed = false;

  // Events carry reasons and numbers only: never bytes, names or child output.
  const emit = event => { try { onEvent(Object.freeze(event)); } catch { /* observers cannot break inspection */ } };

  function runChild(bytes) {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      let settled = false;
      let child;
      let output = [];
      let outputBytes = 0;
      let failure = null;
      let timer = null;
      const finish = (error, value, details) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        active.delete(child);
        emit({ type: error ? 'pdf_inspection_failed' : 'pdf_inspection_completed', durationMs: Date.now() - startedAt, ...details });
        if (error) reject(error); else resolve(value);
      };
      const kill = reason => {
        failure ??= reason;
        try { child?.kill('SIGKILL'); } catch { /* already gone */ }
      };
      try {
        child = spawn(process.execPath, args, {
          cwd,
          env: {},
          stdio: ['pipe', 'pipe', 'ignore'],
          windowsHide: true,
          shell: false,
        });
      } catch {
        finish(unavailable(), null, { reason: 'spawn_error' });
        return;
      }
      active.set(child, () => kill('closed'));
      timer = setTimeout(() => kill('timeout'), resolved.timeoutMs);
      child.once('error', () => {
        kill('spawn_error');
        finish(unavailable(), null, { reason: 'spawn_error' });
      });
      child.stdout.on('data', chunk => {
        if (failure) return;
        outputBytes += chunk.length;
        if (outputBytes > resolved.maxOutputBytes) {
          output = [];
          kill('output_too_large');
          return;
        }
        output.push(chunk);
      });
      // The child may exit before reading everything (a refusal or a cap): ignore EPIPE.
      child.stdin.on('error', () => {});
      child.once('close', (exitCode, signal) => {
        if (failure === 'closed') return finish(unavailable(), null, { reason: 'closed', exitCode, signal });
        if (failure) return finish(failed(), null, { reason: failure, exitCode, signal });
        if (exitCode === PDF_SANDBOX_EXIT_CODES.sandboxInactive) {
          return finish(unavailable(), null, { reason: 'sandbox_inactive', exitCode, signal });
        }
        if (exitCode !== 0 || signal !== null) return finish(failed(), null, { reason: 'abnormal_exit', exitCode, signal });
        let parsed;
        try {
          parsed = validResult(JSON.parse(Buffer.concat(output).toString('utf8')));
        } catch {
          parsed = null;
        }
        if (!parsed) return finish(failed(), null, { reason: 'malformed_output', exitCode, signal });
        if (parsed.rejection) {
          return finish(new DocumentIntakeError(parsed.rejection, CHILD_CODE_MESSAGES[parsed.rejection]), null, { reason: 'rejected', code: parsed.rejection });
        }
        return finish(null, parsed.result, { reason: 'ok' });
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
    limits: resolved,
    async inspect(bytes) {
      if (!(bytes instanceof Uint8Array)) throw new DocumentIntakeError('INVALID_BYTES', 'File bytes are required.');
      if (bytes.length > resolved.maxInputBytes) throw new DocumentIntakeError('FILE_TOO_LARGE', 'The file exceeds the upload limit.');
      if (closed) throw unavailable();
      if (active.size >= resolved.maxConcurrent && queue.length >= resolved.maxQueued) {
        emit({ type: 'pdf_inspection_busy', active: active.size, queued: queue.length });
        throw busy();
      }
      return new Promise((resolve, reject) => {
        queue.push({ bytes, resolve, reject });
        pump();
      });
    },
    stats() {
      return { active: active.size, queued: queue.length, closed };
    },
    // Kills running children and rejects queued work. Safe to call more than once.
    close() {
      closed = true;
      for (const job of queue.splice(0)) job.reject(unavailable());
      for (const killForShutdown of active.values()) killForShutdown();
    },
  });
}

/** Production inspector: fixed child entry and read grant. Returns { inspect, stats, close }. */
export function createSandboxedPdfInspector({ limits, onEvent } = {}) {
  return createPdfSandboxRunner({ entry: CHILD_ENTRY, readPaths: CHILD_READ_PATHS, limits, onEvent });
}

export const PDF_SANDBOX_CHILD = Object.freeze({ entry: CHILD_ENTRY, readPaths: CHILD_READ_PATHS, directory: moduleDirectory });
