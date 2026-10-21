// Block 4 household reasoning contracts. Closed vocabularies and bounds shared by the pure modules. Nothing here does
// I/O. Authority is never created in this feature: it can only narrow what a Block 3 handoff states.

export const SCENARIO_VERSION = 'household-scenario/v1';
export const PREVIEW_VERSION = 'household-coverage-preview/v1';

export const SCENARIO_TYPES = Object.freeze(['planned_procedure', 'general_benefit', 'policy_comparison', 'emergency_admission', 'cashless_information']);
export const RELATIONS = Object.freeze(['self', 'spouse', 'father', 'mother', 'son', 'daughter', 'sibling', 'parent_in_law', 'other']);
export const REPORTED_POLICY_TYPES = Object.freeze(['individual', 'family', 'group', 'top_up', 'super_top_up', 'not_sure']);

export const ASSESSMENT_STATES = Object.freeze(['evidence_summary_available', 'conditional_evidence_summary', 'insufficient_evidence', 'conflicting_evidence', 'source_revalidation_required']);
export const PROVENANCE = Object.freeze(['reviewed_contractual_evidence', 'unverified_extraction', 'user_reported', 'dynamic_external_confirmation_required', 'unavailable']);
export const ITEM_STATES = Object.freeze(['known', 'unverified', 'conflicting', 'missing', 'not_permitted', 'not_selected', 'available_not_selected', 'dynamic_check']);
export const ASSOCIATION_STATES = Object.freeze(['verified', 'candidate_unverified', 'unresolved']);
export const MEMBER_APPLICABILITY = Object.freeze(['established', 'not_enrolled', 'unresolved', 'member_not_specified']);
export const RESOLVERS = Object.freeze(['USER', 'DOCUMENT', 'VERIFIED_SOURCE', 'DYNAMIC_EXTERNAL', 'REVIEW', 'NOT_PERMITTED']);
export const GAP_PRIORITIES = Object.freeze(['P0', 'P1', 'P2']);
export const GAP_TYPES = Object.freeze(['evidence_gap', 'documented_restriction', 'unresolved_member_applicability', 'dynamic_verification_needed']);
export const ANSWER_TYPES = Object.freeze(['member_id', 'date', 'text', 'yes_no']);
export const ACTION_TYPES = Object.freeze([
  'provide_context', 'identify_existing_document', 'upload_document', 'independent_review',
  'insurer_or_tpa_confirmation', 'hospital_confirmation', 'no_further_context_needed',
]);

export const NOT_KNOWN = 'I_DO_NOT_KNOW';
export const SKIPPED = 'SKIPPED';
export const SENTINELS = Object.freeze([NOT_KNOWN, SKIPPED]);

export const LIMITS = Object.freeze({
  sources: 5, answers: 50, procedureText: 2000, hospitalField: 160, topic: 160, answerText: 160,
  questionsPerTurn: 2, questionsPerJourney: 5,
  policies: 20, itemsPerPolicy: 200, itemsTotal: 1000, citationsPerItem: 20, requestBytes: 16_384,
});

// One entry per accepted follow-up answer. `question` is the question that asks for it (null: volunteered only).
export const ANSWER_KEYS = Object.freeze({
  member_id: { type: 'member_id', question: 'Q_MEMBER' },
  exact_date: { type: 'date', question: 'Q_EXACT_DATE' },
  procedure_detail: { type: 'text', question: 'Q_PROCEDURE_DETAIL' },
  topic_detail: { type: 'text', question: 'Q_BENEFIT_TOPIC' },
  hospital_name: { type: 'text', question: 'Q_HOSPITAL_NAME' },
  hospital_city: { type: 'text', question: 'Q_HOSPITAL_CITY' },
  hospital_branch: { type: 'text', question: 'Q_HOSPITAL_BRANCH' },
  policy_schedule_available: { type: 'yes_no', question: 'Q_POLICY_SCHEDULE' },
  continuity_document_available: { type: 'yes_no', question: 'Q_CONTINUITY_DOCUMENT' },
  other_policy_available: { type: 'yes_no', question: 'Q_OTHER_POLICY' },
  uninterrupted_cover_reported: { type: 'yes_no', question: null },
});

export class HouseholdReasoningError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'HouseholdReasoningError';
    this.code = code; // UPPER_SNAKE with an underscore: the route's errorResponse treats it as client-safe
    this.statusCode = statusCode;
  }
}

export const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function deepFreeze(value) {
  if (Array.isArray(value)) value.forEach(deepFreeze);
  else if (isRecord(value)) Object.values(value).forEach(deepFreeze);
  return typeof value === 'object' && value !== null ? Object.freeze(value) : value;
}

// Round-trips the date so 2026-02-30 is not accepted as March.
export const isIsoDate = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '2000-01-01' || value > '2100-12-31') return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};
export const isIsoMonth = value => typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value) && value >= '2000-01' && value <= '2100-12';

// Stable JSON for equality and digests: keys sorted, no dependence on object insertion order.
export const canonical = value => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
};

// Control characters (C0, DEL, C1), line and paragraph separators, invisible formatting characters, bidirectional
// overrides, tag characters and the byte-order mark are refused in user-supplied text. Written with code points so the
// source stays plain ASCII. Two characters carry meaning in real names and are allowed only in their proper place: the
// zero-width non-joiner and joiner (Indic and Arabic-script conjuncts) directly after a letter or mark, never doubled or
// at the start; and the emoji variation selector directly after a pictographic character, a digit, # or *.
export function hasForbiddenCharacters(value) {
  const chars = [...value];
  for (let i = 0; i < chars.length; i += 1) {
    const cp = chars[i].codePointAt(0);
    const previous = i > 0 ? chars[i - 1] : '';
    if (cp === 0x200c || cp === 0x200d) { if (!/^[\p{L}\p{M}]$/u.test(previous)) return true; continue; }
    if (cp === 0xfe0f) { if (!/^[\p{Extended_Pictographic}0-9#*]$/u.test(previous)) return true; continue; }
    // Any other invisible format character (category Cf) is refused; the joiner and selector exemptions are handled above.
    if (/^\p{Cf}$/u.test(chars[i])) return true;
    if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f) || cp === 0x2028 || cp === 0x2029 || (cp >= 0x200b && cp <= 0x200f)
      || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2060 && cp <= 0x206f) || cp === 0xad || cp === 0x61c || cp === 0x180e
      || (cp >= 0xfe00 && cp <= 0xfe0e) || cp === 0xfeff || (cp >= 0xe0000 && cp <= 0xe007f)
      // Invisible letters and marks that would let a joiner follow them: combining grapheme joiner, Hangul fillers, braille blank, Khmer inherent vowels.
      || cp === 0x34f || cp === 0x115f || cp === 0x1160 || cp === 0x3164 || cp === 0xffa0 || cp === 0x2800 || cp === 0x17b4 || cp === 0x17b5) return true;
  }
  return false;
}
