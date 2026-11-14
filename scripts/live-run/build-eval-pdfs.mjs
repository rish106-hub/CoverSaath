// Renders the synthetic eval policy (Zephyr Mutual Health, invented) to two PDFs: schedule and terms.
// Page N of each PDF carries the lines the eval expects on page N, in full (wrapped, never cut), under a one-line
// SYNTHETIC banner. Writes to .local/live-run/pdfs. Usage (repo root): node scripts/live-run/build-eval-pdfs.mjs
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = process.cwd(); const outDir = '.local/live-run/pdfs';
const { PDFDocument, StandardFonts } = await import(pathToFileURL(join(repo, 'node_modules/pdf-lib/cjs/index.js')).href);
const { syntheticStoredPages } = await import(pathToFileURL(join(repo, 'scripts/fixtures/synthetic-eval-policy.mjs')).href);
const BANNER = 'SYNTHETIC FIXTURE - FICTIONAL POLICY, NOT REAL';

await mkdir(outDir, { recursive: true });
for (const kind of ['schedule', 'terms']) {
  const { pages } = syntheticStoredPages(kind);
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const max = Math.max(...pages.map(p => p.page));
  for (let n = 1; n <= max; n += 1) {
    const page = doc.addPage([595, 842]);
    const found = pages.find(p => p.page === n);
    const lines = [BANNER, ...(found ? found.blocks.map(b => b.text) : [`Page ${n}`])];
    const wrapped = lines.flatMap(line => line.match(/.{1,100}(\s|$)|\S+/g) ?? ['']);
    wrapped.forEach((line, i) => page.drawText(line.trimEnd(), { x: 36, y: 800 - i * 14, size: 9, font }));
  }
  doc.setTitle(`Zephyr Mutual Health (synthetic) ${kind}`);
  await writeFile(join(outDir, `zephyr-${kind}.pdf`), await doc.save({ useObjectStreams: false }));
  console.log(kind, 'pages', max);
}
