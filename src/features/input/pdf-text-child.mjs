// Permission-restricted PDF text extractor. It receives one PDF on stdin and returns bounded JSON page texts derived from
// the bytes (pdf-text-extraction.js). No document text or filenames are logged.
import { extractPdfPageTexts } from './pdf-text-extraction.js';

const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const EXIT_SANDBOX_INACTIVE = 78;
const EXIT_INPUT_TOO_LARGE = 65;
const EXIT_INTERNAL = 70;

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

try {
  process.stdout.write(JSON.stringify(await extractPdfPageTexts(Buffer.concat(chunks, received))));
} catch {
  process.exit(EXIT_INTERNAL);
}
