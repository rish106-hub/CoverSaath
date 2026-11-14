import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFArray, PDFDocument, PDFName, PDFString, StandardFonts } from 'pdf-lib';
import { inspectPdf } from '../src/features/input/pdf-inspection.js';
import { sanitisePdf } from '../src/features/input/pdf-sanitise.js';
import { classifyInsuranceText, scoreInsuranceText } from '../src/features/input/insurance-pdf-gate.js';
import { createPdfUploadChecks } from '../src/features/input/pdf-upload-checks.js';
import { createSandboxedInsuranceGate, createSandboxedPdfSanitiser } from '../src/features/input/sandboxed-pdf-upload-checks.js';
import { createSandboxedPdfInspector } from '../src/features/input/sandboxed-pdf-inspection.js';

// Synthetic PDFs only, built in the test with pdf-lib.
const INSURANCE_TEXT = 'Synthetic Policy Schedule. Insurer: Example General Insurance. Sum insured 500000. Premium 12000. Waiting period 30 days. Claim exclusions apply. UIN EXAMPLEHLIP21001V012021.';
const RECIPE_TEXT = 'Chocolate cake recipe. Mix two cups of flour with sugar, butter and eggs, then bake for forty minutes until golden.';

async function build(text, mutate) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([600, 400]);
  if (text) {
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText(text, { x: 20, y: 300, size: 8, font, maxWidth: 560, lineHeight: 10 });
  }
  if (mutate) await mutate(doc, page);
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

const jsOpenAction = doc => doc.catalog.set(PDFName.of('OpenAction'), doc.context.obj({ S: 'JavaScript', JS: PDFString.of('app.alert(1)') }));
const embedded = doc => doc.attach(Buffer.from('synthetic attachment'), 'note.txt', { mimeType: 'text/plain' });
const uriLink = (doc, page) => {
  const link = doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 50, 50], A: { S: 'URI', URI: PDFString.of('https://example.invalid') } }));
  page.node.set(PDFName.of('Annots'), doc.context.obj([link]));
  page.node.set(PDFName.of('AA'), doc.context.obj({ O: { S: 'JavaScript', JS: PDFString.of('x') } }));
};
const acroForm = doc => doc.catalog.set(PDFName.of('AcroForm'), doc.context.obj({ Fields: [], XFA: PDFArray.withContext(doc.context) }));

const rejectsWith = async (promise, code) => assert.rejects(promise, error => error.code === code, code);

function pipeline(t) {
  const inspector = createSandboxedPdfInspector();
  const sanitiser = createSandboxedPdfSanitiser();
  const gate = createSandboxedInsuranceGate();
  t.after(() => { inspector.close(); sanitiser.close(); gate.close(); });
  return createPdfUploadChecks({ inspector, sanitiser, gate });
}

test('scoring: insurance signals and the UIN pattern, with a floor for thin text', () => {
  assert.ok(scoreInsuranceText(INSURANCE_TEXT) >= 6);
  assert.equal(scoreInsuranceText(RECIPE_TEXT), 0);
  assert.equal(classifyInsuranceText(INSURANCE_TEXT), 'insurance');
  assert.equal(classifyInsuranceText(RECIPE_TEXT), 'not_insurance');
  assert.equal(classifyInsuranceText('Page 1'), 'undetermined');
  assert.equal(classifyInsuranceText('Reference EXAMPLEHLIP21001V012021 issued by the competent office for filing'), 'insurance');
});

test('sanitiser strips active content, keeps pages and text, and the output inspects clean', async () => {
  for (const [label, mutate, expected] of [
    ['javascript open action', jsOpenAction, ['open_action']],
    ['embedded file', embedded, ['embedded_files']],
    ['uri link plus page action', uriLink, ['annotation_actions', 'page_actions']],
    ['acroform with xfa', acroForm, ['acroform', 'xfa']],
  ]) {
    const original = await build(INSURANCE_TEXT, mutate);
    const { bytes, removed } = await sanitisePdf(original);
    assert.deepEqual(removed, expected, label);
    assert.equal(inspectPdf(bytes).pageCount, 1, label);
    const text = Buffer.from(bytes).toString('latin1');
    for (const needle of ['/JavaScript', '/JS', '/OpenAction', '/EmbeddedFile', '/URI', '/AcroForm', '/XFA', '/AA']) assert.equal(text.includes(needle), false, `${label}: ${needle}`);
  }
  const unchanged = await sanitisePdf(await build(INSURANCE_TEXT));
  assert.deepEqual(unchanged.removed, []);
});

test('the sandboxed pipeline sanitises active content instead of rejecting it', async t => {
  const check = pipeline(t);
  const original = await build(INSURANCE_TEXT, jsOpenAction);
  assert.throws(() => inspectPdf(original), error => error.code === 'PDF_ACTIVE_CONTENT');
  const result = await check({ bytes: original });
  assert.equal(result.sanitised, true);
  assert.deepEqual(result.removed, ['open_action']);
  assert.notDeepEqual(Buffer.from(result.bytes), original);
  assert.equal(inspectPdf(result.bytes).pageCount, 1);
  assert.equal(Buffer.from(result.bytes).toString('latin1').includes('/JavaScript'), false);

  const withFile = await check({ bytes: await build(INSURANCE_TEXT, embedded) });
  assert.deepEqual(withFile.removed, ['embedded_files']);
});

test('the gate rejects a text PDF that is not insurance and passes insurance, scanned and clean files', async t => {
  const check = pipeline(t);
  await rejectsWith(check({ bytes: await build(RECIPE_TEXT) }), 'NOT_INSURANCE_DOCUMENT');
  // Sanitised files are gated too.
  await rejectsWith(check({ bytes: await build(RECIPE_TEXT, jsOpenAction) }), 'NOT_INSURANCE_DOCUMENT');
  const insurance = await check({ bytes: await build(INSURANCE_TEXT) });
  assert.equal(insurance.bytes, undefined);
  assert.equal(insurance.pageCount, 1);
  // No text layer (scanned style): passes through to OCR-time classification.
  assert.equal((await check({ bytes: await build(null) })).pageCount, 1);
});

test('encrypted and unparseable PDFs still reject with their existing codes', async t => {
  const check = pipeline(t);
  const encrypted = Buffer.from(Buffer.from(await build(INSURANCE_TEXT)).toString('latin1').replace('/Root', '/Encrypt << /Filter /Standard /V 1 /R 2 /O (x) /U (x) /P -4 >> /Root'), 'latin1');
  await rejectsWith(check({ bytes: encrypted }), 'PDF_PASSWORD_REQUIRED');
  await rejectsWith(check({ bytes: Buffer.from('%PDF-1.7\nnot really a pdf\n%%EOF\n') }), 'PDF_STRUCTURE_INVALID');
  await rejectsWith(createSandboxedPdfSanitiser().sanitise(Buffer.from('%PDF-1.7\ngarbage\n%%EOF\n')), 'PDF_STRUCTURE_INVALID');
});
