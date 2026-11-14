// Permission-restricted PDF sanitiser child (ADR 0035). One PDF on stdin; stdout is one JSON header line
// ({"removed":[...]}), a newline, then the rebuilt PDF bytes. A known rejection prints only {"code":"..."} and
// exits 66. Nothing from the document is logged.
import { sanitisePdf } from './pdf-sanitise.js';

const MAX_INPUT_BYTES = 15 * 1024 * 1024;
const EXIT_SANDBOX_INACTIVE = 78;
const EXIT_INPUT_TOO_LARGE = 65;
const EXIT_INTERNAL = 70;
const EXIT_REJECTED = 66;

function denied(scope, reference) {
  try { return process.permission.has(scope, reference) === false; } catch { return true; }
}
function sandboxActive() {
  if (typeof process.permission?.has !== 'function') return false;
  if (!['fs.write', 'child', 'worker', 'wasi', 'addon', 'inspector'].every(scope => denied(scope))) return false;
  if (process.allowedNodeEnvironmentFlags.has('--allow-net') && !denied('net')) return false;
  return denied('fs.read', '/') && denied('fs.write', '/');
}
if (!sandboxActive()) process.exit(EXIT_SANDBOX_INACTIVE);

const chunks = [];
let received = 0;
for await (const chunk of process.stdin) {
  received += chunk.length;
  if (received > MAX_INPUT_BYTES) process.exit(EXIT_INPUT_TOO_LARGE);
  chunks.push(chunk);
}

let result = null;
try {
  result = await sanitisePdf(Buffer.concat(chunks, received));
} catch (error) {
  if (error?.code === 'PDF_PASSWORD_REQUIRED' || error?.code === 'PDF_STRUCTURE_INVALID') {
    process.stdout.write(JSON.stringify({ code: error.code }), () => process.exit(EXIT_REJECTED));
  } else process.exit(EXIT_INTERNAL);
}
if (result) {
  process.stdout.write(Buffer.concat([Buffer.from(`${JSON.stringify({ removed: result.removed })}\n`), Buffer.from(result.bytes)]), () => process.exit(0));
}
