// Capture registry (ADR 0026, design docs/exec-plans/active/capture-everything-design.md sections 3-5): the closed list of person record
// types, with a descriptor for every field. One source of truth: the validator below, `completeness`, and GET /api/v1/capture-schema
// all read the same descriptors, so a form built from the schema cannot drift from what the server accepts.
//
// Rules for every record (same as src/contracts/user-data.js):
//   * the body is a plain JSON object of at most 8 KB once serialised (PAYLOAD_TOO_LARGE, 413);
//   * strict keys: an unknown field is rejected (INVALID_REQUEST, 400), enums are closed, numbers are finite integers within bounds,
//     text is NFC, trimmed, length-capped and free of control characters, DEL, C1, line/paragraph separators and bidi overrides;
//   * text that looks like an Aadhaar number, PAN, card number, CVV, password or one-time code is rejected with
//     SENSITIVE_IDENTIFIER_REJECTED (400); the value is never echoed or logged;
//   * every field is optional (a half-filled form saves); `null` or "" clears a field; `completeness` is computed here from the
//     registry (empty, partial, complete), never taken from the client;
//   * a validator returns a fresh normalised object, never the caller's. Phone numbers are stored as E.164, dates as YYYY-MM-DD.
// A person under 18 keeps an age band, never a date of birth. Health context is collected only with consent, only from closed lists
// plus short capped notes, is never inferred, scored or sent to a model. Consent, notice and health wording is not final and needs
// legal review. No personal data lives in this file.

import {
  MAX_USER_DATA_BYTES, assertBodySize, assertKnownKeys, assertObject, cleanText,
} from './user-data.js';

export const CAPTURE_SCHEMA_VERSION = 1;

export const RECORD_SOURCES = Object.freeze(['user_typed', 'voice', 'document', 'digilocker', 'import']);
export const RECORD_STATES = Object.freeze(['user_stated', 'extracted_unverified', 'conflicting', 'confirmed_by_user']);
export const AGE_BANDS = Object.freeze(['0-5', '6-12', '13-17', '18-30', '31-45', '46-60', '61+']);
export const UNDER_18_BANDS = Object.freeze(['0-5', '6-12', '13-17']);
export const GENDERS = Object.freeze(['female', 'male', 'other', 'undisclosed']);
export const CONTACT_CHANNELS = Object.freeze(['whatsapp', 'sms', 'email']);
export const VOICE_LANGUAGES = Object.freeze(['en-IN', 'hi-IN', 'ta-IN', 'te-IN', 'bn-IN', 'mr-IN', 'gu-IN', 'kn-IN', 'ml-IN', 'pa-IN']);
export const SLOT_PATTERN = /^[A-Za-z0-9_.-]{1,40}$/;

export const CAPTURE_ERROR_CODES = Object.freeze({
  CONSENT_REQUIRED: 403,
  SENSITIVE_IDENTIFIER_REJECTED: 400,
  RECORD_NOT_FOUND: 404,
  RECORD_TYPE_UNKNOWN: 400,
  GUARDIAN_REQUIRED: 403,
  RECORD_CAPACITY_REACHED: 429,
  MEMBER_MOBILE_IN_USE: 409,
});

export const NEVER_COLLECTED = Object.freeze([
  'Aadhaar number', 'PAN', 'full bank account number', 'card number', 'CVV', 'UPI PIN', 'passwords', 'one-time codes',
  'biometrics', 'government photo ID images outside the document pipeline', 'caste or religion', 'call or chat transcripts',
]);

function fail(code, message, statusCode) { throw Object.assign(new Error(message), { code, statusCode }); }
const invalid = message => fail('INVALID_REQUEST', message, 400);

// ---- Field descriptors ---------------------------------------------------------------------------------------------------------

const text = max => ({ type: 'text', max });
const choice = values => ({ type: 'enum', values: Object.freeze([...values]) });
const whole = (min, max) => ({ type: 'int', min, max });
const flag = { type: 'bool' };
const phone = { type: 'phone' };
const email = { type: 'email' };
const day = { type: 'date', notFuture: true };
const year = { type: 'year' };
const list = (item, max, uniqueBy = null) => ({ type: 'list', item, max, ...(uniqueBy ? { uniqueBy } : {}) });
const group = (fields, required = []) => ({ type: 'object', fields, required });

const CONDITIONS = ['diabetes', 'hypertension', 'asthma', 'heart_disease', 'thyroid', 'kidney', 'cancer_history', 'mental_health', 'other'];
const SURGERIES = ['appendectomy', 'cesarean', 'cardiac', 'orthopaedic', 'cataract', 'hernia', 'gallbladder', 'other'];
const ALLERGIES = ['drug', 'food', 'dust', 'pollen', 'latex', 'other'];
const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
const OCCUPATIONS = ['salaried', 'self_employed', 'business', 'professional', 'homemaker', 'student', 'retired', 'unemployed', 'other'];
const SPEND_CATEGORIES = ['consultation', 'medicines', 'diagnostics', 'hospital', 'dental', 'vision', 'therapy', 'other'];

/**
 * Record types. `subject`: member_required needs ?memberId= (self_profile defaults to the caller's own member), member_optional may
 * hang off the household. `consentCategory`: a current consent grant (purpose profile_intake, scope resource_type profile_field,
 * action collect, this data_category) is required to read or write; revoking it erases these records. `maxSlots`: how many records of
 * the type one subject may hold (a type with one slot always uses the slot "main").
 */
export const RECORD_TYPES = Object.freeze({
  self_profile: Object.freeze({
    label: 'About you', tier: 'T1', subject: 'member_required', consentCategory: null, maxSlots: 1,
    requiredForComplete: ['preferredLanguage', 'occupationBand'],
    fields: Object.freeze({
      preferredLanguage: choice(VOICE_LANGUAGES), occupationBand: choice(OCCUPATIONS), employerName: text(80),
    }),
  }),
  health_context: Object.freeze({
    label: 'Health context', tier: 'T2', subject: 'member_required', consentCategory: 'health_profile', maxSlots: 1,
    requiredForComplete: ['heightCm', 'weightKg', 'tobacco', 'alcohol'],
    fields: Object.freeze({
      conditions: list(group({ condition: choice(CONDITIONS), sinceYear: year, onTreatment: flag, note: text(200) }, ['condition']), 9, 'condition'),
      surgeries: list(group({ kind: choice(SURGERIES), year, hospitalNote: text(120) }, ['kind']), 10),
      medicines: list(text(60), 10),
      heightCm: whole(30, 250),
      weightKg: whole(2, 400),
      tobacco: choice(['never', 'former', 'current']),
      alcohol: choice(['never', 'occasional', 'regular']),
      planned: group({ surgery: flag, pregnancy: flag, treatment: flag, month: { type: 'month' } }),
      allergies: list(group({ kind: choice(ALLERGIES), note: text(60) }, ['kind']), 6, 'kind'),
      bloodGroup: choice(BLOOD_GROUPS),
      preferredHospital: text(120),
      preferredDoctor: text(120),
      emergencyNote: text(300),
    }),
  }),
  nominee: Object.freeze({
    label: 'Nominee', tier: 'T2', subject: 'member_optional', consentCategory: 'family_data', maxSlots: 10,
    requiredForComplete: ['name', 'relation', 'sharePct'],
    fields: Object.freeze({
      name: text(80), relation: text(40), sharePct: whole(0, 100), dateOfBirth: day, ageBand: choice(AGE_BANDS),
    }),
  }),
  emergency_contact: Object.freeze({
    label: 'Emergency contact', tier: 'T1', subject: 'member_optional', consentCategory: null, maxSlots: 5,
    requiredForComplete: ['name', 'mobile'],
    fields: Object.freeze({ name: text(80), relation: text(40), mobile: phone, rank: whole(1, 5) }),
  }),
  advisor: Object.freeze({
    label: 'Advisor', tier: 'T1', subject: 'member_optional', consentCategory: null, maxSlots: 5,
    requiredForComplete: ['name'],
    fields: Object.freeze({
      name: text(80), firm: text(80), mobile: phone, email,
      sharingScope: choice(['none', 'renewals_only', 'policy_summary', 'full']),
    }),
  }),
  member_note: Object.freeze({
    label: 'Note', tier: 'T1', subject: 'member_required', consentCategory: null, maxSlots: 1,
    requiredForComplete: ['note'],
    fields: Object.freeze({ note: text(200) }),
  }),
  out_of_pocket_spend: Object.freeze({
    label: 'Out-of-pocket medical spend', tier: 'T2', subject: 'member_optional', consentCategory: null, maxSlots: 200,
    requiredForComplete: ['amountMinor', 'paidOn', 'category'],
    fields: Object.freeze({
      amountMinor: whole(0, 100_000_000_000), paidOn: day, category: choice(SPEND_CATEGORIES), note: text(200),
    }),
  }),
});

export const RECORD_TYPE_NAMES = Object.freeze(Object.keys(RECORD_TYPES));

// ---- Normalisers ---------------------------------------------------------------------------------------------------------------

const isoDay = value => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

/** YYYY-MM-DD, or DD/MM/YYYY and DD-MM-YYYY (four-digit year). Returns the ISO day or null. */
export function normalizeDay(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  let iso = null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) iso = trimmed;
  else {
    const match = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(trimmed);
    if (match) iso = `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
  }
  return iso && isoDay(iso) ? iso : null;
}

/** Indian mobile or international number to E.164. "098765 43210", "+91 98765-43210" and "9876543210" give +919876543210. */
export function normalizePhone(value) {
  if (typeof value !== 'string') return null;
  const compact = value.normalize('NFC').trim().replace(/[\s().-]/g, '');
  if (!/^\+?[0-9]+$/.test(compact)) return null;
  let digits = compact.replace('+', '');
  if (compact.startsWith('+')) return digits.length >= 8 && digits.length <= 15 && digits[0] !== '0' ? `+${digits}` : null;
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  return /^[6-9][0-9]{9}$/.test(digits) ? `+91${digits}` : null;
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,63}$/;

/** Whole years between an ISO day and `now`, or null. */
export function ageInYears(born, now) {
  if (typeof born !== 'string' || !isoDay(born)) return null;
  const today = now.toISOString().slice(0, 10);
  let years = Number(today.slice(0, 4)) - Number(born.slice(0, 4));
  if (today.slice(5) < born.slice(5)) years -= 1;
  return years < 0 ? null : years;
}

export function ageBandForYears(years) {
  if (!Number.isInteger(years) || years < 0) return null;
  if (years <= 5) return '0-5';
  if (years <= 12) return '6-12';
  if (years <= 17) return '13-17';
  if (years <= 30) return '18-30';
  if (years <= 45) return '31-45';
  if (years <= 60) return '46-60';
  return '61+';
}

// ---- Validation ----------------------------------------------------------------------------------------------------------------

const isBlank = value => value === undefined || value === null || (typeof value === 'string' && value.trim() === '');

function validateValue(descriptor, value, field, ctx) {
  switch (descriptor.type) {
    case 'text': return cleanText(value, field, { max: descriptor.max });
    case 'enum':
      if (typeof value !== 'string' || !descriptor.values.includes(value)) invalid(`${field} is not an accepted value.`);
      return value;
    case 'int':
      if (!Number.isInteger(value) || value < descriptor.min || value > descriptor.max) invalid(`${field} must be a whole number from ${descriptor.min} to ${descriptor.max}.`);
      return value;
    case 'year': {
      const top = ctx.now.getUTCFullYear();
      if (!Number.isInteger(value) || value < 1900 || value > top) invalid(`${field} must be a year from 1900 to ${top}.`);
      return value;
    }
    case 'bool':
      if (typeof value !== 'boolean') invalid(`${field} must be true or false.`);
      return value;
    case 'date': {
      const iso = normalizeDay(value);
      if (!iso || iso < '1900-01-01') invalid(`${field} must be a real date as YYYY-MM-DD.`);
      if (descriptor.notFuture && iso > ctx.now.toISOString().slice(0, 10)) invalid(`${field} cannot be in the future.`);
      return iso;
    }
    case 'month':
      if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value) || value < '1900-01' || value > '2100-12') invalid(`${field} must be a month as YYYY-MM.`);
      return value;
    case 'phone': {
      const e164 = normalizePhone(value);
      if (!e164) invalid(`${field} is not a valid phone number.`);
      return e164;
    }
    case 'email': {
      const clean = cleanText(value, field, { max: 254, identifiers: false });
      const lower = clean?.toLowerCase() ?? null;
      if (lower !== null && !EMAIL.test(lower)) invalid(`${field} is not a valid e-mail address.`);
      return lower;
    }
    case 'list': {
      if (!Array.isArray(value) || value.length > descriptor.max) invalid(`${field} must be a list of at most ${descriptor.max}.`);
      const out = [];
      const seen = new Set();
      for (const [index, item] of value.entries()) {
        const clean = validateValue(descriptor.item, item, `${field}[${index}]`, ctx);
        if (clean === null) invalid(`${field}[${index}] is empty.`);
        if (descriptor.uniqueBy) {
          const key = clean[descriptor.uniqueBy];
          if (seen.has(key)) invalid(`${field} has a repeated entry.`);
          seen.add(key);
        }
        out.push(clean);
      }
      return out;
    }
    case 'object': {
      assertObject(value, field);
      return validateFields(descriptor.fields, value, field, ctx, descriptor.required);
    }
    default: throw new Error(`Unknown descriptor type ${descriptor.type}.`);
  }
}

function validateFields(fields, input, name, ctx, required = []) {
  const keys = Object.keys(fields);
  assertKnownKeys(input, keys, name);
  const out = {};
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(input, key) || isBlank(input[key])) continue;
    const clean = validateValue(fields[key], input[key], `${name}.${key}`, ctx);
    if (clean !== null && clean !== undefined) out[key] = clean;
  }
  for (const key of required) if (!(key in out)) invalid(`${name}.${key} is required.`);
  return out;
}

export function parseRecordType(type) {
  if (typeof type !== 'string' || !Object.prototype.hasOwnProperty.call(RECORD_TYPES, type)) {
    fail('RECORD_TYPE_UNKNOWN', 'That record type is not known.', 400);
  }
  return type;
}

export function parseSlot(type, slot) {
  parseRecordType(type);
  const wanted = slot === undefined || slot === null || slot === '' ? 'main' : slot;
  if (typeof wanted !== 'string' || !SLOT_PATTERN.test(wanted)) invalid('slot is not valid.');
  if (RECORD_TYPES[type].maxSlots === 1 && wanted !== 'main') invalid(`${type} holds one record; its slot is "main".`);
  return wanted;
}

/** 'empty' when nothing is set, 'complete' when every required field is set, else 'partial'. Computed here, never by the client. */
export function completeness(type, data) {
  const meta = RECORD_TYPES[parseRecordType(type)];
  if (Object.keys(data).length === 0) return 'empty';
  return meta.requiredForComplete.every(key => data[key] !== undefined) ? 'complete' : 'partial';
}

/** Provenance is decided here: typed values are user_stated; voice, document, digilocker and import values await a user tap. */
export function stateForSource(source) {
  return source === 'user_typed' ? 'user_stated' : 'extracted_unverified';
}

/**
 * Body of PUT /households/{id}/records/{type}/{slot}: { data: {...}, source?: "user_typed" }. Resolves
 * { type, data, source, state, completeness, schemaVersion }.
 */
export function parseRecordBody(type, body, { now = new Date() } = {}) {
  const meta = RECORD_TYPES[parseRecordType(type)];
  assertBodySize(body);
  assertKnownKeys(body, ['data', 'source'], 'The body');
  const source = body.source === undefined ? 'user_typed' : body.source;
  if (!RECORD_SOURCES.includes(source)) invalid('source is not an accepted value.');
  const input = body.data === undefined ? {} : body.data;
  assertObject(input, 'data');
  const data = validateFields(meta.fields, input, 'data', { now });
  if (type === 'nominee' && data.dateOfBirth) {
    const years = ageInYears(data.dateOfBirth, now);
    if (years !== null && years < 18) invalid('A date of birth is not stored for a person under 18. Send ageBand instead.');
  }
  if (Buffer.byteLength(JSON.stringify(data), 'utf8') > MAX_USER_DATA_BYTES) fail('PAYLOAD_TOO_LARGE', 'The record is larger than 8 KB.', 413);
  return { type, data, source, state: stateForSource(source), completeness: completeness(type, data), schemaVersion: CAPTURE_SCHEMA_VERSION };
}

// ---- Schema for GET /api/v1/capture-schema -------------------------------------------------------------------------------------

function describe(descriptor) {
  const out = { type: descriptor.type };
  for (const key of ['max', 'min', 'notFuture', 'uniqueBy']) if (descriptor[key] !== undefined) out[key] = descriptor[key];
  if (descriptor.values) out.values = [...descriptor.values];
  if (descriptor.item) out.item = describe(descriptor.item);
  if (descriptor.fields) {
    out.fields = Object.fromEntries(Object.entries(descriptor.fields).map(([key, value]) => [key, describe(value)]));
    out.required = [...(descriptor.required ?? [])];
  }
  return out;
}

/** The registry as plain JSON for the app to generate and test forms from. Contains no personal data. */
export function captureSchema() {
  return {
    version: CAPTURE_SCHEMA_VERSION,
    status: 'draft_pending_legal_review',
    maxBodyBytes: MAX_USER_DATA_BYTES,
    sources: [...RECORD_SOURCES],
    states: [...RECORD_STATES],
    neverCollected: [...NEVER_COLLECTED],
    member: {
      gender: [...GENDERS], ageBand: [...AGE_BANDS], preferredChannel: [...CONTACT_CHANNELS],
      underEighteenBands: [...UNDER_18_BANDS], rule: 'A member under 18 keeps an age band, never a date of birth or contact details.',
    },
    recordTypes: Object.fromEntries(Object.entries(RECORD_TYPES).map(([name, meta]) => [name, {
      label: meta.label, tier: meta.tier, subject: meta.subject, consentCategory: meta.consentCategory, maxSlots: meta.maxSlots,
      requiredForComplete: [...meta.requiredForComplete],
      fields: Object.fromEntries(Object.entries(meta.fields).map(([key, value]) => [key, describe(value)])),
    }])),
  };
}

// ---- Member details (POST/PATCH /households/{id}/members) -----------------------------------------------------------------------

const MEMBER_ID = /^[A-Za-z0-9_.:-]{1,100}$/;
export const MEMBER_DETAIL_FIELDS = Object.freeze({
  gender: choice(GENDERS), ageBand: choice(AGE_BANDS), mobile: phone, email, preferredChannel: choice(CONTACT_CHANNELS),
  livesWithHousehold: flag,
  dependentOnMemberId: { type: 'memberId' }, guardianMemberId: { type: 'memberId' },
});

/**
 * The detail fields present in a member body, validated and normalised. A field sent as null or "" clears (null). A key that is not
 * present is absent from the result. Contact and age rules that depend on the member are checked by `assertMemberDetailRules`.
 */
export function parseMemberDetails(body, { now = new Date() } = {}) {
  const out = {};
  for (const [key, descriptor] of Object.entries(MEMBER_DETAIL_FIELDS)) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    if (isBlank(body[key])) { out[key] = null; continue; }
    if (descriptor.type === 'memberId') {
      if (typeof body[key] !== 'string' || !MEMBER_ID.test(body[key])) invalid(`${key} is not valid.`);
      out[key] = body[key];
    } else out[key] = validateValue(descriptor, body[key], key, { now });
  }
  return out;
}

/**
 * Age and contact rules for one member (owner decision D5): a member under 18 keeps an age band and never a date of birth, and has no
 * direct contact fields; a dependant may have contact details only when an age band of 18 or more (or a date of birth showing it) is
 * known. `input` holds what this request sets; `stored` what the row already holds.
 */
export function assertMemberDetailRules({ memberKind, input, stored = {}, now = new Date() }) {
  const ageBand = 'ageBand' in input ? input.ageBand : stored.ageBand ?? null;
  const newBirth = input.dateOfBirth ?? null;
  const birth = 'dateOfBirth' in input ? newBirth : stored.dateOfBirth ?? null;
  const years = birth ? ageInYears(birth, now) : null;
  const bandIsMinor = ageBand !== null && UNDER_18_BANDS.includes(ageBand);
  const minor = bandIsMinor || (years !== null && years < 18);
  if (newBirth && (minor)) invalid('A date of birth is not stored for a member under 18. Send ageBand instead.');
  if (newBirth && ageBand && ageBandForYears(years) !== ageBand) invalid('ageBand does not match the date of birth.');
  const contact = Boolean(input.mobile) || Boolean(input.email);
  if (contact) {
    if (minor) invalid('Contact details are not stored for a member under 18.');
    const knownAdult = (ageBand !== null && !bandIsMinor) || (years !== null && years >= 18);
    if (memberKind === 'dependent' && !knownAdult) invalid('A dependant needs an age band of 18 or more before contact details are stored.');
  }
}
