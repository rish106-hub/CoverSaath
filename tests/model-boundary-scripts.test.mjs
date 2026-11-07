// ADR 0017 review fixes P1-1 and P1-2: no script or module sends document text to a model provider except through the
// model gateway. Static checks over the repository text; synthetic data only.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');

test('structure-policy.mjs reaches Gemini only through the structuring call factory', () => {
  const script = read('scripts/structure-policy.mjs');
  assert.match(script, /createStructuringModelCallFactory/);
  assert.doesNotMatch(script, /createGeminiCaller|field-adjudicator|generativelanguage|\bfetch\s*\(/);
  // The loose-payload call shape is gone: the factory call takes a sealed `input`.
  assert.doesNotMatch(script, /\bpayload\b/);
});

test('no module under src/ builds a direct provider request', () => {
  const walk = directory => readdirSync(new URL(directory, root), { withFileTypes: true }).flatMap(entry => (entry.isDirectory() ? walk(`${directory}${entry.name}/`) : [`${directory}${entry.name}`]));
  const offenders = walk('src/').filter(path => path.endsWith('.js') && !path.startsWith('src/integrations/'))
    .filter(path => /generativelanguage\.googleapis\.com|\bfetch\s*\(/.test(read(path)));
  assert.deepEqual(offenders, []);
});

test('the field adjudicator keeps its gate-free eval caller out of src/', async () => {
  const adjudicator = await import('../src/features/ai-analysis/field-adjudicator.js');
  assert.equal('createGeminiCaller' in adjudicator, false);
  const caller = await import('../scripts/lib/gemini-eval-caller.mjs');
  assert.equal(typeof caller.createGeminiEvalCaller, 'function');
  assert.match(read('scripts/lib/gemini-eval-caller.mjs'), /EVAL ONLY/);
});
