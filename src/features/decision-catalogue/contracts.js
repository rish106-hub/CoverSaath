// Block 3 decision catalogue contracts. Facts are open-ended: `factType` and `topic` are free labels, and the
// canonical registry key is optional. A missing registry key never discards evidence.
import { createHash } from 'node:crypto';

export const CATALOGUE_VERSION = 'decision-catalogue/v1';

export const FACT_ORIGINS = Object.freeze(['model', 'deterministic', 'human_review', 'official_source']);
export const FACT_STATES = Object.freeze(['unknown', 'extracted_unverified', 'reported', 'proven', 'calculated', 'dynamic', 'conflicting', 'not_permitted']);
// Only these states may feed a calculation or a "known" rule result.
export const VERIFIED_STATES = Object.freeze(['proven', 'calculated']);
export const SELECTIONS = Object.freeze(['selected', 'not_opted', 'available', 'unspecified']);
export const POLICY_KINDS = Object.freeze(['personal', 'family_floater', 'group', 'top_up', 'super_top_up', 'unresolved']);
export const COVER_BASES = Object.freeze(['individual', 'shared', 'unknown']);
export const CONTRACTUAL_SOURCES = Object.freeze({ endorsement: 700, issued_schedule: 600, policy_wording: 500, certificate_of_insurance: 450, group_benefit_booklet: 400 });
export const NON_CONTRACTUAL_SOURCES = Object.freeze(['customer_information_sheet', 'authorised_institution_reply', 'user_statement', 'marketing_material']);

export class CatalogueError extends Error {
  constructor(code, message, path = 'input') {
    super(`${path}: ${message}`);
    this.name = 'CatalogueError';
    this.code = code;
    this.path = path;
  }
}

export const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const text = (value, max = 300) => (typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : null);

export function deepFreeze(value) {
  if (Array.isArray(value)) value.forEach(deepFreeze);
  else if (isRecord(value)) Object.values(value).forEach(deepFreeze);
  return typeof value === 'object' && value !== null ? Object.freeze(value) : value;
}

const canonical = value => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
};
export const digestOf = value => createHash('sha256').update(canonical(value)).digest('hex');

// Round-trips the date: V8 accepts 2026-02-30 and rolls it to March, which must not count as a valid date.
export const isIsoDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
export const isMinor = value => Number.isSafeInteger(value) && value >= 0;
