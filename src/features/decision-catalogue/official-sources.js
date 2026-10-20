// B3-5 minimal official-source record. External facts carry provenance, time and applicability and can never
// override a private policy contract. Curated by hand: no crawler, no network call.
import { deepFreeze, isIsoDate, isRecord, text } from './contracts.js';

export const SOURCE_AUTHORITIES = Object.freeze(['irdai', 'insurer_document', 'insurer_or_tpa_confirmation', 'hospital_network', 'public_review']);
const AUTHORITATIVE = new Set(['irdai', 'insurer_document', 'insurer_or_tpa_confirmation', 'hospital_network']);
const DYNAMIC_MAX_AGE_DAYS = 30;
const STATIC_MAX_AGE_DAYS = 400;

export function validateOfficialSource(record, { today }) {
  if (!isIsoDate(today)) throw new TypeError('today must be an ISO date.');
  const r = isRecord(record) ? record : {};
  const errors = [];
  if (!SOURCE_AUTHORITIES.includes(r.authority)) errors.push('authority');
  for (const field of ['institution', 'identifier', 'title', 'metricDefinition']) if (!text(r[field], 300)) errors.push(field);
  for (const field of ['publishedOn', 'retrievedOn']) if (!isIsoDate(r[field])) errors.push(field);
  for (const field of ['effectiveFrom', 'validTo']) if (r[field] != null && !isIsoDate(r[field])) errors.push(field);
  if (!isRecord(r.applicability) || !text(r.applicability.insurer, 200)) errors.push('applicability');
  if (errors.length) return deepFreeze({ valid: false, errors });

  if (r.retrievedOn > today) return deepFreeze({ valid: false, errors: ['retrievedOn'] });
  const age = Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${r.retrievedOn}T00:00:00Z`)) / 86_400_000);
  let freshness = 'current';
  if (r.supersededBy) freshness = 'superseded';
  else if (r.effectiveFrom && r.effectiveFrom > today) freshness = 'not_yet_effective';
  else if (age > STATIC_MAX_AGE_DAYS && r.dynamic !== true) freshness = 'stale';
  else if (r.validTo && r.validTo < today) freshness = 'stale';
  else if (r.dynamic === true && age > DYNAMIC_MAX_AGE_DAYS) freshness = 'stale';
  else if (r.validTo == null && r.dynamic !== true) freshness = 'freshness_unknown';
  const verified = AUTHORITATIVE.has(r.authority) && r.verified === true;
  return deepFreeze({
    valid: true, freshness, authority: r.authority, verified, dynamic: r.dynamic === true,
    // Never able to override a contract: it informs, and only a policy-specific applicable fact can control.
    mayOverrideContract: false,
    individualClaimProbability: null,
    record: { institution: r.institution, identifier: r.identifier, title: r.title, publishedOn: r.publishedOn, effectiveFrom: r.effectiveFrom ?? null, validTo: r.validTo ?? null, retrievedOn: r.retrievedOn, applicability: r.applicability, metricDefinition: r.metricDefinition },
  });
}
