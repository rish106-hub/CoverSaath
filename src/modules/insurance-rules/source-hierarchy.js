import { InsuranceRulesValidationError, isRecord, requireString } from './contracts.js';

export const SOURCE_PRIORITY = Object.freeze({
  endorsement: 700,
  issued_schedule: 600,
  policy_wording: 500,
  certificate_of_insurance: 450,
  group_benefit_booklet: 400,
  authorised_institution_reply: 350,
  customer_information_sheet: 300,
  user_statement: 100,
  marketing_material: 0,
});

function parseVersion(value) {
  const parts = String(value).match(/\d+/g);
  return parts ? parts.map(Number) : [];
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return Math.sign(difference);
  }
  return String(left).localeCompare(String(right));
}

export function validateCitation(source, path = 'source') {
  if (!isRecord(source)) return null;
  const type = SOURCE_PRIORITY[source.type] == null ? null : source.type;
  const id = typeof source.id === 'string' && source.id.trim() ? source.id.trim() : null;
  const version = typeof source.version === 'string' && source.version.trim() ? source.version.trim() : null;
  const page = (Number.isInteger(source.page) && source.page >= 0) || (typeof source.page === 'string' && source.page.trim())
    ? source.page
    : null;
  if (!type || !id || !version || page == null) return null;
  return Object.freeze({ type, id, version, page, familyId: source.familyId ? requireString(source.familyId, `${path}.familyId`) : id });
}

export function sourceRank(source) {
  if (!source || SOURCE_PRIORITY[source.type] == null) throw new InsuranceRulesValidationError('has an unsupported source type', 'source.type');
  return SOURCE_PRIORITY[source.type];
}

/** Select only the highest contract layer, then its latest document family versions. */
export function selectControllingObservations(observations) {
  if (!observations.length) return [];
  const highestRank = Math.max(...observations.map(item => sourceRank(item.source)));
  const atLayer = observations.filter(item => sourceRank(item.source) === highestRank);
  const latestByFamily = new Map();
  for (const item of atLayer) {
    const current = latestByFamily.get(item.source.familyId);
    if (!current || compareVersions(item.source.version, current.source.version) > 0) latestByFamily.set(item.source.familyId, item);
    else if (compareVersions(item.source.version, current.source.version) === 0) {
      latestByFamily.set(`${item.source.familyId}:${latestByFamily.size}`, item);
    }
  }
  return [...latestByFamily.values()];
}
