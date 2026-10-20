// Curated insurer-product records, keyed by printed UIN and wording version. Entered by hand from the insurer's own
// published wording, checked by a second person, and loaded with no network call. A record informs: it can raise a
// discrepancy against a household's document but can never replace or override that household's contract. An absent
// record means unknown, never "no such term".
import { createHash } from 'node:crypto';
import { RULES } from './rules.js';
import { deepFreeze, digestOf, isIsoDate, isRecord, text } from './contracts.js';

const UIN = /^[A-Z0-9]{12,24}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const PRINTED_UIN = /\bUIN\b\s*[:.\-#]*\s*([A-Za-z0-9]{12,24})\b/gi;
// Product-level terms only. Household-specific facts (sum insured, enrolment, policy period, continuity, network) are never curated.
const PRODUCT_FACT_TYPES = ['room_rent_limit', 'icu_limit', 'copay', 'deductible', 'sublimit', 'waiting_period', 'exclusion', 'restoration', 'bonus'];
const RULE_BY_TYPE = new Map(RULES.filter(rule => PRODUCT_FACT_TYPES.includes(rule.factType)).map(rule => [rule.factType, rule]));
const STALE_AFTER_DAYS = 400;

/** Distinct UINs printed in a text. A candidate needs a digit and a letter, so a bare number is not one. */
export function extractUins(value) {
  const found = new Set();
  for (const match of String(value ?? '').matchAll(PRINTED_UIN)) {
    const uin = match[1].toUpperCase();
    if (/\d/.test(uin) && /[A-Z]/.test(uin)) found.add(uin);
  }
  return [...found];
}

const httpsUrl = value => {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && String(value).length <= 500; } catch { return false; }
};

/**
 * Strict shape check. `verified` is derived, never taken from the record: it needs a curator and a different checker.
 * Returns { valid, errors } or { valid, freshness, verified, product }.
 */
export function validateCuratedProduct(record, { today }) {
  if (!isIsoDate(today)) throw new TypeError('today must be an ISO date.');
  const r = isRecord(record) ? record : {};
  const errors = [];
  if (typeof r.uin !== 'string' || !UIN.test(r.uin) || !/\d/.test(r.uin) || !/[A-Z]/.test(r.uin)) errors.push('uin');
  for (const field of ['insurer', 'productName', 'wordingVersion', 'curatedBy', 'checkedBy']) if (!text(r[field], 200)) errors.push(field);
  if (text(r.curatedBy, 200) && text(r.curatedBy, 200) === text(r.checkedBy, 200)) errors.push('checkedBy_must_differ_from_curatedBy');
  if (!httpsUrl(r.sourceUrl)) errors.push('sourceUrl');
  if (typeof r.contentSha256 !== 'string' || !SHA256.test(r.contentSha256)) errors.push('contentSha256');
  if (!isIsoDate(r.retrievedOn) || r.retrievedOn > today) errors.push('retrievedOn');
  if (!isIsoDate(r.checkedOn) || r.checkedOn > today || (isIsoDate(r.retrievedOn) && r.checkedOn < r.retrievedOn)) errors.push('checkedOn');
  if (r.effectiveFrom != null && !isIsoDate(r.effectiveFrom)) errors.push('effectiveFrom');
  if (!Array.isArray(r.facts) || r.facts.length < 1 || r.facts.length > 100) errors.push('facts');
  else r.facts.forEach((fact, i) => {
    const f = isRecord(fact) ? fact : {};
    const quote = text(f.quote, 600);
    if (!RULE_BY_TYPE.has(f.factType) || !text(f.topic ?? 'general', 120) || !isRecord(f.value) || !RULE_BY_TYPE.get(f.factType).valid(f.value)
      || !Number.isSafeInteger(f.page) || f.page < 1 || !quote || quote.length < 8) errors.push(`facts[${i}]`);
  });
  if (errors.length) return deepFreeze({ valid: false, errors });
  const age = Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${r.retrievedOn}T00:00:00Z`)) / 86_400_000);
  const freshness = r.supersededBy ? 'superseded' : r.effectiveFrom && r.effectiveFrom > today ? 'not_yet_effective' : age > STALE_AFTER_DAYS ? 'stale' : 'current';
  return deepFreeze({
    valid: true, freshness, verified: true, mayOverrideContract: false,
    product: {
      uin: r.uin, insurer: r.insurer, productName: r.productName, wordingVersion: r.wordingVersion, sourceUrl: r.sourceUrl,
      contentSha256: r.contentSha256, retrievedOn: r.retrievedOn, checkedOn: r.checkedOn, effectiveFrom: r.effectiveFrom ?? null,
      curatedBy: r.curatedBy, checkedBy: r.checkedBy,
      facts: r.facts.map(f => ({ factType: f.factType, topic: f.topic ?? 'general', value: f.value, page: f.page, quote: f.quote })),
    },
  });
}

/** Fails closed: one bad or duplicate record stops the load. No record is silently skipped. */
export function loadCuratedProducts(records, { today }) {
  const seen = new Set();
  return deepFreeze((records ?? []).map((record, index) => {
    const checked = validateCuratedProduct(record, { today });
    if (!checked.valid) throw new TypeError(`Curated product ${index} is invalid: ${checked.errors.join(', ')}`);
    const key = `${checked.product.uin}/${checked.product.wordingVersion}`;
    if (seen.has(key)) throw new TypeError(`Curated product ${index} repeats ${key}.`);
    seen.add(key);
    return checked;
  }));
}

/**
 * Compare a household's own facts with the curated terms of the product its documents print a UIN for.
 * A document is compared only when it prints exactly one UIN that matches exactly one current curated wording version.
 * Output is information only. It never changes a fact, a rule result or a policy association.
 */
export function compareToCurated({ clauseRows, facts, products }) {
  const uinsByDocument = new Map();
  for (const row of clauseRows ?? []) {
    const documentId = row.documentId ?? row.document_id;
    if (!documentId) continue;
    const bucket = uinsByDocument.get(documentId) ?? new Set();
    for (const uin of extractUins(row.text)) bucket.add(uin);
    uinsByDocument.set(documentId, bucket);
  }
  return deepFreeze([...uinsByDocument].map(([documentId, uins]) => {
    const base = { documentId, uin: null, productVersion: null, comparisons: [] };
    if (uins.size !== 1) return { ...base, status: uins.size ? 'several_uins' : 'no_uin' };
    const [uin] = uins;
    const matches = (products ?? []).filter(p => p.product.uin === uin && p.freshness === 'current');
    if (matches.length === 0) return { ...base, uin, status: 'no_curated_record' };
    if (matches.length > 1) return { ...base, uin, status: 'version_ambiguous' };
    const { product } = matches[0];
    const comparisons = product.facts.map(curated => {
      const own = (facts ?? []).filter(f => f.documentId === documentId && f.factType === curated.factType && f.topic === curated.topic && f.value != null);
      const result = own.length === 0 ? 'not_compared'
        : own.every(f => digestOf(f.value) === digestOf(curated.value)) ? 'matches' : 'differs';
      return { factType: curated.factType, topic: curated.topic, result, curatedValue: curated.value, source: { sourceUrl: product.sourceUrl, page: curated.page, contentSha256: product.contentSha256 } };
    });
    return { ...base, uin, productVersion: product.wordingVersion, status: 'compared', comparisons };
  }));
}

/** Test helper: the digest a curator records for a downloaded wording file. */
export const sha256Hex = bytes => createHash('sha256').update(bytes).digest('hex');
