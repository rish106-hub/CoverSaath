// Child entry for sandboxed PDF inspection (ADR 0005 amendment). Spawned only by
// sandboxed-pdf-inspection.js with the Node permission model on, a scoped --allow-fs-read,
// a heap cap and an empty environment. Reads untrusted PDF bytes from stdin and writes one
// bounded JSON object to stdout. It never writes document content, names or messages.
//
// Exit codes: 0 result written, 78 permission model not active (refuses to parse),
// 65 input over the byte cap, 70 internal failure. The parent treats every non-zero exit,
// signal, timeout and malformed output as a failed (never clean) inspection.

import { fileURLToPath } from 'node:url';

const EXIT_SANDBOX_INACTIVE = 78;
const EXIT_INPUT_TOO_LARGE = 65;
const EXIT_INTERNAL = 70;

// Codes inspectPdf raises on purpose. Anything else is an internal failure.
const INSPECTION_CODES = new Set([
  'PDF_STRUCTURE_INVALID', 'PDF_PASSWORD_REQUIRED', 'PDF_ACTIVE_CONTENT',
  'PDF_PAGE_LIMIT', 'PDF_RESOURCE_LIMIT', 'PDF_UNSUPPORTED_ENCODING',
]);

function denied(scope, reference) {
  try {
    return process.permission.has(scope, reference) === false;
  } catch {
    // A scope this Node version does not know cannot be granted.
    return true;
  }
}

// Fail closed unless the permission model is active and grants nothing this process does not need.
function sandboxActive() {
  if (typeof process.permission?.has !== 'function') return false;
  const scopes = ['fs.write', 'child', 'worker', 'wasi', 'addon', 'inspector'];
  if (!scopes.every(scope => denied(scope))) return false;
  // A reference-less fs check only reports a full grant, so also probe concrete paths. This
  // catches broad grants; the parent's flag builder is what keeps grants narrow.
  // Probes: the root, a file under it, and ungranted names beside and above this module, so a
  // root, parent-directory or module-directory grant is refused.
  const probe = 'coversaath-permission-probe';
  const paths = ['/', `/${probe}`, fileURLToPath(new URL(probe, import.meta.url)), fileURLToPath(new URL(`../${probe}`, import.meta.url))];
  if (!denied('fs.read') || !denied('fs.write')) return false;
  for (const path of [...paths, process.cwd()]) {
    if (!denied('fs.write', path)) return false;
  }
  for (const path of paths) {
    if (!denied('fs.read', path)) return false;
  }
  // Network is a permission scope from Node 25. Where it exists it must be denied.
  if (process.allowedNodeEnvironmentFlags.has('--allow-net') && !denied('net')) return false;
  return true;
}

if (!sandboxActive()) process.exit(EXIT_SANDBOX_INACTIVE);

const { inspectPdf } = await import('./pdf-inspection.js');
const { MAX_DOCUMENT_BYTES } = await import('./contracts.js');

const chunks = [];
let received = 0;
for await (const chunk of process.stdin) {
  received += chunk.length;
  if (received > MAX_DOCUMENT_BYTES) process.exit(EXIT_INPUT_TOO_LARGE);
  chunks.push(chunk);
}

let output;
try {
  const result = inspectPdf(Buffer.concat(chunks, received));
  output = { ok: true, pageCount: result.pageCount, objectStreamCount: result.objectStreamCount, pdfVersion: result.pdfVersion };
} catch (error) {
  if (error?.name !== 'DocumentIntakeError' || !INSPECTION_CODES.has(error.code)) process.exit(EXIT_INTERNAL);
  output = { ok: false, code: error.code };
}
// Let the process exit on its own so the pipe is flushed (pipes are asynchronous on macOS).
process.stdout.write(JSON.stringify(output));
