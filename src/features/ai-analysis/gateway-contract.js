// Provider-routing gateway tasks (ADR 0030): chat_answer, intent_classify, fact_extract, embed.
// Data only: closed vocabularies, JSON output schemas and the typed-unknown builder. Validation lives in schemas.js.
// Model output status is only extracted_unverified, conflicting or unknown (src/contracts/ai-authority.js).

export const CHAT_ANSWER_TASK = 'chat_answer';
export const INTENT_CLASSIFY_TASK = 'intent_classify';
export const FACT_EXTRACT_TASK = 'fact_extract';
export const EMBED_TASK = 'embed';
export const GATEWAY_TASK_LIST = Object.freeze([CHAT_ANSWER_TASK, INTENT_CLASSIFY_TASK, FACT_EXTRACT_TASK, EMBED_TASK]);
export function isGatewayTask(task) { return GATEWAY_TASK_LIST.includes(task); }

export const MODEL_STATUSES = Object.freeze(['extracted_unverified', 'conflicting', 'unknown']);
export const CHAT_INTENTS = Object.freeze([
  'coverage_question', 'waiting_period', 'sub_limit', 'procedure_planning', 'claim_process', 'premium_due', 'document_help', 'general', 'unknown',
]);
export const MAX_EMBED_TEXTS = 64;
export const MAX_EMBED_DIMENSIONS = 4096;

export const GATEWAY_PAYLOAD_KEYS = Object.freeze({
  [CHAT_ANSWER_TASK]: ['question', 'history', 'facts'],
  [INTENT_CLASSIFY_TASK]: ['text', 'intents'],
  [FACT_EXTRACT_TASK]: ['text', 'keys'],
  [EMBED_TASK]: ['texts'],
});

export const GATEWAY_INSTRUCTIONS = Object.freeze({
  [CHAT_ANSWER_TASK]: 'You answer one household insurance question in plain language using only the supplied facts. Placeholders such as {{PERSON_1}} or <NAME_1> stand for redacted personal data: keep them as printed. List the fact_id of every fact you used in factsUsed. If the facts do not answer the question, set status to unknown and say what is missing. Never state a number that is not in a fact. status is extracted_unverified or unknown.',
  [INTENT_CLASSIFY_TASK]: 'You label one household question with exactly one intent from the supplied list, or unknown. The label is an unverified hint. status is extracted_unverified or unknown.',
  [FACT_EXTRACT_TASK]: 'You propose values for the requested fact keys from the supplied text. For each fact copy quote verbatim from the text and keep the value as printed. Omit a key the text does not state. status is extracted_unverified, conflicting (the text states two different values) or unknown.',
  [EMBED_TASK]: 'Embedding request for already gated text.',
});

const status = { type: 'string', enum: MODEL_STATUSES };
export const GATEWAY_OUTPUT_SCHEMAS = Object.freeze({
  [CHAT_ANSWER_TASK]: {
    type: 'object', additionalProperties: false, required: ['status', 'answer', 'factsUsed'], properties: {
      status, answer: { type: 'string', minLength: 1, maxLength: 2000 },
      factsUsed: { type: 'array', maxItems: 60, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 64 } },
    },
  },
  [INTENT_CLASSIFY_TASK]: {
    type: 'object', additionalProperties: false, required: ['status', 'intent'], properties: { status, intent: { type: 'string', enum: CHAT_INTENTS } },
  },
  [FACT_EXTRACT_TASK]: {
    type: 'object', additionalProperties: false, required: ['status', 'facts'], properties: {
      status,
      facts: { type: 'array', maxItems: 40, items: {
        type: 'object', additionalProperties: false, required: ['key', 'value', 'quote', 'status'],
        properties: { key: { type: 'string', minLength: 1, maxLength: 80 }, value: { type: ['string', 'null'], maxLength: 400 }, quote: { type: 'string', maxLength: 600 }, status },
      } },
    },
  },
  [EMBED_TASK]: {
    type: 'object', additionalProperties: false, required: ['status', 'dimensions', 'vectors'], properties: {
      status, dimensions: { type: 'integer', minimum: 0, maximum: MAX_EMBED_DIMENSIONS },
      vectors: { type: 'array', maxItems: MAX_EMBED_TEXTS, items: { type: 'array', maxItems: MAX_EMBED_DIMENSIONS, items: { type: 'number' } } },
    },
  },
});

/** The typed `unknown` answer for a task: what an unconfigured or flag-off provider returns instead of calling out. */
export function unknownOutput(task) {
  switch (task) {
    case CHAT_ANSWER_TASK: return { status: 'unknown', answer: 'No model answer is available right now.', factsUsed: [] };
    case INTENT_CLASSIFY_TASK: return { status: 'unknown', intent: 'unknown' };
    case FACT_EXTRACT_TASK: return { status: 'unknown', facts: [] };
    case EMBED_TASK: return { status: 'unknown', dimensions: 0, vectors: [] };
    default: throw Object.assign(new Error(`No unknown output for ${task}.`), { code: 'unsupported_ai_task' });
  }
}
