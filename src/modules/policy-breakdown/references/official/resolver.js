import { OfficialSourceContractError, defineOfficialSource } from './contracts.js';

export const OFFICIAL_SOURCE_RESOLUTION_STATUSES = Object.freeze(['matched', 'ambiguous', 'not_found', 'incompatible']);

const QUERY_KEYS = Object.freeze(['legalInsurerName', 'uin', 'productName', 'version', 'effectiveDate', 'documentType']);
const requiredText = (value, name) => {
  if (typeof value !== 'string' || !value.trim()) throw new OfficialSourceContractError('OFFICIAL_SOURCE_QUERY_INVALID', `${name} is required.`);
  return value.trim();
};
const normalizeWords = value => requiredText(value, 'identity').normalize('NFKC').replace(/\s+/g, ' ').toLocaleLowerCase('en-IN');
const normalizeToken = value => requiredText(value, 'identity').normalize('NFKC').replace(/\s+/g, '').toUpperCase();
const normalizeVersion = value => requiredText(value, 'identity').normalize('NFKC').replace(/\s+/g, ' ').toLocaleLowerCase('en-IN');
const isIsoDate = value => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
};
const effectiveOn = (identity, date) => identity.effectiveFrom <= date && (!identity.effectiveTo || identity.effectiveTo >= date);

function validateQuery(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new OfficialSourceContractError('OFFICIAL_SOURCE_QUERY_INVALID', 'resolution query must be an object.');
  for (const key of Object.keys(raw)) if (!QUERY_KEYS.includes(key)) throw new OfficialSourceContractError('OFFICIAL_SOURCE_PRIVATE_DATA', `resolution query field ${key} is not permitted.`);
  const effectiveDate = requiredText(raw.effectiveDate, 'effectiveDate');
  if (!isIsoDate(effectiveDate)) throw new OfficialSourceContractError('OFFICIAL_SOURCE_QUERY_INVALID', 'effectiveDate must be an ISO date.');
  return Object.freeze({
    legalInsurerName: normalizeWords(raw.legalInsurerName),
    uin: normalizeToken(raw.uin),
    productName: normalizeWords(raw.productName),
    version: normalizeVersion(raw.version),
    effectiveDate,
    documentType: raw.documentType == null ? null : requiredText(raw.documentType, 'documentType'),
  });
}

const publicCandidate = entry => Object.freeze({
  id: entry.id,
  sourceClass: entry.sourceClass,
  documentType: entry.documentType,
  canonicalUrl: entry.canonicalUrl,
  identity: entry.identity,
});

/**
 * Resolve an exact legal-insurer + UIN + product + version + effective-date source.
 * There is deliberately no fuzzy product/name fallback: incompatible and ambiguous results abstain.
 */
export function resolveOfficialSource(rawQuery, rawEntries) {
  const query = validateQuery(rawQuery);
  if (!Array.isArray(rawEntries)) throw new OfficialSourceContractError('OFFICIAL_SOURCE_QUERY_INVALID', 'registry entries must be a list.');
  const entries = rawEntries.map(defineOfficialSource).filter(entry => entry.identity.scope === 'policy_versioned');
  const insurerEntries = entries.filter(entry => normalizeWords(entry.identity.legalInsurerName) === query.legalInsurerName);
  if (insurerEntries.length === 0) return Object.freeze({ status: 'not_found', reason: 'legal_insurer_not_registered', candidates: Object.freeze([]) });

  const identityCompatible = insurerEntries.filter(entry =>
    normalizeToken(entry.identity.uin) === query.uin
    && normalizeWords(entry.identity.productName) === query.productName
    && normalizeVersion(entry.identity.version) === query.version
    && (!query.documentType || entry.documentType === query.documentType));
  if (identityCompatible.length === 0) {
    return Object.freeze({ status: 'incompatible', reason: 'uin_product_or_version_mismatch', candidates: Object.freeze(insurerEntries.map(publicCandidate)) });
  }

  const effective = identityCompatible.filter(entry => effectiveOn(entry.identity, query.effectiveDate));
  if (effective.length === 0) {
    return Object.freeze({ status: 'incompatible', reason: 'effective_date_outside_registered_version', candidates: Object.freeze(identityCompatible.map(publicCandidate)) });
  }
  if (effective.length > 1) {
    return Object.freeze({ status: 'ambiguous', reason: 'multiple_exact_compatible_sources', candidates: Object.freeze(effective.map(publicCandidate)) });
  }
  return Object.freeze({ status: 'matched', reason: 'exact_identity_and_effective_date_match', source: effective[0], candidates: Object.freeze([publicCandidate(effective[0])]) });
}
