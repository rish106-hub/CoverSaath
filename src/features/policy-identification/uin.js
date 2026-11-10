// Deterministic IRDAI UIN handling. Pure: no model, no network, no I/O.
// Supported shape (current IRDAI scheme): insurer code (3 letters) + line code (3 letters) + product letter (1) +
// serial (5 digits) + "V" + version (2 digits) + financial-year code (4 digits), 19 characters.
// Example (synthetic shape check): HDFHLIP26058V082526. Older UIN schemes are NOT guessed at: they are reported malformed.

const ZERO_WIDTH = /[​-‏⁠﻿­]/g;
const SEPARATORS = /[\s\-‐-―−._/]+/g;
const STRICT = /^([A-Z]{3})([A-Z]{3})([A-Z])(\d{5})V(\d{2})(\d{4})$/;
const UIN_LENGTH = 19;
// Slot kinds by position: L = letter, D = digit, V = the literal marker.
const SLOTS = 'LLLLLLLDDDDDVDDDDDD';

// OCR repair only inside slots where one kind is certain. Letters O/I/l read as digits only in digit slots; the digit 0
// reads as the letter O only in letter slots. Anything else stays as read and fails strict validation.
const TO_DIGIT = { O: '0', o: '0', I: '1', i: '1', l: '1', '|': '1' };
const TO_LETTER = { 0: 'O' };

/**
 * Normalises raw text to a UIN. Returns { ok: true, uin, parts, repaired } or { ok: false, reason }.
 * `repaired` is true when an OCR-noise character was corrected; callers lower their confidence then.
 * Reasons: not_a_string, empty, wrong_length, bad_shape.
 */
export function normalizeUin(raw) {
  if (typeof raw !== 'string') return { ok: false, reason: 'not_a_string' };
  const cleaned = raw.normalize('NFKC').replace(ZERO_WIDTH, '').replace(SEPARATORS, '');
  if (cleaned.length === 0) return { ok: false, reason: 'empty' };
  if (cleaned.length !== UIN_LENGTH) return { ok: false, reason: 'wrong_length' };
  let repaired = false;
  let out = '';
  for (let i = 0; i < UIN_LENGTH; i += 1) {
    let ch = cleaned[i];
    if (SLOTS[i] === 'D' && Object.hasOwn(TO_DIGIT, ch)) { ch = TO_DIGIT[ch]; repaired = true; }
    else if (SLOTS[i] === 'L' && Object.hasOwn(TO_LETTER, ch)) { ch = TO_LETTER[ch]; repaired = true; }
    out += ch;
  }
  out = out.toUpperCase();
  const match = STRICT.exec(out);
  if (!match) return { ok: false, reason: 'bad_shape' };
  return {
    ok: true,
    uin: out,
    repaired,
    parts: Object.freeze({ insurerCode: match[1], lineCode: match[2], productLetter: match[3], serial: match[4], version: match[5], financialYear: match[6] }),
  };
}
