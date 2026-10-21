// The shipped catalogue holds no curated or official record, and no synthetic test identity appears in application code.
// A record may be added only after a real person read the insurer's own wording and a different person checked it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CURATED_OFFICIAL_SOURCES, CURATED_PRODUCT_RECORDS } from '../src/features/decision-catalogue/index.js';
import { POLICY_NUMBERS, SYNTHETIC_BANNER, UINS } from './support/synthetic-policies.mjs';

const sourceFiles = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const path = join(dir, entry.name);
  return entry.isDirectory() ? sourceFiles(path) : /\.(m?js|sql|json)$/.test(entry.name) ? [path] : [];
});

test('the shipped curated and official catalogues are empty', () => {
  assert.deepEqual(CURATED_PRODUCT_RECORDS, []);
  assert.deepEqual(CURATED_OFFICIAL_SOURCES, []);
  assert.ok(Object.isFrozen(CURATED_PRODUCT_RECORDS) && Object.isFrozen(CURATED_OFFICIAL_SOURCES));
});

test('no synthetic UIN, policy number or banner is present in application code, migrations or scripts', () => {
  const markers = [...Object.values(UINS), ...Object.values(POLICY_NUMBERS), SYNTHETIC_BANNER];
  for (const file of [...sourceFiles('src'), ...sourceFiles('scripts')]) {
    const content = readFileSync(file, 'utf8');
    for (const marker of markers) assert.ok(!content.includes(marker), `${file} contains synthetic marker ${marker}`);
  }
});
