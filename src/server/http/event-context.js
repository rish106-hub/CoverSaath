// Turns a request into the metadata an activity event may carry: a route template (ids replaced, so no id or free
// text ever becomes part of the route), and the household, case or grant id taken from the path of a request that
// succeeded (a failed or foreign request never attributes itself to a household it was refused for).

const PARAM_COLLECTIONS = new Set([
  'households', 'cases', 'consents', 'documents', 'curated-products', 'ocr-jobs', 'jobs', 'tasks', 'members', 'fields', 'runs', 'passages', 'answers',
]);
const LONG_IDENTIFIER = /^[A-Za-z0-9_-]*[0-9][A-Za-z0-9_-]{15,}$/;
const SLUG = /^[a-z][a-z0-9-]{0,40}$/;
const MAX_SEGMENTS = 8;

export function routeTemplate(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith('/api/v1/')) return '/other';
  const segments = pathname.split('/').filter(Boolean).slice(0, MAX_SEGMENTS);
  const mapped = segments.map((segment, index) => {
    if (index < 2) return segment;
    if (PARAM_COLLECTIONS.has(segments[index - 1]) || /^\d+$/.test(segment) || LONG_IDENTIFIER.test(segment)) return ':id';
    return SLUG.test(segment) ? segment : ':x';
  });
  return `/${mapped.join('/')}`;
}

const PATH_IDS = [
  [/^\/api\/v1\/households\/([^/]+)/, 'householdId'],
  [/^\/api\/v1\/cases\/([^/]+)/, 'caseId'],
  [/^\/api\/v1\/consents\/([^/]+)/, 'consentGrantId'],
];

export function pathAttribution(pathname, status) {
  const ids = {};
  if (!(status >= 200 && status < 400)) return ids;
  for (const [pattern, key] of PATH_IDS) {
    const match = pathname.match(pattern);
    if (match) ids[key] = match[1];
  }
  return ids;
}

const JOURNEY_EVENTS = new Map([
  ['POST /api/v1/identity-sessions', 'sign_in'],
  ['POST /api/v1/cases/:id/documents', 'upload_attempt'],
  ['GET /api/v1/households/:id/consents', 'consent_view'],
  ['GET /api/v1/cases/:id/read-facts', 'readback_query'],
  ['GET /api/v1/cases/:id/passages', 'readback_query'],
]);

/**
 * Event name for a finished request: a request refused by the limiter is a rate_limit_hit, a 5xx a server_error, a
 * sign-in, upload, consent list or read-back request its own journey event, anything else http_request.
 */
export function requestEventName({ status, method, route }) {
  if (status === 429) return 'rate_limit_hit';
  if (status >= 500) return 'server_error';
  return JOURNEY_EVENTS.get(`${method} ${route}`) ?? 'http_request';
}

// Route words that may appear literally in a LOGGED route. routeTemplate() above keeps any short lowercase slug, which
// would let an unknown path such as /api/v1/asha-sharma be written to a log; the log uses this closed set instead and
// shows everything else as :x. tests/logging-leak-review.test.mjs fails if the routes file gains a word missing here.
export const KNOWN_ROUTE_SEGMENTS = new Set([
  'api', 'v1', 'access', 'analysis-runs', 'audit-events', 'cases', 'catalogue-reviewers', 'consents', 'coverage-preview',
  'curated-products', 'current', 'decision-catalogue', 'deletion-inventory', 'documents', 'fields', 'health', 'households',
  'identity-sessions', 'integrations', 'jobs', 'live', 'members', 'metrics', 'notices', 'ocr-jobs', 'onboarding', 'passages', 'permissions',
  'overview', 'places', 'policies', 'preferences', 'profile-answers', 'questions', 'read-facts', 'ready', 'refresh', 'reviews', 'revoke',
  'runs', 'scenarios', 'sessions', 'source-pack', 'structuring-runs', 'tasks', 'transitions',
]);

export function knownRouteTemplate(pathname) {
  const template = routeTemplate(pathname);
  if (template === '/other') return template;
  return template.split('/').map(segment => (segment === '' || segment === ':id' || KNOWN_ROUTE_SEGMENTS.has(segment) ? segment : ':x')).join('/');
}
