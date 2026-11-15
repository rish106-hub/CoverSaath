import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProduct, parseRegistryProducts, parseProductNameSearch } from '../src/integrations/insurance-data/schemas.js';
import { detectInsurerCandidates } from '../src/features/insurer-detection/index.js';

// FSS sends a product whose name it could not read cleanly as product_name: null (name_unresolved: true), never a placeholder.
// One such product must not invalidate a whole registry page, and it may only become a candidate through a printed UIN.
// Synthetic data only.

const row = extra => ({ product_id: 'p-1', insurer_id: 'ins-syn', product_name: 'Synthetic Care Plan', line_of_business: 'health', uin_raw: 'SYNHLIP00001V010001', verification_status: 'candidate', ...extra });

test('a null product name parses; an absent or empty one still fails closed', () => {
  assert.equal(parseProduct(row({ product_name: null, name_unresolved: true })).productName, null);
  assert.equal(parseProduct(row()).productName, 'Synthetic Care Plan');
  const { product_name: _drop, ...absent } = row();
  assert.throws(() => parseProduct(absent), { code: 'REFERENCE_DATA_RESPONSE_INVALID' });
  assert.throws(() => parseProduct(row({ product_name: '' })), { code: 'REFERENCE_DATA_RESPONSE_INVALID' });
});

test('one unnamed product does not invalidate the registry page or a search result', () => {
  const page = parseRegistryProducts({ data: [row(), row({ product_id: 'p-2', product_name: null, uin_raw: 'SYNHLIP00002V010001' })], next_cursor: null });
  assert.deepEqual(page.products.map(p => p.productName), ['Synthetic Care Plan', null]);
  const search = parseProductNameSearch({ data: [{ product_id: 'p-2', product_name: null, insurer_id: 'ins-syn', insurer_name: 'Synthetic Insurer', line_of_business: 'health', uin_raw: null }] });
  assert.equal(search.products.length, 1);
  assert.equal(search.products[0].productName, null);
});

test('an unnamed product is a candidate only when its UIN is printed, and never by name', () => {
  const registry = {
    insurers: [{ id: 'ins-syn', canonicalName: 'Synthetic Insurer Limited', aliases: ['Synthetic Insurer'] }],
    products: [
      { productId: 'p-named', insurerId: 'ins-syn', productName: 'Synthetic Care Plan', uinRaw: 'SYNHLIP00001V010001' },
      { productId: 'p-unnamed', insurerId: 'ins-syn', productName: null, uinRaw: 'SYNHLIP00002V010001' },
    ],
  };
  const withUin = detectInsurerCandidates({ text: 'Synthetic Insurer Limited policy schedule UIN: SYNHLIP00002V010001', registry });
  assert.equal(withUin[0].candidateId, 'p-unnamed');
  assert.equal(withUin[0].productName, null);
  const byName = detectInsurerCandidates({ text: 'Synthetic Insurer Limited Synthetic Care Plan policy schedule', registry });
  // With no name the unnamed product can score only through its insurer (below the cut-off), so it is absent, not just ranked lower.
  assert.deepEqual(byName.map(c => c.candidateId), ['p-named']);
  const insurerOnly = detectInsurerCandidates({ text: 'Synthetic Insurer Limited policy schedule', registry });
  assert.ok(insurerOnly.every(c => c.candidateId !== 'p-unnamed'));
});
