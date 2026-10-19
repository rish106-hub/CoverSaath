// Opt-in: RUN_PARSE_EVAL=1 needs .local/eval/sarvam-raw.json (from `eval-parse.mjs digitise`) and a human-verified
// .local/eval/golden.json. Add RUN_GEMINI_LIVE=1 for the billable negative-control call.
// Thresholds mirror docs/exec-plans/active/sarvam-gemini-parse-validation.xml. No document values are printed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { extractFields } from '../../src/modules/ai-analysis/eval-extractor.js';
import { scoreFields } from '../../src/modules/ai-analysis/eval-scorer.js';
import { adjudicate, createGeminiCaller } from '../../src/modules/ai-analysis/field-adjudicator.js';

const enabled = process.env.RUN_PARSE_EVAL === '1';
const skip = enabled ? false : 'set RUN_PARSE_EVAL=1 with .local/eval/sarvam-raw.json and golden.json';
const load = async name => JSON.parse(await readFile(new URL(`../../.local/eval/${name}`, import.meta.url), 'utf8'));

async function pagesFromRaw() {
  const raw = await load('sarvam-raw.json');
  return raw.flatMap(result => result.documents[0].pages).map((page, index) => ({
    page: index + 1,
    blocks: [...page.blocks].sort((a, b) => a.reading_order - b.reading_order).map(b => ({ text: b.text, tag: b.layout_tag })),
  }));
}

test('page recall: every PDF page returned', { skip }, async () => {
  const pages = await pagesFromRaw();
  const normalized = await load('normalized.json');
  assert.equal(pages.length, normalized.pages.length);
  assert.ok(normalized.pages.every(page => page.extractionStatus === 'extracted'));
});

test('extractor meets critical, overall and hallucination thresholds against the verified golden file', { skip }, async () => {
  const golden = await load('golden.json');
  const confirmed = Object.values(golden.fields).filter(field => field.confirmed === true);
  assert.ok(confirmed.length > 0, 'golden.json has no confirmed fields');
  const score = scoreFields(golden, extractFields(await pagesFromRaw(), Object.keys(golden.fields)));
  assert.equal(score.summary.criticalAccuracy, 1, 'any critical miss is a fail');
  assert.equal(score.summary.hallucinationRate, 0);
  assert.ok(score.summary.fieldAccuracy >= 0.85, `field accuracy ${score.summary.fieldAccuracy}`);
});

test('Gemini negative control: a snippet without the value yields unknown', {
  skip: enabled && process.env.RUN_GEMINI_LIVE === '1' ? false : 'set RUN_GEMINI_LIVE=1 for the billable negative control',
  timeout: 60_000,
}, async () => {
  const synthetic = [{ page: 1, blocks: [{ tag: 'paragraph', text: 'Synthetic schedule. The plan covers hospital stays. Nothing else is stated here.' }] }];
  const dispute = { field: 'co_payment', reason: 'conflicting', a: { value: '10%', page: 1, blockIndex: 0 }, b: { value: '20%', page: 1, blockIndex: 0 } };
  const result = await adjudicate({
    disputes: [dispute], pages: synthetic,
    grant: { granted: true, recipient: 'gemini', documentId: 'synthetic-negative-control' },
    call: createGeminiCaller({ apiKey: process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY, model: process.env.LLM_MODEL }),
  });
  assert.equal(result.calls, 1);
  assert.equal(result.results[0].accepted, false);
  assert.equal(result.results[0].value, null);
});
