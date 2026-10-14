import { createHash } from 'node:crypto';

// v2: Unicode normalisation before scanning, per-request indexed placeholders
// (no value-derived hashes), shape-based payment-card detection, a per-call scan
// cap and linear-time patterns.
export const PRIVACY_EVIDENCE_GATE_VERSION = 'knowvia-privacy-evidence-v2';
export const EVIDENCE_DATA_CLASSES = Object.freeze(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED']);
// The consent-scope recipient that names the live model provider. A document's
// derive scope must name this exact recipient before its evidence may be sent
// to that model. A NULL recipient never authorises model disclosure.
export const GEMINI_MODEL_RECIPIENT = 'google-gemini';

// Every text value is cut to this many UTF-8 bytes (after normalisation and
// before any pattern runs), so worst-case scan time is bounded per value. Text
// beyond the cap never leaves the gate; TEXT_TRUNCATED is recorded. The cut is
// moved back to a line or word boundary so an identifier is not split into an
// unrecognisable fragment.
export const PRIVACY_GATE_SCAN_CAP_BYTES = 16_000;

const SOURCE_STATES = new Set(['known', 'unknown', 'conflict']);
const DEFAULT_LIMITS = Object.freeze({
  maxSources: 30,
  maxRawSourceBytes: 16_000,
  maxSourceBytes: 4_000,
  maxTotalBytes: 48_000,
  maxUpstreamBytes: 12_000,
  maxStructuredDepth: 12,
  maxStructuredItems: 240,
});

function fail(code, message) {
  throw Object.assign(new Error(message), { code, statusCode: 422 });
}

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail('PRIVACY_GATE_MALFORMED', `${label} must be a plain object.`);
  }
}

function exactKeys(value, allowed, label) {
  plainObject(value, label);
  if (Object.keys(value).some(key => !allowed.includes(key))) {
    fail('PRIVACY_GATE_MALFORMED', `${label} contains an unsupported field.`);
  }
}

function boundedText(value, max, label) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
    fail('PRIVACY_GATE_MALFORMED', `${label} must be bounded text.`);
  }
  return value;
}

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

// Opaque case, subject and source ids. They are derived from server-generated
// random record ids (never from personal values) and must stay stable because
// deterministic review maps model citations back through them.
function opaqueId(kind, value) {
  return `${kind}_${digest(String(value)).slice(0, 24)}`;
}

// The exact opaque id the gate assigns to a source with this raw id.
export function opaqueSourceId(rawId) {
  return opaqueId('source', boundedText(rawId, 200, 'source id'));
}

// ---------------------------------------------------------------------------
// Normalisation and bounding
// ---------------------------------------------------------------------------

const FORMAT_CHARACTERS = /\p{Cf}/gu;
const NON_ASCII_DIGIT = /(?![0-9])\p{Nd}/gu;
const DECIMAL_DIGIT = /^\p{Nd}$/u;
const digitValues = new Map();

// Unicode decimal digits are encoded in runs of ten starting at zero. NFKC has
// already folded the adjacent mathematical/full-width runs to ASCII.
function asciiDigit(character) {
  let value = digitValues.get(character);
  if (value === undefined) {
    const code = character.codePointAt(0);
    let zero = code;
    while (zero > code - 9 && DECIMAL_DIGIT.test(String.fromCodePoint(zero - 1))) zero -= 1;
    value = String((code - zero) % 10);
    digitValues.set(character, value);
  }
  return value;
}

// NFKC folds full-width and compatibility forms, format characters (zero-width
// space/joiners, soft hyphen, bidi controls, BOM) are removed, and every Unicode
// decimal digit (Devanagari, Bengali, Tamil, ...) becomes ASCII. Model-bound text
// is the normalised form.
function normalizeText(value) {
  return value.normalize('NFKC').replace(FORMAT_CHARACTERS, '').replace(NON_ASCII_DIGIT, asciiDigit);
}

function truncateUtf8(value, maxBytes) {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) return { text: value, truncated: false };
  let end = maxBytes;
  // Never cut inside a multi-byte sequence.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return { text: bytes.subarray(0, end).toString('utf8'), truncated: true };
}

function prepareText(value) {
  const normalized = normalizeText(value);
  const cut = truncateUtf8(normalized, PRIVACY_GATE_SCAN_CAP_BYTES);
  if (!cut.truncated) return { text: normalized, capped: false };
  const tail = cut.text.slice(-1024);
  const newline = tail.lastIndexOf('\n');
  const space = tail.search(/\s\S*$/u);
  const back = newline >= 0 ? tail.length - newline : space >= 0 ? tail.length - space : 0;
  return { text: cut.text.slice(0, cut.text.length - back), capped: true };
}

// ---------------------------------------------------------------------------
// Placeholders
// ---------------------------------------------------------------------------

// Per-request indexed placeholders such as <PHONE_1> or <NAME_2>. Within one
// sanitise call the same value always maps to the same placeholder; nothing
// about the value (no hash, no length) is encoded. Existing placeholders are
// never rescanned, and new indices start after the highest index already
// present, so repeated sanitisation (storage, then model dispatch) is
// idempotent. Legacy v1 hash tokens (<KIND:16 hex>) are replaced by indexed
// placeholders so their value-derived digests never reach a model.
const PLACEHOLDER_SOURCE = '<[A-Z]+(?:_[A-Z]+)*_[1-9][0-9]{0,5}>';
const LEGACY_TOKEN_SOURCE = '<[A-Z_]+:[a-f0-9]{16}>';
const PLACEHOLDER = new RegExp(`<([A-Z]+(?:_[A-Z]+)*)_([1-9][0-9]{0,5})>`, 'g');
const ANY_TOKEN = new RegExp(`${PLACEHOLDER_SOURCE}|${LEGACY_TOKEN_SOURCE}`, 'g');
const LEGACY_TOKEN = new RegExp(`^<([A-Z_]+):[a-f0-9]{16}>$`);

function createPlaceholderState(seedText = '') {
  const counters = new Map();
  for (const match of seedText.matchAll(PLACEHOLDER)) {
    counters.set(match[1], Math.max(counters.get(match[1]) ?? 0, Number(match[2])));
  }
  return { counters, assigned: new Map() };
}

function canonicalValue(kind, value) {
  const folded = String(value).normalize('NFKC').toLowerCase().replace(/[\s.()‐-―_/-]+/gu, '');
  if (kind === 'PHONE') {
    const digits = folded.replace(/\D/g, '');
    return digits.length > 10 ? digits.slice(-10) : digits;
  }
  return folded;
}

function placeholder(state, kind, value) {
  const key = `${kind}\u0000${canonicalValue(kind, value)}`;
  let assigned = state.assigned.get(key);
  if (!assigned) {
    const next = (state.counters.get(kind) ?? 0) + 1;
    state.counters.set(kind, next);
    assigned = `<${kind}_${next}>`;
    state.assigned.set(key, assigned);
  }
  return assigned;
}

// Applies `transform` to the text between existing tokens only.
function outsideTokens(value, transform) {
  let output = '';
  let cursor = 0;
  for (const match of value.matchAll(ANY_TOKEN)) {
    output += transform(value.slice(cursor, match.index)) + match[0];
    cursor = match.index + match[0].length;
  }
  return output + transform(value.slice(cursor));
}

// ---------------------------------------------------------------------------
// Restricted material (never sent; the whole value is rejected)
// ---------------------------------------------------------------------------

const RESTRICTED_PATTERNS = Object.freeze([
  /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/i,
  // Labelled credentials, including JSON-quoted keys such as "apiKey": "...".
  /\b(?:password|passwd|pwd|pass[_ -]?phrase|api[_ -]?key|api[_ -]?secret|secret[_ -]?key|client[_ -]?secret|private[_ -]?key|access[_ -]?key(?:[_ -]?id)?|access[_ -]?token|refresh[_ -]?token|auth[_ -]?token|session[_ -]?token|id[_ -]?token|bearer[_ -]?token|secret|token)\b["']?\s*[=:]\s*["']?[^\s,"'}]{6,}/i,
  // One-time codes, card verification values and PINs. The separator forms are
  // alternatives (not adjacent optional runs) so the match is linear.
  /\b(?:otp|one[_ -]?time[_ -]?password|cvv2?|cvc2?|card[_ -]?verification[_ -]?(?:value|code)|upi[_ -]?pin|m-?pin|atm[_ -]?pin|card[_ -]?pin)\b["']?(?:\s*(?:is|[=:])\s*|\s+)?["']?\d{3,8}\b/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
  /\bBasic\s+[A-Za-z0-9+/]{16,}={0,2}/,
  // Well-known provider credential formats.
  /\bAIza[0-9A-Za-z_-]{35}/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{36,}/,
  /\bgithub_pat_[A-Za-z0-9_]{22,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
]);

function luhnValid(digits) {
  if (digits.length < 13 || digits.length > 19 || /^0+$/.test(digits)) return false;
  let sum = 0;
  let doubleDigit = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let number = digits.charCodeAt(index) - 48;
    if (doubleDigit) {
      number *= 2;
      if (number > 9) number -= 9;
    }
    sum += number;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}

// A maximal run of digit groups joined by single separators. Groups are only
// ever combined inside one run; separate runs are never concatenated.
const DIGIT_RUN = /(?<![\p{N}\p{L}_])(\+?)(\d+(?:[ .‐-―-]\d+)*)(?![\p{N}])/gu;
const GROUP_SEPARATOR = /[ .‐-―-]/u;
// Printed card groupings: 4-4-4-4 (+1..3), 4-6-5 (Amex), 4-6-4 (Diners), 4-4-5.
const CARD_SHAPES = Object.freeze([[4, 4, 4, 4], [4, 4, 4, 4, 1], [4, 4, 4, 4, 2], [4, 4, 4, 4, 3], [4, 6, 5], [4, 6, 4], [4, 4, 5]]);
const CARD_LABEL = /(?:card|credit|debit|visa|master\s?card|rupay|amex|american\s+express|maestro|diners|discover|cvv|cvc|expiry|valid\s+thru|exp\.?\s*date)/i;
// Major networks (Mastercard 2/5, Amex/Diners/JCB 3, Visa 4, Discover/RuPay/Maestro 6, RuPay 8).
const CARD_NETWORK_PREFIX = /^[2-68]/;

function isAscendingYears(groups) {
  if (groups.length < 2 || groups.some(group => !/^(?:19|20)\d\d$/.test(group))) return false;
  return groups.every((group, index) => index === 0 || Number(group) > Number(groups[index - 1]));
}

const allRoundAmounts = groups => groups.length > 1 && groups.every(group => /00$/.test(group));

// A strictly ascending or descending run of three or more groups reads as a
// table row (premium by age band, sum-insured slabs), not as a card.
function isTableLike(groups) {
  if (groups.length < 3) return false;
  const numbers = groups.map(Number);
  return numbers.every((number, index) => index === 0 || number > numbers[index - 1])
    || numbers.every((number, index) => index === 0 || number < numbers[index - 1]);
}

// Only exact card groupings are Luhn-checked: a window of consecutive groups
// whose lengths equal a printed card layout (or, near a card label, the whole
// 13-19 digit run). Unrelated groups are never concatenated into a candidate.
// 'card'      : Luhn-valid card-shaped number -> the value is rejected.
// 'ambiguous' : Luhn-valid card-shaped window in a table-like run -> the run is
//               minimised to a placeholder instead of rejected.
function cardClassification(groups, labelled) {
  const digits = groups.join('');
  if (groups.length === 1) {
    return digits.length >= 13 && digits.length <= 19 && (labelled || CARD_NETWORK_PREFIX.test(digits)) && luhnValid(digits) ? 'card' : null;
  }
  if (labelled && digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) return 'card';
  const lengths = groups.map(group => group.length);
  for (let start = 0; start < groups.length; start += 1) {
    for (const shape of CARD_SHAPES) {
      const end = start + shape.length;
      if (end > groups.length || !shape.every((length, offset) => lengths[start + offset] === length)) continue;
      const window = groups.slice(start, end);
      const candidate = window.join('');
      if (isAscendingYears(window) || !(labelled || CARD_NETWORK_PREFIX.test(candidate)) || !luhnValid(candidate)) continue;
      return isTableLike(groups) && !labelled ? 'ambiguous' : 'card';
    }
  }
  return null;
}

function containsPaymentCard(value) {
  for (const match of value.matchAll(DIGIT_RUN)) {
    const groups = match[2].split(GROUP_SEPARATOR);
    const labelled = CARD_LABEL.test(value.slice(Math.max(0, match.index - 48), match.index));
    if (cardClassification(groups, labelled) === 'card') return true;
  }
  return false;
}

// Base64 / base64url blobs. They are decoded once to look for restricted
// material and minimised when they decode to readable text.
const BASE64_BLOB = /(?<![A-Za-z0-9+/_=-])[A-Za-z0-9+/_-]{16,}={0,2}(?![A-Za-z0-9+/_=-])/g;

function decodeReadableBase64(blob) {
  const body = blob.replace(/=+$/, '');
  // Plain words (one letter case, no digits or symbols) are not treated as encoded.
  if (body.length % 4 === 1 || !(/[0-9+/_-]/.test(body) || (/[a-z]/.test(body) && /[A-Z]/.test(body)))) return null;
  const bytes = Buffer.from(body, 'base64');
  if (bytes.length < 8) return null;
  const decoded = bytes.toString('utf8');
  if (decoded.includes('�')) return null;
  const readable = decoded.match(/[\p{L}\p{N}\p{P}\p{Zs}\n\r\t]/gu)?.length ?? 0;
  return readable / [...decoded].length >= 0.9 && /[\p{L}\p{N}]/u.test(decoded) ? decoded : null;
}

function scanRestricted(value) {
  // Evidence often arrives as JSON serialised inside JSON; scan an unescaped
  // view too so `\"apiKey\": \"...\"` cannot slip past a quoted-key pattern.
  const unescaped = value.replace(/\\+(["'/\\])/g, '$1');
  return RESTRICTED_PATTERNS.some(pattern => pattern.test(value) || pattern.test(unescaped)) || containsPaymentCard(value);
}

function rejectRestrictedText(value) {
  const scanned = value.replace(ANY_TOKEN, ' ');
  let restricted = scanRestricted(scanned);
  if (!restricted) {
    for (const [blob] of scanned.matchAll(BASE64_BLOB)) {
      const decoded = decodeReadableBase64(blob);
      if (decoded && scanRestricted(normalizeText(decoded))) { restricted = true; break; }
    }
  }
  if (restricted) fail('RESTRICTED_EVIDENCE', 'Restricted evidence cannot be sent to a model.');
}

// ---------------------------------------------------------------------------
// Direct identifiers (minimised to placeholders)
// ---------------------------------------------------------------------------

// Case-insensitive form of a label written in lower case, for patterns whose
// value part must stay case-sensitive (capitalised personal names).
function ci(pattern) {
  let output = '';
  let inClass = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '\\') { output += character + pattern[index + 1]; index += 1; continue; }
    if (character === '[') inClass = true;
    if (character === ']') inClass = false;
    if (/[a-z]/.test(character)) output += inClass ? `${character}${character.toUpperCase()}` : `[${character}${character.toUpperCase()}]`;
    else output += character;
  }
  return output;
}

const LABEL_START = '(?<![\\p{L}\\p{M}\\p{N}_])';
const LABEL_END = '(?![\\p{L}\\p{M}\\p{N}_])';
// Label separators: ':' / '=' (optionally spaced), or a spaced dash.
const STRICT_SEP = '(\\s*[:=]\\s*|\\s+[\\u2013\\u2014-]+\\s*|\\s*[\\u2013\\u2014-]+\\s+)';
// Also accepts bare whitespace or '#', for labels whose value has a strict shape.
const LOOSE_SEP = '(\\s*[:=#]\\s*|\\s*[\\u2013\\u2014-]+\\s*|\\s+)';
// A capitalised personal name of one to four words; single-letter initials may
// carry a full stop ("A. K. Example").
const NAME_WORD = "(?:\\p{Lu}\\.|\\p{Lu}[\\p{L}\\p{M}'\\u2019-]*)";
const CAPITALISED_NAME = `(${NAME_WORD}(?:\\s+${NAME_WORD}){0,3})`;
// Clause values stop at a line end, ';', ',' (names) or a sentence full stop.
// Names may contain single-letter initials; addresses may contain short
// abbreviations ("Rd.", "St.", "No.") and commas.
const NAME_CLAUSE = '((?:[^\\n,;.<]|\\.(?=\\S)|(?<=(?:^|[\\s(])\\p{L})\\.){2,100})';
const ADDRESS_CLAUSE = '((?:[^\\n;.<]|\\.(?=\\S)|(?<=(?:^|[\\s,(])\\p{L}{1,3})\\.){2,160})';
// Health values keep internal full stops ("E11.9") but stop at a sentence end.
const HEALTH_VALUE = '((?:[^\\n,;.<]|\\.(?=\\S)){2,120})';
const HONORIFIC_ONLY = /^(?:mrs|mr|ms|miss|mx|dr|shri|sri|smt|kumari)$/i;
const DATE_VALUE ='(\\d{1,4}[\\/. \\u2013\\u2014-]\\d{1,2}[\\/. \\u2013\\u2014-]\\d{1,4}|\\d{1,2}(?:st|nd|rd|th)?[ -]*\\p{L}{3,9}\\.?,?[ -]*\\d{2,4}|\\p{L}{3,9}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{2,4})';
const PHONE_VALUE = '(\\+?\\d(?:[\\d()\\u2013\\u2014-]|[ .](?=[\\d(]))*\\d)';
const ID_VALUE = '([A-Za-z0-9][A-Za-z0-9\\/._\\u2013\\u2014-]{0,39})';
const GOV_ID_VALUE = '([\\dXx*\\u2022](?:[\\dXx*\\u2022]|[ .\\u2013\\u2014-](?=[\\dXx*\\u2022])){7,24})';

const labelPattern = (labels, separator, value, flags = 'giu') => new RegExp(`${LABEL_START}(${labels})${LABEL_END}${separator}${value}`, flags);

const NUMBER_SUFFIX = '(?:\\s*(?:no\\.?|number|num|#))?';
const PHONE_LABELS = `(?:mobile|mob|cell\\s*phone|cell|telephone|tel|phone|ph|contact|whatsapp|landline|मोबाइल|फ़ोन|फोन)${NUMBER_SUFFIX}`;
const EMAIL_LABELS = '(?:e-?mail(?:\\s*(?:id|address))?|ईमेल)';
const GOV_ID_LABELS = `(?:aadhaa?r|adhaar|uidai|uid|vid|virtual\\s+id|आधार)(?:\\s*card)?${NUMBER_SUFFIX}`;
const DOB_LABELS = '(?:date\\s+of\\s+birth|d\\.?\\s?o\\.?\\s?b\\.?|birth\\s*date|born\\s+on|जन्म\\s*तिथि)';
const ADDRESS_LABELS = '(?:(?:postal|home|residential|permanent|present|current|correspondence|communication|mailing)\\s+address|address(?:\\s+of\\s+(?:the\\s+)?(?:insured|proposer|patient|member|policy\\s?holder|nominee|claimant))?|addr\\.?|पता)';
const ADDRESS_START = '(?=\\d|#|(?:flat|house|h\\.?\\s?no|plot|door|c\\/o|village|vill|at\\s+post|block|sector|ward)(?![\\p{L}]))';
// Multi-word labels that unambiguously name a person.
const NAME_LABELS = [
  'full\\s+name', 'first\\s+name', 'last\\s+name', 'sur\\s?name', 'member\\s+name', "patient(?:'s)?\\s+name",
  'insured\\s+name', 'insured\\s+person', 'insured\\s+member', 'primary\\s+insured', 'life\\s+assured',
  'name\\s+of\\s+(?:the\\s+)?(?:insured|patient|proposer|member|policy\\s?holder|employee|nominee|beneficiary|claimant|life\\s+assured)',
  'proposer(?:\\s+name)?', 'nominee(?:\\s+name)?', 'beneficiary(?:\\s+name)?', 'employee\\s+name', 'spouse(?:\\s+name)?',
  "father(?:'s)?\\s+name", "mother(?:'s)?\\s+name", 'guardian(?:\\s+name)?', 'policy\\s?holder(?:\\s+name)?', 'claimant(?:\\s+name)?',
  'applicant(?:\\s+name)?', 'customer\\s+name', 'account\\s+holder(?:\\s+name)?', 'attendant\\s+name',
].join('|');
// Bare "name", "insured" and "patient" need an explicit ':' / '=' / dash
// separator and are excluded after policy nouns, so wording such as "Plan name:
// Gold", "Sum insured: 500000" and "In-patient: covered" stays usable.
const BARE_NAME_LABELS = [
  '(?<!sum\\s)insured', '(?<!(?:in|out|day)[- ]?)patient', 'नाम',
  '(?<!(?:plan|product|insurer|insurance|hospital|company|tpa|scheme|network|rider|policy|file|document|cover|benefit)\\s)name',
].join('|');
const ID_LABELS = [
  'policy\\s+(?:number|no\\.?|#)', 'certificate\\s+(?:number|no\\.?)', 'member(?:ship)?\\s+(?:id|number|no\\.?)', 'employee\\s+(?:id|code|number|no\\.?)',
  'emp\\s+(?:id|code)', 'uhid', 'mrn', 'ip\\s+(?:number|no\\.?)', 'customer\\s+id', 'client\\s+id', 'claim\\s+(?:id|number|no\\.?)',
  'registration\\s+(?:number|no\\.?)', 'bank\\s+account(?:\\s+(?:number|no\\.?))?', 'account\\s+(?:number|no\\.?)', 'a\\/c(?:\\s+no\\.?)?', 'acct(?:\\s+no\\.?)?',
].join('|');

// Personal health data (diagnosis, condition) is sensitive personal data. Generic
// policy wording such as "pre-existing disease waiting period" is not.
const HEALTH_LABELS = [
  'diagnosis', 'diagnoses', 'provisional\\s+diagnosis', 'final\\s+diagnosis', 'medical\\s+conditions?', 'known\\s+conditions?',
  'existing\\s+conditions?', 'declared\\s+(?:pre-?existing\\s+)?(?:conditions?|diseases?|illness(?:es)?)', 'ailments?',
  'chief\\s+complaint', 'medical\\s+history', 'past\\s+history', 'icd(?:-?10)?(?:\\s+code)?',
].join('|');
const HEALTH_PHRASES = ['diagnosed\\s+with', 'suffering\\s+from', 'being\\s+treated\\s+for'].join('|');

const STRUCTURED_IDENTITY_KEYS = [
  'displayName', 'fullName', 'firstName', 'lastName', 'name', 'memberName', 'patientName', 'insuredName', 'proposerName', 'nomineeName',
  'beneficiaryName', 'employeeName', 'spouseName', 'fatherName', 'motherName', 'dateOfBirth', 'dob', 'postalAddress', 'address',
  'policyNumber', 'passport', 'passportNumber', 'pan', 'panNumber', 'aadhaar', 'aadhaarNumber', 'phone', 'phoneNumber', 'mobile',
  'mobileNumber', 'email', 'emailAddress', 'ifsc', 'ifscCode', 'accountNumber', 'bankAccount', 'bankAccountNumber', 'upiId', 'vpa',
];
const STRUCTURED_HEALTH_KEYS = ['diagnosis', 'medicalCondition', 'condition', 'conditions', 'ailment', 'medicalHistory', 'icdCode', 'chiefComplaint'];
const STRUCTURED_SENSITIVE_KEYS = new Map([
  ...STRUCTURED_IDENTITY_KEYS.map(key => [key.toLowerCase(), ['IDENTIFIER', 'DIRECT_IDENTIFIER_LABELED_VALUE']]),
  ...STRUCTURED_HEALTH_KEYS.map(key => [key.toLowerCase(), ['HEALTH', 'SENSITIVE_HEALTH_CONDITION']]),
]);

// Structured patterns tolerate backslash-escaped quotes (JSON nested in JSON).
// `(?<!\\)` lets a match start only at the first backslash of a run, so long
// backslash runs are scanned once (linear) rather than from every position.
const STRUCTURED_ID_PATTERN = /(?<!\\)(\\*"(?:case|subject|source|document|adult|member|household|policy|reporter|consent|upload|run)Id\\*"\s*:\s*\\*")([^"\\]+)(\\*")/gi;
// Any other camelCase JSON key named "id" or ending in "Id" (factId, taskId, ...).
// Case-sensitive so keys such as "paid" are not mistaken for identifiers.
const GENERIC_ID_KEY_PATTERN = /(?<!\\)(\\*"(?:id|[a-z][A-Za-z0-9]*Id)\\*"\s*:\s*\\*")([^"\\]+)(\\*")/g;
const structuredKeyPattern = keys => new RegExp(`(?<!\\\\)(\\\\*"(?:${keys.join('|')})\\\\*"\\s*:\\s*\\\\*")([^"\\\\]+)(\\\\*")`, 'gi');
const STRUCTURED_HEALTH_PATTERN = structuredKeyPattern(STRUCTURED_HEALTH_KEYS);
const STRUCTURED_IDENTITY_PATTERN = structuredKeyPattern(STRUCTURED_IDENTITY_KEYS);
// Internal record ids (prefix + UUID) and bare UUIDs. A match starts only at the
// beginning of a [A-Za-z0-9-] run, so hyphenated words are scanned linearly.
const INTERNAL_RECORD_ID_PATTERN = /(?<![A-Za-z0-9-])(?:[a-z]+-)*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![A-Za-z0-9])/gi;
// Email and UPI handles: a match starts only at the beginning of a local-part
// run, and domain labels are dot-separated, so both are linear.
const EMAIL_PATTERN = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const UPI_PATTERN = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{2,}@[A-Za-z]{2,16}(?![A-Za-z0-9]|\.[A-Za-z0-9])/g;

const HONORIFIC_NAME = new RegExp(`${LABEL_START}(${ci('mrs|mr|ms|miss|mx|dr|shri|sri|smt|kumari')})\\.?\\s+${CAPITALISED_NAME}`, 'gu');
const RELATION_NAME = new RegExp(`${LABEL_START}([SDWCsdwc]\\s?\\/\\s?[Oo])\\.?\\s+${CAPITALISED_NAME}`, 'gu');
const DEVANAGARI_HONORIFIC_NAME = /(?<![\p{L}\p{M}])(श्रीमती|श्री|सुश्री|कुमारी|डॉ\.?)\s+([ऀ-ॿ]+(?:\s+[ऀ-ॿ]+){0,2})/gu;

const LABELLED_RULES = Object.freeze([
  [labelPattern('passport(?:\\s+(?:no\\.?|number|#))?', LOOSE_SEP, '([A-Za-z0-9]{6,9})(?![A-Za-z0-9])'), 'PASSPORT', 'DIRECT_IDENTIFIER_PASSPORT'],
  [labelPattern('ifsc(?:\\s+code)?', LOOSE_SEP, '([A-Za-z]{4}0[A-Za-z0-9]{6})(?![A-Za-z0-9])'), 'BANK', 'DIRECT_IDENTIFIER_BANK'],
  [labelPattern(HEALTH_LABELS, STRICT_SEP, HEALTH_VALUE), 'HEALTH', 'SENSITIVE_HEALTH_CONDITION'],
  [labelPattern(HEALTH_PHRASES, '(\\s+)', HEALTH_VALUE), 'HEALTH', 'SENSITIVE_HEALTH_CONDITION'],
  [labelPattern(EMAIL_LABELS, STRICT_SEP, '([^\\s,;<>]{3,100})'), 'EMAIL', 'DIRECT_IDENTIFIER_EMAIL'],
  [labelPattern(PHONE_LABELS, LOOSE_SEP, PHONE_VALUE), 'PHONE', 'DIRECT_IDENTIFIER_PHONE', value => (value.match(/\d/g)?.length ?? 0) >= 5],
  [labelPattern(GOV_ID_LABELS, LOOSE_SEP, GOV_ID_VALUE), 'GOV_ID', 'DIRECT_IDENTIFIER_GOVERNMENT_ID', value => (value.match(/[\dXx*•]/g)?.length ?? 0) >= 8],
  [labelPattern(DOB_LABELS, LOOSE_SEP, DATE_VALUE), 'DOB', 'DIRECT_IDENTIFIER_DATE_OF_BIRTH'],
  [labelPattern(DOB_LABELS, STRICT_SEP, '([^\\n,;<]{2,40})'), 'DOB', 'DIRECT_IDENTIFIER_DATE_OF_BIRTH'],
  [labelPattern(ADDRESS_LABELS, STRICT_SEP, ADDRESS_CLAUSE), 'ADDRESS', 'DIRECT_IDENTIFIER_ADDRESS'],
  [labelPattern(ADDRESS_LABELS, '(\\s+)', `${ADDRESS_START}${ADDRESS_CLAUSE}`), 'ADDRESS', 'DIRECT_IDENTIFIER_ADDRESS'],
  [labelPattern(ID_LABELS, LOOSE_SEP, ID_VALUE), 'IDENTIFIER', 'DIRECT_IDENTIFIER_LABELED_VALUE', value => /\d/.test(value)],
  [labelPattern(`${NAME_LABELS}|${BARE_NAME_LABELS}`, STRICT_SEP, NAME_CLAUSE), 'NAME', 'DIRECT_IDENTIFIER_LABELED_VALUE'],
  // "Insured Name ASHA EXAMPLE": whitespace or dash separated, capitalised value.
  [labelPattern(ci(NAME_LABELS), '(\\s+|\\s*[\\u2013\\u2014-]+\\s*)', CAPITALISED_NAME, 'gu'), 'NAME', 'DIRECT_IDENTIFIER_LABELED_VALUE', value => !HONORIFIC_ONLY.test(value)],
]);

const UNLABELLED_RULES = Object.freeze([
  [/(?<![A-Za-z0-9])[A-Za-z][1-9][0-9]{6}(?![A-Za-z0-9])/g, 'PASSPORT', 'DIRECT_IDENTIFIER_PASSPORT'],
  [/(?<![A-Za-z0-9])[A-Za-z]{4}0[A-Za-z0-9]{6}(?![A-Za-z0-9])/g, 'BANK', 'DIRECT_IDENTIFIER_BANK'],
  [/(?<![A-Za-z0-9])[A-Za-z]{5}\d{4}[A-Za-z](?![A-Za-z0-9])/g, 'PAN', 'DIRECT_IDENTIFIER_PAN'],
  [/(?<![A-Za-z0-9])[A-Za-z]{3}\d{7}(?![A-Za-z0-9])/g, 'GOV_ID', 'DIRECT_IDENTIFIER_GOVERNMENT_ID'],
]);

function isIndianPhone(plus, groups) {
  let rest = groups;
  let prefixed = plus === '+';
  if (rest.length > 1 && /^(?:0{0,2}91|0)$/.test(rest[0])) { rest = rest.slice(1); prefixed = true; }
  let digits = rest.join('');
  if (rest.length === 1 && digits.length === 12 && digits.startsWith('91')) { digits = digits.slice(2); prefixed = true; }
  if (rest.length === 1 && digits.length === 11 && digits.startsWith('0')) { digits = digits.slice(1); prefixed = true; }
  if (rest.length > 4 || digits.length !== 10) return false;
  // Unprefixed numbers must look like mobiles; with an explicit +91/0 prefix a
  // landline (STD code + number) also qualifies.
  if (!(/^[6-9]/.test(digits) || (prefixed && /^[1-9]/.test(digits)))) return false;
  return prefixed || !allRoundAmounts(rest);
}

// Aadhaar (12 digits, never starting 0/1) and its 16-digit virtual id, printed
// contiguously or in groups of four, including dot- or dash-separated groups.
function isGovernmentId(groups) {
  const shape = groups.map(group => group.length).join(',');
  const digits = groups.join('');
  if (shape === '12' || shape === '4,4,4') return /^[2-9]/.test(digits) && !isAscendingYears(groups) && !allRoundAmounts(groups);
  if (shape === '16' || shape === '4,4,4,4') return /^[1-9]/.test(digits) && !isAscendingYears(groups) && !allRoundAmounts(groups);
  return false;
}

function redactSegment(segment, state, reasons) {
  let value = segment;
  const swap = (kind, reason, raw) => { reasons.add(reason); return placeholder(state, kind, raw); };
  const replace = (pattern, kind, reason) => {
    value = value.replace(pattern, match => swap(kind, reason, match));
  };
  const replaceStructured = (pattern, kind, reason) => {
    value = value.replace(pattern, (_match, prefix, identifier, suffix) => `${prefix}${swap(kind, reason, identifier)}${suffix}`);
  };
  const replaceLabelled = (pattern, kind, reason, accept = () => true) => {
    value = value.replace(pattern, (match, label, _separator, captured) => {
      const trimmed = captured.replace(/[\s.]+$/u, '');
      if (!trimmed || !accept(trimmed)) return match;
      return `${label}: ${swap(kind, reason, trimmed)}${captured.slice(trimmed.length)}`;
    });
  };
  const replaceNamed = pattern => {
    value = value.replace(pattern, (_match, prefix, name) => `${prefix} ${swap('NAME', 'DIRECT_IDENTIFIER_PERSON_NAME', name)}`);
  };

  // Encoded blobs first, so identifiers hidden in base64 are not split by later rules.
  value = value.replace(BASE64_BLOB, blob => (decodeReadableBase64(blob) ? swap('ENCODED', 'DIRECT_IDENTIFIER_ENCODED_VALUE', blob) : blob));
  // Structured and labelled values next, so a whole value is minimised rather
  // than fragments of it.
  replaceStructured(STRUCTURED_ID_PATTERN, 'ID', 'DIRECT_IDENTIFIER_STRUCTURED_ID');
  replaceStructured(GENERIC_ID_KEY_PATTERN, 'ID', 'DIRECT_IDENTIFIER_STRUCTURED_ID');
  replace(INTERNAL_RECORD_ID_PATTERN, 'ID', 'DIRECT_IDENTIFIER_STRUCTURED_ID');
  replaceStructured(STRUCTURED_HEALTH_PATTERN, 'HEALTH', 'SENSITIVE_HEALTH_CONDITION');
  replaceStructured(STRUCTURED_IDENTITY_PATTERN, 'IDENTIFIER', 'DIRECT_IDENTIFIER_LABELED_VALUE');
  replace(EMAIL_PATTERN, 'EMAIL', 'DIRECT_IDENTIFIER_EMAIL');
  replace(UPI_PATTERN, 'UPI', 'DIRECT_IDENTIFIER_BANK');
  // Honorific- or relation-prefixed names before labels, so "Proposer MRS. ASHA
  // EXAMPLE" is not cut at the honorific's full stop.
  replaceNamed(HONORIFIC_NAME);
  replaceNamed(RELATION_NAME);
  replaceNamed(DEVANAGARI_HONORIFIC_NAME);
  for (const [pattern, kind, reason, accept] of LABELLED_RULES) replaceLabelled(pattern, kind, reason, accept);
  for (const [pattern, kind, reason] of UNLABELLED_RULES) replace(pattern, kind, reason);
  value = value.replace(DIGIT_RUN, (match, plus, run) => {
    const groups = run.split(GROUP_SEPARATOR);
    if (isIndianPhone(plus, groups)) return swap('PHONE', 'DIRECT_IDENTIFIER_PHONE', match);
    if (isGovernmentId(groups)) return `${plus}${swap('GOV_ID', 'DIRECT_IDENTIFIER_GOVERNMENT_ID', run)}`;
    if (cardClassification(groups, false)) return `${plus}${swap('NUMBER', 'DIRECT_IDENTIFIER_CARD_LIKE_NUMBER', run)}`;
    return match;
  });
  return value;
}

function redactText(value, state) {
  const prepared = prepareText(value);
  rejectRestrictedText(prepared.text);
  const reasons = new Set(prepared.capped ? ['TEXT_TRUNCATED'] : []);
  // Each rule runs over the text between placeholders only, so a placeholder is
  // never rescanned and never matched by a later rule.
  const withoutLegacy = prepared.text.replace(ANY_TOKEN, token => {
    const legacy = token.match(LEGACY_TOKEN);
    if (!legacy) return token;
    reasons.add('LEGACY_TOKEN_REPLACED');
    return placeholder(state, legacy[1].split('_').filter(Boolean).join('_') || 'ID', token);
  });
  const text = outsideTokens(withoutLegacy, segment => redactSegment(segment, state, reasons));
  return { text, reasons: [...reasons].sort() };
}

export function sanitizeEvidenceTextForStorage(text, { maxBytes = 4_000 } = {}) {
  if (typeof text !== 'string' || text.trim() === '') fail('PRIVACY_GATE_MALFORMED', 'Evidence text must be non-empty text.');
  if (!Number.isInteger(maxBytes) || maxBytes <= 0 || maxBytes > 16_000) fail('PRIVACY_GATE_MALFORMED', 'Storage text byte limit is invalid.');
  if (Buffer.byteLength(text, 'utf8') > 64_000) fail('EVIDENCE_SOURCE_LIMIT', 'Evidence text exceeds its intake byte limit.');
  const redacted = redactText(text, createPlaceholderState(text));
  const excerpt = truncateUtf8(redacted.text, maxBytes);
  const reasonCodes = new Set(redacted.reasons);
  if (excerpt.truncated) reasonCodes.add('TEXT_TRUNCATED');
  return Object.freeze({
    text: excerpt.text,
    digest: digest(text),
    reasonCodes: Object.freeze([...reasonCodes].sort()),
    truncated: excerpt.truncated || reasonCodes.has('TEXT_TRUNCATED'),
  });
}

function normalizeDataClass(value, label) {
  if (typeof value !== 'string') fail('PRIVACY_GATE_MALFORMED', `${label} needs a data class.`);
  const normalized = value.toUpperCase();
  if (!EVIDENCE_DATA_CLASSES.includes(normalized)) fail('PRIVACY_GATE_MALFORMED', `${label} has an invalid data class.`);
  return normalized;
}

function resolvePolicies(parameterKeys, resolveParameterPolicy) {
  if (parameterKeys.length === 0) return [];
  if (typeof resolveParameterPolicy !== 'function') {
    fail('PARAMETER_POLICY_REQUIRED', 'A parameter policy resolver is required before model use.');
  }
  return parameterKeys.map(key => {
    const policy = resolveParameterPolicy(key);
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
      fail('PARAMETER_NOT_CLASSIFIED', 'An evidence parameter is not classified for model use.');
    }
    const permitted = policy.modelExtraction === true
      || policy.modelExtraction === 'allow'
      || policy.modelExtraction?.allowed === true;
    if (!permitted) fail('PARAMETER_MODEL_DISALLOWED', 'An evidence parameter is not permitted for model extraction.');
    const dataClass = normalizeDataClass(policy.dataClass, 'Parameter policy');
    if (dataClass === 'RESTRICTED') fail('RESTRICTED_EVIDENCE', 'Restricted evidence cannot be sent to a model.');
    const registryVersion = policy.registryVersion ?? null;
    if (registryVersion !== null && (typeof registryVersion !== 'string' || !/^[A-Za-z0-9._/-]{1,120}$/.test(registryVersion))) {
      fail('PRIVACY_GATE_MALFORMED', 'Parameter registry version is invalid.');
    }
    return Object.freeze({ key, dataClass, registryVersion });
  });
}

function sanitizeStructured(value, state, key = '', depth = 0) {
  if (depth > state.limits.maxStructuredDepth) fail('PRIVACY_GATE_MALFORMED', 'Structured evidence is too deeply nested.');
  state.items += 1;
  if (state.items > state.limits.maxStructuredItems) fail('PRIVACY_GATE_MALFORMED', 'Structured evidence has too many items.');
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  if (typeof value === 'string') {
    if (/(?:^|_)(?:id|ids)$/i.test(key) || /Id(?:s)?$/.test(key)) {
      state.reasons.add('DIRECT_IDENTIFIER_STRUCTURED_ID');
      return placeholder(state.placeholders, 'ID', value);
    }
    const sensitive = STRUCTURED_SENSITIVE_KEYS.get(key.toLowerCase());
    if (sensitive) {
      rejectRestrictedText(prepareText(value).text);
      state.reasons.add(sensitive[1]);
      return placeholder(state.placeholders, sensitive[0], value);
    }
    const redacted = redactText(value, state.placeholders);
    redacted.reasons.forEach(reason => state.reasons.add(reason));
    return redacted.text;
  }
  if (Array.isArray(value)) return value.map(item => sanitizeStructured(item, state, key, depth + 1));
  plainObject(value, 'Structured evidence value');
  const output = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(childKey)) fail('PRIVACY_GATE_MALFORMED', 'Structured evidence contains an unsafe key.');
    output[childKey] = sanitizeStructured(childValue, state, childKey, depth + 1);
  }
  return output;
}

function limitsWithDefaults(limits = {}) {
  exactKeys(limits, Object.keys(DEFAULT_LIMITS), 'Privacy gate limits');
  const value = { ...DEFAULT_LIMITS, ...limits };
  for (const [key, number] of Object.entries(value)) {
    if (!Number.isInteger(number) || number <= 0) fail('PRIVACY_GATE_MALFORMED', `${key} must be a positive integer.`);
  }
  if (value.maxRawSourceBytes > 64_000 || value.maxSourceBytes > 16_000 || value.maxTotalBytes > 96_000 || value.maxSources > 30) {
    fail('PRIVACY_GATE_MALFORMED', 'Privacy gate limits exceed their safety ceiling.');
  }
  return Object.freeze(value);
}

export function sanitizeEvidenceForModel(input, { task = 'model_task', resolveParameterPolicy, limits } = {}) {
  const bounded = limitsWithDefaults(limits);
  if (typeof task !== 'string' || !/^[a-z][a-z0-9_]{0,79}$/.test(task)) fail('PRIVACY_GATE_MALFORMED', 'Model task name is invalid.');
  exactKeys(input, ['context', 'sources', 'upstream'], 'Model evidence');
  exactKeys(input.context, ['caseId', 'subjectId', 'purpose', 'requestedFields'], 'Model evidence context');
  const caseId = boundedText(input.context.caseId, 160, 'caseId');
  const subjectId = boundedText(input.context.subjectId, 160, 'subjectId');
  const purpose = boundedText(input.context.purpose, 240, 'purpose');
  if (!Array.isArray(input.context.requestedFields) || input.context.requestedFields.length > 40) {
    fail('PRIVACY_GATE_MALFORMED', 'requestedFields must be a bounded array.');
  }
  const parameterKeys = [...new Set(input.context.requestedFields)];
  for (const key of parameterKeys) {
    if (typeof key !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,119}$/.test(key)) {
      fail('PRIVACY_GATE_MALFORMED', 'A requested parameter key is invalid.');
    }
  }
  const policies = resolvePolicies(parameterKeys, resolveParameterPolicy);
  if (!Array.isArray(input.sources) || input.sources.length < 1 || input.sources.length > bounded.maxSources) {
    fail('EVIDENCE_SOURCE_LIMIT', 'Evidence source count is outside its safety bound.');
  }
  // One placeholder namespace for the whole request: the same value maps to the
  // same placeholder in every source, version, purpose and upstream value.
  let serialized;
  try {
    serialized = JSON.stringify(input);
  } catch {
    fail('PRIVACY_GATE_MALFORMED', 'Model evidence must be serialisable.');
  }
  const placeholders = createPlaceholderState(serialized);

  const policyClasses = policies.map(policy => policy.dataClass);
  const safeSources = [];
  const sourceAudit = [];
  const safeIds = new Set();
  for (const source of input.sources) {
    exactKeys(source, ['id', 'version', 'page', 'text', 'status', 'dataClass'], 'Evidence source');
    const rawId = boundedText(source.id, 200, 'source id');
    const version = boundedText(source.version, 120, 'source version');
    if (!(source.page === null || (Number.isInteger(source.page) && source.page >= 1))) fail('PRIVACY_GATE_MALFORMED', 'Source page must be null or a positive integer.');
    if (typeof source.text !== 'string' || source.text.trim() === '') fail('PRIVACY_GATE_MALFORMED', 'Source text must be non-empty text.');
    if (Buffer.byteLength(source.text, 'utf8') > bounded.maxRawSourceBytes) fail('EVIDENCE_SOURCE_LIMIT', 'Evidence source text exceeds its intake byte limit.');
    if (!SOURCE_STATES.has(source.status)) fail('PRIVACY_GATE_MALFORMED', 'Source status is invalid.');
    let dataClass = source.dataClass === undefined
      ? (policyClasses.includes('CONFIDENTIAL') ? 'CONFIDENTIAL' : 'INTERNAL')
      : normalizeDataClass(source.dataClass, 'Evidence source');
    if (dataClass === 'RESTRICTED') fail('RESTRICTED_EVIDENCE', 'Restricted evidence cannot be sent to a model.');

    const redactedText = redactText(source.text, placeholders);
    const excerpt = truncateUtf8(redactedText.text, bounded.maxSourceBytes);
    const textReasons = new Set(redactedText.reasons);
    if (excerpt.truncated) textReasons.add('TEXT_TRUNCATED');
    const safeVersion = redactText(version, placeholders);
    if (textReasons.size > 0 || safeVersion.reasons.length > 0) dataClass = 'CONFIDENTIAL';
    const reasons = new Set([...textReasons, ...safeVersion.reasons]);
    const safeId = opaqueId('source', rawId);
    if (safeIds.has(safeId)) fail('PRIVACY_GATE_MALFORMED', 'Evidence source IDs must be unique.');
    safeIds.add(safeId);
    safeSources.push({ id: safeId, version: safeVersion.text, page: source.page, text: excerpt.text, status: source.status });
    sourceAudit.push(Object.freeze({ sourceId: safeId, digest: digest(source.text), dataClass, page: source.page, version: safeVersion.text, redactionReasonCodes: [...reasons].sort(), inputBytes: Buffer.byteLength(source.text, 'utf8'), outputBytes: Buffer.byteLength(excerpt.text, 'utf8') }));
  }

  if (!Array.isArray(input.upstream) || input.upstream.length > 20) fail('PRIVACY_GATE_MALFORMED', 'upstream must be a bounded array.');
  const structuredState = { limits: bounded, items: 0, reasons: new Set(), placeholders };
  const safeUpstream = sanitizeStructured(input.upstream, structuredState);
  if (Buffer.byteLength(JSON.stringify(safeUpstream), 'utf8') > bounded.maxUpstreamBytes) {
    fail('EVIDENCE_UPSTREAM_LIMIT', 'Structured upstream evidence exceeds its byte limit.');
  }
  const safePurpose = redactText(purpose, placeholders);
  const safeInput = {
    context: {
      caseId: opaqueId('case', caseId),
      subjectId: opaqueId('subject', subjectId),
      purpose: safePurpose.text,
      requestedFields: parameterKeys,
    },
    sources: safeSources,
    upstream: safeUpstream,
  };
  const totalBytes = Buffer.byteLength(JSON.stringify(safeInput), 'utf8');
  if (totalBytes > bounded.maxTotalBytes) fail('EVIDENCE_TOTAL_LIMIT', 'Sanitized model evidence exceeds its byte limit.');

  const registryVersions = [...new Set(policies.map(policy => policy.registryVersion).filter(Boolean))].sort();
  const redactionReasonCodes = [...new Set([
    ...safePurpose.reasons,
    ...structuredState.reasons,
    ...sourceAudit.flatMap(source => source.redactionReasonCodes),
  ])].sort();
  const audit = Object.freeze({
    gateVersion: PRIVACY_EVIDENCE_GATE_VERSION,
    decision: 'allowed',
    task,
    parameterKeys: Object.freeze([...parameterKeys]),
    registryVersions: Object.freeze(registryVersions),
    sourceCount: safeSources.length,
    sources: Object.freeze(sourceAudit),
    redactionReasonCodes: Object.freeze(redactionReasonCodes),
    totalOutputBytes: totalBytes,
  });
  return Object.freeze({ input: structuredClone(safeInput), audit });
}
