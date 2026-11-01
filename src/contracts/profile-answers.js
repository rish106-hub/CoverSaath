// User-stated profile answers (run E1a, ADR 0013). A small closed list of questions the dashboard asks (who is covered,
// where the user lives, the renewal month, a few yes/no answers). No free text beyond a city or state name, no diagnoses,
// no identity numbers. These answers are what the user told us: they are NOT evidence from a document and NOT model
// output, so they carry no evidence state and are never shown as confirmed.

export const PROFILE_ANSWER_SOURCE = 'user_stated';

export const COVERED_PEOPLE_VALUES = Object.freeze([
  'self', 'self_partner', 'self_partner_children', 'self_parents', 'self_partner_children_parents', 'other',
]);

const PLACE_NAME = /^[\p{L}\p{M}][\p{L}\p{M} .'-]{0,59}$/u;

const place = value => (typeof value === 'string' && PLACE_NAME.test(value.trim()) ? value.trim().replace(/\s+/g, ' ') : undefined);
const yesNo = value => (typeof value === 'boolean' ? value : undefined);

export const PROFILE_ANSWER_FIELDS = Object.freeze({
  covered_people: value => (COVERED_PEOPLE_VALUES.includes(value) ? value : undefined),
  city: place,
  state: place,
  renewal_month: value => (Number.isInteger(value) && value >= 1 && value <= 12 ? value : undefined),
  has_employer_cover: yesNo,
  has_personal_policy: yesNo,
  has_top_up_policy: yesNo,
});

export const PROFILE_ANSWER_KEYS = Object.freeze(Object.keys(PROFILE_ANSWER_FIELDS));

/**
 * Checks a PUT body `answers` object. Returns a Map(fieldKey -> value | null); null removes that answer.
 * Throws a coded 400 for an unknown key, an invalid value, an empty set or a set larger than the field list.
 */
export function parseProfileAnswers(input) {
  const invalid = message => Object.assign(new Error(message), { code: 'PROFILE_ANSWER_INVALID', statusCode: 400 });
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw invalid('answers must be an object.');
  const entries = Object.entries(input);
  if (entries.length === 0 || entries.length > PROFILE_ANSWER_KEYS.length) throw invalid('answers must hold between 1 and 7 fields.');
  const parsed = new Map();
  for (const [key, value] of entries) {
    if (!Object.hasOwn(PROFILE_ANSWER_FIELDS, key)) throw invalid('An answer field is not recognised.');
    if (value === null) { parsed.set(key, null); continue; }
    const clean = PROFILE_ANSWER_FIELDS[key](value);
    if (clean === undefined) throw invalid(`The value for ${key} is not valid.`);
    parsed.set(key, clean);
  }
  return parsed;
}
