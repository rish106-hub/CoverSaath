export const EVIDENCE_STATES = Object.freeze(['known', 'unknown', 'conflict']);
export const POLICY_KINDS = Object.freeze(['group', 'personal']);
export const CASE_TRIGGERS = Object.freeze(['emergency', 'planned_care', 'renewal', 'family_change', 'job_change']);
export const ROUTES = Object.freeze(['emergency', 'clarification', 'human_review', 'purchase_review', 'no_action']);

export class InsuranceRulesValidationError extends Error {
  constructor(message, path = 'input') {
    super(`${path}: ${message}`);
    this.name = 'InsuranceRulesValidationError';
    this.code = 'INVALID_INSURANCE_RULES_INPUT';
    this.path = path;
  }
}

export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function requireRecord(value, path) {
  if (!isRecord(value)) throw new InsuranceRulesValidationError('must be an object', path);
  return value;
}

export function requireString(value, path, { optional = false, max = 500 } = {}) {
  if (optional && value == null) return null;
  if (typeof value !== 'string' || !value.trim()) throw new InsuranceRulesValidationError('must be a non-empty string', path);
  if (value.length > max) throw new InsuranceRulesValidationError(`must be at most ${max} characters`, path);
  return value.trim();
}

export function requireEnum(value, allowed, path) {
  if (!allowed.includes(value)) throw new InsuranceRulesValidationError(`must be one of: ${allowed.join(', ')}`, path);
  return value;
}

export function optionalMoney(value, path) {
  if (value == null) return null;
  if (!Number.isFinite(value) || value < 0 || value > 1_000_000_000) {
    throw new InsuranceRulesValidationError('must be a finite non-negative amount', path);
  }
  return value;
}

export function freeze(value) {
  if (Array.isArray(value)) {
    value.forEach(freeze);
    return Object.freeze(value);
  }
  if (isRecord(value)) {
    Object.values(value).forEach(freeze);
    return Object.freeze(value);
  }
  return value;
}
