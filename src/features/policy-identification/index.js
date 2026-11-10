// Deterministic policy identification (plan R2). Pure functions: no model, no network, no database, no routes.
// A match is only a proposal; the user must confirm it. See match-product.js.
export { normalizeUin } from './uin.js';
export { extractIdentifiers } from './extract-identifiers.js';
export { matchProduct, MATCH_OUTCOMES, MAX_CANDIDATES } from './match-product.js';
