// Renders Claude Design artboards in Chromium and writes a compact layer tree + raster crops per job.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const require = createRequire('/opt/node22/lib/node_modules/');
const { chromium } = require('playwright');

const HERE = path.dirname(new URL(import.meta.url).pathname);
const [jobsFileArg, projDirArg, blobDirArg, outDirArg] = process.argv.slice(2);
const SAFE_ROOT = path.resolve(process.cwd());
const resolveWithinRoot = (p, name) => {
  const resolved = path.resolve(p);
  const relToRoot = path.relative(SAFE_ROOT, resolved);
  if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) {
    throw new Error(`Invalid ${name}: path must be within ${SAFE_ROOT}`);
  }
  return resolved;
};
const jobsFile = resolveWithinRoot(jobsFileArg, 'jobsFile');
const projDir = resolveWithinRoot(projDirArg, 'projDir');
const blobDir = resolveWithinRoot(blobDirArg, 'blobDir');
const outDir = resolveWithinRoot(outDirArg, 'outDir');
const jobs = JSON.parse(fs.readFileSync(jobsFile, 'utf8'));
const inpage = fs.readFileSync(path.join(HERE, 'inpage.js'), 'utf8');
const work = path.join(outDir, 'work');
fs.mkdirSync(path.join(work, 'blobs'), { recursive: true });
for (const f of fs.readdirSync(blobDir)) fs.copyFileSync(path.join(blobDir, f), path.join(work, 'blobs', f));
fs.writeFileSync(path.join(work, 'support.js'), 'window.DCLogic = class { constructor(p){ this.props = p || {}; this.state = {}; } setState(s){ Object.assign(this.state, s); } };');

const rel = (node, ox, oy) => {
  const n = { ...node };
  n.x = Math.round((node.x - ox) * 100) / 100; n.y = Math.round((node.y - oy) * 100) / 100;
  n.w = Math.round(node.w * 100) / 100; if (node.h != null) n.h = Math.round(node.h * 100) / 100;
  if (node.k) n.k = node.k.map(c => rel(c, node.x, node.y));
  if (n.lh) n.lh = Math.round(n.lh * 100) / 100;
  return n;
};

const browser = await chromium.launch();
const only = process.argv[6] ? process.argv[6].split(',') : null;
for (const job of jobs) {
  if (only && !only.includes(job.id)) continue;
  let html = fs.readFileSync(path.join(projDir, job.file), 'utf8').replace(/\/_blob\/([0-9a-f]{32})/g, 'blobs/$1.png');
  const htmlPath = path.join(work, job.id + '.html');
  fs.writeFileSync(htmlPath, html);
  const ctx = await browser.newContext({ viewport: { width: job.w, height: job.vh || 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.addInitScript(inpage);
  await page.goto('file://' + htmlPath, { waitUntil: 'load' });
  await page.evaluate(o => window.__expand(o), job.props || {});
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  await page.evaluate(() => window.__settle());
  await page.waitForTimeout(150);
  await page.evaluate(() => window.__settle());
  // static snapshot of the expanded, settled artboard (no template script)
  const snap = await page.evaluate(() => {
    const d = document.documentElement.cloneNode(true);
    d.querySelectorAll('script').forEach(s => s.remove());
    return '<!doctype html>\n' + d.outerHTML;
  });
  if (job.scrollTo) await page.evaluate(s => { const t = document.querySelector(s); if (t) t.scrollLeft = 0; }, job.scrollTo);
  const res = await page.evaluate(o => window.__extract(o), { selector: job.selector || null });
  const tree = rel(res.tree, res.tree.x, res.tree.y);
  tree.x = 0; tree.y = 0;
  const dir = path.join(outDir, job.id); fs.mkdirSync(dir, { recursive: true });
  // raster crops: isolate the element's own background and border
  const isoTag = await page.addStyleTag({ content: '.__iso,.__iso *{transition:none!important} body *{visibility:hidden!important} .__iso{visibility:visible!important;color:transparent!important;box-shadow:none!important;outline:none!important} .__iso *{visibility:hidden!important}' });
  for (const key of res.rasters) {
    const el = await page.$(`[data-raster="${key}"]`);
    await el.evaluate(e => e.classList.add('__iso'));
    await el.screenshot({ path: path.join(dir, key + '.png'), omitBackground: true, animations: 'disabled' });
    await el.evaluate(e => e.classList.remove('__iso'));
  }
  await isoTag.evaluate(e => e.remove());
  fs.writeFileSync(path.join(dir, 'static.html'), snap);
  fs.writeFileSync(path.join(dir, 'tree.json'), JSON.stringify({ id: job.id, title: job.title, w: tree.w, h: tree.h, tree, rasters: res.rasters, root: res.root, w0: job.w, vh: job.vh || 900 }));
  // reference render of the same state, for comparison
  await page.addStyleTag({ content: 'header.kv-nav{position:relative!important;top:auto!important}' });
  const target = job.selector ? await page.$(job.selector) : null;
  if (target) await target.screenshot({ path: path.join(dir, 'ref.png') });
  else await page.screenshot({ path: path.join(dir, 'ref.png'), fullPage: true });
  console.log(job.id, 'w', tree.w, 'h', tree.h, 'rasters', res.rasters.length, 'nodes', JSON.stringify(tree).length);
  await ctx.close();
}
await browser.close();
