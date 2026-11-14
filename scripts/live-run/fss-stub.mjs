// Local stand-in for the FSS reference API (the real insurance-data-api has no single branch serving every route
// CoverSaath calls). Invented insurer and product only. Usage: node fss-stub.mjs <port>
import http from 'node:http';

const port = Number(process.argv[2] ?? 3999);
const SHA = 'c'.repeat(64);
const UIN = 'ZEPHLIP26001V012627';
const insurer = { id: 'ins-zephyr', canonical_name: 'Zephyr Mutual Health', aliases: ['Zephyr Mutual Health (synthetic)', 'Zephyr Mutual'] };
const product = { product_id: 'prod-zephyr', insurer_id: 'ins-zephyr', product_name: 'Zephyr Family Care', line_of_business: 'health', uin_raw: UIN, verification_status: 'synthetic_test' };
const exportBody = {
  export_version: SHA,
  product: { product_id: 'prod-zephyr', product_name: product.product_name, insurer_id: 'ins-zephyr', insurer_name: insurer.canonical_name, line_of_business: 'health' },
  documents: [{ document_id: 'fss-doc-1', version_id: 'fss-ver-1', wording_version: 'SYN-v1', sha256: SHA, media_type: 'application/pdf', source_observed_at: '2026-01-01T00:00:00.000Z', synthetic: true,
    source_pages: [{ page_number: 1, text: 'Synthetic reference page.', content_sha256: SHA, parser_version: 'p1', extraction_status: 'extracted', tables_json: [] }] }],
};

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const send = (body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json', etag: '"stub"' }); res.end(JSON.stringify(body)); };
  console.log(req.method, url.pathname);
  if (url.pathname === '/v1/insurers') return send({ data: [insurer], next_cursor: null });
  if (url.pathname === '/v1/insurers/resolve') return send({ data: [{ ...insurer, score: 1 }] });
  if (url.pathname === '/v1/products') return send({ data: [product], next_cursor: null });
  if (url.pathname === '/v1/products/search') return send({ data: [{ ...product, insurer_name: insurer.canonical_name }] });
  if (url.pathname === '/v1/network-hospitals/export') return send({ data: [], next_cursor: null });
  if (url.pathname === '/v1/products/prod-zephyr') return send(product);
  if (url.pathname === `/v1/products/by-uin/${UIN}/export`) return send(exportBody);
  return send({ error: { code: 'not_found' } }, 404);
}).listen(port, '127.0.0.1', () => console.log(`fss-stub listening ${port}`));
