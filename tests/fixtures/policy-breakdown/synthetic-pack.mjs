// Assembles the 9 section wording fixtures into one synthetic policy pack with global page numbers,
// and builds a fixture responder that answers each section agent with its gold output.
// Synthetic only: fictional insurer, product and people.

import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const here = new URL('./', import.meta.url);
const SECTION_FILES = ['01', '02', '03', '04', '05', '06', '07', '08', '09'];
const SECTION_IDS = {
  '01': 'section-01-document-authority', '02': 'section-02-people', '03': 'section-03-time',
  '04': 'section-04-treatment', '05': 'section-05-exclusions', '06': 'section-06-money',
  '07': 'section-07-hospital-access', '08': 'section-08-claims', '09': 'section-09-renewal',
};

/** Synthetic packs: 'a' (retail family floater, root folder), 'b' (employer group), 'c' (super top-up). */
export const SYNTHETIC_PACKS = Object.freeze(['a', 'b', 'c']);

export function loadSyntheticPack({ pack = 'a' } = {}) {
  if (!SYNTHETIC_PACKS.includes(pack)) throw new Error(`Unknown synthetic pack ${pack}.`);
  const base = pack === 'a' ? here : new URL(`pack-${pack}/`, here);
  const pages = [];
  const gold = {};
  for (const number of SECTION_FILES) {
    // A pack may omit a section; its agents then answer "not found" for every key.
    if (!existsSync(new URL(`s${number}-wording.txt`, base))) { gold[SECTION_IDS[number]] = []; continue; }
    const wording = readFileSync(new URL(`s${number}-wording.txt`, base), 'utf8');
    const sectionPages = wording.split(/^=== PAGE BREAK ===$/m).map(text => text.trim()).filter(Boolean);
    for (const text of sectionPages) pages.push({ pageNumber: pages.length + 1, text, sourceSection: Number(number) });
    gold[SECTION_IDS[number]] = JSON.parse(readFileSync(new URL(`s${number}-gold.json`, base), 'utf8')).expected;
  }
  return { name: pack, pages, gold };
}

function locate(pages, quote) {
  if (!quote) return null;
  const page = pages.find(candidate => candidate.text.includes(quote));
  return page ? page.pageNumber : null;
}

/** Converts a gold item into the model output shape (citations instead of quote). */
export function goldToOutput(item, pages) {
  const { quote, ...rest } = item;
  const pageNumber = locate(pages, quote);
  return {
    ...rest,
    valueList: rest.valueList ?? null,
    basis: rest.basis ?? 'not_stated',
    effect: rest.effect ?? 'not_stated',
    conditions: rest.conditions ?? [],
    exceptions: rest.exceptions ?? [],
    citations: item.found && quote && pageNumber ? [{ pageNumber, quote }] : [],
  };
}

/**
 * responder({ agent, schema }) → model output. `mutate(agent, output)` lets tests inject disagreement,
 * fabricated quotes or failures.
 */
export function createGoldResponder(pack, { mutate = null } = {}) {
  return async ({ agent, schema }) => {
    const [sectionId, role] = agent.split(':');
    const items = pack.gold[sectionId];
    if (!items) throw Object.assign(new Error(`No gold for ${agent}`), { code: 'FIXTURE_MISSING' });
    const allowed = new Set(schema.properties.parameters.items.properties.key.enum);
    let output = { parameters: items.filter(item => allowed.has(item.key)).map(item => goldToOutput(item, pack.pages)) };
    if (mutate) output = await mutate({ agent, sectionId, role, output });
    return output;
  };
}

/** Renders the pack into a real multi-page PDF (text drawn with a standard font; ₹ replaced). */
export async function buildSyntheticPdf(pack) {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (const page of pack.pages) {
    const pdfPage = document.addPage([595, 842]);
    const lines = page.text.replace(/₹/g, 'Rs.').replace(/[^\x20-\x7E\n]/g, '-').split('\n').flatMap(line => line.match(/.{1,95}(\s|$)|.{95}/g) ?? ['']);
    let y = 810;
    for (const line of lines.slice(0, 70)) {
      pdfPage.drawText(line, { x: 30, y, size: 8, font });
      y -= 11;
    }
  }
  return Buffer.from(await document.save());
}

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** Fixture page-text provider keyed by document bytes digest. */
export function createFixturePageTextProvider(pagesBySha) {
  return Object.freeze({
    name: 'fixture',
    mode: 'fixture',
    async extractPages({ bytes }) {
      const pages = pagesBySha.get(sha256(bytes));
      if (!pages) throw Object.assign(new Error('No fixture pages for this document.'), { code: 'FIXTURE_PAGES_MISSING' });
      return {
        pages: pages.map(page => ({ pageNumber: page.pageNumber, text: page.text, extractionStatus: 'extracted', confidenceBasisPoints: null, providerPageRef: `fixture:${page.pageNumber}` })),
        jobRefs: [`fixture-${sha256(bytes).slice(0, 12)}`],
        warnings: [],
      };
    },
  });
}

/**
 * Runs a synthetic pack through the real pipeline (fixture model, real assembly and analysis) and returns the
 * assembled parameter record, as the service would store it.
 */
export async function buildPackRecord({ pack = 'a', household = { members: [], city: null }, asOf = '2026-10-02', references = {}, otherRecords = [] } = {}) {
  const { EXTRACTION_SECTIONS } = await import('../../../src/modules/policy-breakdown/sections/index.js');
  const { runExtractionSection, assembleSectionFromStep, runAnalysisSections } = await import('../../../src/modules/policy-breakdown/pipeline/run-sections.js');
  const { createFixtureModelRunner, createJobBudget } = await import('../../../src/modules/policy-breakdown/agents/model-runner.js');
  const loaded = loadSyntheticPack({ pack });
  const pages = loaded.pages.map(page => ({ ...page, documentId: `synthetic-${pack}`, localPageNumber: page.pageNumber, documentLabel: `synthetic-pack-${pack}` }));
  const runner = createFixtureModelRunner({ responder: createGoldResponder(loaded) });
  const parameters = {};
  for (const section of EXTRACTION_SECTIONS) {
    const output = await runExtractionSection({ section, pages, runner, budget: createJobBudget(Number.MAX_SAFE_INTEGER) });
    Object.assign(parameters, assembleSectionFromStep({ section, stepOutput: output, pages, runner }));
  }
  Object.assign(parameters, runAnalysisSections({ parameters, household, otherRecords, references, asOf }));
  return parameters;
}
