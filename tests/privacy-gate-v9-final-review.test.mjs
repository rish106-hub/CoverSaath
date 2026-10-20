// Privacy gate v9 final review: truncated pages, natural-language credentials and PINs, singular name lists, split known names.
// Every value is synthetic. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeEvidenceTextForStorage } from '../src/features/ai-analysis/privacy-evidence-gate.js';
import { createCoverageAnalysisSourceInput } from '../src/features/coverage-analysis/source-input.js';

const storage = (text, knownIdentifiers = []) => sanitizeEvidenceTextForStorage(text, { knownIdentifiers }).text;
const restricted = error => error?.code === 'RESTRICTED_EVIDENCE';

for (const text of [
  'my pin: 4821', 'Is my PIN 4821 covered', 'Pin number is 4821', 'the password is hunter22', 'pass: hunter22',
  'username kavya01 password hunter22', 'client secret abcdef123456', 'secret key abcdef123456',
  'sk_live_abcdefghijklmnop1234', 'AKIAIOSHFODNN7EXAMPLE',
]) test(`credential or PIN in prose is refused: ${text}`, () => assert.throws(() => storage(text), restricted));

test('postal PIN codes and ordinary password wording stay', () => {
  assert.doesNotThrow(() => storage('PIN code 560001'));
  assert.equal(storage('Password protected documents are not accepted'), 'Password protected documents are not accepted');
});

for (const text of ['Insured: Ravi Synthetic, Asha Example', 'Nominee: Ravi Synthetic, Asha Example', 'Patient names: Ravi Synthetic, Asha Example', 'Proposer: Ravi Synthetic & Asha Example', 'Name of Insured: Ravi Synthetic, Asha Example']) {
  test(`every name in a list is masked: ${text}`, () => {
    const out = storage(text);
    assert.ok(!out.includes('Ravi') && !out.includes('Asha'), out);
  });
}

test('a known name split by a format character is still masked', () => {
  const out = storage('Insured Kavya​Placeholder is covered', [{ kind: 'NAME', value: 'Kavya Placeholder' }]);
  assert.ok(!out.includes('Kavya') && !out.includes('Placeholder'), out);
});

test('a truncated page is excluded, never sent with a cut identifier', () => {
  const filler = 'General terms apply here. '.repeat(700);
  const page = { id: 'p1', document_upload_id: 'doc-1', page_number: 1, source_version: '1', extracted_text: `${filler} Room rent limit 5000 card 4111 1111 1111 1111` };
  assert.throws(() => createCoverageAnalysisSourceInput({ id: 'case-1', household_id: 'h-1' }, [page], { knownIdentifiers: [] }), error => error.code === 'SOURCE_PACK_REQUIRED');
});

test('re-review: ordinary password wording and postal PIN code phrasing are not refused; bare pwd value is', () => {
  for (const text of ['Password is required', 'Password is case-sensitive', 'Your PIN code is 560001']) assert.doesNotThrow(() => storage(text), text);
  assert.throws(() => storage('pwd hunter22'), restricted);
  assert.throws(() => storage('the password is hunter22'), restricted);
});
