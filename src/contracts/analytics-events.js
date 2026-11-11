// Product analytics event allowlist (complete.md section 4, D6, ADR 0033). Nine server-side events; each names the only property keys it may
// carry and the closed shape of each value (a closed vocabulary or a bounded whole number). No free text, name, policy number, UIN or
// amount ever fits: a key that is not listed, or a value that does not match its shape, rejects the whole event.
//
// A contract: no imports, no I/O. The app mirrors this file (Knowvia Frontend, src/lib/analytics-allowlist.ts, with a drift test).
// FOR LEGAL REVIEW: whether these events need a notice, and their wording, are not final (ADR 0033).

export const ANALYTICS_PURPOSE = 'analytics';
export const ANALYTICS_RECIPIENT = 'posthog';
// The consent scope that opens analytics for a household: a household-wide scope (no resource id), migration 057.
export const ANALYTICS_CONSENT_SCOPE = Object.freeze({ resourceType: 'household', action: 'share', dataCategory: 'usage_events', recipient: ANALYTICS_RECIPIENT });

const oneOf = (...values) => Object.freeze({ kind: 'enum', values: Object.freeze(values) });
const count = max => Object.freeze({ kind: 'count', max });
const flag = Object.freeze({ kind: 'boolean' });

export const ANALYTICS_EVENTS = Object.freeze({
  cover_uploaded: Object.freeze({ kind: oneOf('policy_wording', 'policy_schedule', 'endorsement', 'member_card'), pages: count(2000) }),
  insurer_confirmed: Object.freeze({ candidate_rank: count(3), manual: flag }),
  parse_completed: Object.freeze({ facts: count(10_000), conflicts: count(10_000), ms: count(86_400_000) }),
  conflict_resolved: Object.freeze({ choice: oneOf('primary', 'alternative') }),
  declaration_added: Object.freeze({ kind: oneOf('pre_existing_disease', 'prior_condition', 'habit', 'occupation', 'nominee', 'other') }),
  premium_recorded: Object.freeze({ channel: oneOf('upi', 'card', 'netbanking', 'cheque', 'cash', 'salary_deduction', 'unknown'), via: oneOf('self', 'agent', 'employer', 'bank') }),
  chat_turn: Object.freeze({
    intent: oneOf('coverage_question', 'waiting_period', 'sub_limit', 'procedure_planning', 'claim_process', 'premium_due', 'document_help', 'general', 'unknown'),
    provider: oneOf('none', 'anthropic', 'gemini', 'deepseek', 'kimi', 'openai'),
    tokens: count(10_000_000), ms: count(3_600_000), facts_used: count(1000),
  }),
  voice_turn: Object.freeze({ seconds: count(3600) }),
  hospital_search: Object.freeze({ results: count(1000) }),
});

export const ANALYTICS_EVENT_NAMES = Object.freeze(Object.keys(ANALYTICS_EVENTS));

const reject = (code, message) => { throw Object.assign(new Error(message), { code, statusCode: 400 }); };

/**
 * Validates one event against the allowlist and returns { event, properties } with only listed keys. Throws a coded error for an unknown
 * event, an unlisted key or a value outside its shape. Numbers above a count's maximum are clamped; non-integers are rejected.
 */
export function sanitizeAnalyticsEvent(event, properties = {}) {
  const spec = typeof event === 'string' && Object.hasOwn(ANALYTICS_EVENTS, event) ? ANALYTICS_EVENTS[event] : null;
  if (!spec) reject('ANALYTICS_EVENT_REJECTED', 'That analytics event is not allowlisted.');
  if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) reject('ANALYTICS_PROPERTY_REJECTED', 'Properties must be an object.');
  const clean = {};
  for (const [key, value] of Object.entries(properties)) {
    const shape = Object.hasOwn(spec, key) ? spec[key] : null;
    if (!shape) reject('ANALYTICS_PROPERTY_REJECTED', `Property ${key} is not allowlisted for ${event}.`);
    if (shape.kind === 'enum') {
      if (typeof value !== 'string' || !shape.values.includes(value)) reject('ANALYTICS_PROPERTY_REJECTED', `Property ${key} is outside its closed vocabulary.`);
      clean[key] = value;
    } else if (shape.kind === 'count') {
      if (!Number.isInteger(value) || value < 0) reject('ANALYTICS_PROPERTY_REJECTED', `Property ${key} must be a whole number.`);
      clean[key] = Math.min(value, shape.max);
    } else {
      if (typeof value !== 'boolean') reject('ANALYTICS_PROPERTY_REJECTED', `Property ${key} must be true or false.`);
      clean[key] = value;
    }
  }
  return Object.freeze({ event, properties: Object.freeze(clean) });
}
