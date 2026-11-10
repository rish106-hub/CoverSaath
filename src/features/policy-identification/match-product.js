import { normalizeUin } from './uin.js';

// Deterministic product matching against reference-cache style candidates (parseProduct output from
// src/integrations/insurance-data/schemas.js, plus optional insurerName / insurerAliases the caller joined in):
//   { productId, insurerId, productName, uinRaw, insurerName?, insurerAliases? }
//
// A MATCH NEVER AUTHORISES ANYTHING. The result is a proposal. The user must confirm "Is this X by Y?" before any lookup
// or fact is attached to their case, and reference data stays context only (it never overwrites what the document says).
// Every result therefore carries requiresUserConfirmation: true and authorises: 'nothing'. Reasons are fixed strings: they
// never echo text from the document.
//
// Outcomes:
//   exact_uin_match   one candidate has the document's UIN and no extracted name contradicts it (proposal to confirm)
//   uin_unknown       a valid UIN, no candidate holds it, and no name candidate either
//   uin_name_mismatch the UIN points at a product whose name/insurer disagrees with the document, or the UIN is unknown
//                     but the names match a product with a different (or no recorded) UIN
//   no_uin            no valid UIN in the document; candidates come from the name only
//   ambiguous         several distinct UINs in the document, several candidates with the UIN, or tied name matches
//   no_match          no valid UIN and nothing in the names to go on

export const MATCH_OUTCOMES = Object.freeze(['exact_uin_match', 'uin_unknown', 'uin_name_mismatch', 'no_uin', 'ambiguous', 'no_match']);
export const MAX_CANDIDATES = 5;

const NOISE = new Set(['the', 'of', 'and', 'ltd', 'limited', 'pvt', 'private', 'co', 'company', 'insurance', 'general', 'plan', 'policy']);
const PLAN_MIN = 0.6;
const AGREE_MIN = 0.5;

const tokens = value => {
  if (typeof value !== 'string') return new Set();
  const list = value.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(t => t && !NOISE.has(t));
  return new Set(list);
};

function similarity(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  const jaccard = shared / (a.size + b.size - shared);
  // One name wholly inside the other ("Optima Secure" vs "Optima Secure Plus") still agrees, a little weaker.
  return shared === Math.min(a.size, b.size) ? Math.max(jaccard, 0.75) : jaccard;
}

const insurerScore = (name, candidate) => {
  const wanted = tokens(name);
  const names = [candidate.insurerName, ...(Array.isArray(candidate.insurerAliases) ? candidate.insurerAliases : [])];
  return Math.max(0, ...names.map(n => similarity(wanted, tokens(n))));
};

const view = (candidate, matchedOn, score) => Object.freeze({
  productId: candidate.productId,
  insurerId: typeof candidate.insurerId === 'string' ? candidate.insurerId : null,
  productName: candidate.productName ?? null,
  insurerName: typeof candidate.insurerName === 'string' ? candidate.insurerName : null,
  uinRaw: typeof candidate.uinRaw === 'string' ? candidate.uinRaw : null,
  matchedOn,
  score: Math.round(score * 100) / 100,
});

const result = (outcome, reason, candidates = []) => Object.freeze({
  outcome,
  reason,
  candidates: Object.freeze(candidates.slice(0, MAX_CANDIDATES)),
  requiresUserConfirmation: true,
  authorises: 'nothing',
});

function uinOf(candidate) {
  const normalized = normalizeUin(candidate.uinRaw);
  return normalized.ok ? normalized.uin : null;
}

/** Names the document gives that contradict the candidate. Absent names never contradict. */
function namesContradict(identifiers, candidate) {
  const plan = identifiers.planName?.value;
  if (plan && candidate.productName && similarity(tokens(plan), tokens(candidate.productName)) < AGREE_MIN) return true;
  const insurer = identifiers.insurerName?.value;
  const hasInsurer = typeof candidate.insurerName === 'string' || (Array.isArray(candidate.insurerAliases) && candidate.insurerAliases.length > 0);
  if (insurer && hasInsurer && insurerScore(insurer, candidate) < AGREE_MIN) return true;
  return false;
}

function nameCandidates(identifiers, candidates) {
  const plan = identifiers.planName?.value;
  if (!plan) return [];
  const wanted = tokens(plan);
  const scored = [];
  for (const candidate of candidates) {
    const planScore = similarity(wanted, tokens(candidate.productName));
    if (planScore < PLAN_MIN) continue;
    const insurer = identifiers.insurerName?.value;
    const hasInsurer = typeof candidate.insurerName === 'string' || (Array.isArray(candidate.insurerAliases) && candidate.insurerAliases.length > 0);
    if (insurer && hasInsurer && insurerScore(insurer, candidate) < AGREE_MIN) continue;
    scored.push({ candidate, score: planScore });
  }
  scored.sort((a, b) => b.score - a.score || String(a.candidate.productId).localeCompare(String(b.candidate.productId)));
  return scored.map(({ candidate, score }) => view(candidate, 'name', score));
}

/**
 * Proposes a reference product for extracted identifiers. Pure; never throws on odd input. See the header for outcomes.
 * `identifiers` is extractIdentifiers output; `candidates` is an array of reference-cache style products.
 */
export function matchProduct(identifiers, candidates) {
  const ids = identifiers && typeof identifiers === 'object' ? identifiers : {};
  const pool = (Array.isArray(candidates) ? candidates : []).filter(c => c && typeof c === 'object' && typeof c.productId === 'string' && c.productId);
  const distinctUins = Array.isArray(ids.uinCandidates) ? ids.uinCandidates.length : (ids.uin ? 1 : 0);

  if (distinctUins > 1) {
    const listed = pool.filter(c => (ids.uinCandidates ?? []).some(u => u.value === uinOf(c))).map(c => view(c, 'uin', 1));
    return result('ambiguous', 'The document shows more than one UIN.', listed);
  }

  const uin = ids.uin?.value ?? null;
  const byName = nameCandidates(ids, pool);

  if (uin) {
    const holders = pool.filter(c => uinOf(c) === uin);
    if (holders.length > 1) return result('ambiguous', 'More than one reference product carries this UIN.', holders.map(c => view(c, 'uin', 1)));
    if (holders.length === 1) {
      const [holder] = holders;
      if (namesContradict(ids, holder)) {
        return result('uin_name_mismatch', 'The UIN belongs to a product whose name or insurer differs from the document.', [view(holder, 'uin', 1)]);
      }
      return result('exact_uin_match', 'The UIN matches one reference product. Ask the user to confirm it.', [view(holder, 'uin', 1)]);
    }
    if (byName.length > 0) return result('uin_name_mismatch', 'The UIN is not in the reference data but the name matches products with another UIN.', byName);
    return result('uin_unknown', 'The UIN is valid in shape but not in the reference data.');
  }

  const malformed = Number(ids.malformedUinCount) > 0;
  if (byName.length === 0) {
    return result('no_match', malformed ? 'The UIN in the document is malformed and no name matches.' : 'No UIN and no name to match on.');
  }
  if (byName.length > 1 && byName[0].score === byName[1].score) {
    return result('ambiguous', 'Several products match the name equally well.', byName);
  }
  return result('no_uin', malformed ? 'The UIN in the document is malformed; these products match the name.' : 'No UIN in the document; these products match the name.', byName);
}
