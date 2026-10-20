#!/usr/bin/env node
/**
 * Parse-accuracy eval for one real policy PDF. Opt-in, billable, consent-gated.
 *   digitise <pdf> --consent=sarvam   Sarvam digitise -> .local/eval/sarvam-raw.json + normalized.json
 *   draft                             candidate golden fields -> .local/eval/golden.draft.json
 *   run [--consent=gemini]            extract, score, optionally adjudicate -> .local/eval/report.json
 * All values stay under .local/eval/ (gitignored). Nothing here prints document text.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createSarvamOcrProvider } from '../src/integrations/index.js';
import { createSandboxedPdfSegmenter } from '../src/features/input/index.js';

const DERIVED_FIELDS = new Set(['exclusions_present', 'add_ons_opted']);
const OUT = resolve('.local/eval');
const wait = ms => new Promise(done => setTimeout(done, ms));
const [command, ...rest] = process.argv.slice(2);
const flags = Object.fromEntries(rest.filter(a => a.startsWith('--')).map(a => a.slice(2).split('=')));
const positional = rest.filter(a => !a.startsWith('--'));
const consent = new Set((flags.consent ?? '').split(',').filter(Boolean));
const readJson = async name => JSON.parse(await readFile(resolve(OUT, name), 'utf8'));
const writeJson = (name, value) => writeFile(resolve(OUT, name), JSON.stringify(value, null, 2));

async function digitise(pdfPath) {
  if (!consent.has('sarvam')) throw new Error('Document-specific Sarvam grant required: pass --consent=sarvam.');
  if (!process.env.SARVAM_API_KEY) throw new Error('SARVAM_API_KEY is required.');
  const bytes = await readFile(pdfPath);
  const source = { documentId: 'eval-real-policy', sourceVersion: '1', contentSha256: createHash('sha256').update(bytes).digest('hex') };
  const provider = createSarvamOcrProvider({
    env: { ...process.env, SARVAM_OCR_ENABLED: 'true' }, segmenter: createSandboxedPdfSegmenter(),
  });
  const authorization = {
    authorized: true, consentGrantId: 'eval-operator-grant', requestedByAdultId: 'eval-operator',
    purpose: 'document_processing', recipient: 'sarvam', settings: { language: 'en-IN', contentType: 'printed' },
  };
  const submitted = await provider.createJob({ document: source, bytes, authorization, requestId: 'eval-real-policy-request' });
  let result;
  for (let poll = 0; poll < 300; poll += 1) {
    result = await provider.getJob({ jobRef: result?.jobRef ?? submitted.jobRef, authorization });
    if (result.status !== 'processing') break;
    await wait(2_000);
  }
  if (result?.status !== 'succeeded') throw new Error(`Sarvam job ended ${result?.status}.`);
  const normalized = provider.normalizeResult(result.result, source);
  await mkdir(OUT, { recursive: true });
  await writeJson('sarvam-raw.json', result.result.results);
  await writeJson('normalized.json', normalized);
  const metrics = { pageRecall: `${normalized.pages.length}/${result.result.manifest.pageCount}`, emptyPages: normalized.pages.filter(p => p.extractionStatus !== 'extracted').length };
  console.log(JSON.stringify(metrics));
}

function rawPages(raw) {
  // Block-level view for the extractor: [{ page, blocks: [{ text, tag }] }] in original page order.
  return raw.flatMap(result => result.documents[0].pages).map((page, index) => ({
    page: index + 1,
    blocks: [...page.blocks].sort((a, b) => a.reading_order - b.reading_order).map(b => ({ text: b.text, tag: b.layout_tag })),
  }));
}

async function main() {
  if (command === 'digitise') return digitise(positional[0]);
  const { draftCandidates, extractFields, flattenBlock } = await import('../src/features/ai-analysis/eval-extractor.js');
  const { scoreFields, adjudicationMetrics } = await import('../src/features/ai-analysis/eval-scorer.js');
  const { selectDisputes, adjudicate, createGeminiCaller, ADJUDICATOR_LIMITS } = await import('../src/features/ai-analysis/field-adjudicator.js');
  const pages = rawPages(await readJson('sarvam-raw.json'));
  if (command === 'draft') {
    await writeJson('golden.draft.json', draftCandidates(pages));
    return console.log('Draft written to .local/eval/golden.draft.json. Verify every value against the PDF, then save as golden.json.');
  }
  if (command === 'run') {
    const golden = await readJson('golden.json');
    const extracted = extractFields(pages, Object.keys(golden.fields));
    const squash = text => String(text).toLowerCase().replace(/[\s,]+/g, '');
    const sourceText = squash(pages.flatMap(page => page.blocks.filter(b => b.tag !== 'image' && b.tag !== 'image-caption').map(flattenBlock)).join(' '));
    // exclusions_present and add_ons_opted are derived from table structure, not quoted text.
    const grounded = (field, value) => DERIVED_FIELDS.has(field) || (Array.isArray(value) ? value : [value]).every(part => sourceText.includes(squash(part)));
    const before = scoreFields(golden, extracted, [], { grounded });
    let after = before;
    let adjudication = { calls: 0, usage: { inputTokens: 0, outputTokens: 0 }, results: [] };
    // The adjudicator gets presence and page hints only, never golden values.
    const pageHints = Object.fromEntries(Object.entries(golden.fields)
      .filter(([, truth]) => truth.confirmed === true && truth.value !== 'unknown' && truth.page).map(([field, truth]) => [field, truth.page]));
    const disputes = selectDisputes(extracted, pageHints);
    if (disputes.length && consent.has('gemini')) {
      const call = createGeminiCaller({ apiKey: process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY, model: process.env.LLM_MODEL });
      adjudication = await adjudicate({ disputes, pages, call, grant: { recipient: 'gemini', documentId: 'eval-real-policy', granted: true } });
      after = scoreFields(golden, extracted, adjudication.results, { grounded });
    }
    const report = { metrics: { adjudicator: adjudicationMetrics(before, after), pageRecall: pages.length, geminiCalls: adjudication.calls }, generatedAt: new Date().toISOString(), before, after, adjudication: { ...adjudication, disputedFields: disputes.map(d => d.field), maxCalls: ADJUDICATOR_LIMITS.maxCalls } };
    await writeJson('report.json', report);
    return console.log(JSON.stringify({ before: before.summary, after: after.summary, geminiCalls: adjudication.calls }));
  }
  throw new Error('Usage: eval-parse.mjs digitise <pdf> --consent=sarvam | draft | run [--consent=gemini]');
}

main().catch(error => { console.error(`eval-parse failed: ${error.code ?? ''} ${error.message}`); process.exit(1); });
