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

/** Name the prompt's output-contract block refers to; bump when the shape below changes. */
export const SECTION_OUTPUT_SCHEMA_NAME = 'knowvia.breakdown.section-output/v2';

/** Every field of a model item, in schema order. Only `key` and `found` are required (compact abstain). */
export const MODEL_ITEM_FIELDS = Object.freeze(['key', 'found', 'valueText', 'valueNumber', 'valueBoolean', 'valueList', 'unit', 'basis', 'effect', 'memberScope', 'conditions', 'exceptions', 'citations', 'confidence', 'notes']);
export const MAX_OPEN_QUESTIONS = 5;

/**
 * JSON schema the section agent must return. Enumerates only that section's keys.
 * v2: not-found items may be the compact abstain shape { key, found:false }; every other field is optional in
 * the schema and the prompt requires all of them when found=true. Assembly already treats a missing field as
 * empty, and a found=true item without citations or a value can never become Proven (fail-safe).
 */
export function sectionOutputSchema(section) {
  const keys = section.parameters.map(parameter => parameter.key);
  return {
    type: 'object',
    additionalProperties: false,
    required: ['parameters'],
    properties: {
      parameters: {
        // No top-level maxItems: Gemini 3.x rejects it (HTTP 400 INVALID_ARGUMENT, verified 2026-10-07).
        // The per-section cap (keys × 3) is enforced deterministically in assembleExtractionSection.
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['key', 'found'],
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
      openQuestions: { type: 'array', maxItems: MAX_OPEN_QUESTIONS, items: { type: 'string', maxLength: 300 } },
    },
  };
}

// ---------------------------------------------------------------------------
// Compact abstain normalisation (deterministic; downstream always sees the full item shape)
// ---------------------------------------------------------------------------

const listOrEmpty = value => (Array.isArray(value) ? value : []);
const valueOrNull = value => (value === undefined ? null : value);

/** Expands a model item (possibly the compact `{ key, found:false }`) to the full item shape. */
export function expandModelItem(item) {
  if (!item || typeof item !== 'object') return item;
  return {
    key: item.key,
    found: item.found === true,
    valueText: valueOrNull(item.valueText),
    valueNumber: valueOrNull(item.valueNumber),
    valueBoolean: valueOrNull(item.valueBoolean),
    valueList: valueOrNull(item.valueList),
    unit: valueOrNull(item.unit),
    basis: item.basis ?? NOT_STATED,
    effect: item.effect ?? NOT_STATED,
    memberScope: valueOrNull(item.memberScope),
    conditions: listOrEmpty(item.conditions),
    exceptions: listOrEmpty(item.exceptions),
    citations: listOrEmpty(item.citations),
    confidence: valueOrNull(item.confidence),
    notes: valueOrNull(item.notes),
  };
}

const MANDATORY_FOUND_FIELDS = new Set(['key', 'found', 'unit', 'basis', 'effect', 'citations', 'confidence']);
const isEmptyField = value => value === null || value === undefined || (Array.isArray(value) && value.length === 0);

/**
 * The compact wire shape the v2 prompt asks for: a not-found item becomes `{ key, found:false }`; a found item
 * drops optional fields that are null or empty. expandModelItem() is its inverse for everything assembly reads.
 */
export function compactModelItem(item) {
  if (!item || typeof item !== 'object') return item;
  if (item.found !== true) return { key: item.key, found: false };
  return Object.fromEntries(Object.entries(item).filter(([field, value]) => MANDATORY_FOUND_FIELDS.has(field) || !isEmptyField(value)));
}

/** Normalises a raw section output: full item shapes plus a bounded openQuestions list. */
export function normaliseSectionOutput(output) {
  const parameters = Array.isArray(output?.parameters) ? output.parameters.map(expandModelItem) : [];
  const openQuestions = listOrEmpty(output?.openQuestions)
    .filter(question => typeof question === 'string' && question.trim())
    .map(question => question.trim().slice(0, 300))
    .slice(0, MAX_OPEN_QUESTIONS);
  return { parameters, openQuestions };
}

// ---------------------------------------------------------------------------
// Agent handoff envelope `knowvia.handoff/v1`
// The model emits only items (+ open questions); code fills every other field. Validated before the next
// agent or the assembler reads it. Spec: docs/ai/prompt-contract.md.
// ---------------------------------------------------------------------------

export const HANDOFF_SCHEMA = 'knowvia.handoff/v1';
export const HANDOFF_STATUSES = Object.freeze(['ok', 'partial', 'abstain', 'error']);
const HANDOFF_KEYS = Object.freeze(['schema', 'job_id', 'agent', 'next', 'status', 'prompt_version', 'model', 'items', 'open_questions', 'usage']);
const HANDOFF_USAGE_KEYS = Object.freeze(['input_tokens', 'cached_tokens', 'output_tokens', 'cost_micro_usd']);
const HANDOFF_MAX_ITEMS = LIMITS.maxParametersPerSection * 3;
const HANDOFF_MAX_OPEN_QUESTIONS = 10;
const AGENT_PATTERN = /^[a-z0-9][a-z0-9._:-]{1,95}$/;
const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROMPT_VERSION_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;

const handoffFail = message => fail('HANDOFF_INVALID', message);
const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonNegativeInteger = value => Number.isSafeInteger(value) && value >= 0;

function validateHandoffItem(item, index) {
  const at = `items[${index}]`;
  if (!isPlainObject(item)) handoffFail(`${at} must be an object.`);
  for (const key of Object.keys(item)) if (!MODEL_ITEM_FIELDS.includes(key)) handoffFail(`${at} has unknown field ${key}.`);
  if (typeof item.key !== 'string' || !KEY_PATTERN.test(item.key)) handoffFail(`${at}.key must be a snake_case parameter key.`);
  if (typeof item.found !== 'boolean') handoffFail(`${at}.found must be a boolean.`);
  if (item.citations !== undefined) {
    if (!Array.isArray(item.citations) || item.citations.length > LIMITS.maxCitationsPerParameter) handoffFail(`${at}.citations must be a list of at most ${LIMITS.maxCitationsPerParameter}.`);
    item.citations.forEach((citation, position) => {
      if (!isPlainObject(citation) || Object.keys(citation).some(key => !['pageNumber', 'quote'].includes(key))) handoffFail(`${at}.citations[${position}] must be { pageNumber, quote }.`);
      if (!Number.isInteger(citation.pageNumber) || citation.pageNumber < 1) handoffFail(`${at}.citations[${position}].pageNumber must be a positive integer.`);
      if (typeof citation.quote !== 'string' || !citation.quote || citation.quote.length > LIMITS.maxQuoteCharacters) handoffFail(`${at}.citations[${position}].quote must be 1–${LIMITS.maxQuoteCharacters} characters.`);
    });
  }
  if (item.confidence != null && !CONFIDENCE_LEVELS.includes(item.confidence)) handoffFail(`${at}.confidence must be one of ${CONFIDENCE_LEVELS.join(', ')}.`);
}

/**
 * Strict validator. Returns the envelope unchanged when valid; throws BreakdownContractError
 * (code HANDOFF_INVALID) on unknown keys, wrong enums, non-integer usage or inconsistent status.
 */
export function validateHandoff(envelope) {
  if (!isPlainObject(envelope)) handoffFail('Handoff envelope must be an object.');
  for (const key of Object.keys(envelope)) if (!HANDOFF_KEYS.includes(key)) handoffFail(`Handoff has unknown key ${key}.`);
  for (const key of HANDOFF_KEYS) if (!(key in envelope)) handoffFail(`Handoff is missing ${key}.`);
  if (envelope.schema !== HANDOFF_SCHEMA) handoffFail(`schema must be ${HANDOFF_SCHEMA}.`);
  if (typeof envelope.job_id !== 'string' || !JOB_ID_PATTERN.test(envelope.job_id)) handoffFail('job_id must be 1–128 safe characters.');
  if (typeof envelope.agent !== 'string' || !AGENT_PATTERN.test(envelope.agent)) handoffFail('agent must be a lowercase agent name such as section-04-treatment:extractor.');
  if (envelope.next !== null && (typeof envelope.next !== 'string' || !AGENT_PATTERN.test(envelope.next))) handoffFail('next must be an agent name or null.');
  if (!HANDOFF_STATUSES.includes(envelope.status)) handoffFail(`status must be one of ${HANDOFF_STATUSES.join(', ')}.`);
  if (typeof envelope.prompt_version !== 'string' || !PROMPT_VERSION_PATTERN.test(envelope.prompt_version)) handoffFail('prompt_version must be a lowercase version token.');
  if (typeof envelope.model !== 'string' || !MODEL_PATTERN.test(envelope.model)) handoffFail('model must be a model identifier.');
  if (!Array.isArray(envelope.items) || envelope.items.length > HANDOFF_MAX_ITEMS) handoffFail(`items must be a list of at most ${HANDOFF_MAX_ITEMS}.`);
  envelope.items.forEach(validateHandoffItem);
  if (!Array.isArray(envelope.open_questions) || envelope.open_questions.length > HANDOFF_MAX_OPEN_QUESTIONS
    || envelope.open_questions.some(question => typeof question !== 'string' || !question.trim() || question.length > 300)) {
    handoffFail(`open_questions must be at most ${HANDOFF_MAX_OPEN_QUESTIONS} non-empty strings of ≤300 characters.`);
  }
  const { usage } = envelope;
  if (!isPlainObject(usage)) handoffFail('usage must be an object.');
  for (const key of Object.keys(usage)) if (!HANDOFF_USAGE_KEYS.includes(key)) handoffFail(`usage has unknown key ${key}.`);
  for (const key of HANDOFF_USAGE_KEYS) if (!nonNegativeInteger(usage[key])) handoffFail(`usage.${key} must be a non-negative integer.`);
  if (usage.cached_tokens > usage.input_tokens) handoffFail('usage.cached_tokens cannot exceed usage.input_tokens.');
  const anyFound = envelope.items.some(item => item.found === true);
  if (envelope.status === 'abstain' && anyFound) handoffFail('status abstain cannot carry found=true items.');
  if (envelope.status === 'error' && envelope.items.length > 0) handoffFail('status error cannot carry items.');
  if (envelope.status === 'ok' && envelope.items.length === 0) handoffFail('status ok requires items.');
  return envelope;
}

const usageInteger = (value, name) => {
  const number = value ?? 0;
  if (!nonNegativeInteger(number)) handoffFail(`usage.${name} must be a non-negative integer.`);
  return number;
};

/**
 * Wraps one agent's model output in the handoff envelope. The model supplies only `items` (its `parameters`)
 * and `openQuestions`; everything else comes from code. Items are expanded to the full shape so the next reader
 * never sees the compact abstain form. `status` defaults to ok (any found item) or abstain (none).
 * usage: { inputTokens, cachedTokens, outputTokens, costMicroUsd } (or costUsd, converted to micro-USD).
 */
export function wrapHandoff({ jobId, agent, next = null, status, promptVersion, model, items = [], openQuestions = [], usage = {} } = {}) {
  if (!Array.isArray(items)) handoffFail('items must be a list.');
  const expanded = items.map(expandModelItem);
  const costMicroUsd = usage.costMicroUsd ?? (typeof usage.costUsd === 'number' && Number.isFinite(usage.costUsd) && usage.costUsd >= 0 ? Math.round(usage.costUsd * 1_000_000) : 0);
  const envelope = {
    schema: HANDOFF_SCHEMA,
    job_id: jobId,
    agent,
    next,
    status: status ?? (expanded.some(item => item.found) ? 'ok' : 'abstain'),
    prompt_version: promptVersion,
    model,
    items: expanded,
    open_questions: Array.isArray(openQuestions) ? openQuestions.map(question => (typeof question === 'string' ? question.trim() : question)) : openQuestions,
    usage: {
      input_tokens: usageInteger(usage.inputTokens, 'input_tokens'),
      cached_tokens: usageInteger(usage.cachedTokens, 'cached_tokens'),
      output_tokens: usageInteger(usage.outputTokens, 'output_tokens'),
      cost_micro_usd: usageInteger(costMicroUsd, 'cost_micro_usd'),
    },
  };
  return validateHandoff(envelope);
}

// ---------------------------------------------------------------------------
// Value normalisation (deterministic; models never decide the stored value)
// ---------------------------------------------------------------------------

const MONEY_MAX_MINOR = 1_000_000_000_00; // ₹100 crore
const isInt = value => Number.isInteger(value);
const enumSlug = text => (text ? String(text).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') : null);

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
    case 'enum': {
      // Models sometimes return the label form ("India only"); accept it only when it maps exactly to one enum value.
      const enumValue = parameter.enumValues.includes(text) ? text : enumSlug(text);
      if (!enumValue || !parameter.enumValues.includes(enumValue)) return { ok: false, reason: 'enum_value_not_allowed' };
      value = { kind: 'enum', enumValue };
      break;
    }
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
