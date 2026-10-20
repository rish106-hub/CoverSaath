import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { DocumentIntakeError } from '../src/features/input/contracts.js';
import { PDF_INSPECTION_LIMITS, inspectPdf } from '../src/features/input/pdf-inspection.js';

// All PDFs below are synthetic and built in memory. No real documents or personal data.
const CANARY = 'CANARY-SYNTHETIC-7F3A';
const toBuf = value => (Buffer.isBuffer(value) ? value : Buffer.from(value, 'latin1'));

function streamBody(dict, data) {
  const bytes = toBuf(data);
  return Buffer.concat([toBuf(`<< ${dict} /Length ${bytes.length} >>\nstream\n`), bytes, toBuf('\nendstream')]);
}

function objStmBody(objects, { filter = '/FlateDecode', extraDict = '', compress = true } = {}) {
  let header = '';
  let body = '';
  for (const { num, body: objectBody } of objects) {
    header += `${num} ${body.length} `;
    body += `${objectBody}\n`;
  }
  const plain = toBuf(header + body);
  const encoded = compress ? deflateSync(plain) : plain;
  const filterPart = filter ? `/Filter ${filter} ` : '';
  return streamBody(`/Type /ObjStm /N ${objects.length} /First ${header.length} ${filterPart}${extraDict}`, encoded);
}

// objects: array of bodies (string | Buffer); object N is objects[N - 1].
function buildPdf(objects, { version = '1.7', trailerExtra = '', root = 1, trailer = true, eof = true, header = true } = {}) {
  const parts = [];
  let offset = 0;
  const push = chunk => { const b = toBuf(chunk); parts.push(b); offset += b.length; };
  if (header) push(`%PDF-${version}\n%\xe2\xe3\xcf\xd3\n`);
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(offset);
    push(`${index + 1} 0 obj\n`);
    push(body);
    push('\nendobj\n');
  });
  const xrefOffset = offset;
  if (trailer) {
    push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
    for (const value of offsets) push(`${String(value).padStart(10, '0')} 00000 n \n`);
    push(`trailer\n<< /Size ${objects.length + 1} /Root ${root} 0 R /Info << /Title (${CANARY}) >> ${trailerExtra} >>\n`);
  }
  push(`startxref\n${xrefOffset}\n`);
  if (eof) push('%%EOF\n');
  return Buffer.concat(parts);
}

const catalog = '<< /Type /Catalog /Pages 2 0 R >>';
const pageTree = kids => `<< /Type /Pages /Kids [${kids.map(n => `${n} 0 R`).join(' ')}] /Count ${kids.length} >>`;
const page = (extra = '') => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ${extra} >>`;
const onePage = (extra = '', options) => buildPdf([catalog, pageTree([3]), page(extra)], options);

function rejects(bytes, code, limits) {
  let caught;
  try { inspectPdf(bytes, limits); } catch (error) { caught = error; }
  assert.ok(caught instanceof DocumentIntakeError, `expected DocumentIntakeError ${code}, got ${caught}`);
  assert.equal(caught.code, code);
  assert.ok(caught.message.length > 0 && caught.message.length < 100);
  assert.ok(!caught.message.includes(CANARY), 'message must not echo file content');
  assert.ok(!caught.message.includes('/'), 'message must not echo PDF names');
  assert.ok(!bytes.toString('latin1').includes(caught.message), 'message must not be file content');
  return caught;
}

test('minimal valid one-page PDF is accepted', () => {
  const result = inspectPdf(onePage());
  assert.deepEqual({ ...result }, { pageCount: 1, objectStreamCount: 0, pdfVersion: '1.7' });
  assert.ok(Object.isFrozen(result));
});

test('PDF 2.0 header is accepted and Uint8Array input works', () => {
  const bytes = onePage('', { version: '2.0' });
  assert.equal(inspectPdf(new Uint8Array(bytes)).pdfVersion, '2.0');
});

test('three pages stored inside an object stream are counted', () => {
  const pdf = buildPdf([
    catalog,
    objStmBody([{ num: 2, body: pageTree([3, 4, 5]) }, { num: 3, body: page() }, { num: 4, body: page() }, { num: 5, body: page() }]),
  ]);
  const result = inspectPdf(pdf);
  assert.equal(result.pageCount, 3);
  assert.equal(result.objectStreamCount, 1);
});

test('missing header is rejected', () => {
  rejects(onePage('', { header: false }), 'PDF_STRUCTURE_INVALID');
  rejects(Buffer.concat([toBuf(' '), onePage()]), 'PDF_STRUCTURE_INVALID');
  rejects(onePage('', { version: '3.0' }), 'PDF_STRUCTURE_INVALID');
});

test('missing %%EOF near the end is rejected', () => {
  rejects(onePage('', { eof: false }), 'PDF_STRUCTURE_INVALID');
  rejects(Buffer.concat([onePage(), Buffer.alloc(2048, 0x20)]), 'PDF_STRUCTURE_INVALID');
});

test('zero pages is rejected', () => {
  rejects(buildPdf([catalog, pageTree([])]), 'PDF_STRUCTURE_INVALID');
});

test('/Encrypt in the trailer requires a password', () => {
  rejects(buildPdf([catalog, pageTree([3]), page(), '<< /Filter /Standard /V 2 /R 3 >>'], { trailerExtra: '/Encrypt 4 0 R' }), 'PDF_PASSWORD_REQUIRED');
});

test('/Encrypt in an xref stream dictionary requires a password', () => {
  const xrefStream = streamBody('/Type /XRef /Size 5 /W [1 2 1] /Root 1 0 R /Encrypt 5 0 R', Buffer.alloc(20, 1));
  rejects(buildPdf([catalog, pageTree([3]), page(), xrefStream, '<< /Filter /Standard >>'], { trailer: false }), 'PDF_PASSWORD_REQUIRED');
});

test('raw /JavaScript is active content', () => {
  rejects(onePage('/AA << /O << /S /JavaScript /JS (app.alert(1)) >> >>'), 'PDF_ACTIVE_CONTENT');
});

test('/JS hidden inside an object stream is active content', () => {
  const pdf = buildPdf([
    catalog,
    pageTree([3]),
    page(),
    objStmBody([{ num: 5, body: '<< /S /Foo /JS (x) >>' }]),
  ]);
  rejects(pdf, 'PDF_ACTIVE_CONTENT');
});

test('#-escaped names are decoded before matching', () => {
  rejects(onePage('/AA << /O << /S /J#61vaScript >> >>'), 'PDF_ACTIVE_CONTENT');
  rejects(onePage('/X /#4C#61#75#6e#63#68'), 'PDF_ACTIVE_CONTENT');
});

test('/Launch and /EmbeddedFiles are active content', () => {
  rejects(onePage('/A << /S /Launch /F (calc) >>'), 'PDF_ACTIVE_CONTENT');
  rejects(buildPdf(['<< /Type /Catalog /Pages 2 0 R /Names << /EmbeddedFiles 4 0 R >> >>', pageTree([3]), page(), '<< /Names [] >>']), 'PDF_ACTIVE_CONTENT');
});

test('/URI links and /OpenAction alone are allowed', () => {
  const pdf = buildPdf([
    '<< /Type /Catalog /Pages 2 0 R /OpenAction [3 0 R /Fit] >>',
    pageTree([3]),
    page('/Annots [4 0 R]'),
    '<< /Type /Annot /Subtype /Link /Rect [0 0 10 10] /A << /S /URI /URI (https://insurer.example/policy) >> >>',
  ]);
  assert.equal(inspectPdf(pdf).pageCount, 1);
});

test('names inside literal strings and comments do not count', () => {
  const pdf = onePage('/Title (see /JavaScript and \\) /Launch) % /JS in a comment\n');
  assert.equal(inspectPdf(pdf).pageCount, 1);
});

test('/Type/Page without a space counts and /Type /Pages does not', () => {
  const pdf = buildPdf([catalog, '<</Type/Pages/Kids[3 0 R 4 0 R]/Count 2>>', '<</Type/Page/Parent 2 0 R>>', '<</Type\n%c\n/P#61ge/Parent 2 0 R>>']);
  assert.equal(inspectPdf(pdf).pageCount, 2);
});

test('page limit uses the limits override', () => {
  const pdf = buildPdf([catalog, pageTree([3, 4, 5]), page(), page(), page()]);
  assert.equal(inspectPdf(pdf, { ...PDF_INSPECTION_LIMITS, maxPages: 3 }).pageCount, 3);
  rejects(pdf, 'PDF_PAGE_LIMIT', { ...PDF_INSPECTION_LIMITS, maxPages: 2 });
});

test('page limit also applies to pages inside object streams', () => {
  const pdf = buildPdf([
    catalog,
    objStmBody([{ num: 2, body: pageTree([3, 4, 5]) }, { num: 3, body: page() }, { num: 4, body: page() }, { num: 5, body: page() }]),
  ]);
  rejects(pdf, 'PDF_PAGE_LIMIT', { ...PDF_INSPECTION_LIMITS, maxPages: 2 });
});

test('deflate bomb inside an object stream hits the resource limit', () => {
  const bomb = deflateSync(Buffer.alloc(20 * 1024 * 1024, 0x20));
  assert.ok(bomb.length < 64 * 1024);
  const pdf = buildPdf([catalog, pageTree([3]), page(), streamBody('/Type /ObjStm /N 1 /First 4 /Filter /FlateDecode', bomb)]);
  rejects(pdf, 'PDF_RESOURCE_LIMIT');
});

test('total inflated bytes and object stream count are bounded', () => {
  const streams = [1, 2, 3].map(n => objStmBody([{ num: 10 + n, body: `<< /Pad (${'x'.repeat(1000)}) >>` }]));
  const pdf = buildPdf([catalog, pageTree([3]), page(), ...streams]);
  assert.equal(inspectPdf(pdf).objectStreamCount, 3);
  rejects(pdf, 'PDF_RESOURCE_LIMIT', { ...PDF_INSPECTION_LIMITS, maxTotalInflatedBytes: 2500 });
  rejects(pdf, 'PDF_RESOURCE_LIMIT', { ...PDF_INSPECTION_LIMITS, maxObjectStreams: 2 });
});

test('object stream with a non-Flate filter is unsupported', () => {
  const hex = Buffer.from('3420302031203020').toString('hex');
  const pdf = buildPdf([catalog, pageTree([3]), page(), streamBody('/Type /ObjStm /N 1 /First 4 /Filter /ASCIIHexDecode', `${hex}>`)]);
  rejects(pdf, 'PDF_UNSUPPORTED_ENCODING');
  const chained = buildPdf([catalog, pageTree([3]), page(), objStmBody([{ num: 5, body: '<< >>' }], { filter: '[/ASCII85Decode /FlateDecode]' })]);
  rejects(chained, 'PDF_UNSUPPORTED_ENCODING');
  const predictor = buildPdf([catalog, pageTree([3]), page(), objStmBody([{ num: 5, body: '<< >>' }], { extraDict: '/DecodeParms << /Predictor 12 /Columns 4 >>' })]);
  rejects(predictor, 'PDF_UNSUPPORTED_ENCODING');
});

test('object stream that cannot be inflated is structurally invalid', () => {
  const pdf = buildPdf([catalog, pageTree([3]), page(), streamBody('/Type /ObjStm /N 1 /First 4 /Filter /FlateDecode', Buffer.from('not zlib data'))]);
  rejects(pdf, 'PDF_STRUCTURE_INVALID');
});

test('/JavaScript inside binary data of a non-ObjStm stream does not trigger', () => {
  const binary = Buffer.concat([Buffer.from([0, 255, 40, 1]), toBuf('/JavaScript /Launch /Type /Page (('), Buffer.from([41, 0])]);
  const pdf = buildPdf([catalog, pageTree([3]), page('/Contents 4 0 R'), streamBody('/Filter /FlateDecode', binary)]);
  assert.equal(inspectPdf(pdf).pageCount, 1);
});

test('stream with an indirect /Length falls back to the endstream search', () => {
  const data = toBuf('BT /F1 12 Tf (hello) Tj ET');
  const body = Buffer.concat([toBuf('<< /Length 5 0 R >>\nstream\n'), data, toBuf('\nendstream')]);
  const pdf = buildPdf([catalog, pageTree([3]), page('/Contents 4 0 R'), body, String(data.length)]);
  assert.equal(inspectPdf(pdf).pageCount, 1);
});

test('unterminated literal string is rejected', () => {
  rejects(onePage('/Title (open'), 'PDF_STRUCTURE_INVALID');
});

test('a 15 MiB synthetic PDF is inspected in under 2000 ms', () => {
  const objects = [catalog, pageTree(Array.from({ length: 300 }, (_, i) => i + 3))];
  for (let i = 0; i < 300; i += 1) objects.push(page(`/Contents ${303 + i} 0 R`));
  // Dense dictionary text (worst case for the tokenizer) plus binary content streams.
  const names = Array.from({ length: 2000 }, (_, i) => `/N${i} [${i} 0 R (s${i}) <0a0b>]`).join(' ');
  let binarySeed = 1;
  const chunk = Buffer.alloc(19 * 1024);
  for (let i = 0; i < chunk.length; i += 1) { binarySeed = (binarySeed * 1103515245 + 12345) & 0x7fffffff; chunk[i] = binarySeed & 0xff; }
  for (let i = 0; i < 300; i += 1) objects.push(streamBody(`/Filter /FlateDecode /Extra << ${i % 2 ? names : ''} >>`, chunk));
  const pdf = buildPdf(objects);
  assert.ok(pdf.length >= 15 * 1024 * 1024 * 0.95 && pdf.length <= 16 * 1024 * 1024, `size ${pdf.length}`);
  const started = process.hrtime.bigint();
  const result = inspectPdf(pdf);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(result.pageCount, 300);
  assert.ok(elapsedMs < 2000, `took ${elapsedMs} ms`);
});

// --- Security review regressions: hidden structure and untyped object streams ---

function xorshiftBytes(size, seed) {
  const out = Buffer.alloc(size);
  let x = seed >>> 0;
  for (let i = 0; i < size; i += 1) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

const withHiddenStream = (data, { useLength = true } = {}) => buildPdf([
  '<< /Type /Catalog /Pages 2 0 R /OpenAction 5 0 R >>',
  pageTree([3]),
  page(),
  useLength ? streamBody('', data) : Buffer.concat([toBuf('<< >>\nstream\n'), toBuf(data), toBuf('\nendstream')]),
]);

test('an object header hidden inside stream data is rejected', () => {
  const hidden = '5 0 obj << /S /JavaScript /JS (app.alert(1)) >> endobj';
  rejects(withHiddenStream(hidden, { useLength: false }), 'PDF_STRUCTURE_INVALID');
  rejects(withHiddenStream(`junk\n${hidden}\n`), 'PDF_STRUCTURE_INVALID');
  rejects(withHiddenStream('5\r\n0\tobj<<>>'), 'PDF_STRUCTURE_INVALID');
});

test('a trailer, startxref or xref table hidden inside stream data is rejected', () => {
  rejects(withHiddenStream(' trailer << /Encrypt 7 0 R >> ', { useLength: false }), 'PDF_STRUCTURE_INVALID');
  rejects(withHiddenStream('trailer\n<< >>'), 'PDF_STRUCTURE_INVALID');
  rejects(withHiddenStream('abc startxref 10'), 'PDF_STRUCTURE_INVALID');
  rejects(withHiddenStream('abc\nxref\n0 1\n0000000000 65535 f \n'), 'PDF_STRUCTURE_INVALID');
});

test('object headers hidden in comments or literal strings are rejected', () => {
  rejects(onePage('% 5 0 obj << /JS (x) >> endobj\n'), 'PDF_STRUCTURE_INVALID');
  rejects(onePage('/Title (5 0 obj << /JS (x) >> endobj)'), 'PDF_STRUCTURE_INVALID');
  rejects(onePage('/Title (trailer << /Encrypt 1 0 R >>)'), 'PDF_STRUCTURE_INVALID');
});

test('near-miss words in stream data do not trigger the hidden-structure guard', () => {
  const benign = 'object 5 obj 5 0 objx 0 obj obj0 the trailer is long a xref table startx ref\nxref 5\n';
  assert.equal(inspectPdf(withHiddenStream(benign)).pageCount, 1);
  assert.equal(inspectPdf(onePage('/Title (object 12 obj trailer) % xref and obj\n')).pageCount, 1);
});

test('15 MiB of seeded random bytes in a non-ObjStm stream is accepted quickly', () => {
  const pdf = buildPdf([catalog, pageTree([3]), page('/Contents 4 0 R'), streamBody('/Filter /DCTDecode', xorshiftBytes(15 * 1024 * 1024, 0x9e3779b9))]);
  const started = process.hrtime.bigint();
  const result = inspectPdf(pdf);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(result.pageCount, 1);
  assert.ok(elapsedMs < 2000, `took ${elapsedMs} ms`);
});

test('a stream with /N and /First is inflated as an object stream without /Type /ObjStm', () => {
  const inner = '5 0 << /S /JavaScript /JS (app.alert(1)) >>';
  const z = deflateSync(Buffer.from(inner, 'latin1'));
  rejects(buildPdf([catalog, pageTree([3]), page(), streamBody('/N 1 /First 4 /Filter /FlateDecode', z)]), 'PDF_ACTIVE_CONTENT');
  rejects(buildPdf([catalog, pageTree([3]), page(), streamBody('/Type 9 0 R /N 1 /First 4 /Filter /FlateDecode', z)]), 'PDF_ACTIVE_CONTENT');
  const hex = `${Buffer.from(inner, 'latin1').toString('hex')}>`;
  rejects(buildPdf([catalog, pageTree([3]), page(), streamBody('/N 1 /First 4 /Filter /ASCIIHexDecode', hex)]), 'PDF_UNSUPPORTED_ENCODING');
  rejects(buildPdf([catalog, pageTree([3]), page(), streamBody('/N 1 /First 4 /Filter 8 0 R', z)]), 'PDF_UNSUPPORTED_ENCODING');
  const pagesInside = buildPdf([catalog, streamBody('/N 2 /First 8 /Filter /FlateDecode', deflateSync(Buffer.from(`2 0 3 40 ${pageTree([3])} ${page()}`, 'latin1')))]);
  assert.deepEqual({ ...inspectPdf(pagesInside) }, { pageCount: 1, objectStreamCount: 1, pdfVersion: '1.7' });
});

function appendUpdate(base, body, trailerExtra) {
  const offset = base.length;
  return Buffer.concat([base, toBuf(`6 0 obj\n${body}\nendobj\nxref\n6 1\n${String(offset).padStart(10, '0')} 00000 n \ntrailer\n<< /Size 7 /Root 1 0 R /Prev 0 ${trailerExtra} >>\nstartxref\n${offset}\n%%EOF\n`)]);
}

test('incremental updates and later trailers are scanned', () => {
  const base = onePage();
  rejects(appendUpdate(base, '<< /S /JavaScript /JS (x) >>', ''), 'PDF_ACTIVE_CONTENT');
  rejects(appendUpdate(base, '<< /Filter /Standard >>', '/Encrypt 6 0 R'), 'PDF_PASSWORD_REQUIRED');
  assert.equal(inspectPdf(appendUpdate(base, '<< /Producer (synthetic) >>', '')).pageCount, 1);
});

test('/Encrypt in an xref stream dictionary after an object stream is detected', () => {
  const pdf = buildPdf([
    catalog,
    objStmBody([{ num: 2, body: pageTree([3]) }, { num: 3, body: page() }]),
    streamBody('/Type /XRef /Size 5 /W [1 2 1] /Root 1 0 R /Encrypt 4 0 R', Buffer.alloc(20, 1)),
    '<< /Filter /Standard >>',
  ], { trailer: false });
  rejects(pdf, 'PDF_PASSWORD_REQUIRED');
});
