// Chat v0 contract (P7a). Deterministic, cited, no model. The one place that defines what a chat response may point to:
// routes and labels come from this fixed allowlist, never from user text.

export const CHAT_MESSAGE_MAX = 500;
export const CHAT_PAGE_PATTERN = /^\/[a-z0-9/_-]{0,64}$/;
export const CHAT_REQUEST_KEYS = Object.freeze(['message', 'page']);
export const CHAT_ANSWER_STATUSES = Object.freeze(['evidence_found', 'unknown', 'out_of_scope']);
export const CHAT_SOURCE_TIERS = Object.freeze(['household_evidence', 'reference', 'none']);

// In-app paths of the beta app. Keys are internal; values are the only route and button label a reply may carry.
export const CHAT_ROUTES = Object.freeze({
  documents: Object.freeze({ route: '/documents', goLabel: 'Open documents' }),
  claims: Object.freeze({ route: '/claims', goLabel: 'Open claims' }),
  family: Object.freeze({ route: '/family', goLabel: 'Open family' }),
  hospitals: Object.freeze({ route: '/hospitals', goLabel: 'Open hospitals' }),
  settings: Object.freeze({ route: '/settings', goLabel: 'Open settings' }),
});

// Chat v1 (memory + model, ADR 0031). Extends v0: v0 stays as the deterministic fallback when CHAT_MODEL_ENABLED is not "true" or the
// budget is spent. Routes (src/server/routes/chat-v1-routes.js), owner or member of the household only, off unless MEMORY_ENABLED:
//   POST /api/v1/chat/threads                    body { household_id, holding_id? }            -> 201 { thread }
//   POST /api/v1/chat/threads/{id}/turns         body below                                    -> 200 text/event-stream
export const CHAT_V1_MESSAGE_MAX = 1000;
export const CHAT_THREAD_REQUEST_KEYS = Object.freeze(['household_id', 'holding_id']);
export const CHAT_TURN_REQUEST_KEYS = Object.freeze(['message', 'input_kind', 'audio_document_id', 'procedure']);
// Structured inputs of a procedure-planning question (amounts in whole rupees, converted to paise by the server).
export const CHAT_PROCEDURE_KEYS = Object.freeze(['planned_date', 'estimated_cost_inr', 'room_rent_per_day_inr', 'stay_days']);
export const CHAT_INPUT_KINDS = Object.freeze(['text', 'voice']);
export const CHAT_ANSWER_SOURCES = Object.freeze(['model', 'deterministic']);
export const CHAT_RETRIEVAL_MODES = Object.freeze(['vector', 'keyword', 'facts_only']);
// SSE events of a turn, in order: meta, delta (zero or more), answer, done. An error after the stream opened is one `error` event
// { code } and the stream ends. Failures before it opens (validation, ownership) are ordinary JSON errors.
export const CHAT_SSE_EVENTS = Object.freeze(['meta', 'delta', 'answer', 'error', 'done']);
