// Scrubbing for anything that leaves the process as a log line or an error report (ADR 0016).
// Two independent layers: keys that name sensitive data have their value removed whatever it holds, and every remaining
// string is pattern-scrubbed for identifiers (PAN, Aadhaar, phone and card-length digit runs, email, credentials).
// Detection is deliberately over-eager: a false positive costs a redacted log field, a miss leaks an identifier.
// Self-contained: src/shared may not import from other source areas.

export const REDACTED = '[REDACTED]';

const MAX_DEPTH = 8;
const MAX_STRING = 500;
const MAX_ITEMS = 50;
const MAX_NODES = 2000; // total values visited per scrubValue call, so a wide or shared structure cannot hold the event loop

// Unicode-aware (\p{Nd} covers Devanagari, Arabic-Indic and other digit scripts). Separators between digits may be a
// space, dot, hyphen, slash or no-break space, up to three of them.
const SEP = String.raw`[\s\u00a0./-]{0,3}`;
const PATTERNS = Object.freeze([
  /[\p{L}\p{N}._%+'-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*/gu, // e-mail, ABHA address (name@abdm), any name@host
  /[A-Z]{5}[\s.-]{0,2}\p{Nd}{4}[\s.-]{0,2}[A-Z]/giu, // PAN, also with spaces or hyphens, and glued to other letters
  /(?<![\p{L}\p{N}])[A-Z]{4}0[A-Z0-9]{6}(?![\p{L}\p{N}])/giu, // IFSC
  /(?<![\p{L}\p{N}])[A-Z]{2}[ -]?\p{Nd}{1,2}[ -]?[A-Z]{1,3}[ -]?\p{Nd}{4}(?![\p{L}\p{N}])/giu, // vehicle registration
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, // bearer credential
  /(?<![A-Za-z0-9_-])AIza[A-Za-z0-9_-]{20,}/g, // Google API key
  /(?<![A-Za-z0-9])(?:sk|pk|rk|ghp|gho|ghu|ghs|github_pat|xox[abprs]|AKIA|ASIA)[-_]?[A-Za-z0-9_-]{16,}/g, // common provider key prefixes
  /(?<![A-Za-z0-9_-])(?![0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![A-Za-z0-9_-]))(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/gi, // long mixed token: key, secret, hash (a plain UUID is an opaque id and is kept)
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, // JWT
  /(?<!\p{Nd})\p{Nd}{1,2}[/.-]\p{Nd}{1,2}[/.-]\p{Nd}{2,4}(?!\p{Nd})/gu, // date of birth dd/mm/yyyy, dd-mm-yy, dd.mm.yyyy
  /(?<!\p{Nd})\p{Nd}{4}[/.-]\p{Nd}{1,2}[/.-]\p{Nd}{1,2}(?!\p{Nd})/gu, // yyyy-mm-dd
  /(?<!\p{Nd})\p{Nd}{1,2}[ -](?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[ ,.-]+\p{Nd}{2,4}(?!\p{Nd})/giu, // 15 Aug 1990
  new RegExp(String.raw`(?<!\p{Nd})[+(]?\p{Nd}(?:\)?${SEP}\p{Nd}){8,}(?!\p{Nd})`, 'gu'), // 9 or more digits: Aadhaar, phone, card, account
]);

/** Pattern-scrub, then fold anything outside printable ASCII to "?": log lines are ASCII by design and a name in another script cannot be recognised. */
export function scrubText(value) {
  // Dash-like characters (en dash, minus sign, non-breaking hyphen and others) are folded to "-" so they cannot split an identifier.
  let text = String(value).normalize('NFKC').replace(/[\u2010-\u2015\u2212\u207b\u208b\ufe58\ufe63\uff0d]/gu, '-');
  for (const pattern of PATTERNS) text = text.replace(pattern, REDACTED);
  return text.replace(/[^\x20-\x7E]/gu, '?');
}

// Whole words. Matched after splitting camelCase, snake_case and kebab-case.
const SENSITIVE_WORDS = new Set([
  'token', 'secret', 'password', 'passwd', 'authorization', 'cookie', 'jwt', 'bearer', 'session', 'key', 'dsn', 'otp', 'pin', 'cvv',
  'pan', 'aadhaar', 'aadhar', 'uid', 'ssn', 'dob', 'birth', 'email', 'phone', 'mobile', 'msisdn', 'address', 'name',
  'body', 'payload', 'text', 'content', 'prompt', 'ocr', 'diagnosis', 'claimant', 'nominee',
]);
// Substrings of the lower-cased key with separators removed, for compound words that do not split cleanly.
const SENSITIVE_SUBSTRINGS = Object.freeze([
  'authorization', 'cookie', 'password', 'passwd', 'secret', 'apikey', 'aadhaar', 'aadhar', 'email', 'phone', 'mobile',
  'policynumber', 'membernumber', 'memberid', 'cardnumber', 'creditcard', 'accountnumber', 'displayname', 'fullname',
  'ocrtext', 'dateofbirth', 'privatekey',
]);

export function isSensitiveKey(key) {
  const words = String(key).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (words.some(word => SENSITIVE_WORDS.has(word))) return true;
  const joined = words.join('');
  return SENSITIVE_SUBSTRINGS.some(part => joined.includes(part));
}

// The two keys pino writes itself keep their value only in their exact expected shape; anything else is scrubbed like any value.
const ISO_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const LEVEL_LABELS = new Set(['fatal', 'error', 'warn', 'info', 'debug', 'trace']);
const isLoggerOwn = (key, value) => (key === 'time' && ISO_TIME.test(value)) || (key === 'level' && LEVEL_LABELS.has(value));

/**
 * Deep copy with sensitive keys removed and every string scrubbed and bounded. Non-plain values (functions, symbols,
 * class instances other than arrays and errors) are reduced to a type label rather than serialised.
 */
export function scrubValue(value, state = { depth: 0 }) {
  const budget = state.budget ?? { nodes: 0 };
  const ancestors = state.ancestors ?? new WeakSet();
  const depth = state.depth ?? 0;
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    // Scrub first, cut second: cutting first would leave a fragment of an identifier that straddles the limit.
    const scrubbed = scrubText(value);
    return scrubbed.length > MAX_STRING ? `${scrubbed.slice(0, MAX_STRING)}...` : scrubbed;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return Number(value);
  if (depth >= MAX_DEPTH) return '[TRUNCATED]';
  if (typeof value !== 'object') return `[${typeof value}]`;
  // One shared node budget and an ancestor set: a cycle is cut where it closes, and a structure that is huge or shares
  // sub-objects at every level stops being walked once the budget is spent.
  if (ancestors.has(value)) return '[CIRCULAR]';
  if ((budget.nodes += 1) > MAX_NODES) return '[TRUNCATED]';
  ancestors.add(value);
  try {
    const next = { depth: depth + 1, budget, ancestors };
    if (Array.isArray(value)) return value.slice(0, MAX_ITEMS).map(item => scrubValue(item, next));
    const out = {};
    for (const [key, inner] of Object.entries(value).slice(0, MAX_ITEMS)) {
      if (depth === 0 && isLoggerOwn(key, inner)) { out[key] = inner; continue; }
      out[scrubText(key)] = isSensitiveKey(key) ? REDACTED : scrubValue(inner, next);
    }
    return out;
  } finally {
    ancestors.delete(value);
  }
}

// Paths handed to pino's own redaction (first layer, applied before serialisation). The scrubber above is the second layer.
export const PINO_REDACT_PATHS = Object.freeze([
  'req', 'res', 'request', 'response', 'body', 'headers', 'rawBody', 'payload', 'prompt', 'text',
  '*.body', '*.headers', '*.authorization', '*.cookie', '*.payload', '*.prompt', '*.text',
]);
