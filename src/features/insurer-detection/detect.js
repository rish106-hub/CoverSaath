// Insurer and plan detection (S-A3). A pure, local function: it matches the text of the first pages of an uploaded document
// against the public registry names. The text never leaves the backend (no provider, no network, nothing stored). It returns at
// most three candidates, best first, shaped { candidateId, insurerName, productName, rank }. The UIN of a candidate is never part
// of a result: the registry rows may carry it (it is used to prefer a product whose printed UIN appears in the text), but the
// caller resolves it server-side from the registry after the owner confirms a candidate.
// The result is a suggestion for the owner to confirm, never a decision.
import { extractUins } from '../decision-catalogue/index.js';

export const MAX_CANDIDATES = 3;
export const DETECTION_PAGES = 3;
const MAX_TEXT_CHARS = 60_000;
const MIN_SCORE = 0.5;
const INSURER_WEIGHT = 0.35;
const PRODUCT_WEIGHT = 0.65;

// Words that name a kind of company or product rather than one of them; they never decide a match on their own.
const GENERIC = new Set(['insurance', 'general', 'health', 'life', 'limited', 'ltd', 'co', 'company', 'corporation', 'of', 'india', 'the', 'and', 'plan', 'policy', 'plus', 'private', 'pvt']);

export const normalise = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
const tokensOf = value => normalise(value).split(' ').filter(Boolean);

// Optimal string alignment distance (an adjacent swap counts as one edit), abandoned early once it exceeds `max`.
function editDistanceAtMost(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let beforePrevious = null;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      let value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (beforePrevious && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) value = Math.min(value, beforePrevious[j - 2] + 1);
      current[j] = value;
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > max) return max + 1;
    beforePrevious = previous;
    previous = current;
  }
  return previous[b.length];
}

// A name token is present when the text holds it exactly, or (for tokens of five letters or more) within one edit: OCR often
// drops or swaps a letter.
function tokenPresent(token, textTokens, textSet) {
  if (textSet.has(token)) return true;
  if (token.length < 5) return false;
  return textTokens.some(candidate => Math.abs(candidate.length - token.length) <= 1 && editDistanceAtMost(token, candidate, 1) <= 1);
}

/** 0..1: how well one registry name is found in the text. 1 for the whole phrase, else the weighted share of its distinctive tokens. */
export function nameScore(name, normalisedText, textTokens, textSet) {
  const phrase = normalise(name);
  if (!phrase) return 0;
  if (` ${normalisedText} `.includes(` ${phrase} `)) return 1;
  const tokens = phrase.split(' ');
  const distinctive = tokens.filter(token => !GENERIC.has(token));
  const scored = distinctive.length > 0 ? distinctive : tokens;
  // Count the extra distinctive tokens of a longer name more: "shield" alone must not match "Acme Shield Plus Gold" as well as
  // the full name does.
  const found = scored.filter(token => tokenPresent(token, textTokens, textSet)).length;
  const share = found / scored.length;
  return share === 1 ? 0.9 : share >= 0.75 ? share * 0.8 : share >= 0.5 ? share * 0.5 : 0;
}

/**
 * @param text      the text of pages 1 to 3 (the caller limits the pages)
 * @param registry  { insurers: [{ id, canonicalName, aliases }], products: [{ productId, insurerId, productName, uinRaw }] }
 * @returns up to three { candidateId, insurerName, productName, rank }
 */
export function detectInsurerCandidates({ text, registry }) {
  const bounded = String(text ?? '').slice(0, MAX_TEXT_CHARS);
  if (!bounded.trim() || !registry?.products?.length) return [];
  const normalisedText = normalise(bounded);
  const textTokens = [...new Set(normalisedText.split(' '))];
  const textSet = new Set(textTokens);
  const printedUins = new Set(extractUins(bounded));
  const insurers = new Map((registry.insurers ?? []).map(insurer => [insurer.id, insurer]));
  const insurerScores = new Map();
  const scoreInsurer = insurerId => {
    if (!insurerScores.has(insurerId)) {
      const insurer = insurers.get(insurerId);
      const names = insurer ? [insurer.canonicalName, ...(insurer.aliases ?? [])] : [];
      insurerScores.set(insurerId, Math.max(0, ...names.map(name => nameScore(name, normalisedText, textTokens, textSet))));
    }
    return insurerScores.get(insurerId);
  };
  const scored = [];
  for (const product of registry.products) {
    const insurer = insurers.get(product.insurerId);
    if (!insurer) continue;
    const uinMatch = typeof product.uinRaw === 'string' && printedUins.has(product.uinRaw.toUpperCase().replace(/[^A-Z0-9]/g, ''));
    const combined = INSURER_WEIGHT * scoreInsurer(product.insurerId) + PRODUCT_WEIGHT * nameScore(product.productName, normalisedText, textTokens, textSet);
    const score = uinMatch ? Math.max(combined, 1) : combined;
    if (score >= MIN_SCORE) scored.push({ score, product, insurer });
  }
  scored.sort((a, b) => b.score - a.score || a.product.productName.length - b.product.productName.length || (a.product.productId < b.product.productId ? -1 : 1));
  return scored.slice(0, MAX_CANDIDATES).map(({ product, insurer }, index) => Object.freeze({
    candidateId: product.productId, insurerName: insurer.canonicalName, productName: product.productName, rank: index + 1,
  }));
}
