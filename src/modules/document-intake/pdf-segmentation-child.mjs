// Permission-restricted PDF segmenter. It receives one PDF on stdin and returns
// bounded JSON with base64 PDF batches. No document text or filenames are logged.
import { PDFDocument } from 'pdf-lib';

const MAX_INPUT_BYTES = 15 * 1024 * 1024;
const MAX_PAGES = 500;
const PAGES_PER_SEGMENT = 10;
const EXIT_SANDBOX_INACTIVE = 78;
const EXIT_INPUT_TOO_LARGE = 65;
const EXIT_INVALID = 66;
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
  const source = await PDFDocument.load(Buffer.concat(chunks, received), {
    ignoreEncryption: false,
    updateMetadata: false,
  });
  const pageCount = source.getPageCount();
  if (pageCount < 1 || pageCount > MAX_PAGES) process.exit(EXIT_INVALID);
  const segments = [];
  for (let start = 0, index = 0; start < pageCount; start += PAGES_PER_SEGMENT, index += 1) {
    const end = Math.min(start + PAGES_PER_SEGMENT, pageCount);
    const output = await PDFDocument.create();
    const copied = await output.copyPages(source, Array.from({ length: end - start }, (_, offset) => start + offset));
    copied.forEach(page => output.addPage(page));
    const bytes = await output.save({ addDefaultPage: false, updateFieldAppearances: false, useObjectStreams: false });
    segments.push({
      index,
      originalPages: Array.from({ length: end - start }, (_, offset) => start + offset + 1),
      bytes: Buffer.from(bytes).toString('base64'),
    });
  }
  process.stdout.write(JSON.stringify({ ok: true, pageCount, segments }));
} catch {
  process.exit(EXIT_INTERNAL);
}
