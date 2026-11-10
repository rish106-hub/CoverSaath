import { normalizeUin } from './uin.js';

// Deterministic identifier extraction from REDACTED policy text. Pure: no model, no network.
// The text is untrusted data. Nothing in it is ever followed as an instruction; values are only compared, never executed
// or echoed into reasons. Callers must pass text whose personal data was already removed (src/features/input redaction).
//
// Result: { insurerName, planName, uin, formNumber, uinCandidates, malformedUinCount }. Each identifier is null or
// { value, confidence (0..1), span: { start, end } } with offsets into the text passed in. `uin` is set only when the text
// holds exactly one distinct valid UIN; several distinct ones leave it null and list them in `uinCandidates`.

const MAX_TEXT = 1_000_000;
const MAX_VALUE = 120;
const CONTROL = /[\u0000-\u001F\u007F​-‏⁠﻿]/g;

// Labelled UIN: "UIN" (OCR: U1N, UlN) then optional "No./Number", then up to 5 short tokens joined by space or dash.
const LABELLED_UIN = /\bU[I1l]N(?:\s*(?:No\.?|Number|Code))?\s*[:\-#]?\s*([A-Za-z0-9|][A-Za-z0-9|​⁠﻿\- ]{14,40})/gid;
const BARE_UIN = /\b[A-Za-z0-9|]{12}[Vv][A-Za-z0-9|]{6}\b/gd;

const INSURER_LABEL = /\b(?:Name of (?:the )?Insurer|Insurance Company|Insurer|Issued by|Underwritten by)\s*[:\-]\s*([^\n\r;|]{3,120})/gid;
const PLAN_LABEL = /\b(?:Name of (?:the )?(?:Product|Plan)|Product Name|Plan Name|Policy Name|Product|Plan)\s*[:\-]\s*([^\n\r;|]{3,120})/gid;
const FORM_LABEL = /\b(?:Form\s*(?:No\.?|Number)|Proposal Form\s*(?:No\.?|Number))\s*[:\-#]?\s*([A-Za-z0-9][A-Za-z0-9/.\- ]{2,40})/gid;

const clean = value => value.replace(CONTROL, '').replace(/\s+/g, ' ').trim();

function labelled(text, pattern, { confidence, maxTokens = null }) {
  pattern.lastIndex = 0;
  const match = pattern.exec(text);
  if (!match) return null;
  let [start, end] = match.indices[1];
  let value = clean(text.slice(start, end));
  if (maxTokens) {
    // Form numbers are short codes: keep the first tokens only, so trailing prose is not swallowed.
    value = value.split(' ').slice(0, maxTokens).join(' ');
    end = start + text.slice(start, end).indexOf(value) + value.length;
  }
  if (value.length < 3 || value.length > MAX_VALUE) return null;
  return { value, confidence, span: { start, end } };
}

function findUins(text) {
  const found = new Map();
  let malformed = 0;
  const add = (uin, repaired, labelledForm, start, end) => {
    const confidence = labelledForm ? (repaired ? 0.8 : 0.95) : (repaired ? 0.6 : 0.8);
    const existing = found.get(uin);
    if (!existing || existing.confidence < confidence) found.set(uin, { value: uin, confidence, span: { start, end } });
  };
  LABELLED_UIN.lastIndex = 0;
  for (const match of text.matchAll(LABELLED_UIN)) {
    const [groupStart, groupEnd] = match.indices[1];
    const group = text.slice(groupStart, groupEnd);
    // Try growing prefixes of the token group; the shortest that normalises wins, so trailing words are ignored.
    const tokens = [...group.matchAll(/[^ \-]+/g)];
    let accepted = false;
    for (let k = 1; k <= Math.min(5, tokens.length) && !accepted; k += 1) {
      const last = tokens[k - 1];
      const slice = group.slice(tokens[0].index, last.index + last[0].length);
      const result = normalizeUin(slice);
      if (result.ok) {
        add(result.uin, result.repaired, true, groupStart + tokens[0].index, groupStart + last.index + last[0].length);
        accepted = true;
      }
    }
    if (!accepted) malformed += 1;
  }
  for (const match of text.matchAll(BARE_UIN)) {
    const result = normalizeUin(match[0]);
    if (result.ok) add(result.uin, result.repaired, false, match.index, match.index + match[0].length);
  }
  return { found: [...found.values()].sort((a, b) => a.span.start - b.span.start), malformed };
}

/** Extracts insurer, plan name, UIN and form number from redacted text. Never throws on odd input; non-strings yield nulls. */
export function extractIdentifiers(redactedText) {
  const empty = { insurerName: null, planName: null, uin: null, formNumber: null, uinCandidates: [], malformedUinCount: 0 };
  if (typeof redactedText !== 'string' || redactedText.length === 0) return empty;
  const text = redactedText.length > MAX_TEXT ? redactedText.slice(0, MAX_TEXT) : redactedText;
  const { found, malformed } = findUins(text);
  return {
    insurerName: labelled(text, INSURER_LABEL, { confidence: 0.7 }),
    planName: labelled(text, PLAN_LABEL, { confidence: 0.7 }),
    uin: found.length === 1 ? found[0] : null,
    formNumber: labelled(text, FORM_LABEL, { confidence: 0.7, maxTokens: 3 }),
    uinCandidates: found,
    malformedUinCount: malformed,
  };
}
