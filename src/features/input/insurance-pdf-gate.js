// Fast deterministic "is this an insurance document" check on the text layer of the first pages (ADR 0035).
// Pure scoring plus `assessInsurancePdf`, which runs only inside the restricted child (insurance-pdf-gate-child.mjs).
// A scanned PDF (no text layer) or one whose text cannot be decoded is NOT judged here: OCR-time classification stays.
import { extractPdfPageTexts } from './pdf-text-extraction.js';

export const INSURANCE_GATE_PAGES = 3;
export const INSURANCE_GATE_THRESHOLD = 3;
export const INSURANCE_GATE_MIN_CHARS = 40;

const SIGNALS = Object.freeze([
  /\bpolic(?:y|ies)\b/i, /\binsured\b/i, /\bsum\s+insured\b/i, /\bpremium\b/i, /\birdai?\b/i, /\binsurer\b/i,
  /\bcover(?:age|ed)?\b/i, /\bschedule\b/i, /\bwording\b/i, /\bclaims?\b/i, /\bexclusions?\b/i,
  /\bwaiting\s+period\b/i, /\binsurance\b/i,
]);
const UIN = /[A-Z]{3,5}[A-Z]{2}\w{6,}V\d{6}/;
const UIN_WEIGHT = 3;

/** Distinct signal count; a UIN-shaped token counts as three. */
export function scoreInsuranceText(text) {
  let score = 0;
  for (const pattern of SIGNALS) if (pattern.test(text)) score += 1;
  if (UIN.test(text)) score += UIN_WEIGHT;
  return score;
}

/** @returns {'insurance'|'not_insurance'|'undetermined'} */
export function classifyInsuranceText(text, threshold = INSURANCE_GATE_THRESHOLD) {
  if (text.replace(/\s+/g, '').length < INSURANCE_GATE_MIN_CHARS) return 'undetermined';
  return scoreInsuranceText(text) >= threshold ? 'insurance' : 'not_insurance';
}

export async function assessInsurancePdf(bytes) {
  const extracted = await extractPdfPageTexts(bytes, { firstPages: INSURANCE_GATE_PAGES });
  const text = extracted.pages.filter(page => page.status === 'established').map(page => page.text).join('\n');
  return { verdict: classifyInsuranceText(text) };
}
