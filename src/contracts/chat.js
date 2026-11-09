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
