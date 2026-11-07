// ADR 0017 D6: the golden corpus. P1 zero leaks, P2 fail closed, P3 preservation, P4 gap ledger, P5 idempotence,
// P6 brand, P8 time. Synthetic data only; a failure prints the row id and variant, never a value.
import assert from 'node:assert/strict';
import test from 'node:test';
import { gateText, isGatedText } from '../src/features/ai-analysis/privacy-evidence-gate.js';
import { RESTRICTED_PATTERNS_PROBE } from './support/restricted-probe.mjs';
import { CATEGORY_COUNTS, CORPUS, KNOWN_GAP_CEILING } from './support/privacy-corpus.mjs';
import { verhoeffValid } from './support/corpus-rows.mjs';
import { leaks } from './support/leak-oracle.mjs';

const CATEGORIES = new Set(['aadhaar', 'pan', 'abha', 'phone', 'email', 'name_latin', 'name_devanagari', 'name_variant', 'member_table', 'dob_address', 'ocr_noise', 'restricted', 'preserve']);
const PLACEHOLDER = /<[A-Z]+(?:_[A-Z]+)*_[1-9]\d{0,5}>/;

function run(row) {
  const started = performance.now();
  try {
    return { output: gateText(row.input, { knownIdentifiers: row.knownIdentifiers }), ms: performance.now() - started };
  } catch (error) {
    return { error: error?.code ?? 'ERROR', ms: performance.now() - started };
  }
}
const label = row => `${row.id} ${row.variant}`;
const enforced = CORPUS.filter(row => row.status === 'enforced');
const gaps = CORPUS.filter(row => row.status === 'known_gap');

test('corpus meta: schema, unique ids, category counts, gap refs', () => {
  assert.equal(CORPUS.length, 340);
  assert.equal(new Set(CORPUS.map(row => row.id)).size, CORPUS.length);
  const counts = {};
  for (const row of CORPUS) {
    assert.ok(CATEGORIES.has(row.category), label(row));
    assert.ok(['redact', 'refuse', 'preserve'].includes(row.expect), label(row));
    assert.ok(['enforced', 'known_gap'].includes(row.status), label(row));
    assert.equal(row.status === 'known_gap', typeof row.gapRef === 'string' && row.gapRef.startsWith('GAP-'), label(row));
    assert.ok(typeof row.input === 'string' && row.input.length > 0, label(row));
    if (row.status === 'known_gap') assert.ok(row.note.length > 0, `${label(row)} needs a gap note`);
    if (row.expect === 'refuse') assert.ok(row.refuseCodes.length > 0, label(row));
    if (row.expect === 'redact') assert.ok(row.mustNotContain.length > 0 || row.note.length > 0, label(row));
    counts[row.id.split('-')[0]] = (counts[row.id.split('-')[0]] ?? 0) + 1;
  }
  assert.deepEqual(counts, CATEGORY_COUNTS);
});

test('corpus meta: generated values are synthetic (Verhoeff-invalid Aadhaar, reserved email domains, no raw secrets)', () => {
  for (const row of CORPUS.filter(candidate => candidate.category === 'aadhaar')) {
    for (const run of row.input.normalize('NFKC').replace(/[^\d]+/g, ' ').match(/\d{12}/g) ?? []) assert.equal(verhoeffValid(run), false, label(row));
    const compact = row.input.normalize('NFKC').replace(/[\s .\-·/]/g, '').match(/\d{12,16}/g) ?? [];
    for (const value of compact.filter(candidate => candidate.length === 12)) assert.equal(verhoeffValid(value), false, label(row));
  }
  for (const row of CORPUS) {
    for (const domain of row.input.match(/@([A-Za-z0-9.-]+\.[a-z]+)/g) ?? []) assert.match(domain, /@example\.(?:test|invalid)$/i, label(row));
    if (row.expect !== 'refuse') assert.equal(RESTRICTED_PATTERNS_PROBE(row.input), false, `${label(row)} must not look restricted`);
  }
});

test('P1/P2/P3: enforced rows redact with zero leaks, refuse closed, or preserve', () => {
  let preserved = 0;
  let preserveRows = 0;
  const failures = [];
  for (const row of enforced) {
    const { output, error } = run(row);
    if (row.expect === 'refuse') {
      if (!(error && row.refuseCodes.includes(error))) failures.push(`${label(row)}: not refused (${error ?? 'returned text'})`);
      continue;
    }
    if (error) { failures.push(`${label(row)}: threw ${error}`); continue; }
    if (row.expect === 'redact') {
      const count = leaks(output.text, row.mustNotContain);
      if (count > 0) failures.push(`${label(row)}: ${count} fragment(s) leaked`);
      if (!PLACEHOLDER.test(output.text)) failures.push(`${label(row)}: nothing was redacted`);
      for (const kept of row.mustContain) if (!output.text.includes(kept)) failures.push(`${label(row)}: wording was destroyed`);
    } else {
      preserveRows += 1;
      const same = row.mustContain.every(kept => output.text.includes(kept));
      if (same) preserved += 1;
      else if (row.critical) failures.push(`${label(row)}: critical wording was over-redacted`);
    }
  }
  assert.deepEqual(failures, []);
  assert.ok(preserved / preserveRows >= 0.95, `preserved ${preserved} of ${preserveRows}`);
});

test('P4: known gaps are todo tests, never silently handled, and the count only falls', async t => {
  assert.ok(gaps.length <= KNOWN_GAP_CEILING, `${gaps.length} known gaps exceed the ceiling of ${KNOWN_GAP_CEILING}`);
  const stale = [];
  for (const row of gaps) {
    const { output, error } = run(row);
    let handled;
    if (row.expect === 'refuse') handled = Boolean(error) && row.refuseCodes.includes(error);
    else if (error) handled = false;
    else if (row.expect === 'preserve') handled = row.mustContain.every(kept => output.text.includes(kept));
    else handled = leaks(output.text, row.mustNotContain) === 0 && PLACEHOLDER.test(output.text);
    // A gap the gate now handles must be promoted to enforced, so the ledger and the gate stay in step.
    if (handled) stale.push(label(row));
    await t.test(`${label(row)} [${row.gapRef}]`, { todo: row.gapRef }, () => { assert.ok(handled); });
  }
  assert.deepEqual(stale, [], 'promote these rows to enforced and lower KNOWN_GAP_CEILING');
  t.diagnostic(`known gaps: ${gaps.length} of ${KNOWN_GAP_CEILING}`);
});

test('P5/P6: output is idempotent under regate and every returned value is branded and frozen', () => {
  const failures = [];
  for (const row of enforced.filter(candidate => candidate.expect !== 'refuse')) {
    const { output, error } = run(row);
    if (error) continue;
    if (!isGatedText(output) || !Object.isFrozen(output)) failures.push(`${label(row)}: not branded`);
    const second = gateText(output.text, { knownIdentifiers: row.knownIdentifiers, regate: true });
    if (second.text !== output.text) failures.push(`${label(row)}: regate changed the text`);
  }
  assert.deepEqual(failures, []);
});

test('P8: the corpus runs within its time budget', () => {
  // Only the total is gated: a per-row wall-clock bound fails on a loaded CI machine for reasons unrelated to the change.
  const started = performance.now();
  for (const row of CORPUS) run(row);
  const total = performance.now() - started;
  assert.ok(total < 10_000, `corpus took ${Math.round(total)}ms (rerun in isolation before blaming a change; timing under a loaded run is noisy)`);
});

test('Verhoeff-valid Aadhaar shapes are redacted too (the gate must not rely on the checksum)', () => {
  // Generated at runtime, never printed or stored.
  let checked = 0;
  for (let seed = 1; seed < 400 && checked < 6; seed += 1) {
    const base = `${2 + (seed % 8)}${String(10_000_000_000 + seed * 7_919_317).slice(1, 11)}`;
    const candidate = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(last => `${base}${last}`).find(value => verhoeffValid(value));
    if (!candidate || !/^[2-9]\d{11}$/.test(candidate) || new Set(candidate.match(/.{4}/g)).size < 3) continue;
    const out = gateText(`Aadhaar ${candidate.match(/.{4}/g).join(' ')}`, { knownIdentifiers: [] }).text;
    assert.equal(leaks(out, candidate.match(/.{4}/g)), 0);
    checked += 1;
  }
  assert.equal(checked, 6);
});
