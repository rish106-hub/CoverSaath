export const UNKNOWN = 'UNKNOWN';

const PROFILE_FIELDS = Object.freeze({
  displayName: 'text',
  contactEmail: 'email',
  contactPhone: 'text',
  householdRole: 'text',
  employerName: 'text',
  employeeId: 'text',
  employmentStartDate: 'date',
  employmentEndDate: 'date',
  currentlyEmployed: 'boolean',
  employerBenefitEnrolled: 'boolean',
  enrolledMembers: 'list',
  availableEmployerBenefits: 'list'
});

const AFFORDABILITY_FIELDS = Object.freeze({
  monthlyIncome: 'money',
  fixedCommitments: 'money',
  loanEmis: 'money',
  emergencySavings: 'money'
});

const SOURCE_TYPES = new Set(['hrms', 'manual', 'payroll', 'form16']);
const POLICY_TERM_PATTERN = /policy|sum.?insured|cover.?amount|waiting.?period|exclusion|co.?pay|room.?rent|deductible|cashless|claim.?eligibility|remaining.?cover/i;
const MEDICAL_PATTERN = /medical|diagnos|disease|condition|treatment|procedure|medication|clinical|symptom|health.?history/i;

export class ProfileIntakeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProfileIntakeError';
    this.code = code;
  }
}

const cleanText = value => String(value).trim().replace(/\s+/g, ' ');

function normaliseValue(value, kind) {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) return UNKNOWN;
  if (kind === 'boolean') return typeof value === 'boolean' ? value : UNKNOWN;
  if (kind === 'list') {
    if (!Array.isArray(value)) return UNKNOWN;
    const entries = [...new Set(value.map(cleanText).filter(Boolean))];
    return entries.length ? entries : UNKNOWN;
  }
  if (kind === 'money') {
    const amount = typeof value === 'number' ? value : Number(String(value).replaceAll(',', '').trim());
    return Number.isFinite(amount) && amount >= 0 ? amount : UNKNOWN;
  }
  if (kind === 'date') {
    const text = cleanText(value);
    return /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(`${text}T00:00:00Z`)) ? text : UNKNOWN;
  }
  if (kind === 'email') {
    const text = cleanText(value).toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) ? text : UNKNOWN;
  }
  return cleanText(value).slice(0, 240) || UNKNOWN;
}

function normaliseSource(source) {
  if (!source || !SOURCE_TYPES.has(source.type) || !cleanText(source.id || '')) {
    throw new ProfileIntakeError('INVALID_SOURCE', 'A supported source type and source ID are required.');
  }
  return {
    type: source.type,
    id: cleanText(source.id),
    retrievedAt: source.retrievedAt ? cleanText(source.retrievedAt) : UNKNOWN,
    version: source.version ? cleanText(source.version) : UNKNOWN,
    location: source.location ? cleanText(source.location) : UNKNOWN,
    reporterId: source.reporterId ? cleanText(source.reporterId) : UNKNOWN
  };
}

function requireConsent(consent, { subjectId, sourceType, fields, purpose, now }) {
  const purposes = Array.isArray(consent?.purposes) ? consent.purposes : [consent?.purpose].filter(Boolean);
  const sources = Array.isArray(consent?.sources) ? consent.sources : [];
  const scopedFields = Array.isArray(consent?.fields) ? consent.fields : [];
  const expired = consent?.expiresAt && Date.parse(consent.expiresAt) <= now.getTime();
  if (!consent || consent.status !== 'granted' || consent.revokedAt || expired || consent.subjectId !== subjectId ||
      !purposes.includes(purpose) || !sources.includes(sourceType) || fields.some(field => !scopedFields.includes(field))) {
    throw new ProfileIntakeError('CONSENT_REQUIRED', `Active, subject-scoped consent is required for ${purpose}.`);
  }
  return {
    id: consent.id ? cleanText(consent.id) : UNKNOWN,
    subjectId,
    status: 'granted',
    purpose,
    source: sourceType,
    fields: [...fields],
    grantedAt: consent.grantedAt ? cleanText(consent.grantedAt) : UNKNOWN,
    expiresAt: consent.expiresAt ? cleanText(consent.expiresAt) : UNKNOWN
  };
}

function verificationFor(source, subjectId) {
  if (source.type === 'manual') {
    return source.reporterId !== UNKNOWN && source.reporterId !== subjectId
      ? 'proxy_reported_unconfirmed'
      : 'subject_stated_unverified';
  }
  if (source.type === 'hrms') return 'hrms_recorded_unverified';
  return 'document_recorded_profile_only';
}

function makeFact(value, source, subjectId) {
  return {
    value,
    status: value === UNKNOWN ? 'unknown' : 'known',
    verificationStatus: value === UNKNOWN ? 'not_provided' : verificationFor(source, subjectId),
    source: { ...source }
  };
}

function classifyRejected(field, requested) {
  if (POLICY_TERM_PATTERN.test(field)) return 'policy_terms_require_issued_benefit_documents';
  if (MEDICAL_PATTERN.test(field)) return 'medical_data_not_processed_or_inferred';
  return requested ? 'unsupported_field' : 'not_requested_or_not_consent_scoped';
}

function normaliseSection({ data, requestedFields, schema, source, subjectId }) {
  const fields = [...new Set(Array.isArray(requestedFields) ? requestedFields : [])];
  const allowedFields = fields.filter(field => Object.hasOwn(schema, field));
  const rejected = [];
  for (const field of fields.filter(field => !Object.hasOwn(schema, field))) {
    rejected.push({ field, reason: classifyRejected(field, true) });
  }
  for (const field of Object.keys(data || {})) {
    if (!allowedFields.includes(field)) rejected.push({ field, reason: classifyRejected(field, fields.includes(field)) });
  }
  const facts = Object.fromEntries(allowedFields.map(field => [
    field,
    makeFact(normaliseValue(data?.[field], schema[field]), source, subjectId)
  ]));
  return { allowedFields, facts, rejected: [...new Map(rejected.map(item => [item.field, item])).values()] };
}

/**
 * Normalise a bounded profile intake packet without inferring missing facts.
 * The caller supplies `now` in tests or replay jobs so consent expiry is deterministic.
 */
export function normalizeProfileIntake(packet, { now = new Date() } = {}) {
  const subjectId = cleanText(packet?.subjectId || '');
  if (!subjectId) throw new ProfileIntakeError('INVALID_SUBJECT', 'A subject ID is required.');

  const source = normaliseSource(packet.source);
  const profile = normaliseSection({
    data: packet.data,
    requestedFields: packet.requestedFields,
    schema: PROFILE_FIELDS,
    source,
    subjectId
  });
  const consent = requireConsent(packet.consent, {
    subjectId,
    sourceType: source.type,
    fields: profile.allowedFields,
    purpose: 'profile_intake',
    now
  });

  let affordability = null;
  let affordabilityRejected = [];
  if (packet.affordability !== undefined) {
    const affordabilitySource = normaliseSource(packet.affordability.source);
    const section = normaliseSection({
      data: packet.affordability.data,
      requestedFields: packet.affordability.requestedFields,
      schema: AFFORDABILITY_FIELDS,
      source: affordabilitySource,
      subjectId
    });
    const affordabilityConsent = requireConsent(packet.affordability.consent, {
      subjectId,
      sourceType: affordabilitySource.type,
      fields: section.allowedFields,
      purpose: 'affordability_planning',
      now
    });
    affordability = {
      voluntary: true,
      purpose: 'premium_and_cash_scenario_only',
      facts: section.facts,
      source: affordabilitySource,
      consent: affordabilityConsent
    };
    affordabilityRejected = section.rejected;
  }

  return {
    subjectId,
    profile: profile.facts,
    affordability,
    provenance: { profileSource: source },
    consent,
    rejectedFields: [...profile.rejected, ...affordabilityRejected.map(item => ({ ...item, section: 'affordability' }))],
    boundaries: {
      policyTermsVerified: false,
      medicalFactsInferred: false,
      affordabilityAffectsCoverageTruth: false
    }
  };
}

