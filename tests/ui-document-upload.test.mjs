import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ERROR_MESSAGES, MAX_FILE_BYTES, STATUS_LABELS, messageForErrorCode, statusLabel, validateSelection,
} from '../src/ui/state/document-selection.js';
import { createV1Client } from '../src/ui/api/v1-client.js';

const pdf = (name = 'a.pdf', size = 100, extra = {}) => ({ name, size, type: 'application/pdf', lastModified: 1, ...extra });

test('accepts a valid pdf', () => {
  const [r] = validateSelection([pdf()]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings, []);
});

test('rejects wrong extension, wrong type, empty and oversize', () => {
  assert.equal(validateSelection([pdf('a.txt')])[0].ok, false);
  assert.equal(validateSelection([pdf('a.pdf', 10, { type: 'image/png' })])[0].ok, false);
  assert.equal(validateSelection([pdf('a.pdf', 0)])[0].errors[0].code, 'EMPTY_FILE');
  assert.equal(validateSelection([pdf('a.pdf', MAX_FILE_BYTES)])[0].ok, true);
  assert.equal(validateSelection([pdf('a.pdf', MAX_FILE_BYTES + 1)])[0].errors[0].code, 'FILE_TOO_LARGE');
});

test('empty type with .pdf is allowed but flagged; empty type without .pdf is rejected', () => {
  const [ok] = validateSelection([pdf('a.pdf', 5, { type: '' })]);
  assert.equal(ok.ok, true);
  assert.match(ok.warnings[0].message, /server will verify/);
  assert.equal(validateSelection([pdf('a', 5, { type: '' })])[0].ok, false);
});

test('limits a batch to 10 files, counting existing queue', () => {
  const files = Array.from({ length: 11 }, (_, i) => pdf(`f${i}.pdf`));
  const results = validateSelection(files);
  assert.equal(results.filter(r => r.ok).length, 10);
  assert.equal(results[10].errors[0].code, 'BATCH_LIMIT');
  const existing = Array.from({ length: 10 }, (_, i) => pdf(`e${i}.pdf`));
  assert.equal(validateSelection([pdf('new.pdf')], existing)[0].errors[0].code, 'BATCH_LIMIT');
});

test('detects duplicate selections by name+size+lastModified', () => {
  const [first, dup] = validateSelection([pdf(), pdf()]);
  assert.equal(first.ok, true);
  assert.equal(dup.ok, false);
  assert.equal(dup.warnings[0].code, 'DUPLICATE_SELECTION');
  assert.equal(validateSelection([pdf()], [pdf()])[0].ok, false);
  assert.equal(validateSelection([pdf('a.pdf', 100, { lastModified: 2 })], [pdf()])[0].ok, true);
});

test('every server error code has a plain message and unknown codes fall back', () => {
  const codes = ['INVALID_REQUEST', 'IDEMPOTENCY_KEY_REQUIRED', 'CONSENT_REQUIRED', 'CONSENT_SCOPE_REQUIRED', 'CASE_NOT_FOUND',
    'DUPLICATE_DOCUMENT', 'IDEMPOTENCY_CONFLICT', 'REQUEST_TOO_LARGE', 'UNSUPPORTED_MEDIA_TYPE', 'MIME_MISMATCH', 'EXTENSION_MISMATCH',
    'EMPTY_FILE', 'PDF_STRUCTURE_INVALID', 'PDF_PASSWORD_REQUIRED', 'PDF_ACTIVE_CONTENT', 'PDF_PAGE_LIMIT', 'PDF_RESOURCE_LIMIT',
    'PDF_UNSUPPORTED_ENCODING', 'UPLOAD_CAPACITY_REACHED', 'DOCUMENT_STORAGE_NOT_CONFIGURED', 'AUTHENTICATION_REQUIRED'];
  for (const code of codes) assert.ok(ERROR_MESSAGES[code]?.length > 5, code);
  assert.equal(messageForErrorCode('PDF_PASSWORD_REQUIRED'), 'This PDF is password-protected. Upload an unlocked copy.');
  assert.ok(messageForErrorCode('SOMETHING_NEW'));
  assert.ok(messageForErrorCode('toString'));
});

test('status labels never claim processed or accepted for a fresh upload', () => {
  assert.equal(statusLabel('received_pending_checks'), 'Received, waiting for security checks');
  assert.doesNotMatch(statusLabel('received_pending_checks'), /processed|accepted/i);
  assert.doesNotMatch(Object.values(STATUS_LABELS).join(' '), /processed/i);
});

function fakeXhrFactory(responses) {
  const calls = [];
  const factory = () => {
    const xhr = {
      headers: {}, upload: {}, status: 0, responseText: '',
      open(method, url) { this.method = method; this.url = url; },
      setRequestHeader(k, v) { this.headers[k] = v; },
      send(body) {
        this.body = body; calls.push(this);
        const next = responses.shift();
        queueMicrotask(() => {
          this.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 });
          this.status = next.status; this.responseText = JSON.stringify(next.body); this.onload();
        });
      },
    };
    return xhr;
  };
  return { factory, calls };
}

test('uploadDocument sends raw body with the contract headers and reports progress', async () => {
  const { factory, calls } = fakeXhrFactory([{ status: 201, body: { document: { id: 'd1' } } }]);
  const client = createV1Client({ fetchImpl: () => assert.fail('no fetch'), xhrFactory: factory });
  client.setSessionToken('tok');
  const file = { name: 'My policy é.pdf', size: 10 };
  const progress = [];
  const result = await client.uploadDocument({
    caseId: 'case/1', file, documentKind: 'endorsement', consentGrantId: 'g1', idempotencyKey: 'key-12345678',
    onProgress: (l, t) => progress.push([l, t]),
  });
  assert.equal(result.document.id, 'd1');
  const [x] = calls;
  assert.equal(x.method, 'POST');
  assert.equal(x.url, '/api/v1/cases/case%2F1/documents');
  assert.equal(x.body, file);
  assert.deepEqual(x.headers, {
    Authorization: 'Bearer tok', 'Content-Type': 'application/pdf', 'Idempotency-Key': 'key-12345678',
    'X-Document-Kind': 'endorsement', 'X-Consent-Grant-Id': 'g1', 'X-Filename': encodeURIComponent(file.name),
  });
  assert.deepEqual(progress, [[5, 10]]);
});

test('uploadDocument rejects with the server error code on failure and resolves 200 replays', async () => {
  const { factory } = fakeXhrFactory([
    { status: 415, body: { error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'x' } } },
    { status: 200, body: { document: { id: 'd1' }, idempotentReplay: true } },
  ]);
  const client = createV1Client({ xhrFactory: factory });
  const args = { caseId: 'c', file: { name: 'a.pdf', size: 1 }, documentKind: 'policy_wording', consentGrantId: 'g', idempotencyKey: 'key-12345678' };
  await assert.rejects(client.uploadDocument(args), error => error.code === 'UNSUPPORTED_MEDIA_TYPE' && error.status === 415);
  assert.equal((await client.uploadDocument(args)).idempotentReplay, true);
});

test('JSON request errors keep the server error code so list failures get a specific message', async () => {
  const fetchImpl = async () => ({
    ok: false, status: 403,
    json: async () => ({ error: { code: 'FIELD_ACCESS_REQUIRED', message: 'denied' } }),
  });
  const client = createV1Client({ fetchImpl });
  await assert.rejects(client.listCaseDocuments('case-1'), error => error.code === 'FIELD_ACCESS_REQUIRED' && error.status === 403);
  assert.equal(messageForErrorCode('FIELD_ACCESS_REQUIRED'), ERROR_MESSAGES.FIELD_ACCESS_REQUIRED);
  const odd = createV1Client({ fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({ error: { code: '<script>' } }) }) });
  await assert.rejects(odd.listCaseDocuments('case-1'), error => error.code === undefined);
});
