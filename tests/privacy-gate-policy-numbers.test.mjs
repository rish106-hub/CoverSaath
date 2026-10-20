import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeEvidenceTextForStorage } from './support/storage-gate.mjs';

// Synthetic Luhn-valid numbers generated here; no real identifier.
function withLuhn(body) {
  for (let check = 0; check < 10; check += 1) {
    const digits = `${body}${check}`;
    let sum = 0;
    [...digits].reverse().forEach((ch, i) => { let n = Number(ch); if (i % 2) { n *= 2; if (n > 9) n -= 9; } sum += n; });
    if (sum % 10 === 0) return digits;
  }
  throw new Error('unreachable');
}
const policy19 = withLuhn('351234567890123456');
const visa16 = withLuhn('411111111111111');

test('S1: a labelled 19-digit policy number is minimised, not rejected', () => {
  const out = sanitizeEvidenceTextForStorage(`Policy Number: ${policy19} issued`);
  assert.doesNotMatch(out.text, /\d{8}/);
});

test('S1: an unlabelled 19-digit Luhn run without a card shape is minimised', () => {
  const out = sanitizeEvidenceTextForStorage(`Reference ${withLuhn('812345678901234567')} noted`);
  assert.doesNotMatch(out.text, /\d{8}/);
});

test('S1: an identifier-labelled network-shaped number is minimised', () => {
  const out = sanitizeEvidenceTextForStorage(`Certificate No ${visa16} here`);
  assert.doesNotMatch(out.text, /\d{8}/);
});

test('S1: card-labelled numbers are still rejected', () => {
  assert.throws(() => sanitizeEvidenceTextForStorage(`Credit card number ${visa16}`), { code: 'RESTRICTED_EVIDENCE' });
  assert.throws(() => sanitizeEvidenceTextForStorage(`card ${policy19}`), { code: 'RESTRICTED_EVIDENCE' });
  assert.throws(() => sanitizeEvidenceTextForStorage(`Card no: 4111 1111 1111 1111`), { code: 'RESTRICTED_EVIDENCE' });
  assert.throws(() => sanitizeEvidenceTextForStorage(`note ${visa16} end`), { code: 'RESTRICTED_EVIDENCE' });
});
