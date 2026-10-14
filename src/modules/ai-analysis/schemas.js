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

// Unsupported-certainty language. A model may never itself state or imply
// approval, guaranteed coverage or guaranteed payment; only the institution with
// authority can. The check applies to model-authored assertions (summaries,
// statements, unknowns, ids and unquoted values). Interrogative question
// sentences, and policy wording the model quotes verbatim from a supplied
// source, are not model assertions and are exempt. Text is normalised first
// (NFKC, format characters removed, Cyrillic/Greek look-alikes folded, Latin
// diacritics stripped) so obfuscated spellings cannot bypass the patterns.
// Optional negation within three words before a match ("shall not be liable to pay").
const NOT_NEGATED = String.raw`(?<!\b(?:not|never|no|cannot|can't|won't|isn't|aren't)\s+(?:\w+\s+){0,2})`;
const UNSUPPORTED_CERTAINTY_PATTERNS = Object.freeze([
  /\bguaranteed\s+(?:coverage|cashless|payout|payment|reimbursement)\b/i,
  /\b(?:claim|cashless)\s+(?:is\s+)?approved\b/i,
  /\binsurer\s+(?:will|must)\s+pay\b/i,
  /\bdefinitely\s+(?:covered|eligible|payable)\b/i,
  // Bare guarantee language ("guaranteed", "we guarantee").
  /\bguarantee(?:d|s)?\b/i,
  /\bwill\s+(?:definitely\s+|surely\s+|certainly\s+|always\s+)?be\s+(?:approved|sanctioned|covered|paid|reimbursed|settled|cashless)\b/i,
  /\b(?:claims?|cashless|pre-?auth(?:ori[sz]ation)?|reimbursement)\s+(?:request\s+)?(?:is\s+|are\s+|has\s+been\s+|have\s+been\s+|was\s+|were\s+)?(?:approved|sanctioned)\b/i,
  /\b(?:100|hundred)\s*(?:%|percent|per\s+cent)\s*(?:covered|coverage|cover|payable|paid|reimburs\w*|approved|cashless|claim\s+approval)\b/i,
  /\b(?:fully|completely|totally|entirely)\s+covered\s+for\s+sure\b/i,
  /\bcovered\s+for\s+sure\b/i,
  /\b(?:certainly|surely|assuredly|absolutely)\s+(?:be\s+)?(?:covered|eligible|payable|approved|paid|reimbursed)\b/i,
  /\binsurer\s+(?:will|must|shall)\s+(?:pay|approve|cover|reimburse|settle)\b/i,
  // "no / zero / nil risk of rejection".
  /\b(?:no|zero|nil|without\s+any|not\s+any)\s+(?:chance|risk|possibility|probability|scope)\s+of\s+(?:claim\s+|any\s+)?(?:rejection|denial|repudiation|being\s+(?:rejected|denied))\b/i,
  // "Your claim is assured", "assured payout"; "sum assured" is not matched.
  new RegExp(`${NOT_NEGATED}\\b(?:is|are|was|were|be|been|being|stands?|remains?)\\s+(?:fully\\s+|completely\\s+)?assured\\b`, 'i'),
  /\bassured(?:ly)?\s+(?:coverage|cover|payout|payment|approval|settlement|reimbursement|cashless)\b/i,
  // "insurer is obligated to pay", "the company is bound to settle".
  new RegExp(`${NOT_NEGATED}\\b(?:obligated|obliged|duty[- ]bound)\\s+to\\s+(?:pay|approve|cover|reimburse|settle|accept|honou?r)\\b`, 'i'),
  new RegExp(`${NOT_NEGATED}\\b(?:insurer|insurance\\s+company|company|tpa|we|they)\\s+(?:is|are|will\\s+be|shall\\s+be|would\\s+be|remains?)\\s+(?:legally\\s+)?(?:bound|liable|required|committed)\\s+to\\s+(?:pay|approve|cover|reimburse|settle|accept|honou?r)\\b`, 'i'),
  // "certain to be covered", "sure to be paid".
  new RegExp(`${NOT_NEGATED}\\b(?:certain|sure|bound|assured)\\s+to\\s+(?:be\\s+)?(?:covered|approved|paid|reimbursed|settled|accepted|sanctioned|cleared|passed)\\b`, 'i'),
  // "The claim stands approved", "deemed sanctioned".
  new RegExp(`${NOT_NEGATED}\\b(?:stands?|deemed|considered)\\s+(?:as\\s+)?(?:approved|sanctioned|accepted|cleared|settled)\\b`, 'i'),
  // Hindi (Devanagari) and Hinglish equivalents. "स्वीकृत अस्पताल" (approved
  // hospital list) is permitted wording and removed before matching.
  /गारंटी|पक्का|पक्की|मंजूर|मंज़ूर|स्वीकृत|अप्रूव/u,
  /\bpakk(?:a|i|aa)\b/i,
  /\bclaim\s+(?:pass|approve|manjoor|manzoor|sanction)\s+ho\s+(?:jayega|jaayega|jaega|jayegi|gaya|gayi)\b/i,
  /\b(?:guarantee|guaranteed)\s+(?:hai|he|h)\b/i,
  /\b(?:100\s*%|poora|pura|poori|puri)\s+(?:cover|covered|paisa)\s+(?:milega|hoga|ho\s+jayega)\b/i,
]);
// Policy feature names that legitimately contain certainty words (the registry
// parameter "Guaranteed / loyalty bonus", lifelong renewability, life-cover
// "Guaranteed Surrender Value", the "approved hospital list"), plus explicit
// negations ("not guaranteed", "no guarantee"). These are removed before
// matching; every other use of certainty language fails.
const PERMITTED_CERTAINTY_WORDING = [
  /\bguaranteed\s*(?:\/\s*loyalty\s+|cumulative\s+|loyalty\s+|no[- ]claims?\s+)?(?:bonus|renewal|renewability|lifelong\s+renewal)\b/gi,
  /\bguaranteed\s+(?:surrender\s+value|additions?|(?:lifelong|life-?long|lifetime)\s+renewab\w*)\b/gi,
  /\b(?:renewal|renewability)\s+(?:is\s+)?guaranteed(?:\s+(?:for\s+life|lifelong|for\s+lifetime))?\b/gi,
  /\b(?:lifelong|life-?long|lifetime)\s+(?:renewal|renewability)\s+(?:is\s+)?guaranteed\b/gi,
  /\b(?:not|never|no|without|cannot\s+be|can't\s+be|isn't|is\s+not|are\s+not|aren't)\s+(?:a\s+|any\s+)?guarantee(?:d|s)?\b/gi,
  /(?:स्वीकृत|मंजूर|मंज़ूर|अप्रूव्ड|अप्रूव)\s+(?:अस्पताल|अस्पतालों|नेटवर्क|सूची|प्रदाता)/gu,
];

// Look-alike letters from Cyrillic and Greek that render as Latin letters.
const CONFUSABLE_LETTERS = new Map(Object.entries({
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', і: 'i', ј: 'j', ѕ: 's', һ: 'h', ԁ: 'd', ӏ: 'l', ԛ: 'q', ԝ: 'w',
  А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', У: 'Y', Х: 'X', І: 'I', Ј: 'J', Ѕ: 'S',
  α: 'a', ε: 'e', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x',
  Α: 'A', Β: 'B', Ε: 'E', Ζ: 'Z', Η: 'H', Ι: 'I', Κ: 'K', Μ: 'M', Ν: 'N', Ο: 'O', Ρ: 'P', Τ: 'T', Υ: 'Y', Χ: 'X',
  ɑ: 'a', ɡ: 'g', ı: 'i',
}));
const CONFUSABLE_PATTERN = new RegExp(`[${[...CONFUSABLE_LETTERS.keys()].join('')}]`, 'gu');

function normalizeCertaintyText(value) {
  return String(value)
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .replace(CONFUSABLE_PATTERN, letter => CONFUSABLE_LETTERS.get(letter))
    .normalize('NFD')
    .replace(/(?<=[A-Za-z])\p{M}+/gu, '')
    .normalize('NFC')
    .replace(/\s+/gu, ' ');
}

// Comparable form for verbatim-quote checks. Source text may be JSON-encoded.
function comparableText(value) {
  return normalizeCertaintyText(String(value).replace(/\\[nrt]/g, ' ').replace(/\\(["\\/])/g, '$1'))
    .replace(/[“”„«»]/gu, '"')
    .replace(/[‘’]/gu, "'")
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const MIN_QUOTE_LENGTH = 12;
function quotedFrom(text, sourceTexts) {
  const quote = comparableText(text).replace(/^["'\s]+/, '').replace(/(?:\.{3}|…|["'\s.,;:!])+$/u, '');
  return quote.length >= MIN_QUOTE_LENGTH && sourceTexts.some(source => source.includes(quote));
}

function hasUnsupportedCertainty(text) {
  let body = normalizeCertaintyText(text);
  for (const pattern of PERMITTED_CERTAINTY_WORDING) body = body.replace(pattern, ' ');
  return UNSUPPORTED_CERTAINTY_PATTERNS.some(pattern => pattern.test(body));
}

// Spans in quotation marks that reproduce supplied source wording are removed
// from a model-authored assertion before it is checked.
const QUOTED_SPAN = /"([^"]{1,800})"|“([^”]{1,800})”|‘([^’]{1,800})’|'([^']{1,800})'/gu;
function assertionHasUnsupportedCertainty(text, sourceTexts) {
  const withoutQuotes = normalizeCertaintyText(text).replace(QUOTED_SPAN, (match, ...groups) => {
    const quoted = groups.slice(0, 4).find(group => group !== undefined);
    return quotedFrom(quoted, sourceTexts) ? ' ' : match;
  });
  return hasUnsupportedCertainty(withoutQuotes);
}

const INTERROGATIVE_START = /^(?:is|are|was|were|will|would|can|could|does|do|did|has|have|had|should|shall|may|might|must|what|which|when|where|why|how|who|whom|whose|please|kindly|kya|kab|kaise|kitna|kitni|kaun|kyun|क्या|कब|कैसे|कितना|कितनी|कितने|कौन|किस|किसे|क्यों|कहाँ|कहां)(?![\p{L}\p{M}\p{N}])/iu;
const CONDITIONAL_QUESTION = /^(?:if|for|under|in|at|on|during|after|before|given|assuming|as|to|with|since)\b[^?]*,\s*(?:is|are|was|were|will|would|can|could|does|do|did|has|have|should|shall|may|what|which|when|where|why|how|who)\b/iu;
const TAG_QUESTION = /,\s*(?:isn't|aren't|wasn't|won't|isn't\s+it|right|correct|no|yes|ok|okay|na|hai\s+na|true)\s*\?$/iu;

// A question sentence ends with '?', opens with an interrogative (or a
// conditional clause followed by one) and is not a tag question ("..., right?").
function isQuestionSentence(sentence) {
  const trimmed = sentence.trim();
  return trimmed.endsWith('?') && !TAG_QUESTION.test(trimmed)
    && (INTERROGATIVE_START.test(trimmed) || CONDITIONAL_QUESTION.test(trimmed));
}

function questionHasUnsupportedCertainty(text, sourceTexts) {
  return normalizeCertaintyText(text).split(/(?<=[.!?।])\s+/u)
    .some(sentence => !isQuestionSentence(sentence) && assertionHasUnsupportedCertainty(sentence, sourceTexts));
}

function rejectUnsupportedClaims(task, output, input) {
  const sourceTexts = input.sources.map(source => comparableText(source.text));
  const sourceTextById = new Map(input.sources.map((source, index) => [source.id, sourceTexts[index]]));
  const requestedFields = new Set(input.context.requestedFields);
  const findings = [];
  const check = (text, kind, citations = []) => {
    if (typeof text !== 'string') return;
    if (kind === 'value') {
      // A value the model reproduces verbatim from one of its cited sources is
      // extracted evidence (unverified), not a model assertion.
      const cited = citations.map(id => sourceTextById.get(id)).filter(Boolean);
      if (quotedFrom(text, cited)) return;
    }
    const unsupported = kind === 'question'
      ? questionHasUnsupportedCertainty(text, sourceTexts)
      : assertionHasUnsupportedCertainty(text, sourceTexts);
    if (unsupported) findings.push(kind);
  };
  if (task.endsWith('_extraction')) {
    check(output.summary, 'assertion');
    for (const fact of output.facts) {
      check(fact.id, 'assertion');
      if (!requestedFields.has(fact.field)) check(fact.field, 'assertion');
      check(fact.value, 'value', fact.citations);
    }
  } else if (task === 'evidence_synthesis') {
    check(output.summary, 'assertion');
    for (const item of [...output.statements, ...output.unknowns]) {
      check(item.id, 'assertion');
      check(item.text, 'assertion');
    }
  } else if (task === 'question_drafting') {
    for (const question of output.questions) {
      check(question.id, 'assertion');
      check(question.text, 'question');
    }
  } else {
    check(JSON.stringify(output), 'assertion');
  }
  if (findings.length > 0) fail('unsupported_claim', 'Output contains unsupported insurance certainty.');
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
  rejectUnsupportedClaims(task, output, input);
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
