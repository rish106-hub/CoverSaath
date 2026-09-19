import { assertModelTask } from './responsibility-matrix.js';

const SOURCE_STATES = Object.freeze(['known', 'unknown', 'conflict']);
const FACT_STATES = Object.freeze(['known', 'unknown', 'conflict']);
const STATEMENT_KINDS = Object.freeze(['observation', 'unknown']);
const AUTHORITY_OWNERS = Object.freeze(['household', 'employer', 'hospital', 'tpa', 'insurer', 'licensed_adviser']);

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function exactObject(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_schema', `${label} must be an object.`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail('invalid_schema', `${label} has missing or unexpected fields.`);
  }
}

function text(value, max, label) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) fail('invalid_schema', `${label} must be bounded text.`);
}

function boundedArray(value, min, max, label) {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail('invalid_schema', `${label} is outside its item bound.`);
}

function validateCitations(citations, sourceIds, label) {
  if (!Array.isArray(citations) || citations.length === 0) fail('missing_citation', `${label} are required.`);
  boundedArray(citations, 1, 8, label);
  if (new Set(citations).size !== citations.length || citations.some(id => typeof id !== 'string' || !sourceIds.has(id))) {
    fail('missing_citation', `${label} must contain unique supplied source IDs.`);
  }
}

function rejectUnsupportedClaims(value) {
  const body = JSON.stringify(value);
  const patterns = [
    /\bguaranteed\s+(?:coverage|cashless|payout|payment|reimbursement)\b/i,
    /\b(?:claim|cashless)\s+(?:is\s+)?approved\b/i,
    /\binsurer\s+(?:will|must)\s+pay\b/i,
    /\bdefinitely\s+(?:covered|eligible|payable)\b/i,
  ];
  if (patterns.some(pattern => pattern.test(body))) fail('unsupported_claim', 'Output contains unsupported insurance certainty.');
}

export function validateTaskInput(task, input) {
  assertModelTask(task);
  exactObject(input, ['context', 'sources', 'upstream'], 'AI task input');
  exactObject(input.context, ['caseId', 'subjectId', 'purpose', 'requestedFields'], 'AI task context');
  text(input.context.caseId, 160, 'caseId');
  text(input.context.subjectId, 160, 'subjectId');
  text(input.context.purpose, 240, 'purpose');
  boundedArray(input.context.requestedFields, 0, 40, 'requestedFields');
  input.context.requestedFields.forEach(field => text(field, 120, 'requested field'));
  boundedArray(input.sources, 1, 30, 'sources');
  const sourceIds = new Set();
  for (const source of input.sources) {
    exactObject(source, ['id', 'version', 'page', 'text', 'status'], 'source');
    text(source.id, 160, 'source id');
    text(source.version, 120, 'source version');
    if (!(source.page === null || (Number.isInteger(source.page) && source.page >= 1))) fail('invalid_schema', 'Source page must be null or a positive integer.');
    text(source.text, 4000, 'source text');
    if (!SOURCE_STATES.includes(source.status) || sourceIds.has(source.id)) fail('invalid_schema', 'Source state or ID is invalid.');
    sourceIds.add(source.id);
  }
  if (!Array.isArray(input.upstream) || input.upstream.length > 20) fail('invalid_schema', 'upstream must be a bounded array.');
  if (Buffer.byteLength(JSON.stringify(input), 'utf8') > 48_000) fail('input_limit', 'AI task input exceeds the byte limit.');
  return { input: structuredClone(input), sourceIds };
}

function validateFacts(output, sourceIds, requestedFields) {
  exactObject(output, ['facts', 'summary'], 'extraction output');
  boundedArray(output.facts, 0, 30, 'facts');
  text(output.summary, 1200, 'summary');
  const ids = new Set();
  for (const fact of output.facts) {
    exactObject(fact, ['id', 'field', 'value', 'status', 'citations'], 'fact');
    text(fact.id, 120, 'fact id');
    text(fact.field, 120, 'fact field');
    if (ids.has(fact.id) || !FACT_STATES.includes(fact.status)) fail('invalid_schema', 'Fact ID or state is invalid.');
    if (requestedFields.length && !requestedFields.includes(fact.field)) fail('field_not_requested', `Field ${fact.field} was not requested.`);
    if (fact.value !== null && !['string', 'number', 'boolean'].includes(typeof fact.value)) fail('invalid_schema', 'Fact value must be scalar or null.');
    if (fact.status !== 'known' && fact.value !== null) fail('unknown_not_preserved', 'Unknown or conflicting facts must have a null value.');
    validateCitations(fact.citations, sourceIds, 'fact citations');
    ids.add(fact.id);
  }
}

function validateSynthesis(output, sourceIds, unknownSourceIds) {
  exactObject(output, ['statements', 'unknowns', 'summary'], 'synthesis output');
  boundedArray(output.statements, 0, 16, 'statements');
  boundedArray(output.unknowns, 0, 16, 'unknowns');
  text(output.summary, 1200, 'summary');
  for (const statement of output.statements) {
    exactObject(statement, ['id', 'text', 'kind', 'citations'], 'statement');
    text(statement.id, 120, 'statement id');
    text(statement.text, 800, 'statement text');
    if (!STATEMENT_KINDS.includes(statement.kind)) fail('invalid_schema', 'Statement kind is invalid.');
    validateCitations(statement.citations, sourceIds, 'statement citations');
  }
  const coveredUnknowns = new Set();
  for (const unknown of output.unknowns) {
    exactObject(unknown, ['id', 'text', 'citations'], 'unknown');
    text(unknown.id, 120, 'unknown id');
    text(unknown.text, 800, 'unknown text');
    validateCitations(unknown.citations, sourceIds, 'unknown citations');
    unknown.citations.forEach(id => coveredUnknowns.add(id));
  }
  if (unknownSourceIds.some(id => !coveredUnknowns.has(id))) fail('unknown_not_preserved', 'Every unknown source must remain visible in synthesis.');
}

function validateQuestions(output, sourceIds, unknownSourceIds) {
  exactObject(output, ['questions', 'unresolvedSourceIds'], 'question output');
  boundedArray(output.questions, 0, 16, 'questions');
  boundedArray(output.unresolvedSourceIds, 0, 30, 'unresolvedSourceIds');
  for (const question of output.questions) {
    exactObject(question, ['id', 'text', 'authorityOwner', 'citations'], 'question');
    text(question.id, 120, 'question id');
    text(question.text, 600, 'question text');
    if (!question.text.endsWith('?') || !AUTHORITY_OWNERS.includes(question.authorityOwner)) fail('invalid_schema', 'Question text or authority owner is invalid.');
    validateCitations(question.citations, sourceIds, 'question citations');
  }
  const unresolved = new Set(output.unresolvedSourceIds);
  if (output.unresolvedSourceIds.some(id => !sourceIds.has(id)) || unknownSourceIds.some(id => !unresolved.has(id))) {
    fail('unknown_not_preserved', 'Question output must preserve every unresolved source ID.');
  }
}

export function validateTaskOutput(task, output, input) {
  const { sourceIds } = validateTaskInput(task, input);
  const unknownSourceIds = input.sources.filter(source => source.status !== 'known').map(source => source.id);
  if (task.endsWith('_extraction')) validateFacts(output, sourceIds, input.context.requestedFields);
  else if (task === 'evidence_synthesis') validateSynthesis(output, sourceIds, unknownSourceIds);
  else if (task === 'question_drafting') validateQuestions(output, sourceIds, unknownSourceIds);
  rejectUnsupportedClaims(output);
  return structuredClone(output);
}

const citationsSchema = { type: 'array', minItems: 1, maxItems: 8, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 160 } };
const factSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'field', 'value', 'status', 'citations'],
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 120 },
    field: { type: 'string', minLength: 1, maxLength: 120 },
    value: { type: ['string', 'number', 'boolean', 'null'] },
    status: { type: 'string', enum: FACT_STATES },
    citations: citationsSchema,
  },
};
const extractionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['facts', 'summary'],
  properties: {
    facts: { type: 'array', maxItems: 30, items: factSchema },
    summary: { type: 'string', minLength: 1, maxLength: 1200 },
  },
};

export const TASK_OUTPUT_SCHEMAS = Object.freeze({
  profile_extraction: extractionSchema,
  group_cover_extraction: extractionSchema,
  personal_cover_extraction: extractionSchema,
  evidence_synthesis: {
    type: 'object', additionalProperties: false, required: ['statements', 'unknowns', 'summary'], properties: {
      statements: { type: 'array', maxItems: 16, items: { type: 'object', additionalProperties: false, required: ['id', 'text', 'kind', 'citations'], properties: { id: { type: 'string', minLength: 1, maxLength: 120 }, text: { type: 'string', minLength: 1, maxLength: 800 }, kind: { type: 'string', enum: STATEMENT_KINDS }, citations: citationsSchema } } },
      unknowns: { type: 'array', maxItems: 16, items: { type: 'object', additionalProperties: false, required: ['id', 'text', 'citations'], properties: { id: { type: 'string', minLength: 1, maxLength: 120 }, text: { type: 'string', minLength: 1, maxLength: 800 }, citations: citationsSchema } } },
      summary: { type: 'string', minLength: 1, maxLength: 1200 },
    },
  },
  question_drafting: {
    type: 'object', additionalProperties: false, required: ['questions', 'unresolvedSourceIds'], properties: {
      questions: { type: 'array', maxItems: 16, items: { type: 'object', additionalProperties: false, required: ['id', 'text', 'authorityOwner', 'citations'], properties: { id: { type: 'string', minLength: 1, maxLength: 120 }, text: { type: 'string', minLength: 1, maxLength: 600 }, authorityOwner: { type: 'string', enum: AUTHORITY_OWNERS }, citations: citationsSchema } } },
      unresolvedSourceIds: { type: 'array', maxItems: 30, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 160 } },
    },
  },
});
