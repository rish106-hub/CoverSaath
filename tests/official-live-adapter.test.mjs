import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import { classifyIpAddress, createGuardedLookup, createLiveOfficialSourceAdapter } from '../src/modules/policy-breakdown/references/official/live-adapter.js';
import { buildSafeFetchRequest } from '../src/modules/policy-breakdown/references/official/contracts.js';

const source = {
  id: 'example.wording.test', sourceClass: 'insurer_policy_wording', documentType: 'policy_wording', publisher: 'Example Insurer Limited',
  identity: { scope: 'insurer', legalInsurerName: 'Example Insurer Limited', uin: null, productName: null, version: null, effectiveFrom: null, effectiveTo: null },
  canonicalUrl: 'https://docs.example-insurer.com/wording.pdf', allowedHosts: ['docs.example-insurer.com'],
  expectedMimeTypes: ['application/pdf'], maxBytes: 1_000, freshnessDays: 30, owner: 'test',
};
const request = () => buildSafeFetchRequest({ requestId: 'r1', source, requestedAt: '2026-10-08T00:00:00Z' });
const pdf = Buffer.from('%PDF-1.7 synthetic');
const reply = (status, headers, body = Buffer.alloc(0)) => async () => ({ status, headers, body: Readable.from([body]) });
const adapterWith = (transport, options = {}) => createLiveOfficialSourceAdapter({ registry: [source], enabled: true, transport, ...options });

test('disabled adapter never calls the transport', async () => {
  let called = false;
  const result = await createLiveOfficialSourceAdapter({ registry: [source], enabled: false, transport: async () => { called = true; } }).fetch(request());
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'SOURCE_FETCH_DISABLED');
  assert.equal(called, false);
});

test('a PDF within limits is returned with its SHA-256', async () => {
  const result = await adapterWith(reply(200, { 'content-type': 'application/pdf' }, pdf)).fetch(request());
  assert.equal(result.ok, true);
  assert.equal(result.contentSha256, createHash('sha256').update(pdf).digest('hex'));
  assert.equal(result.url, source.canonicalUrl);
});

test('redirects off the allowlist, wrong MIME, oversize, compressed and non-PDF bodies are rejected', async () => {
  const code = async transport => (await adapterWith(transport).fetch(request())).error?.code;
  assert.equal(await code(reply(302, { location: 'https://attacker.example.net/x.pdf' })), 'SOURCE_REDIRECT_REJECTED');
  assert.equal(await code(reply(200, { 'content-type': 'text/html' }, pdf)), 'SOURCE_MIME_REJECTED');
  assert.equal(await code(reply(200, { 'content-type': 'application/pdf' }, Buffer.concat([pdf, Buffer.alloc(2_000)]))), 'SOURCE_TOO_LARGE');
  assert.equal(await code(reply(200, { 'content-type': 'application/pdf', 'content-encoding': 'gzip' }, pdf)), 'SOURCE_ENCODING_REJECTED');
  assert.equal(await code(reply(200, { 'content-type': 'application/pdf' }, Buffer.from('<html>not a pdf'))), 'SOURCE_CONTENT_MISMATCH');
  assert.equal(await code(reply(404, {})), 'SOURCE_NOT_FOUND');
});

test('a request that differs from its registry entry throws before any network use', async () => {
  const forged = { ...request(), url: 'https://docs.example-insurer.com/other.pdf' };
  await assert.rejects(adapterWith(reply(200, {}, pdf)).fetch(forged), /registry/);
});

test('non-public addresses are blocked, including mapped and NAT64 forms', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '192.168.0.1', '::1', 'fe80::1', '::ffff:10.0.0.1', '64:ff9b::a00:1', 'fd00::1']) assert.equal(classifyIpAddress(address).allowed, false, address);
  for (const address of ['8.8.8.8', '2606:4700:4700::1111']) assert.equal(classifyIpAddress(address).allowed, true, address);
});

test('the guarded lookup refuses a host if any resolved address is non-public', async () => {
  const lookup = createGuardedLookup({ resolve: (host, options, callback) => callback(null, [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }]) });
  const error = await new Promise(resolve => lookup('docs.example-insurer.com', { all: true }, resolve));
  assert.equal(error?.code, 'SOURCE_ADDRESS_BLOCKED');
  const ok = createGuardedLookup({ resolve: (host, options, callback) => callback(null, [{ address: '93.184.216.34', family: 4 }]) });
  const [failure, address] = await new Promise(resolve => ok('docs.example-insurer.com', {}, (...args) => resolve(args)));
  assert.equal(failure, null);
  assert.equal(address, '93.184.216.34');
});
