// Closed product-event taxonomy (object_action). Anything not listed here is dropped before it reaches the SDK,
// and each property is checked against a fixed rule, so names, dates of birth, policy values, amounts, document
// text and IDs can never become analytics properties by accident.
const DOCUMENT_KIND_VALUES = Object.freeze(['policy_wording', 'policy_schedule', 'endorsement', 'member_card', 'other']);
const REVIEW_ACTIONS = Object.freeze(['confirm', 'correct', 'mark_absent']);
const TABS = Object.freeze(['breakdown', 'emergency', 'procedure', 'estimate', 'status']);
const VERDICTS = Object.freeze(['no_blocker_found', 'needs_confirmation', 'blocker_found']);
const UPLOAD_FAILURES = Object.freeze(['rejected', 'error']);

const oneOf = values => value => values.includes(value);
const smallCount = value => Number.isInteger(value) && value >= 0 && value <= 1000;

export const PROPERTY_RULES = Object.freeze({
  document_kind: oneOf(DOCUMENT_KIND_VALUES),
  review_action: oneOf(REVIEW_ACTIONS),
  tab: oneOf(TABS),
  verdict: oneOf(VERDICTS),
  failure: oneOf(UPLOAD_FAILURES),
  failed_step_count: smallCount,
  member_count: smallCount,
  ready: value => typeof value === 'boolean',
});

/** event name → allowed property names. */
export const PRODUCT_EVENTS = Object.freeze({
  landing_viewed: [],
  household_created: [],
  household_reconnected: [],
  member_added: ['member_count'],
  consent_granted: [],
  document_upload_completed: ['document_kind'],
  document_upload_failed: ['document_kind', 'failure'],
  breakdown_queued: [],
  breakdown_completed: [],
  breakdown_failed: ['failed_step_count'],
  breakdown_resumed: [],
  budget_exhausted_shown: [],
  review_parameter_saved: ['review_action'],
  readiness_checked: ['ready'],
  workspace_tab_viewed: ['tab'],
  emergency_card_viewed: [],
  procedure_check_requested: ['verdict'],
  estimate_requested: [],
  signed_out: [],
});

/** Returns { event, properties } with only allowlisted, valid properties, or null for an unknown event. */
export function sanitizeProductEvent(event, properties = {}) {
  const allowed = PRODUCT_EVENTS[event];
  if (!allowed) return null;
  const clean = {};
  for (const name of allowed) {
    if (Object.hasOwn(properties ?? {}, name) && PROPERTY_RULES[name](properties[name])) clean[name] = properties[name];
  }
  return { event, properties: clean };
}

/** A no-op analytics port: the default for tests and for builds without a PostHog key. */
export const noopAnalytics = Object.freeze({ track() {}, identify() {}, reset() {} });
