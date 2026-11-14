// Renders the synthetic eval policy (Zephyr Mutual Health, invented) to two PDFs: schedule and terms.
// Page N of each PDF carries exactly the lines the eval expects on page N. Usage (repo root): node scripts/live-run/build-eval-pdfs.mjs [outDir]
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = process.cwd(); const outDir = process.argv[2] ?? '.local/live-run/pdfs';
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
    lines.forEach((line, i) => page.drawText(line.slice(0, 110), { x: 36, y: 800 - i * 16, size: 9, font }));
  }
  doc.setTitle(`Zephyr Mutual Health (synthetic) ${kind}`);
  await writeFile(join(outDir, `zephyr-${kind}.pdf`), await doc.save({ useObjectStreams: false }));
  console.log(kind, 'pages', max);
}
