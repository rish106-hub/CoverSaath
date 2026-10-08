import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import {
  IRDAI_DISCOVERY_SOURCES,
  IRDAI_HEALTH_PRODUCTS,
  createIrdaiProductRepository,
  irdaiSearchUrl,
  parseIrdaiProductRows,
} from '../src/modules/policy-breakdown/references/official/irdai-product-repository.js';
import { createFakeOfficialSourceAdapter } from '../src/modules/policy-breakdown/references/official/fake-adapter.js';
import { createLiveOfficialSourceAdapter } from '../src/modules/policy-breakdown/references/official/live-adapter.js';

// Synthetic pages that mimic the IRDAI listing markup; every insurer, UIN and link in them is invented.
const fixture = name => readFile(new URL(`./fixtures/official-sources/${name}`, import.meta.url), 'utf8');
const syntheticPage = await fixture('irdai-products-synthetic.html');
const emptyPage = await fixture('irdai-products-empty.html');
const NOW = () => new Date('2026-10-08T00:00:00Z');
const DOCS = 'https://irdai.gov.in/documents/37343/931203/';

// The fake serves the same listing for every UIN searched, so selection must come from exact row matching alone.
function fakeRepository({ page = syntheticPage, uins, extra = {}, cacheDirectory = null, now = NOW, onFetch = () => {} } = {}) {
  const responses = { ...extra };
  for (const uin of uins) responses[irdaiSearchUrl(uin)] = { body: page, mimeType: 'text/html;charset=UTF-8' };
  const fake = createFakeOfficialSourceAdapter({ discoverySources: IRDAI_DISCOVERY_SOURCES, responses });
  const adapter = { fetchDiscovered: (request, source) => { onFetch(request); return fake.fetchDiscovered(request, source); } };
  return createIrdaiProductRepository({ adapter, now, cacheDirectory });
}

test('the search URL is the namespaced portlet render URL with the exact UIN', () => {
  const url = new URL(irdaiSearchUrl(' exahlip90001v019091 '));
  assert.equal(url.origin + url.pathname, 'https://irdai.gov.in/health-insurance-products');
  assert.equal(url.searchParams.get('p_p_id'), 'com_irdai_document_media_IRDAIDocumentMediaPortlet');
  assert.equal(url.searchParams.get('p_p_lifecycle'), '0');
  assert.equal(url.searchParams.get('_com_irdai_document_media_IRDAIDocumentMediaPortlet_filterUIN'), 'EXAHLIP90001V019091');
  assert.equal(new URL(irdaiSearchUrl('IRDA/NL-HLT/L&TGI/P-H/V.I/242/13-14')).searchParams.get('_com_irdai_document_media_IRDAIDocumentMediaPortlet_filterUIN'), 'IRDA/NL-HLT/L&TGI/P-H/V.I/242/13-14');
  for (const bad of ['', 'abc', 'ABCDEFGHIJ', 'patient@example.com', '<script>alert(1)</script>', 'A'.repeat(90)]) {
    assert.throws(() => irdaiSearchUrl(bad), error => error.code === 'IRDAI_UIN_INVALID', bad);
  }
});

test('the parser reads every row from its own cells and ignores page-level links', () => {
  const parsed = parseIrdaiProductRows(syntheticPage);
  assert.equal(parsed.recognised, true);
  assert.equal(parsed.rows.length, 10);
  const first = parsed.rows[0];
  assert.equal(first.insurerName, 'Example Health & General Insurance Co. Ltd.');
  assert.equal(first.documentUrl, `${DOCS}EXAHLIP90001V019091.pdf/00000000-0000-4000-8000-000000000001`);
  assert.equal(parsed.rows.find(row => row.uin === null)?.productName, 'Group Shield Without UIN');
  assert.deepEqual(parseIrdaiProductRows(emptyPage), { recognised: true, empty: true, rows: [] });
  assert.equal(parseIrdaiProductRows('<html><body>Maintenance</body></html>').recognised, false);
  // Rows present while the empty-results marker is visible is contradictory markup, not data.
  assert.equal(parseIrdaiProductRows(syntheticPage.replace('alert alert-info hide', 'alert alert-info')).recognised, false);
});

test('an exact UIN returns the product with ISO approval date and a path-only official document URL', async () => {
  const repository = fakeRepository({ uins: ['EXAHLIP90001V019091'] });
  const result = await repository.findByUin('exahlip90001v019091');
  assert.equal(result.status, 'found');
  assert.deepEqual(result.product, {
    insurerName: 'Example Health & General Insurance Co. Ltd.',
    uin: 'EXAHLIP90001V019091',
    productName: 'Example Secure Plus',
    approvalDate: '2090-05-06',
    financialYear: '2090-2091',
    productType: 'Individual',
    archived: false,
    documentUrl: `${DOCS}EXAHLIP90001V019091.pdf/00000000-0000-4000-8000-000000000001`,
  });
  assert.equal(result.evidence.discoverySourceId, 'irdai.health-insurance-products.search');
  assert.match(result.evidence.contentSha256, /^[a-f0-9]{64}$/);
});

test('matching is exact: other versions, prefixes and near misses never match', async () => {
  // The synthetic page lists rows but none equals these UINs: that is what IRDAI returns when its filter is not
  // applied, so the answer is unavailable (not a cached negative) and never a fuzzy pick.
  const uins = ['EXAHLIP90001V039293', 'EXAHLIP90001V01', 'EXAHLIP90001V0190911', 'XAHLIP90001V019091'];
  let fetches = 0;
  const cacheDirectory = await mkdtemp(join(tmpdir(), 'irdai-nomatch-'));
  try {
    const repository = fakeRepository({ uins, cacheDirectory, onFetch: () => { fetches += 1; } });
    for (const uin of uins) {
      const result = await repository.findByUin(uin);
      assert.equal(result.status, 'unavailable', uin);
      assert.equal(result.code, 'IRDAI_FILTER_NOT_APPLIED');
      assert.equal(result.product, null);
    }
    assert.equal((await repository.findByUin(uins[0])).cached, false);
    assert.equal(fetches, uins.length + 1);
  } finally {
    await rm(cacheDirectory, { recursive: true, force: true });
  }
  const second = await fakeRepository({ uins: ['EXAHLIP90001V029192'] }).findByUin('EXAHLIP90001V029192');
  assert.equal(second.product.productType, 'Revision');
  assert.match(second.product.documentUrl, /V029192\.pdf/);
});

test('an empty listing is not_found and an unrecognised page is unavailable', async () => {
  assert.equal((await fakeRepository({ page: emptyPage, uins: ['EXAHLIP90001V019091'] }).findByUin('EXAHLIP90001V019091')).status, 'not_found');
  const broken = await fakeRepository({ page: '<html><body>Under maintenance</body></html>', uins: ['EXAHLIP90001V019091'] }).findByUin('EXAHLIP90001V019091');
  assert.equal(broken.status, 'unavailable');
  assert.equal(broken.code, 'IRDAI_PAGE_UNRECOGNISED');
});

test('non-archived rows win; an archived-only product is returned flagged archived', async () => {
  const both = await fakeRepository({ uins: ['EXBHLIP90002V019091'] }).findByUin('EXBHLIP90002V019091');
  assert.equal(both.status, 'found');
  assert.equal(both.product.archived, false);
  assert.match(both.product.documentUrl, /EXBHLIP90002V019091\.pdf\//);
  const archivedOnly = await fakeRepository({ uins: ['EXCHLIP90003V018990'] }).findByUin('EXCHLIP90003V018990');
  assert.equal(archivedOnly.status, 'found');
  assert.equal(archivedOnly.product.archived, true);
});

test('document links off the allowlist or outside the product folder make the row unusable', async () => {
  for (const uin of ['EXDHLIP90004V019091', 'EXFHLIP90006V019091']) {
    const result = await fakeRepository({ uins: [uin] }).findByUin(uin);
    assert.equal(result.status, 'unavailable', uin);
    assert.equal(result.code, 'IRDAI_ROW_INVALID');
    assert.equal(result.product, null);
  }
});

test('two different documents for the same UIN are unavailable rather than guessed', async () => {
  const result = await fakeRepository({ uins: ['EXEHLIP90005V019091'] }).findByUin('EXEHLIP90005V019091');
  assert.equal(result.status, 'unavailable');
  assert.equal(result.code, 'IRDAI_UIN_MULTIPLE_DOCUMENTS');
  assert.equal(result.product, null);
});

test('upstream failures are unavailable with a stable code', async () => {
  const missing = await fakeRepository({ uins: [] }).findByUin('EXAHLIP90001V019091');
  assert.equal(missing.status, 'unavailable');
  assert.equal(missing.code, 'SOURCE_UNAVAILABLE');
  const errorAdapter = createFakeOfficialSourceAdapter({ discoverySources: IRDAI_DISCOVERY_SOURCES, responses: { [irdaiSearchUrl('EXAHLIP90001V019091')]: { status: 503 } } });
  assert.equal((await createIrdaiProductRepository({ adapter: errorAdapter, now: NOW }).findByUin('EXAHLIP90001V019091')).code, 'SOURCE_UPSTREAM_ERROR');
  const disabled = createLiveOfficialSourceAdapter({ discoverySources: IRDAI_DISCOVERY_SOURCES, enabled: false });
  const result = await createIrdaiProductRepository({ adapter: disabled, now: NOW }).findByUin('EXAHLIP90001V019091');
  assert.equal(result.status, 'unavailable');
  assert.equal(result.code, 'SOURCE_FETCH_DISABLED');
});

test('through the live adapter: listing then PDF, with redirects held to the IRDAI document rule', async () => {
  const pdf = Buffer.from('%PDF-1.7 synthetic EXAHLIP90001V019091');
  const seen = [];
  let redirectTarget = null;
  const transport = async url => {
    seen.push(url);
    if (url.startsWith('https://irdai.gov.in/health-insurance-products?')) {
      return { status: 200, headers: { 'content-type': 'text/html;charset=UTF-8' }, body: Readable.from([Buffer.from(syntheticPage)]) };
    }
    if (redirectTarget && !seen.includes(redirectTarget)) return { status: 302, headers: { location: redirectTarget }, body: Readable.from([]) };
    return { status: 200, headers: { 'content-type': 'application/pdf' }, body: Readable.from([pdf]) };
  };
  const adapter = createLiveOfficialSourceAdapter({ discoverySources: IRDAI_DISCOVERY_SOURCES, enabled: true, transport });
  const repository = createIrdaiProductRepository({ adapter, now: NOW });
  const { product } = await repository.findByUin('EXAHLIP90001V019091');
  const document = await repository.fetchDocument(product);
  assert.equal(document.ok, true);
  assert.equal(document.discoverySourceId, IRDAI_HEALTH_PRODUCTS.id);
  assert.equal(document.url, product.documentUrl);

  redirectTarget = 'https://attacker.example.net/documents/37343/931203/x.pdf';
  assert.equal((await repository.fetchDocument(product)).error.code, 'SOURCE_REDIRECT_REJECTED');
  redirectTarget = 'https://irdai.gov.in/documents/37343/620662/other.pdf';
  seen.length = 0;
  assert.equal((await repository.fetchDocument(product)).error.code, 'SOURCE_REDIRECT_REJECTED');
  await assert.rejects(repository.fetchDocument({ ...product, documentUrl: 'https://attacker.example.net/x.pdf' }), error => error.code === 'OFFICIAL_SOURCE_HOST_NOT_ALLOWED');
});

test('found and not_found results are cached for the source freshness window', async () => {
  const cacheDirectory = await mkdtemp(join(tmpdir(), 'irdai-cache-'));
  try {
    let fetches = 0;
    let clock = new Date('2026-10-08T00:00:00Z');
    const repository = fakeRepository({
      uins: ['EXAHLIP90001V019091'],
      extra: { [irdaiSearchUrl('EXZHLIP90009V019091')]: { body: emptyPage, mimeType: 'text/html' } },
      cacheDirectory, now: () => clock, onFetch: () => { fetches += 1; },
    });
    const first = await repository.findByUin('EXAHLIP90001V019091');
    const again = await repository.findByUin('EXAHLIP90001V019091');
    assert.equal(fetches, 1);
    assert.equal(again.cached, true);
    assert.deepEqual(again.product, first.product);
    assert.equal((await repository.findByUin('EXZHLIP90009V019091')).status, 'not_found');
    assert.equal((await repository.findByUin('EXZHLIP90009V019091')).cached, true);
    assert.equal(fetches, 2);
    clock = new Date('2026-12-01T00:00:00Z');
    assert.equal((await repository.findByUin('EXAHLIP90001V019091')).cached, false);
    assert.equal(fetches, 3);
  } finally {
    await rm(cacheDirectory, { recursive: true, force: true });
  }
});
