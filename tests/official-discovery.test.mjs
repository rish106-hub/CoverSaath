import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import {
  buildDiscoveredFetchRequest,
  defineDiscoverySource,
  validateDiscoveredFetchRequest,
  validateDiscoveredUrl,
} from '../src/modules/policy-breakdown/references/official/discovery.js';
import { createLiveOfficialSourceAdapter } from '../src/modules/policy-breakdown/references/official/live-adapter.js';
import { createFakeOfficialSourceAdapter } from '../src/modules/policy-breakdown/references/official/fake-adapter.js';
import { buildSafeFetchRequest } from '../src/modules/policy-breakdown/references/official/contracts.js';

const rawSource = {
  id: 'example-regulator.products.document', publisher: 'Example Regulator', sourceClass: 'regulator_product_repository',
  documentType: 'policy_wording', indexUrl: 'https://regulator.example.org/products', allowedHosts: ['regulator.example.org'],
  documentPathPrefixes: ['/documents/products/', '/products'], allowedQueryKeys: ['uinFilter'],
  expectedMimeTypes: ['application/pdf'], maxBytes: 1_000, freshnessDays: 30, owner: 'test',
};
const source = defineDiscoverySource(rawSource);
const docUrl = 'https://regulator.example.org/documents/products/EXAHLIP90001V019091.pdf';
const requestFor = (url = docUrl) => buildDiscoveredFetchRequest({ requestId: 'd1', discoverySource: source, url, requestedAt: '2026-10-08T00:00:00Z' });
const pdf = Buffer.from('%PDF-1.7 synthetic');
const reply = (status, headers, body = Buffer.alloc(0)) => ({ status, headers, body: Readable.from([body]) });
const live = (transport, options = {}) => createLiveOfficialSourceAdapter({ discoverySources: [source], enabled: true, transport, ...options });
const code = error => error?.code;

test('defineDiscoverySource validates and freezes operator rules', () => {
  assert.ok(Object.isFrozen(source));
  assert.ok(Object.isFrozen(source.allowedHosts));
  const bad = patch => assert.throws(() => defineDiscoverySource({ ...rawSource, ...patch }), /discoverySource|HTTPS|host|identifier|prefix|URL/i, JSON.stringify(patch));
  bad({ id: 'Upper.Case' });
  bad({ indexUrl: 'http://regulator.example.org/products' });
  bad({ allowedHosts: ['localhost'] });
  bad({ allowedHosts: ['10.0.0.1'] });
  bad({ allowedHosts: ['intranet.local'] });
  bad({ documentPathPrefixes: ['documents/'] });
  bad({ documentPathPrefixes: ['/documents/../admin/'] });
  bad({ documentPathPrefixes: ['/documents/%2e%2e/'] });
  bad({ allowedQueryKeys: ['bad key'] });
  bad({ expectedMimeTypes: ['application/x-msdownload'] });
  bad({ maxBytes: 0 });
  bad({ unexpected: true });
  assert.throws(() => defineDiscoverySource({ ...rawSource, indexUrl: 'https://other.example.org/products' }), /allowlisted/);
});

test('validateDiscoveredUrl allows only the reviewed host, path and query space', () => {
  assert.equal(validateDiscoveredUrl(docUrl, source), docUrl);
  assert.equal(validateDiscoveredUrl('https://REGULATOR.example.org/products?uinFilter=EXAHLIP90001V019091', source), 'https://regulator.example.org/products?uinFilter=EXAHLIP90001V019091');
  const rejects = (url, expected) => assert.throws(() => validateDiscoveredUrl(url, source), error => code(error) === expected, url);
  rejects('https://attacker.example.net/documents/products/x.pdf', 'OFFICIAL_SOURCE_HOST_NOT_ALLOWED');
  rejects('https://regulator.example.org.attacker.net/documents/products/x.pdf', 'OFFICIAL_SOURCE_HOST_NOT_ALLOWED');
  rejects('http://regulator.example.org/documents/products/x.pdf', 'OFFICIAL_SOURCE_HTTPS_REQUIRED');
  rejects('https://regulator.example.org:8443/documents/products/x.pdf', 'OFFICIAL_SOURCE_URL_INVALID');
  rejects('https://user:pw@regulator.example.org/documents/products/x.pdf', 'OFFICIAL_SOURCE_URL_INVALID');
  rejects('https://regulator.example.org/documents/products/x.pdf#frag', 'OFFICIAL_SOURCE_URL_INVALID');
  rejects('https://regulator.example.org/admin/x.pdf', 'OFFICIAL_SOURCE_PATH_NOT_ALLOWED');
  rejects('https://regulator.example.org/documents/products/', 'OFFICIAL_SOURCE_PATH_NOT_ALLOWED');
  rejects('https://regulator.example.org/products-evil', 'OFFICIAL_SOURCE_PATH_NOT_ALLOWED');
  rejects('https://regulator.example.org/documents/products/..%2f..%2fadmin', 'OFFICIAL_SOURCE_PATH_NOT_ALLOWED');
  rejects('https://regulator.example.org/documents/products/../../admin/x.pdf', 'OFFICIAL_SOURCE_PATH_NOT_ALLOWED');
  rejects(`${docUrl}?download=true`, 'OFFICIAL_SOURCE_PRIVATE_QUERY');
  rejects('https://regulator.example.org/products?uinFilter=A1&uinFilter=B2', 'OFFICIAL_SOURCE_PRIVATE_QUERY');
  rejects('https://regulator.example.org/products?uinFilter=my%20claim%20123', 'OFFICIAL_SOURCE_PRIVATE_QUERY');
  rejects('https://regulator.example.org/products?uinFilter=claim', 'OFFICIAL_SOURCE_PRIVATE_QUERY');
  rejects(`https://regulator.example.org/products?uinFilter=${'A'.repeat(201)}`, 'OFFICIAL_SOURCE_PRIVATE_QUERY');
  rejects('https://regulator.example.org/products?uinFilter=%3Cscript%3E', 'OFFICIAL_SOURCE_PRIVATE_QUERY');
  rejects('/documents/products/x.pdf', 'OFFICIAL_SOURCE_URL_INVALID');
});

test('discovered fetch requests take MIME and size authority from the source', () => {
  const request = requestFor();
  assert.deepEqual(request.expectedMimeTypes, ['application/pdf']);
  assert.equal(request.maxBytes, 1_000);
  assert.throws(() => validateDiscoveredFetchRequest({ ...request, maxBytes: 10_000_000 }, source), /authority/);
  assert.throws(() => validateDiscoveredFetchRequest({ ...request, expectedMimeTypes: ['text/html'] }, source), /authority/);
  assert.throws(() => validateDiscoveredFetchRequest({ ...request, discoverySourceId: 'other.source' }, source), /discoverySourceId/);
  assert.throws(() => validateDiscoveredFetchRequest({ ...request, url: 'https://attacker.example.net/x.pdf' }, source), /allowlisted/);
  assert.throws(() => validateDiscoveredFetchRequest({ ...request, extra: 1 }, source), /not a permitted field/);
});

test('live fetchDiscovered honours the kill switch', async () => {
  let called = false;
  const adapter = createLiveOfficialSourceAdapter({ discoverySources: [source], enabled: false, transport: async () => { called = true; } });
  const result = await adapter.fetchDiscovered(requestFor(), source);
  assert.equal(result.error.code, 'SOURCE_FETCH_DISABLED');
  assert.equal(called, false);
});

test('live fetchDiscovered returns bytes, SHA-256 and a query-free attempt URL', async () => {
  const searchSource = defineDiscoverySource({ ...rawSource, id: 'example-regulator.products.search', expectedMimeTypes: ['text/html'] });
  const html = Buffer.from('<html>ok</html>');
  const adapter = createLiveOfficialSourceAdapter({ discoverySources: [source, searchSource], enabled: true, transport: async () => reply(200, { 'content-type': 'text/html;charset=UTF-8' }, html) });
  const url = 'https://regulator.example.org/products?uinFilter=EXAHLIP90001V019091';
  const result = await adapter.fetchDiscovered(buildDiscoveredFetchRequest({ requestId: 's1', discoverySource: searchSource, url, requestedAt: '2026-10-08T00:00:00Z' }), searchSource);
  assert.equal(result.ok, true);
  assert.equal(result.discoverySourceId, searchSource.id);
  assert.equal(result.url, url);
  assert.equal(result.contentSha256, createHash('sha256').update(html).digest('hex'));
  assert.equal(result.attempts[0].url, 'https://regulator.example.org/products');
  assert.equal(result.attempts[0].registryEntryId, searchSource.id);
});

test('live fetchDiscovered keeps redirects inside the discovery rule and checks PDF bodies', async () => {
  const redirectTo = location => {
    let first = true;
    return async () => {
      if (first) { first = false; return reply(302, { location }); }
      return reply(200, { 'content-type': 'application/pdf' }, pdf);
    };
  };
  const ok = await live(redirectTo('/documents/products/moved.pdf')).fetchDiscovered(requestFor(), source);
  assert.equal(ok.ok, true);
  assert.equal(ok.url, 'https://regulator.example.org/documents/products/moved.pdf');
  assert.deepEqual(ok.redirects, ['https://regulator.example.org/documents/products/moved.pdf']);

  const errorCode = async transport => (await live(transport).fetchDiscovered(requestFor(), source)).error?.code;
  assert.equal(await errorCode(redirectTo('https://attacker.example.net/documents/products/x.pdf')), 'SOURCE_REDIRECT_REJECTED');
  assert.equal(await errorCode(redirectTo('/admin/secret.pdf')), 'SOURCE_REDIRECT_REJECTED');
  assert.equal(await errorCode(redirectTo('/documents/products/x.pdf?session=abc')), 'SOURCE_REDIRECT_REJECTED');
  assert.equal(await errorCode(async () => reply(200, { 'content-type': 'application/pdf' }, Buffer.from('<html>no'))), 'SOURCE_CONTENT_MISMATCH');
  assert.equal(await errorCode(async () => reply(200, { 'content-type': 'text/html' }, pdf)), 'SOURCE_MIME_REJECTED');
  assert.equal(await errorCode(async () => reply(200, { 'content-type': 'application/pdf' }, Buffer.concat([pdf, Buffer.alloc(2_000)]))), 'SOURCE_TOO_LARGE');
  assert.equal(await errorCode(async () => reply(503, {})), 'SOURCE_UPSTREAM_ERROR');
  assert.equal(await errorCode(async () => { throw new Error('ECONNRESET'); }), 'SOURCE_UNAVAILABLE');
  const failed = await live(redirectTo('https://attacker.example.net/x.pdf')).fetchDiscovered(requestFor(), source);
  assert.equal(failed.attempts[0].url, docUrl);
});

test('fetchDiscovered refuses discovery sources the adapter was not configured with', async () => {
  const adapter = live(async () => reply(200, { 'content-type': 'application/pdf' }, pdf));
  const other = defineDiscoverySource({ ...rawSource, id: 'unconfigured.source' });
  await assert.rejects(adapter.fetchDiscovered(buildDiscoveredFetchRequest({ requestId: 'x', discoverySource: other, url: docUrl, requestedAt: '2026-10-08T00:00:00Z' }), other), error => code(error) === 'OFFICIAL_SOURCE_DISCOVERY_NOT_CONFIGURED');
  const widened = defineDiscoverySource({ ...rawSource, allowedHosts: ['regulator.example.org', 'attacker.example.net'] });
  const widenedRequest = buildDiscoveredFetchRequest({ requestId: 'y', discoverySource: widened, url: 'https://attacker.example.net/documents/products/x.pdf', requestedAt: '2026-10-08T00:00:00Z' });
  await assert.rejects(adapter.fetchDiscovered(widenedRequest, widened), error => code(error) === 'OFFICIAL_SOURCE_REQUEST_MISMATCH');
});

test('registry fetch keeps working on an adapter that also has discovery sources', async () => {
  const registrySource = {
    id: 'example.wording.test', sourceClass: 'insurer_policy_wording', documentType: 'policy_wording', publisher: 'Example Insurer Limited',
    identity: { scope: 'insurer', legalInsurerName: 'Example Insurer Limited', uin: null, productName: null, version: null, effectiveFrom: null, effectiveTo: null },
    canonicalUrl: 'https://docs.example-insurer.com/wording.pdf', allowedHosts: ['docs.example-insurer.com'],
    expectedMimeTypes: ['application/pdf'], maxBytes: 1_000, freshnessDays: 30, owner: 'test',
  };
  const adapter = live(async () => reply(200, { 'content-type': 'application/pdf' }, pdf), { registry: [registrySource] });
  const result = await adapter.fetch(buildSafeFetchRequest({ requestId: 'r1', source: registrySource, requestedAt: '2026-10-08T00:00:00Z' }));
  assert.equal(result.ok, true);
  assert.equal(result.registryEntryId, 'example.wording.test');
  assert.throws(() => createLiveOfficialSourceAdapter({}), /registry/);
});

test('fake fetchDiscovered is keyed by URL and enforces the same discovery rule', async () => {
  const adapter = createFakeOfficialSourceAdapter({
    discoverySources: [source],
    responses: {
      [docUrl]: { body: pdf, mimeType: 'application/pdf' },
      'https://regulator.example.org/documents/products/redirects.pdf': { body: pdf, mimeType: 'application/pdf', redirects: ['https://attacker.example.net/x.pdf'] },
    },
  });
  const ok = await adapter.fetchDiscovered(requestFor(), source);
  assert.equal(ok.ok, true);
  assert.equal(ok.contentSha256, createHash('sha256').update(pdf).digest('hex'));
  assert.equal((await adapter.fetchDiscovered(requestFor('https://regulator.example.org/documents/products/redirects.pdf'), source)).error.code, 'SOURCE_REDIRECT_REJECTED');
  assert.equal((await adapter.fetchDiscovered(requestFor('https://regulator.example.org/documents/products/missing.pdf'), source)).error.code, 'SOURCE_UNAVAILABLE');
});
