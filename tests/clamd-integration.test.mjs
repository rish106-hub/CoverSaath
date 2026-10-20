import test from 'node:test';
import assert from 'node:assert/strict';
import { createClamdScanner } from '../src/features/input/clamd-scanner.js';

// Opt-in: runs only against a real clamd configured per docs/runbooks/clamav.md.
// CLAMD_TEST_HOST=127.0.0.1 CLAMD_TEST_PORT=3310 node --test tests/clamd-integration.test.mjs
const host = process.env.CLAMD_TEST_HOST;
const port = Number(process.env.CLAMD_TEST_PORT || 3310);
const skip = host ? false : 'set CLAMD_TEST_HOST to run against a real clamd';

// The EICAR antivirus test string, assembled at runtime so the repository never holds it verbatim.
const EICAR = Buffer.from(['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'].join(''), 'latin1');

function syntheticPdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>',
  ];
  let body = '%PDF-1.7\n% synthetic clamd integration fixture\n';
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

test('real clamd answers PING', { skip }, async () => {
  assert.equal(await createClamdScanner({ host, port }).ping(), true);
});

test('real clamd blocks the EICAR test string', { skip }, async () => {
  const result = await createClamdScanner({ host, port }).scan(EICAR);
  assert.equal(result.status, 'blocked');
  assert.match(result.signature, /Eicar/i);
});

test('real clamd reports a synthetic PDF as clean', { skip }, async () => {
  const result = await createClamdScanner({ host, port }).scan(syntheticPdf());
  assert.deepEqual(result, { status: 'clean' });
});

test('real clamd refuses input over StreamMaxLength as an error, never clean', { skip }, async () => {
  // StreamMaxLength is 16M; the production cap is 15 MiB, so lift the client cap to reach clamd's limit.
  const bytes = Buffer.alloc(17 * 1024 * 1024, 0x20);
  const scanner = createClamdScanner({ host, port, maxBytes: bytes.length, timeoutMs: 60_000 });
  // clamd answers "INSTREAM size limit exceeded. ERROR" and closes. If the reset wins the race with
  // the reply the client sees SCANNER_UNAVAILABLE instead; both defer the document, neither is clean.
  await assert.rejects(scanner.scan(bytes), error => ['SCANNER_ERROR', 'SCANNER_UNAVAILABLE'].includes(error.code));
});

test('real clamd fully scans an input at the 15 MiB upload cap', { skip }, async () => {
  const pdf = syntheticPdf();
  const bytes = Buffer.concat([pdf, Buffer.alloc(15 * 1024 * 1024 - pdf.length, 0x20)]);
  const result = await createClamdScanner({ host, port, timeoutMs: 60_000 }).scan(bytes);
  assert.deepEqual(result, { status: 'clean' });
});
