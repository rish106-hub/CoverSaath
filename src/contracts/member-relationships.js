// Closed vocabulary of household_members.relationship (migration 067), like member_kind. Free text stays in the sealed
// relationship_label. Aliases (what the household calls the person) are a sealed list: at most MEMBER_ALIASES_MAX, each at most
// MEMBER_ALIAS_MAX_LENGTH characters, trimmed and deduplicated without regard to case.
export const MEMBER_RELATIONSHIPS = Object.freeze(['self', 'spouse', 'son', 'daughter', 'mother', 'father', 'sibling', 'in_law', 'other']);
export const MEMBER_ALIASES_MAX = 8;
export const MEMBER_ALIAS_MAX_LENGTH = 40;

// GET /api/v1/households/{id}/overview and /policies, per holding (src/backend/services/holding-overview-service.js).
export const OVERVIEW_HOLDING_STATES = Object.freeze(['ready', 'reading', 'needs_product', 'failed', 'conflicting']);
