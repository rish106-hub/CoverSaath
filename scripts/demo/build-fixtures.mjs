// Regenerates tests/fixtures/demo/*.pdf and hospitals.json from scripts/demo/demo-data.mjs. Run: node scripts/demo/build-fixtures.mjs
// Output is deterministic (no metadata timestamps). Synthetic text only.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { DEMO_BANNER, DEMO_PDF_SPECS, DEMO_HOSPITAL_PINCODES } from './demo-data.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = join(here, '..', '..', 'tests', 'fixtures', 'demo');

export async function buildPdfBytes(title, lines) {
  const document = await PDFDocument.create({ updateMetadata: false });
  document.setTitle(title);
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage([595, 842]);
  let y = 800;
  for (const text of [DEMO_BANNER, '', ...lines]) {
    page.drawText(text, { x: 50, y, size: 11, font });
    y -= 22;
  }
  return Buffer.from(await document.save({ useObjectStreams: false }));
}

// Thirty invented hospitals across three invented pincodes. Names carry the word "Demo" so no real facility is implied.
export function buildHospitalFixture() {
  const hospitals = [];
  DEMO_HOSPITAL_PINCODES.forEach((pincode, block) => {
    for (let n = 1; n <= 10; n += 1) {
      const index = block * 10 + n;
      hospitals.push({ id: `demo-hospital-${String(index).padStart(2, '0')}`, name: `Demo Hospital ${String(index).padStart(2, '0')} (synthetic)`, pincode, city: `Demo City ${block + 1}`, networkTier: n % 3 === 0 ? 'tier_2' : 'tier_1' });
    }
  });
  return { banner: DEMO_BANNER, hospitals };
}

async function main() {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  for (const spec of DEMO_PDF_SPECS) {
    writeFileSync(join(FIXTURE_DIR, spec.filename), await buildPdfBytes(spec.title, spec.lines));
  }
  writeFileSync(join(FIXTURE_DIR, 'hospitals.json'), `${JSON.stringify(buildHospitalFixture(), null, 2)}\n`);
  process.stdout.write(`wrote ${DEMO_PDF_SPECS.length} pdf files and hospitals.json\n`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main();
