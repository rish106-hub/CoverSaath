// Spelled-out email addresses must not reach storage or the model. Synthetic values only. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeEvidenceForModel, sanitizeEvidenceTextForStorage } from '../src/features/ai-analysis/privacy-evidence-gate.js';

const policy = () => ({ dataClass: 'CONFIDENTIAL', modelExtraction: true, registryVersion: 'policy-parameters/v1' });
const toModel = text => JSON.stringify(sanitizeEvidenceForModel({
  context: { caseId: 'case-1', subjectId: 'subject-1', purpose: 'Extract requested policy facts.', requestedFields: ['d.room_rent_limit'] },
  sources: [{ id: 'page-1', version: 'v1', page: 1, text, status: 'known' }], upstream: [],
}, { resolveParameterPolicy: policy }));

for (const text of ['rahulsharma (at) example (dot) com', 'rahulsharma [at] example.com', 'contact rahulsharma{at}example{dot}co{dot}in today']) {
  test(`obfuscated email is removed: ${text}`, () => {
    assert.ok(!sanitizeEvidenceTextForStorage(text, { knownIdentifiers: [] }).text.toLowerCase().includes('rahulsharma'));
    assert.ok(!toModel(text).toLowerCase().includes('rahulsharma'));
  });
}
test('policy wording with "at" in prose stays', () => {
  const text = 'Room rent is paid at actuals (at the insurer discretion) for a single private room';
  assert.equal(sanitizeEvidenceTextForStorage(text, { knownIdentifiers: [] }).text, text);
});
