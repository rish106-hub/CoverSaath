// Typed equality for fact values (ADR 0023 D3: "equality uses a typed normaliser"). Pure: no I/O, never throws.
//
// equalityKey(valueType, value) is the string that decides whether two values of one fact are the same. It builds on comparable()
// of normalisers.js so a fact read from a PDF and the same fact from the insurer wording meet on one form:
//   money      minor units (paise)                 date       ISO date
//   date_range ISO start/end                       duration   days (the printed unit does not matter: 36 months = 3 years)
//   percent    basis points                        number     the integer
//   enum       the exact closed value              bool       true | false
//   text       NFC, whitespace collapsed, trimmed, case-folded
// A value that does not fit its type has no key (null) and is never equal to anything, including another null.

import { comparable } from './normalisers.js';

const KIND_OF = Object.freeze({
  money: 'money', date: 'date', date_range: 'date_range', duration: 'duration', percent: 'percent', number: 'number',
});

const foldText = text => text.normalize('NFC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-IN');

export function equalityKey(valueType, value) {
  if (!value || typeof value !== 'object') return null;
  try {
    if (Object.hasOwn(KIND_OF, valueType)) {
      const key = comparable(KIND_OF[valueType], value);
      return typeof key === 'string' && key !== '' && !key.includes('undefined') ? `${valueType}:${key}` : null;
    }
    if (valueType === 'enum') return typeof value.value === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(value.value) ? `enum:${value.value}` : null;
    if (valueType === 'bool') return typeof value.value === 'boolean' ? `bool:${value.value}` : null;
    if (valueType === 'text') {
      if (typeof value.text !== 'string') return null;
      const folded = foldText(value.text);
      return folded ? `text:${folded}` : null;
    }
  } catch {
    return null;
  }
  return null;
}

/** True only when both values have a key and the keys match. */
export function sameFactValue(valueType, left, right) {
  const a = equalityKey(valueType, left);
  return a !== null && a === equalityKey(valueType, right);
}
