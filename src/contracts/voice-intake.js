// Voice intake prefill contract (run C, F2). A prefill is never verified.
export const VOICE_INTAKE_CONTRACT_VERSION = 'voice-intake/v0';
export const VOICE_PREFILL_FIELDS = Object.freeze(['relationship', 'insurer_name', 'hospital_city', 'event_kind', 'member_name']);
export const VOICE_PREFILL_STATES = Object.freeze(['extracted_unverified', 'unknown']);
const MAX_ITEMS = 10;
const MAX_VALUE_LENGTH = 200;

export function validateVoicePrefill(items) {
  const errors = [];
  if (!Array.isArray(items)) return { valid: false, errors: ['prefill must be an array'] };
  if (items.length > MAX_ITEMS) errors.push(`at most ${MAX_ITEMS} items`);
  items.slice(0, MAX_ITEMS).forEach((item, index) => {
    if (item === null || typeof item !== 'object') { errors.push(`item ${index} must be an object`); return; }
    if (!VOICE_PREFILL_FIELDS.includes(item.field)) errors.push(`item ${index} has an unknown field`);
    if (!VOICE_PREFILL_STATES.includes(item.state)) errors.push(`item ${index} has a state that is not allowed`);
    if (typeof item.value !== 'string' || item.value.length > MAX_VALUE_LENGTH) errors.push(`item ${index} value must be a string of at most ${MAX_VALUE_LENGTH} characters`);
  });
  return { valid: errors.length === 0, errors };
}
