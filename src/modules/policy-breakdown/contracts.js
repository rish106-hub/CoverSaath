// Shared contracts for the 12-section policy breakdown.
// Section files under ./sections/ declare parameters with defineSection(); nothing else may
// change these shapes without the central agent updating every section and the pipeline.

export const BREAKDOWN_CONTRACT_VERSION = 'knowvia.policy-breakdown.v1';

export const EVIDENCE_STATES = Object.freeze([
  'Proven',        // every citation quote matched stored page text and adjudication agreed
  'Calculated',    // derived deterministically from Proven inputs
  'Reported',      // stated by a person, not document-verified
  'Dynamic',       // valid only at a dated point (network lists, regulatory floors, disclosures)
  'Unknown',       // the source pack does not establish it
  'Conflicting',   // sources or passes disagree; both are preserved
  'NotPermitted',  // withheld by permission; never rendered as Unknown
]);

export const VALUE_TYPES = Object.freeze([
  'money',      // integer minor units (paise) in `amountMinor`, currency INR
  'percent',    // number 0..100 in `percent`
  'days',       // integer in `count`
  'months',     // integer in `count`
  'years',      // integer in `count`
  'count',      // integer in `count` (e.g. number of deliveries, members)
  'boolean',    // `flag`
  'enum',       // one of parameter.enumValues in `enumValue`
  'date',       // ISO yyyy-mm-dd in `date`
  'text',       // short normalised text in `text`
  'text_list',  // array of short strings in `items`
  'rule',       // structured clause with no single scalar; `text` + effect/basis/conditions carry meaning
]);

export const EFFECTS = Object.freeze([
  'pay', 'pay_percent', 'cap_amount', 'cap_per_day', 'deduct', 'exclude',
  'wait_until', 'require', 'void', 'inform',
]);

export const BASES = Object.freeze([
  'per_claim', 'per_illness', 'per_person', 'per_policy_year', 'per_lifetime', 'per_day',
  'per_eye', 'per_joint', 'per_limb', 'per_trip', 'per_event', 'per_policy', 'not_applicable',
]);

// Sentinel the model uses instead of null in enum fields (some providers reject null enum members).
export const NOT_STATED = 'not_stated';

export const VISIBILITY_CLASSES = Object.freeze(['cover', 'operational', 'protected']);
export const SECTION_KINDS = Object.freeze(['extraction', 'analysis']);
export const CONFIDENCE_LEVELS = Object.freeze(['high', 'medium', 'low']);

export const LIMITS = Object.freeze({
  maxParametersPerSection: 80,
  maxCitationsPerParameter: 5,
  maxQuoteCharacters: 600,
  maxTextCharacters: 2_000,
  maxListItems: 60,
  maxConditions: 12,
});

const KEY_PATTERN = /^[a-z][a-z0-9_]{2,63}$/;

export class BreakdownContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BreakdownContractError';
    this.code = code;
  }
}

const fail = (code, message) => { throw new BreakdownContractError(code, message); };
const nonEmpty = (value, name, max = 4_000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail('SECTION_DEFINITION_INVALID', `${name} must be a non-empty string of at most ${max} characters.`);
  return value.trim();
};
const stringList = (value, name, { max = 40, itemMax = 400, allowEmpty = true } = {}) => {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > max || (!allowEmpty && value.length === 0)) fail('SECTION_DEFINITION_INVALID', `${name} must be a list of at most ${max} strings.`);
  return Object.freeze(value.map((item, index) => nonEmpty(item, `${name}[${index}]`, itemMax)));
};
const subsetOf = (value, allowed, name) => {
  const list = value === undefined ? [...allowed] : value;
  if (!Array.isArray(list) || list.length === 0 || list.some(item => !allowed.includes(item))) fail('SECTION_DEFINITION_INVALID', `${name} must be a non-empty subset of: ${allowed.join(', ')}.`);
  return Object.freeze([...new Set(list)]);
};

function defineParameter(sectionNumber, raw, index) {
  const at = `section ${sectionNumber} parameters[${index}]`;
  if (!raw || typeof raw !== 'object') fail('SECTION_DEFINITION_INVALID', `${at} must be an object.`);
  const allowedKeys = new Set([
    'key', 'label', 'description', 'valueType', 'enumValues', 'effects', 'bases', 'critical', 'visibility',
    'memberScoped', 'extractionHints', 'emergencyCard', 'estimateInput', 'validate', 'derivedFrom',
  ]);
  for (const key of Object.keys(raw)) if (!allowedKeys.has(key)) fail('SECTION_DEFINITION_INVALID', `${at} has unknown property ${key}.`);
  if (typeof raw.key !== 'string' || !KEY_PATTERN.test(raw.key)) fail('SECTION_DEFINITION_INVALID', `${at}.key must be snake_case (3–64 chars).`);
  if (!VALUE_TYPES.includes(raw.valueType)) fail('SECTION_DEFINITION_INVALID', `${at}.valueType must be one of ${VALUE_TYPES.join(', ')}.`);
  const enumValues = raw.valueType === 'enum' ? stringList(raw.enumValues, `${at}.enumValues`, { max: 40, itemMax: 64, allowEmpty: false }) : Object.freeze([]);
  if (raw.valueType !== 'enum' && raw.enumValues !== undefined) fail('SECTION_DEFINITION_INVALID', `${at}.enumValues is only allowed for enum parameters.`);
  if (enumValues.some(item => !KEY_PATTERN.test(item) && !/^[a-z0-9_]{1,64}$/.test(item))) fail('SECTION_DEFINITION_INVALID', `${at}.enumValues must be snake_case tokens.`);
  if (raw.validate !== undefined && typeof raw.validate !== 'function') fail('SECTION_DEFINITION_INVALID', `${at}.validate must be a function.`);
  if (!VISIBILITY_CLASSES.includes(raw.visibility)) fail('SECTION_DEFINITION_INVALID', `${at}.visibility must be one of ${VISIBILITY_CLASSES.join(', ')}.`);
  return Object.freeze({
    key: raw.key,
    section: sectionNumber,
    label: nonEmpty(raw.label, `${at}.label`, 120),
    description: nonEmpty(raw.description, `${at}.description`, 1_200),
    valueType: raw.valueType,
    enumValues,
    effects: subsetOf(raw.effects, EFFECTS, `${at}.effects`),
    bases: subsetOf(raw.bases, BASES, `${at}.bases`),
    critical: raw.critical === true,
    visibility: raw.visibility,
    memberScoped: raw.memberScoped === true,
    extractionHints: stringList(raw.extractionHints, `${at}.extractionHints`, { max: 12, itemMax: 300 }),
    emergencyCard: raw.emergencyCard === true,
    estimateInput: raw.estimateInput === true,
    validate: raw.validate ?? null,
    derivedFrom: stringList(raw.derivedFrom, `${at}.derivedFrom`, { max: 20, itemMax: 64 }),
  });
}

/**
 * Declares one of the 12 sections.
 * Extraction sections are read by a model from page-tagged policy text.
 * Analysis sections (10–12) expose a deterministic `analyze(context)` instead.
 */
export function defineSection(raw) {
  if (!raw || typeof raw !== 'object') fail('SECTION_DEFINITION_INVALID', 'Section definition must be an object.');
  const allowedKeys = new Set(['number', 'id', 'title', 'question', 'kind', 'expertise', 'parameters', 'analyze', 'reviewGuidance']);
  for (const key of Object.keys(raw)) if (!allowedKeys.has(key)) fail('SECTION_DEFINITION_INVALID', `Section has unknown property ${key}.`);
  if (!Number.isInteger(raw.number) || raw.number < 1 || raw.number > 12) fail('SECTION_DEFINITION_INVALID', 'Section number must be 1–12.');
  if (typeof raw.id !== 'string' || !/^section-\d{2}-[a-z0-9-]+$/.test(raw.id)) fail('SECTION_DEFINITION_INVALID', 'Section id must look like section-06-money.');
  if (!raw.id.startsWith(`section-${String(raw.number).padStart(2, '0')}-`)) fail('SECTION_DEFINITION_INVALID', 'Section id must match its number.');
  if (!SECTION_KINDS.includes(raw.kind)) fail('SECTION_DEFINITION_INVALID', `Section kind must be one of ${SECTION_KINDS.join(', ')}.`);
  if (raw.kind === 'analysis' && typeof raw.analyze !== 'function') fail('SECTION_DEFINITION_INVALID', 'Analysis sections must provide analyze(context).');
  if (raw.kind === 'extraction' && raw.analyze !== undefined) fail('SECTION_DEFINITION_INVALID', 'Extraction sections must not provide analyze().');
  if (!Array.isArray(raw.parameters) || raw.parameters.length === 0 || raw.parameters.length > LIMITS.maxParametersPerSection) {
    fail('SECTION_DEFINITION_INVALID', `Section must declare 1–${LIMITS.maxParametersPerSection} parameters.`);
  }
  const parameters = raw.parameters.map((parameter, index) => defineParameter(raw.number, parameter, index));
  const seen = new Set();
  for (const parameter of parameters) {
    if (seen.has(parameter.key)) fail('SECTION_DEFINITION_INVALID', `Duplicate parameter key ${parameter.key}.`);
    seen.add(parameter.key);
  }
  return Object.freeze({
    number: raw.number,
    id: raw.id,
    title: nonEmpty(raw.title, 'title', 120),
    question: nonEmpty(raw.question, 'question', 300),
    kind: raw.kind,
    expertise: nonEmpty(raw.expertise, 'expertise', 12_000),
    reviewGuidance: raw.reviewGuidance === undefined ? '' : nonEmpty(raw.reviewGuidance, 'reviewGuidance', 4_000),
    parameters: Object.freeze(parameters),
    analyze: raw.analyze ?? null,
  });
}

// ---------------------------------------------------------------------------
// Model output contract (extraction sections)
// ---------------------------------------------------------------------------

/** JSON schema the section agent must return. Enumerates only that section's keys. */
export function sectionOutputSchema(section) {
  const keys = section.parameters.map(parameter => parameter.key);
  return {
    type: 'object',
    additionalProperties: false,
    required: ['parameters'],
    properties: {
      parameters: {
        type: 'array',
        maxItems: keys.length * 3,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['key', 'found', 'valueText', 'valueNumber', 'valueBoolean', 'valueList', 'unit', 'basis', 'effect', 'memberScope', 'conditions', 'exceptions', 'citations', 'confidence', 'notes'],
          properties: {
            key: { type: 'string', enum: keys },
            found: { type: 'boolean' },
            valueText: { type: ['string', 'null'], maxLength: LIMITS.maxTextCharacters },
            valueNumber: { type: ['number', 'null'] },
            valueBoolean: { type: ['boolean', 'null'] },
            valueList: { type: ['array', 'null'], maxItems: LIMITS.maxListItems, items: { type: 'string', maxLength: 300 } },
            unit: { type: ['string', 'null'], maxLength: 40 },
            basis: { type: 'string', enum: [...BASES, NOT_STATED] },
            effect: { type: 'string', enum: [...EFFECTS, NOT_STATED] },
            memberScope: { type: ['string', 'null'], maxLength: 120 },
            conditions: { type: 'array', maxItems: LIMITS.maxConditions, items: { type: 'string', maxLength: 300 } },
            exceptions: { type: 'array', maxItems: LIMITS.maxConditions, items: { type: 'string', maxLength: 300 } },
            citations: {
              type: 'array',
              maxItems: LIMITS.maxCitationsPerParameter,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['pageNumber', 'quote'],
                properties: {
                  pageNumber: { type: 'integer', minimum: 1 },
                  quote: { type: 'string', minLength: 1, maxLength: LIMITS.maxQuoteCharacters },
                },
              },
            },
            confidence: { type: 'string', enum: CONFIDENCE_LEVELS },
            notes: { type: ['string', 'null'], maxLength: 600 },
          },
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Value normalisation (deterministic; models never decide the stored value)
// ---------------------------------------------------------------------------

const MONEY_MAX_MINOR = 1_000_000_000_00; // ₹100 crore
const isInt = value => Number.isInteger(value);

/**
 * Turns a raw model item into a normalised value for its parameter definition.
 * Returns { ok: true, value } or { ok: false, reason }.
 */
export function normaliseValue(parameter, item) {
  const number = typeof item.valueNumber === 'number' && Number.isFinite(item.valueNumber) ? item.valueNumber : null;
  const text = typeof item.valueText === 'string' ? item.valueText.trim().slice(0, LIMITS.maxTextCharacters) : null;
  let value;
  switch (parameter.valueType) {
    case 'money': {
      if (number === null || number < 0) return { ok: false, reason: 'money_requires_non_negative_rupees_in_valueNumber' };
      const amountMinor = Math.round(number * 100);
      if (amountMinor > MONEY_MAX_MINOR) return { ok: false, reason: 'money_out_of_range' };
      value = { kind: 'money', amountMinor, currency: 'INR' };
      break;
    }
    case 'percent':
      if (number === null || number < 0 || number > 100) return { ok: false, reason: 'percent_must_be_0_to_100' };
      value = { kind: 'percent', percent: Math.round(number * 100) / 100 };
      break;
    case 'days': case 'months': case 'years': case 'count':
      if (number === null || !isInt(number) || number < 0 || number > 100_000) return { ok: false, reason: `${parameter.valueType}_requires_non_negative_integer` };
      value = { kind: parameter.valueType, count: number };
      break;
    case 'boolean':
      if (typeof item.valueBoolean !== 'boolean') return { ok: false, reason: 'boolean_requires_valueBoolean' };
      value = { kind: 'boolean', flag: item.valueBoolean };
      break;
    case 'enum':
      if (!text || !parameter.enumValues.includes(text)) return { ok: false, reason: 'enum_value_not_allowed' };
      value = { kind: 'enum', enumValue: text };
      break;
    case 'date':
      if (!text || !/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) return { ok: false, reason: 'date_requires_iso_yyyy_mm_dd' };
      value = { kind: 'date', date: text };
      break;
    case 'text':
      if (!text) return { ok: false, reason: 'text_required' };
      value = { kind: 'text', text };
      break;
    case 'text_list': {
      const items = Array.isArray(item.valueList) ? item.valueList.map(entry => String(entry).trim()).filter(Boolean).slice(0, LIMITS.maxListItems) : [];
      if (items.length === 0) return { ok: false, reason: 'text_list_requires_items' };
      value = { kind: 'text_list', items };
      break;
    }
    case 'rule':
      if (!text) return { ok: false, reason: 'rule_requires_valueText' };
      value = { kind: 'rule', text };
      break;
    default:
      return { ok: false, reason: 'unsupported_value_type' };
  }
  if (parameter.validate) {
    const problem = parameter.validate(value, item);
    if (problem) return { ok: false, reason: String(problem).slice(0, 200) };
  }
  return { ok: true, value };
}

/** The persisted shape of one parameter in a policy record. */
export function emptyParameterResult(parameter, { reason = 'not_found_in_source_pack' } = {}) {
  return {
    key: parameter.key,
    section: parameter.section,
    label: parameter.label,
    valueType: parameter.valueType,
    value: null,
    unit: null,
    basis: null,
    effect: null,
    memberScope: null,
    conditions: [],
    exceptions: [],
    evidenceState: 'Unknown',
    stateReason: reason,
    citations: [],
    confidence: null,
    critical: parameter.critical,
    visibility: parameter.visibility,
    extraction: null,
    verification: null,
    review: { state: 'unreviewed', by: null, at: null, note: null },
  };
}
