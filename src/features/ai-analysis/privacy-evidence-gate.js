import { createHash } from 'node:crypto';

// v2: Unicode normalisation before scanning, per-request indexed placeholders
// (no value-derived hashes), shape-based payment-card detection, a per-call scan
// cap and linear-time patterns.
// v3: inline whitespace runs collapsed before scanning, caller-supplied known
// identifiers redacted before pattern scanning, member-table rows and name
// lists, wider label variants, and policy-wording guards against over-redaction.
// v4: pipe tables read by header and row label (identity and member health
// columns, ICD tables), headers carried over page breaks, and table rows fail
// closed on ID-shaped cells and whole-cell dates. Headers split over two rows are
// read as one header; tab-separated tables (two or more tab rows) are refused as
// restricted, because collapsing tabs loses the cell boundaries a header needs.
export const PRIVACY_EVIDENCE_GATE_VERSION = 'knowvia-privacy-evidence-v9';
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
// is the normalised form. Line breaks are unified and every run of inline
// whitespace (spaces, tabs, NBSP, ...) becomes one space, so "4111  1111" and
// "98765\t43210" are scanned exactly like their single-spaced forms.
const LINE_BREAK = /\r\n?|[\u2028\u2029]/g;
const INLINE_WHITESPACE_RUN = /[^\S\n]+/g;

function normalizeText(value) {
  return value.normalize('NFKC').replace(FORMAT_CHARACTERS, '').replace(NON_ASCII_DIGIT, asciiDigit)
    .replace(LINE_BREAK, '\n').replace(INLINE_WHITESPACE_RUN, ' ');
}

// A tab-separated table is two or more lines that each hold two or more
// tab-separated cells, with a header-like cell (any column kind a pipe header
// would read) or an ID-shaped or whole-date cell among them. Inline whitespace
// is collapsed before scanning, so its cells and header could not be read; such
// text fails closed instead of being scanned as prose. A single tab row, and a
// tab used as spacing in prose, keep the line rules (N1, N2 probes).
const TAB_ROW = /\S[^\S\n]*\t[^\S\n]*\S/;

function tabTableCell(raw) {
  const cell = normalizeText(raw).trim();
  if (!cell) return false;
  return Boolean(columnKind(cell)) || (ID_SHAPE.test(cell) && !PRODUCT_UIN.test(cell)) || WHOLE_DATE.test(cell);
}

function rejectTabTables(value) {
  const lines = value.normalize('NFKC').replace(FORMAT_CHARACTERS, '').replace(LINE_BREAK, '\n').split('\n');
  const rows = lines.filter(line => TAB_ROW.test(line));
  if (rows.length >= 2 && rows.some(row => row.split('\t').some(tabTableCell))) {
    fail('RESTRICTED_EVIDENCE', 'Restricted evidence cannot be sent to a model.');
  }
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
const HAS_TOKEN = new RegExp(`${PLACEHOLDER_SOURCE}|${LEGACY_TOKEN_SOURCE}`);
const LEGACY_TOKEN = new RegExp(`^<([A-Z_]+):[a-f0-9]{16}>$`);

function createPlaceholderState(seedText = '', known = null) {
  const counters = new Map();
  for (const match of seedText.matchAll(PLACEHOLDER)) {
    counters.set(match[1], Math.max(counters.get(match[1]) ?? 0, Number(match[2])));
  }
  return { counters, assigned: new Map(), known };
}

const MONTH_NUMBERS = new Map(['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].map((month, index) => [month, index + 1]));
const pad2 = number => String(number).padStart(2, '0');

function isoDate(year, month, day) {
  const [y, m, d] = [Number(year), Number(month), Number(day)];
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

// A rendered date (four-digit year) as an ISO date, so "01/02/1990",
// "1 Feb 1990" and the stored "1990-02-01" share one placeholder. Numeric
// day-month order follows the Indian convention (D/M/Y).
function dateToIso(value) {
  const text = value.trim().toLowerCase();
  let match = text.match(/^(\d{4})\D{1,2}(\d{1,2})\D{1,2}(\d{1,2})$/);
  if (match) return isoDate(match[1], match[2], match[3]);
  match = text.match(/^(\d{1,2})\D{1,2}(\d{1,2})\D{1,2}(\d{4})$/);
  if (match) return isoDate(match[3], match[2], match[1]);
  match = text.match(/^(\d{1,2})(?:st|nd|rd|th)?[\s.,-]*(?:of\s+)?([a-z]{3})[a-z]*\.?[\s.,-]*(\d{4})$/);
  if (match && MONTH_NUMBERS.has(match[2])) return isoDate(match[3], MONTH_NUMBERS.get(match[2]), match[1]);
  match = text.match(/^([a-z]{3})[a-z]*\.?[\s-]*(\d{1,2})(?:st|nd|rd|th)?,?[\s-]*(\d{4})$/);
  if (match && MONTH_NUMBERS.has(match[1])) return isoDate(match[3], MONTH_NUMBERS.get(match[1]), match[2]);
  return null;
}

function canonicalValue(kind, value) {
  const folded = String(value).normalize('NFKC').toLowerCase().replace(/[\s.()‐-―_/-]+/gu, '');
  if (kind === 'DOB') return dateToIso(String(value).normalize('NFKC')) ?? folded;
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
  /(?<![\p{L}\p{N}])(?:password|passwd|pwd|pass[_ -]?phrase|api[_ -]?key|api[_ -]?secret|secret[_ -]?key|client[_ -]?secret|private[_ -]?key|access[_ -]?key(?:[_ -]?id)?|access[_ -]?token|refresh[_ -]?token|auth[_ -]?token|session[_ -]?token|id[_ -]?token|bearer[_ -]?token|secret|token)(?![\p{L}\p{N}_])["']?\s*[=:]\s*["']?[^\s,"'}]{6,}/iu,
  // One-time codes, card verification values and PINs. The separator forms are
  // alternatives (not adjacent optional runs) so the match is linear.
  /(?<![\p{L}\p{N}])(?:otp|one[_ -]?time[_ -]?(?:password|passcode|code)|verification[_ -]?code|security[_ -]?code|cvv2?|cvc2?|card[_ -]?verification[_ -]?(?:value|code)|upi[_ -]?pin|m-?pin|atm[_ -]?pin|card[_ -]?pin|(?:my|your|new|old|secret|login)\s+pin(?![\s_-]*code)|pin\s+(?:number|no\.?))(?![\p{L}_])["']?[\s:=-]*(?:(?:is|are|was|code|for|your|the|login|transaction|no|number|sent|to|you|my)(?![\p{L}_])[\s:=-]*){0,4}["']?\d(?:[ -]?\d){2,7}(?!\d)/iu,
  // Credential keys with a prefix: camelCase ("dbPassword"), snake_case ("my_secret_value"), dotted ("user.access_token").
  /(?<![A-Za-z0-9_.-])[A-Za-z0-9_.-]{0,40}?(?:(?<=[_.-])(?:[Pp]assword|[Pp]asswd|[Pp]wd|[Aa]pi_?[Kk]ey|[Ss]ecret|[Tt]oken|[Pp]rivate_?[Kk]ey|[Aa]ccess_?[Kk]ey)|(?<=[a-z0-9])(?:Password|Passwd|Pwd|ApiKey|Secret|Token|PrivateKey|AccessKey)|(?<![A-Za-z0-9])(?:apiKey|accessKey|privateKey))(?![a-z])[A-Za-z0-9_.-]{0,60}["']?\s*[=:]\s*["']?[^\s,"'}]{6,}/u,
  // Natural-language forms: "the password is hunter22", "password hunter22", "client secret abc123def456".
  /(?<![\p{L}\p{N}])(?:password|passwd|pwd|passcode|pass)(?![\p{L}\p{N}_])["']?(?:\s*[=:]\s*["']?[^\s,"'}]{6,}|\s+(?:is|are|was)\s+["']?(?=[^\s,"'}]*\d)[^\s,"'}]{6,})/iu,
  /(?<![\p{L}\p{N}])(?:password|passwd|pwd|passcode|(?:api|client)[_ -]?secret|secret[_ -]?key|api[_ -]?key|access[_ -]?token)\s+["']?(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{6,}/iu,
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
  /\bBasic\s+[A-Za-z0-9+/]{16,}={0,2}/,
  // Well-known provider credential formats.
  /\bAIza[0-9A-Za-z_-]{35}/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16,}\b/,
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
// Groups may be joined by a space, dot, dash, newline, underscore, slash or middle dot.
const DIGIT_RUN = /(?<!\p{N})(\+?)(\d+(?:[ .‐-―\-\n_/·]\d+)*)(?![\p{N}])/gu;
const GROUP_SEPARATOR = /[ .‐-―\-\n_/·]/u;
// Printed card groupings: 4-4-4-4 (+1..3), 4-6-5 (Amex), 4-6-4 (Diners), 4-4-5.
const CARD_SHAPES = Object.freeze([[4, 4, 4, 4], [4, 4, 4, 4, 1], [4, 4, 4, 4, 2], [4, 4, 4, 4, 3], [4, 6, 5], [4, 6, 4], [4, 4, 5]]);
const CARD_LABEL = /(?:card|credit|debit|visa|master\s?card|rupay|amex|american\s+express|maestro|diners|discover|cvv|cvc|expiry|valid\s+thru|exp\.?\s*date)/i;
// Major networks (Mastercard 2/5, Amex/Diners/JCB 3, Visa 4, Discover/RuPay/Maestro 6, RuPay 8).
const CARD_NETWORK_PREFIX = /^[2-68]/;
// Identifier labels (policy, certificate, member, proposal, receipt, claim, customer, UIN, e-card + no/number/id).
// A Luhn-valid run behind one of these is a policy-style identifier: minimised, never mistaken for a payment card.
const ID_LABEL = /\b(?:(?:policy|certificate|member(?:ship)?|proposal|receipt|claim|customer|e-?card|uin)\s*(?:no\.?|number|num|id|#)|uin)\b\s*[:.\-#]*\s*$/i;
const LABEL_WINDOW = 48;
// Prefix and length of real card networks. A lone unlabelled Luhn-valid run is rejected only when it has one of
// these shapes; any other 13-19 digit run (a 19-digit policy number, say) is minimised instead.
const NETWORK_SHAPES = Object.freeze([
  [/^4/, [13, 16, 19]], [/^(?:5[1-5]|2(?:2[2-9]|[3-6]\d|7[01]|720))/, [16]], [/^3[47]/, [15]], [/^3(?:0[0-5]|[68])/, [14]],
  [/^35/, [16, 17, 18, 19]], [/^6(?:011|5|4[4-9])/, [16, 17, 18, 19]], [/^(?:60|81|82|508)/, [16]],
]);
const hasNetworkShape = digits => NETWORK_SHAPES.some(([prefix, lengths]) => prefix.test(digits) && lengths.includes(digits.length));

// Label context of a digit run: `card` is an explicit payment-card label, `identifier` an ID label.
// "e-card" and "health card" name insurer cards, so they are removed before the card-label test.
function runLabels(value, index) {
  const prefix = value.slice(Math.max(0, index - LABEL_WINDOW), index);
  return {
    card: CARD_LABEL.test(prefix.replace(/\b(?:e-?card|health\s+card)\b/gi, ' ')),
    identifier: ID_LABEL.test(prefix),
  };
}

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
function cardClassification(groups, labelled, identifierLabelled = false) {
  const digits = groups.join('');
  // An identifier label downgrades an unlabelled card shape to minimisation; a card label always wins.
  const unlabelledVerdict = identifierLabelled ? 'ambiguous' : 'card';
  if (groups.length === 1) {
    if (digits.length < 13 || digits.length > 19 || !luhnValid(digits)) return null;
    if (labelled) return 'card';
    // Unlabelled lone run: a real network shape is rejected unless an identifier label explains it; anything
    // else with a card-like prefix could be a policy number and is minimised.
    if (hasNetworkShape(digits)) return unlabelledVerdict;
    return CARD_NETWORK_PREFIX.test(digits) ? 'ambiguous' : null;
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
      return isTableLike(groups) && !labelled ? 'ambiguous' : labelled ? 'card' : unlabelledVerdict;
    }
  }
  return null;
}

function containsPaymentCard(value) {
  for (const match of value.matchAll(DIGIT_RUN)) {
    const groups = match[2].split(GROUP_SEPARATOR);
    const labels = runLabels(value, match.index);
    if (cardClassification(groups, labels.card, labels.identifier) === 'card') return true;
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

// A placeholder can sit inside a value ("password=abc<NAME_1>xyz123456", "98765<PHONE_1>43210"). Gate-minted tokens
// replace a whole matched value and never touch a digit, so a token with a digit straight before or after it is
// foreign text trying to split a value: refused. Restricted patterns are also scanned with tokens deleted, so the
// pieces on either side of a token read as one run.
const TOKEN_NEXT_TO_DIGIT = new RegExp(`\\p{N}(?:${PLACEHOLDER_SOURCE}|${LEGACY_TOKEN_SOURCE})|(?:${PLACEHOLDER_SOURCE}|${LEGACY_TOKEN_SOURCE})\\p{N}`, 'u');

// Three views with the tokens taken out: blanked (text on either side stays apart), spaced (a token and its
// surrounding whitespace become one space, so "4111 1111 <NAME_1> 1111 1111" reads as a card) and joined (the token
// and its whitespace vanish, so "12 <NAME_1> 3456" reads as one number).
const TOKEN_WITH_SPACE = new RegExp(`\\s*(?:${PLACEHOLDER_SOURCE}|${LEGACY_TOKEN_SOURCE})\\s*`, 'g');

function identifierRuns(text) {
  const runs = new Set();
  for (const match of text.matchAll(DIGIT_RUN)) {
    const groups = match[2].split(GROUP_SEPARATOR);
    if (isIndianPhone(match[1], groups) || isGovernmentId(groups)) runs.add(match[0]);
  }
  return runs;
}

function rejectRestrictedText(value) {
  let restricted = TOKEN_NEXT_TO_DIGIT.test(value);
  const blanked = restricted ? '' : value.replace(ANY_TOKEN, ' ');
  const views = restricted ? [] : [blanked, value.replace(TOKEN_WITH_SPACE, ' '), value.replace(TOKEN_WITH_SPACE, '')];
  for (const scanned of views) {
    restricted = scanRestricted(scanned);
    // A phone or government id that exists only once a token is removed was split by that token.
    if (!restricted && scanned !== blanked) {
      const seen = identifierRuns(blanked);
      restricted = [...identifierRuns(scanned)].some(run => !seen.has(run));
    }
    if (!restricted) {
      for (const [blob] of scanned.matchAll(BASE64_BLOB)) {
        const decoded = decodeReadableBase64(blob);
        if (decoded && scanRestricted(normalizeText(decoded))) { restricted = true; break; }
      }
    }
    if (restricted) break;
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
const PHONE_VALUE = '(\\+?\\d(?:[\\d()\\u2013\\u2014-]|[ ._/\\u00b7](?=[\\d(]))*\\d)';
const ID_VALUE = '([A-Za-z0-9][A-Za-z0-9\\/._\\u2013\\u2014-]{0,39})';
const GOV_ID_VALUE = '([\\dXx*\\u2022](?:[\\dXx*\\u2022]|[ .\\u2013\\u2014-](?=[\\dXx*\\u2022])){7,24})';

const labelPattern = (labels, separator, value, flags = 'giu') => new RegExp(`${LABEL_START}(${labels})${LABEL_END}${separator}${value}`, flags);

const NUMBER_SUFFIX = '(?:\\s*(?:no\\.?|number|num|#))?';
const PHONE_LABELS = `(?:mobile|mob|cell\\s*phone|cell|telephone|tel|phone|ph|contact|whatsapp|landline|मोबाइल|फ़ोन|फोन)${NUMBER_SUFFIX}`;
const EMAIL_LABELS = '(?:e-?mail(?:\\s*(?:id|address))?|ईमेल)';
const GOV_ID_LABELS = `(?:aadhaa?r|adhaar|uidai|uid|vid|virtual\\s+id|आधार)(?:\\s*card)?${NUMBER_SUFFIX}`;
const DOB_LABELS = '(?:date\\s+of\\s+birth|d\\.?\\s?o\\.?\\s?b\\.?|birth\\s*date|born(?:\\s+on)?|जन्म\\s*तिथि)';
const DRIVING_LICENCE_LABELS = `(?:driving\\s+licen[cs]e|driver'?s?\\s+licen[cs]e|d\\.?\\s?l\\.?)${NUMBER_SUFFIX}`;
const ADDRESS_LABELS = '(?:(?:postal|home|residential|permanent|present|current|correspondence|communication|mailing)\\s+address|address(?:\\s+of\\s+(?:the\\s+)?(?:insured|proposer|patient|member|policy\\s?holder|nominee|claimant))?|addr\\.?|पता)';
const ADDRESS_START = '(?=\\d|#|(?:flat|house|h\\.?\\s?no|plot|door|c\\/o|village|vill|at\\s+post|block|sector|ward)(?![\\p{L}]))';
// Multi-word labels that unambiguously name a person.
const NAME_LABELS = [
  'full\\s+name', 'first\\s+name', 'last\\s+name', 'sur\\s?name', 'member\\s+name', "patient(?:'s)?\\s+name",
  'insured\\s+name', 'insured\\s+person', 'insured\\s+member', 'primary\\s+insured', 'life\\s+assured',
  'name\\s+of\\s+(?:the\\s+)?(?:insured|patient|proposer|member|policy\\s?holder|employee|nominee|beneficiary|claimant|life\\s+assured)',
  'proposer(?:\\s+name)?', 'nominee(?:\\s+name)?', 'beneficiary(?:\\s+name)?', 'employee\\s+name', 'spouse(?:\\s+name)?',
  "father(?:'s)?\\s+name", "mother(?:'s)?\\s+name", 'guardian(?:\\s+name)?', 'policy\\s?holder(?:\\s+name)?', 'claimant(?:\\s+name)?',
  'applicant(?:\\s+name)?', 'dependants?', 'contact\\s+person', 'customer\\s+name', 'account\\s+holder(?:\\s+name)?', 'attendant\\s+name',
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
  'chief\\s+complaint', 'medical\\s+history', 'past\\s+history', 'icd(?:-?10)?(?:\\s+code)?', 'health\\s+conditions?',
].join('|');
const HEALTH_PHRASES = ['diagnosed\\s+with', 'suffering\\s+from', 'being\\s+treated\\s+for'].join('|');

const STRUCTURED_IDENTITY_KEYS = [
  'displayName', 'fullName', 'firstName', 'lastName', 'name', 'memberName', 'patientName', 'insuredName', 'proposerName', 'nomineeName',
  'beneficiaryName', 'employeeName', 'spouseName', 'fatherName', 'motherName', 'dateOfBirth', 'dob', 'postalAddress', 'address',
  'policyNumber', 'passport', 'passportNumber', 'pan', 'panNumber', 'aadhaar', 'aadhaarNumber', 'phone', 'phoneNumber', 'mobile',
  'mobileNumber', 'email', 'emailAddress', 'ifsc', 'ifscCode', 'accountNumber', 'bankAccount', 'bankAccountNumber', 'upiId', 'vpa',
];
// Keys are compared lower-cased with '_' and '-' removed, so patient_name, Patient-Name and patientName are one key.
const STRUCTURED_EXTRA_IDENTITY_KEYS = [
  'names', 'patient_name', 'member_name', 'contact_person', 'contactPerson', 'contactName', 'dependant', 'dependants', 'dependent', 'dependents',
  'nominee', 'proposer', 'insured', 'surname', 'givenName', 'middleName', 'applicantName', 'claimantName', 'policyholderName', 'policyHolderName',
  'accountHolderName', 'customerName', 'guardianName', 'attendantName', 'date_of_birth', 'birthDate', 'birthdate', 'born', 'dateOfBirth',
  'landline', 'whatsapp', 'passportNo', 'aadhar', 'aadhaarNo', 'uid', 'vid', 'uhid', 'mrn',
  'drivingLicence', 'drivingLicense', 'licenceNumber', 'licenseNumber', 'emailId',
];
const STRUCTURED_ADDRESS_KEYS = [
  'pincode', 'pin', 'pin_code', 'postalCode', 'zip', 'zipCode', 'addressLine', 'addressLine1', 'addressLine2', 'street', 'locality', 'homeAddress',
  'residentialAddress', 'permanentAddress', 'correspondenceAddress', 'mailingAddress',
];
const structuredKey = key => String(key).toLowerCase().replace(/[_-]/g, '');
const STRUCTURED_HEALTH_KEYS = ['diagnosis', 'medicalCondition', 'condition', 'conditions', 'ailment', 'medicalHistory', 'icdCode', 'chiefComplaint'];
const STRUCTURED_SENSITIVE_KEYS = new Map([
  ...[...STRUCTURED_IDENTITY_KEYS, ...STRUCTURED_EXTRA_IDENTITY_KEYS].map(key => [structuredKey(key), ['IDENTIFIER', 'DIRECT_IDENTIFIER_LABELED_VALUE']]),
  ...STRUCTURED_ADDRESS_KEYS.map(key => [structuredKey(key), ['ADDRESS', 'DIRECT_IDENTIFIER_ADDRESS']]),
  ...STRUCTURED_HEALTH_KEYS.map(key => [structuredKey(key), ['HEALTH', 'SENSITIVE_HEALTH_CONDITION']]),
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

// The honorific may be glued to the name by its full stop ("MRS.KAVYA").
const HONORIFIC_NAME = new RegExp(`${LABEL_START}(${ci('mrs|mr|ms|miss|mx|dr|shri|sri|smt|kumari')})(?:\\.\\s*|\\s+)${CAPITALISED_NAME}`, 'gu');
const RELATION_NAME = new RegExp(`${LABEL_START}([SDWCsdwc]\\s?\\/\\s?[Oo])\\.?\\s+${CAPITALISED_NAME}`, 'gu');
const DEVANAGARI_HONORIFIC_NAME = /(?<![\p{L}\p{M}])(श्रीमती|श्री|सुश्री|कुमारी|डॉ\.?)\s+([ऀ-ॿ]+(?:\s+[ऀ-ॿ]+){0,2})/gu;

// ---------------------------------------------------------------------------
// Name boundaries and policy-wording guards
// ---------------------------------------------------------------------------

// Relationship words end a personal name in member tables and name clauses.
const RELATIONSHIP_WORDS = ['self', 'spouse', 'son', 'daughter', 'father', 'mother', 'child', 'children', 'wife', 'husband', 'brother', 'sister', 'dependant', 'dependent'];
const HONORIFIC_WORDS = ['mrs', 'mr', 'ms', 'miss', 'mx', 'dr', 'shri', 'sri', 'smt', 'kumari'];
// Capitalised words that are table headers or policy nouns, never part of a
// personal name. A whitespace-separated name stops before the first of them.
const NAME_STOP_WORDS = new Set([
  ...RELATIONSHIP_WORDS, ...HONORIFIC_WORDS,
  'name', 'names', 'relationship', 'relation', 'date', 'dob', 'birth', 'age', 'gender', 'sex', 'male', 'female', 'sum', 'insured',
  'assured', 'amount', 'premium', 'policy', 'policyholder', 'holder', 'plan', 'member', 'members', 'person', 'persons', 'proposer',
  'nominee', 'number', 'no', 'id', 'code', 'type', 'status', 'details', 'cover', 'coverage', 'covered', 'hospital', 'address',
  'mobile', 'phone', 'email', 'period', 'from', 'to', 'till', 'start', 'end', 'valid', 'card', 'room', 'rent', 'limit', 'total',
  'rs', 'inr', 'opd', 'ipd', 'icu', 'tpa', 'claim', 'deductible', 'copay', 'benefit', 'benefits', 'section', 'clause', 'schedule',
  'table', 'annexure', 'page', 'sr', 'serial', 'the', 'of', 'and', 'or', 'as', 'per', 'is', 'are', 'shall', 'will', 'means', 'not',
  'any', 'all', 'for', 'with', 'in', 'on', 'at', 'by', 'under', 'subject', 'applicable', 'new', 'born', 'baby', 'newborn', 'care',
  'day', 'yes', 'nil', 'none', 'na', 'occupation', 'height', 'weight', 'pincode', 'city', 'state', 'country', 'nationality',
  'family', 'floater', 'individual', 'group', 'adult', 'adults', 'senior', 'citizen', 'citizens', 'employee', 'employees', 'parent', 'parents',
]);
// Label values that open with policy-wording function words are policy text
// ("Nominee: as per proposal form", "Diagnosis: not covered under OPD").
const POLICY_FUNCTION_WORDS = new Set([
  'as', 'per', 'not', 'covered', 'after', 'upto', 'up', 'any', 'all', 'the', 'is', 'are', 'will', 'shall', 'from', 'to', 'of',
  'under', 'subject', 'applicable', 'n/a', 'na', 'nil', 'none', 'declared', 'such', 'these', 'those', 'listed', 'specified',
  'mentioned', 'stated', 'refer', 'see', 'same', 'excluded', 'payable', 'within', 'upon', 'only', 'also', 'be', 'if', 'when',
  'which', 'each', 'every', 'either', 'both', 'may', 'must', 'can', 'no', 'a', 'an', 'in', 'on', 'for', 'with', 'by', 'at',
]);
const AMOUNT_START = /^(?:rs\b\.?|inr\b|₹|rupees\b|usd\b|\$|\d)/i;
const RANGE_OR_DURATION = /^(?:\d{1,3} ?(?:-|–|—|to|and) ?\d{1,3}(?![\d/.-])|\d{1,3} ?(?:days?|months?|years?|yrs?)\b)/i;

const wordCore = word => word.replace(/^[("'“‘]+|[)"'”’,.;:]+$/gu, '').toLowerCase();

function startsWithPolicyWording(value) {
  const words = value.trim().split(' ');
  const first = words[0] ?? '';
  if (!POLICY_FUNCTION_WORDS.has(wordCore(first))) return false;
  // "Will Smith": a capitalised function word followed by another capitalised
  // word reads as a name, not policy wording.
  return !(/^\p{Lu}/u.test(first) && words[1] && /^\p{Lu}/u.test(words[1]));
}

// The leading run of capitalised name words, cut before the first stop word
// (header, relationship, policy noun). Returns the kept prefix or null.
function capitalisedNameSpan(value, minWords) {
  let end = 0;
  let count = 0;
  for (const match of value.matchAll(/\S+/g)) {
    if (NAME_STOP_WORDS.has(wordCore(match[0]))) break;
    end = match.index + match[0].length;
    count += 1;
  }
  return count >= minWords ? value.slice(0, end) : null;
}

const NAME_CLAUSE_END = new RegExp(` (?:(?:${RELATIONSHIP_WORDS.join('|')})(?![\\p{L}\\p{M}])|[^\\s\\d₹]*[\\d₹])`, 'iu');

// A colon-labelled name clause. Policy wording and amounts are not names; the
// name ends before a relationship word or a word carrying digits.
const RELATIONSHIP_SET = new Set(RELATIONSHIP_WORDS);

function clauseNameSpan(value) {
  if (startsWithPolicyWording(value) || AMOUNT_START.test(value)) return null;
  // "Dependant: Spouse and children covered" names a relationship, not a person.
  if (RELATIONSHIP_SET.has(wordCore(value.trim().split(/\s+/u)[0] ?? ''))) return null;
  const cut = value.search(NAME_CLAUSE_END);
  const kept = (cut >= 0 ? value.slice(0, cut) : value).replace(/[\s.,]+$/u, '');
  return kept && /\p{L}/u.test(kept) && !HONORIFIC_ONLY.test(kept) ? kept : null;
}

const notPolicyWording = value => (startsWithPolicyWording(value) ? null : value);
const accepting = test => value => (test(value) ? value : null);
const minDigits = count => accepting(value => (value.match(/\d/g)?.length ?? 0) >= count);

const PASSPORT_VALUE = '([A-Za-z0-9](?:[ -]?[A-Za-z0-9]){5,9})(?![A-Za-z0-9])';
const LICENCE_VALUE = '([A-Za-z]{2}(?:[ -]?[A-Za-z0-9]){8,16})(?![A-Za-z0-9])';
const NAME_SPACE_SEP = '([^\\S\\n]+)';
const BARE_NAME_LABEL = '(?<!(?:plan|product|insurer|insurance|hospital|company|tpa|scheme|network|rider|policy|file|document|cover|benefit|doctor|branch|bank|agent|intermediary)\\s)name';
const BARE_PERSON_LABEL = '(?<!sum\\s)insured|(?<!(?:in|out|day)[- ]?)patient';

// Each rule: [pattern, kind, reason, refine]. `refine` receives the trimmed
// captured value and returns the prefix to minimise, or null to keep it.
const LABELLED_RULES = Object.freeze([
  [labelPattern('passport(?:\\s+(?:no\\.?|number|#))?', LOOSE_SEP, PASSPORT_VALUE), 'PASSPORT', 'DIRECT_IDENTIFIER_PASSPORT', minDigits(5)],
  [labelPattern(DRIVING_LICENCE_LABELS, LOOSE_SEP, LICENCE_VALUE), 'GOV_ID', 'DIRECT_IDENTIFIER_GOVERNMENT_ID', minDigits(8)],
  [labelPattern('ifsc(?:\\s+code)?', LOOSE_SEP, '([A-Za-z]{4}0[A-Za-z0-9]{6})(?![A-Za-z0-9])'), 'BANK', 'DIRECT_IDENTIFIER_BANK'],
  [labelPattern(HEALTH_LABELS, STRICT_SEP, HEALTH_VALUE), 'HEALTH', 'SENSITIVE_HEALTH_CONDITION', notPolicyWording],
  [labelPattern(HEALTH_PHRASES, '(\\s+)', HEALTH_VALUE), 'HEALTH', 'SENSITIVE_HEALTH_CONDITION', notPolicyWording],
  [labelPattern(EMAIL_LABELS, STRICT_SEP, '([^\\s,;<>]{3,100})'), 'EMAIL', 'DIRECT_IDENTIFIER_EMAIL'],
  [labelPattern(PHONE_LABELS, LOOSE_SEP, PHONE_VALUE), 'PHONE', 'DIRECT_IDENTIFIER_PHONE', minDigits(5)],
  [labelPattern(GOV_ID_LABELS, LOOSE_SEP, GOV_ID_VALUE), 'GOV_ID', 'DIRECT_IDENTIFIER_GOVERNMENT_ID', accepting(value => (value.match(/[\dXx*•]/g)?.length ?? 0) >= 8)],
  [labelPattern(DOB_LABELS, LOOSE_SEP, DATE_VALUE), 'DOB', 'DIRECT_IDENTIFIER_DATE_OF_BIRTH'],
  [labelPattern(DOB_LABELS, STRICT_SEP, '([^\\n,;<]{2,40})'), 'DOB', 'DIRECT_IDENTIFIER_DATE_OF_BIRTH', accepting(value => !startsWithPolicyWording(value) && !RANGE_OR_DURATION.test(value))],
  [labelPattern('pin\\s?code|pin|postal\\s+code|zip\\s?code', LOOSE_SEP, '([1-9](?:[ -]?\\d){5})(?![\\d]|[,.]\\d)'), 'ADDRESS', 'DIRECT_IDENTIFIER_ADDRESS'],
  [labelPattern(ADDRESS_LABELS, STRICT_SEP, ADDRESS_CLAUSE), 'ADDRESS', 'DIRECT_IDENTIFIER_ADDRESS'],
  [labelPattern(ADDRESS_LABELS, '(\\s+)', `${ADDRESS_START}${ADDRESS_CLAUSE}`), 'ADDRESS', 'DIRECT_IDENTIFIER_ADDRESS'],
  [labelPattern(ID_LABELS, LOOSE_SEP, ID_VALUE), 'IDENTIFIER', 'DIRECT_IDENTIFIER_LABELED_VALUE', accepting(value => /\d/.test(value))],
  [labelPattern(`${NAME_LABELS}|${BARE_NAME_LABELS}`, STRICT_SEP, NAME_CLAUSE), 'NAME', 'DIRECT_IDENTIFIER_LABELED_VALUE', clauseNameSpan],
  // "Insured Name ASHA EXAMPLE": whitespace or dash separated, capitalised value.
  [labelPattern(ci(NAME_LABELS), '(\\s+|\\s*[\\u2013\\u2014-]+\\s*)', CAPITALISED_NAME, 'gu'), 'NAME', 'DIRECT_IDENTIFIER_LABELED_VALUE', value => capitalisedNameSpan(value, 1)],
  // "Name KAVYA PLACEHOLDER", "Insured Kavya Placeholder", "Patient Kavya
  // Placeholder admitted": bare labels followed (on the same line) by a
  // capitalised name. "insured"/"patient" need two name words.
  [labelPattern(ci(BARE_NAME_LABEL), NAME_SPACE_SEP, CAPITALISED_NAME, 'gu'), 'NAME', 'DIRECT_IDENTIFIER_LABELED_VALUE', value => capitalisedNameSpan(value, 1)],
  [labelPattern(ci(BARE_PERSON_LABEL), NAME_SPACE_SEP, CAPITALISED_NAME, 'gu'), 'NAME', 'DIRECT_IDENTIFIER_LABELED_VALUE', value => capitalisedNameSpan(value, 2)],
]);

const UNLABELLED_RULES = Object.freeze([
  [/(?<![A-Za-z0-9])[A-Za-z][1-9][0-9]{6}(?![A-Za-z0-9])/g, 'PASSPORT', 'DIRECT_IDENTIFIER_PASSPORT'],
  [/(?<![A-Za-z0-9])[A-Za-z]{4}0[A-Za-z0-9]{6}(?![A-Za-z0-9])/g, 'BANK', 'DIRECT_IDENTIFIER_BANK'],
  [/(?<![A-Za-z0-9])[A-Za-z]{5}\d{4}[A-Za-z](?![A-Za-z0-9])/g, 'PAN', 'DIRECT_IDENTIFIER_PAN'],
  [/(?<![A-Za-z0-9])[A-Za-z]{3}\d{7}(?![A-Za-z0-9])/g, 'GOV_ID', 'DIRECT_IDENTIFIER_GOVERNMENT_ID'],
  // Indian driving licence: state code, RTO, issue year, seven digits.
  [/(?<![A-Za-z0-9])[A-Za-z]{2}[ -]?\d{2}[ -]?(?:19|20)\d{2}[ -]?\d{7}(?![A-Za-z0-9])/g, 'GOV_ID', 'DIRECT_IDENTIFIER_GOVERNMENT_ID'],
]);

// "+91 (987) 654-3210", "(022) 2345 6789": a bracketed group inside a phone.
const BRACKETED_PHONE = /(?<!\p{N})(\+?)((?:\d{1,4}[ .‐-―-]?)?\(\d{1,5}\)[ .‐-―-]?\d+(?:[ .‐-―-]\d+){0,3})(?![\p{N}])/gu;

const isMultipleOfFive = group => Number(group) % 5 === 0;
const isConsecutiveRun = numbers => numbers.every((number, index) => index === 0 || number === numbers[index - 1] + 1)
  || numbers.every((number, index) => index === 0 || number === numbers[index - 1] - 1);

function isIndianPhone(plus, groups) {
  let rest = groups;
  let prefixed = plus === '+';
  if (rest.length > 1 && /^(?:0{0,2}91|0)$/.test(rest[0])) { rest = rest.slice(1); prefixed = true; }
  // A leading STD code with its trunk zero ("022 2345 6789", "(080) 2345 6789").
  else if (rest.length > 1 && /^0[1-9]\d{1,4}$/.test(rest[0])) { rest = [rest[0].slice(1), ...rest.slice(1)]; prefixed = true; }
  let digits = rest.join('');
  if (rest.length === 1 && digits.length === 12 && digits.startsWith('91')) { digits = digits.slice(2); prefixed = true; }
  if (rest.length === 1 && digits.length === 11 && digits.startsWith('0')) { digits = digits.slice(1); prefixed = true; }
  if (rest.length > 5 || digits.length !== 10) return false;
  // Three or more unprefixed groups that are all round figures or a run of
  // consecutive numbers read as a table row ("Age 61 62 63 64 65"), not a phone.
  if (!prefixed && rest.length >= 3 && (rest.every(isMultipleOfFive) || isConsecutiveRun(rest.map(Number)))) return false;
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

// ---------------------------------------------------------------------------
// Line structures: name lists and member-table rows
// ---------------------------------------------------------------------------

const HONORIFIC_SET = new Set([...HONORIFIC_WORDS, 'श्रीमती', 'श्री', 'सुश्री', 'कुमारी', 'डॉ']);
const MONTH_PATTERNS = ['jan(?:uary)?', 'feb(?:ruary)?', 'mar(?:ch)?', 'apr(?:il)?', 'may', 'june?', 'july?', 'aug(?:ust)?', 'sep(?:t(?:ember)?)?', 'oct(?:ober)?', 'nov(?:ember)?', 'dec(?:ember)?'];
const MONTH_SOURCE = MONTH_PATTERNS.join('|');
const DATE_SEPARATOR = '[/.\\u2010-\\u2015-]';
// Date shapes printed in member tables: D/M/Y, Y-M-D, "1 Feb 1990", "Feb 1, 1990".
const ROW_DATE = `(?:\\d{1,2}${DATE_SEPARATOR}\\d{1,2}${DATE_SEPARATOR}\\d{2,4}|\\d{4}${DATE_SEPARATOR}\\d{1,2}${DATE_SEPARATOR}\\d{1,2}`
  + `|\\d{1,2}(?:st|nd|rd|th)?[ -]?(?:of )?(?:${MONTH_SOURCE})\\.?[ ,-]{0,3}\\d{4}|(?:${MONTH_SOURCE})\\.?[ -]?\\d{1,2}(?:st|nd|rd|th)?,? ?\\d{4})`;
const DOB_TOKEN = '<DOB_[1-9][0-9]{0,5}>';
const NAME_TOKEN = '<NAME_[1-9][0-9]{0,5}>';
const ROW_STOP_SOURCE = ci([...NAME_STOP_WORDS].sort((left, right) => right.length - left.length).join('|'));
const ROW_NAME_WORD = `(?!(?:${ROW_STOP_SOURCE})(?![\\p{L}\\p{M}]))${NAME_WORD}`;
const ROW_NAME = `(${ROW_NAME_WORD}(?: ${ROW_NAME_WORD}){1,3})`;
const ROW_SEPARATOR = '(?: ?[(|,/\\u2013\\u2014-] ?| )';
const RELATIONSHIP_AHEAD = `${ROW_SEPARATOR}(?:${ci(RELATIONSHIP_WORDS.join('|'))})(?![\\p{L}\\p{M}-])`;
const DATE_AHEAD = `${ROW_SEPARATOR}(?:${ci(ROW_DATE)}(?![\\p{N}])|${DOB_TOKEN})`;
const ROW_START = '^( ?(?:\\d{1,3}[.)]? |[|] ?)?)';
// "KAVYA PLACEHOLDER Self ...": a capitalised 2-4 word name before a relationship word.
const NAME_BEFORE_RELATIONSHIP = new RegExp(`(?<![\\p{L}\\p{M}\\p{N}_])${ROW_NAME}(?=${RELATIONSHIP_AHEAD})`, 'gu');
// "KAVYA PLACEHOLDER 01/02/1990 ...": a row that opens with a name and a date.
const NAME_BEFORE_DATE = new RegExp(`${ROW_START}${ROW_NAME}(?=${DATE_AHEAD})`, 'u');
const MEMBER_ROW_SIGNALS = Object.freeze([
  new RegExp(`${NAME_TOKEN}(?=${RELATIONSHIP_AHEAD})`, 'u'),
  new RegExp(`${ROW_START}${NAME_TOKEN}(?=${DATE_AHEAD})`, 'u'),
  new RegExp(`(?<![\\p{L}\\p{M}])(?:${ci(RELATIONSHIP_WORDS.join('|'))})(?=${DATE_AHEAD})`, 'u'),
]);
const ROW_DATE_ANYWHERE = new RegExp(`(?<![\\p{N}\\p{L}_])${ROW_DATE}(?![\\p{N}])`, 'giu');
// Dates next to policy-period wording are policy facts, not dates of birth.
const PERIOD_BEFORE = /\b(?:period|starts?|started|end|ends|inception|expiry|expires|expiration|renewal|renewed|issue|issued|commencement|commences|effective|maturity|valid(?:ity)?|from|to|till|until|upto|w\.?e\.?f)\W{0,4}(?:(?:date|on)\W{0,4})?$/i;
const PERIOD_AFTER = /^ ?(?:to|till|until|upto|[-–—]) ?\d/i;

function redactMemberRow(line, swap) {
  let isRow = false;
  const swapName = name => { isRow = true; return swap('NAME', 'DIRECT_IDENTIFIER_PERSON_NAME', name); };
  let value = line.replace(NAME_BEFORE_RELATIONSHIP, swapName);
  value = value.replace(NAME_BEFORE_DATE, (_match, prefix, name) => `${prefix}${swapName(name)}`);
  if (!isRow && !MEMBER_ROW_SIGNALS.some(signal => signal.test(value))) return value;
  return value.replace(ROW_DATE_ANYWHERE, (date, offset, whole) => {
    const before = whole.slice(Math.max(0, offset - 40), offset);
    const after = whole.slice(offset + date.length, offset + date.length + 12);
    if (PERIOD_BEFORE.test(before) || PERIOD_AFTER.test(after)) return date;
    return swap('DOB', 'DIRECT_IDENTIFIER_DATE_OF_BIRTH', date);
  });
}

// Plural member labels introduce a list of names: "Insured Persons: Kavya
// Placeholder (Self), Ravi Synthetic (Spouse)".
const LIST_LABELS = [
  '(?:insured|covered|family)\\s+(?:persons?|members?|lives)(?:\\s+names?)?', 'members?\\s+(?:covered|insured|names?)', 'members',
  'nominees?', 'proposers?', 'insured', 'patient\\s+names?', 'name\\s+of\\s+(?:the\\s+)?insured', 'beneficiaries', 'dependants', 'dependents', 'insured\\s+names', 'names\\s+of\\s+(?:the\\s+)?(?:insured(?:\\s+persons)?|members)',
].join('|');
const LIST_LABEL = new RegExp(`${LABEL_START}(${LIST_LABELS})${LABEL_END}${STRICT_SEP}`, 'iu');
const LIST_SEPARATOR = /( ?(?:[,&|/]| and ) ?)/i;

function redactListItem(piece, swap) {
  if (startsWithPolicyWording(piece) || AMOUNT_START.test(piece.trim()) || piece.trim().length <= 2) return piece;
  let start = -1;
  let end = -1;
  let count = 0;
  for (const match of piece.matchAll(/\S+/g)) {
    const word = match[0];
    const core = wordCore(word);
    if (start < 0 && HONORIFIC_SET.has(core)) continue;
    if (NAME_STOP_WORDS.has(core) || !/^\p{Lu}/u.test(word) || /[\d@<>₹]/u.test(word)) break;
    if (start < 0) start = match.index;
    count += 1;
    const sentenceEnd = word.endsWith('.') && core.length > 1;
    end = match.index + word.replace(sentenceEnd ? /[.,;:)]+$/ : /[,;:)]+$/, '').length;
    if (sentenceEnd || count === 4) break;
  }
  if (count === 0) return piece;
  return `${piece.slice(0, start)}${swap('NAME', 'DIRECT_IDENTIFIER_PERSON_NAME', piece.slice(start, end))}${piece.slice(end)}`;
}

function redactNameList(line, swap) {
  const label = LIST_LABEL.exec(line);
  if (!label) return line;
  const start = label.index + label[0].length;
  const stop = line.indexOf(';', start);
  const end = stop < 0 ? line.length : stop;
  const items = outsideTokens(line.slice(start, end), segment => segment.split(LIST_SEPARATOR)
    .map((piece, index) => (index % 2 ? piece : redactListItem(piece, swap))).join(''));
  return `${line.slice(0, start)}${items}${line.slice(end)}`;
}

// Pipe tables (OCR layout output): a header cell names what its column holds,
// and a row-label cell names the value after it ("Aadhaar Number | XXXX9101").
// A header carries forward over non-table lines (page breaks, blank lines) until
// the next header. Every table row also fails closed: an ID-shaped cell or a
// whole-cell date outside policy-period wording is minimised with or without a
// header. Health columns count only in member tables (a person, member or
// identity column) or ICD tables, so "Pre-existing disease | 36 months" is kept.
const NOT_PERSONAL_CONTACT = /\b(?:hospital|customer care|customer service|toll free|company|branch|insurer|office|registered|corporate|grievance|helpline|call cent(?:re|er)|network)\b/;
const TABLE_COLUMN_KINDS = Object.freeze([
  ['DOB', 'DIRECT_IDENTIFIER_DATE_OF_BIRTH', /\b(?:date of birth|d ?o ?b|birth ?date)\b/],
  ['GOV_ID', 'DIRECT_IDENTIFIER_GOVERNMENT_ID', /\b(?:aadhaa?r|adhaar|passport|voter(?: id)?|driving licen[cs]e|abha)\b|^pan(?: (?:no|number|card))?$/],
  ['IDENTIFIER', 'DIRECT_IDENTIFIER_LABELED_VALUE', /\b(?:mem(?:ber(?:ship)?)? (?:id|no|number)|customer (?:id|no|number)|client id|employee (?:id|code|no|number)|uhid|mrn|ckyc|policy (?:no|number)|certificate (?:no|number)|proposal (?:no|number)|card (?:no|number)|(?:bank )?account (?:no|number)|ifsc)\b/],
  ['PHONE', 'DIRECT_IDENTIFIER_PHONE', /\b(?:mobile|phone|telephone|contact (?:no|number))\b/],
  ['EMAIL', 'DIRECT_IDENTIFIER_EMAIL', /\be ?mail\b/],
  ['ADDRESS', 'DIRECT_IDENTIFIER_ADDRESS', /\baddress\b/],
  ['NAME', 'DIRECT_IDENTIFIER_PERSON_NAME', /^(?:name|member|insured|insd name|(?:insured|covered) (?:person|member)s?)$|\b(?:insured|insd|member|nominee|appointee|proposer|policy ?holder|patient|person|employee|beneficiary|customer|claimant|spouse|father|mother|guardian)\b.*\bname\b|\bname of (?:the )?(?:insured|member|nominee|appointee|proposer|policy ?holder|patient|person|employee|beneficiary|claimant)/],
  ['HEALTH', 'SENSITIVE_HEALTH_CONDITION', /\b(?:icd|diagnos[ie]s|health conditions?|medical conditions?|medical history|chief complaint|loading reason|special conditions?|exclusion wa[iv]{2}er|ailments?)\b/],
  ['HEALTH_WORDING', 'SENSITIVE_HEALTH_CONDITION', /\bpre ?existing (?:diseases?|conditions?)\b/],
]);
const MEMBER_COLUMN = /\b(?:insured person|member|relationship)\b/;
const ICD_HEADER = /\bicd\b/;
const ICD_CODE = /^[A-Z]\d{2}(?:\.\d{1,4})?[A-Z]?$/;
const EMPTY_CELL = /^(?:|-+|–|—|na|n\/a|nil|none)$/i;
const TABLE_TOKEN = new RegExp(PLACEHOLDER_SOURCE);
const TABLE_SEPARATORS = /[│┃¦]/g;
// Member, customer and card numbers: letters and five or more digits, no spaces.
// IRDAI product UINs (letters, five digits, V and six digits) are policy facts.
const ID_SHAPE = /^(?=(?:[^\d]*\d){5})(?=.*[A-Za-z])[A-Za-z0-9/-]{8,32}$/;
const PRODUCT_UIN = /^[A-Za-z]{5,10}\d{5}V\d{6}$/;
const WHOLE_DATE = new RegExp(`^${ROW_DATE}$`, 'iu');
const HEALTH_KIND = { kind: 'HEALTH', reason: 'SENSITIVE_HEALTH_CONDITION' };

const cellLabel = cell => cell.toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/['’]s\b/g, '').replace(/[^\p{L}\p{N} ]+/gu, ' ')
  .replace(/\s+/g, ' ').trim().replace(/ \d{1,2}$/, '');

// A cell holding a placeholder or a digit (other than a trailing ordinal or a
// bracketed hint) is a value, never a label: "<DOB_1>" is not a DOB header.
function columnKind(cell) {
  if (TABLE_TOKEN.test(cell)) return null;
  const label = cellLabel(cell);
  if (!label || label.length > 80 || /\d/.test(label) || label.split(' ').length > 8) return null;
  const found = TABLE_COLUMN_KINDS.find(([, , pattern]) => pattern.test(label));
  if (!found) return null;
  if (['PHONE', 'EMAIL', 'ADDRESS'].includes(found[0]) && NOT_PERSONAL_CONTACT.test(label)) return null;
  return { kind: found[0], reason: found[1], icd: ICD_HEADER.test(label), member: MEMBER_COLUMN.test(label) };
}

// Cells between the edge pipes of "| a | b |"; the edges are kept for re-joining.
function splitCells(line) {
  const cells = line.replace(TABLE_SEPARATORS, '|').split('|');
  const lead = cells.length > 1 && !cells[0].trim() ? 1 : 0;
  const trail = cells.length - lead > 1 && !cells[cells.length - 1].trim() ? 1 : 0;
  return { head: cells.slice(0, lead), data: cells.slice(lead, cells.length - trail), tail: cells.slice(cells.length - trail) };
}
const joinCells = ({ head, data, tail }) => [...head, ...data, ...tail].join('|');
const valueCell = cell => !EMPTY_CELL.test(cell.trim()) && !TABLE_TOKEN.test(cell);

function swapCell(cell, column, swap) {
  if (!valueCell(cell)) return cell;
  const value = cell.trim();
  const start = cell.indexOf(value);
  return `${cell.slice(0, start)}${swap(column.kind, column.reason, value)}${cell.slice(start + value.length)}`;
}

// A header row: two or more labelled cells (or one ICD cell), at least half the
// cells labelled while another header is active, and no data among the others.
function tableHeader(cells, active) {
  const columns = cells.map(columnKind);
  const labelled = columns.filter(Boolean);
  const dataCell = cells.some((cell, index) => !columns[index] && (/\d/.test(cell) || TABLE_TOKEN.test(cell)));
  if (dataCell || !(labelled.length >= 2 || labelled.some(column => column.icd))) return null;
  // "Diagnosis | value | Insured | value": strictly alternating label and value cells are label/value pairs.
  if (cells.length >= 4 && cells.length % 2 === 0 && columns.every((column, index) => (index % 2 === 0) === Boolean(column))) return null;
  if (active && labelled.length * 2 < cells.filter(cell => cell.trim()).length) return null;
  const icd = labelled.some(column => column.icd);
  const memberTable = labelled.some(column => column.member || ['NAME', 'IDENTIFIER', 'DOB', 'GOV_ID'].includes(column.kind));
  const kinds = columns.map(column => {
    if (icd) return HEALTH_KIND;
    if (column?.kind === 'HEALTH' || column?.kind === 'HEALTH_WORDING') return memberTable ? HEALTH_KIND : null;
    return column?.kind === 'NAME' || column?.kind === 'IDENTIFIER' || column?.kind === 'DOB' || column?.kind === 'GOV_ID'
      || column?.kind === 'PHONE' || column?.kind === 'EMAIL' || column?.kind === 'ADDRESS' ? column : null;
  });
  return { kinds, icd };
}

// A row-label cell minimises the next value cell, and further cells while they
// keep the same shape (dates after a DOB label, IDs after an ID label). The run
// stops at any label cell. Generic pre-existing-disease wording is not a label.
function sameShape(kind, cell) {
  const value = cell.trim();
  if (kind === 'DOB') return WHOLE_DATE.test(value);
  if (kind === 'IDENTIFIER' || kind === 'GOV_ID') return ID_SHAPE.test(value) || /^[Xx*•\d]{8,}$/.test(value);
  if (kind === 'NAME') return /^\p{Lu}[\p{L}.'’ -]{1,60}$/u.test(value) && !/\d/.test(value);
  return false;
}

function redactLabelledCells(cells, swap) {
  let current = null;
  let taken = 0;
  return cells.map(cell => {
    const column = columnKind(cell);
    if (column) { current = column.kind === 'HEALTH_WORDING' ? null : column; taken = 0; return cell; }
    if (!current || !valueCell(cell)) return cell;
    if (taken > 0 && !sameShape(current.kind, cell)) { current = null; return cell; }
    taken += 1;
    return swapCell(cell, current, swap);
  });
}

// Fail closed on every table row: ID-shaped cells and whole-cell dates.
function redactRowShapes(cells, swap) {
  return cells.map((cell, index) => {
    if (!valueCell(cell)) return cell;
    const value = cell.trim();
    if (ID_SHAPE.test(value) && !PRODUCT_UIN.test(value)) return swapCell(cell, { kind: 'IDENTIFIER', reason: 'DIRECT_IDENTIFIER_LABELED_VALUE' }, swap);
    if (WHOLE_DATE.test(value)) {
      const before = cells.slice(Math.max(0, index - 1), index).join(' ');
      if (PERIOD_BEFORE.test(before.trim())) return cell;
      return swapCell(cell, { kind: 'DOB', reason: 'DIRECT_IDENTIFIER_DATE_OF_BIRTH' }, swap);
    }
    return cell;
  });
}

// A row of label text only (no digit, no placeholder) may be the first half of
// a header printed over two rows ("Member | Date of" over "ID | Birth").
const labelOnlyRow = cells => cells.every(cell => !/\d/.test(cell) && !TABLE_TOKEN.test(cell));

function redactPipeTables(text, swap) {
  let header = null;
  let previous = null;
  return text.split('\n').map(line => {
    const prior = previous;
    previous = null;
    if (!/[|│┃¦]/.test(line)) return line;
    const row = splitCells(line);
    // Header split over two rows: the cells are joined pairwise and read as one header. The
    // second row is still redacted under the header active before it, then the joined header
    // applies to the rows after it.
    const split = prior && labelOnlyRow(row.data) && prior.length === row.data.length
      ? tableHeader(row.data.map((cell, index) => `${prior[index].trim()} ${cell.trim()}`), null) : null;
    previous = labelOnlyRow(row.data) ? row.data : null;
    const found = split ? null : tableHeader(row.data, header);
    if (found) { header = found; return joinCells(row); }
    // An ICD table ends at the first row without an ICD code in its first cell.
    if (header?.icd && !ICD_CODE.test(row.data[0]?.trim() ?? '')) header = null;
    let data = row.data;
    if (header) {
      // A row longer than its header cannot be aligned: every cell is minimised.
      data = data.length > header.kinds.length
        ? data.map(cell => swapCell(cell, { kind: 'VALUE', reason: 'DIRECT_IDENTIFIER_LABELED_VALUE' }, swap))
        : data.map((cell, index) => (header.kinds[index] ? swapCell(cell, header.kinds[index], swap) : cell));
    }
    data = redactRowShapes(redactLabelledCells(data, swap), swap);
    // The joined header only adds columns: a column the active header already minimises stays minimised.
    if (split) header = { kinds: split.kinds.map((kind, index) => kind ?? header?.kinds[index] ?? null), icd: split.icd || Boolean(header?.icd) };
    return joinCells({ ...row, data });
  }).join('\n');
}

function redactLineStructures(text, swap) {
  return redactPipeTables(text, swap).split('\n').map(line => redactMemberRow(redactNameList(line, swap), swap)).join('\n');
}

// ---------------------------------------------------------------------------
// Caller-supplied known identifiers (redacted before any pattern scanning)
// ---------------------------------------------------------------------------

const KNOWN_IDENTIFIER_KINDS = new Set(['NAME', 'DOB', 'PHONE', 'EMAIL']);
const MAX_KNOWN_IDENTIFIERS = 200;
const KNOWN_REASONS = Object.freeze({
  NAME: 'DIRECT_IDENTIFIER_PERSON_NAME', DOB: 'DIRECT_IDENTIFIER_DATE_OF_BIRTH', PHONE: 'DIRECT_IDENTIFIER_PHONE', EMAIL: 'DIRECT_IDENTIFIER_EMAIL',
});
const ISO_DATE_VALUE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const KNOWN_DIGIT_SEPARATOR = '[ .()\\u2010-\\u2015-]{0,3}';
const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

function knownMalformed(message) {
  // Never echoes the value.
  fail('PRIVACY_GATE_MALFORMED', message);
}

function dateRenderings(isoValue) {
  const [year, month, day] = isoValue.split('-').map(Number);
  const D = day < 10 ? `0?${day}` : String(day);
  const M = month < 10 ? `0?${month}` : String(month);
  const Y = `(?:${year}|${String(year).slice(2)})`;
  const SEP = '[/.\\u2010-\\u2015 -]';
  const ORDINAL = '(?:st|nd|rd|th)?';
  const NAME = `(?:${MONTH_PATTERNS[month - 1]})`;
  return [
    `${D}${SEP}${M}${SEP}${Y}`,
    `${year}${SEP}${M}${SEP}${D}`,
    `${pad2(day)}${pad2(month)}${year}`,
    `${year}${pad2(month)}${pad2(day)}`,
    `${D}${ORDINAL}[ ,.-]{0,3}(?:of )?${NAME}\\.?[ ,.-]{0,3}${Y}`,
    `${NAME}\\.?[ ,.-]{0,3}${D}${ORDINAL}[ ,.-]{0,3}${Y}`,
    // US month-first order for the same date, when it differs.
    ...(day !== month && day <= 12 ? [`${M}${SEP}${D}${SEP}${year}`] : []),
  ];
}

function phoneCore(digits) {
  let core = digits.startsWith('00') ? digits.slice(2) : digits;
  if (core.length === 12 && core.startsWith('91')) core = core.slice(2);
  else if (core.length === 11 && core.startsWith('0')) core = core.slice(1);
  return core;
}

// One alternation per kind; each entry is one capture group so a match maps
// back to its owner (whose canonical value keys the placeholder).
function groupedPattern(entries, before, after, flags) {
  if (entries.length === 0) return null;
  const ordered = [...entries].sort((left, right) => right.weight - left.weight);
  return {
    pattern: new RegExp(`${before}(?:${ordered.map(entry => `(${entry.variants.join('|')})`).join('|')})${after}`, flags),
    owners: ordered.map(entry => entry.owner),
  };
}

function compileKnownIdentifiers(entries) {
  if (entries === undefined || entries === null) return null;
  if (!Array.isArray(entries) || entries.length > MAX_KNOWN_IDENTIFIERS) knownMalformed('Known identifiers must be an array of at most 200 entries.');
  if (entries.length === 0) return null;
  const names = [];
  const dates = [];
  const phones = [];
  const emails = [];
  const nameTokens = new Map();
  for (const entry of entries) {
    exactKeys(entry, ['kind', 'value'], 'Known identifier');
    if (!KNOWN_IDENTIFIER_KINDS.has(entry.kind)) knownMalformed('A known identifier has an unsupported kind.');
    if (typeof entry.value !== 'string' || entry.value.length < 1 || entry.value.length > 200) knownMalformed('A known identifier value must be 1 to 200 characters.');
    const value = normalizeText(entry.value).trim();
    if (!value) knownMalformed('A known identifier value is blank.');
    if (entry.kind === 'NAME') {
      const tokens = value.split(/[\s.,]+/u).filter(Boolean);
      if (!tokens.some(token => /\p{L}/u.test(token))) knownMalformed('A known name must contain letters.');
      const forward = tokens.map(escapeRegExp).join('[\\s.,]*');
      const variants = tokens.length > 1 ? [forward, [...tokens].reverse().map(escapeRegExp).join('[\\s.,]*')] : [forward];
      names.push({ owner: value, variants, weight: value.length });
      for (const token of tokens) {
        const lower = token.toLowerCase();
        if ([...token].length >= 3 && /\p{L}/u.test(token) && !nameTokens.has(lower)) nameTokens.set(lower, value);
      }
    } else if (entry.kind === 'DOB') {
      const match = value.match(ISO_DATE_VALUE);
      const iso = match ? isoDate(match[1], match[2], match[3]) : null;
      if (!iso) knownMalformed('A known date of birth must be an ISO date.');
      dates.push({ owner: iso, variants: dateRenderings(iso), weight: 0 });
    } else if (entry.kind === 'PHONE') {
      const digits = value.replace(/\D/g, '');
      if (digits.length < 7 || digits.length > 15 || /[^\d\s+().\u2010-\u2015-]/u.test(value)) knownMalformed('A known phone number must have 7 to 15 digits.');
      const core = phoneCore(digits);
      const prefix = '(?:(?:(?:\\+|00) ?)?\\(?91\\)?[ .()\\u2010-\\u2015-]{0,3}|\\(?0\\)?[ .()\\u2010-\\u2015-]{0,2}|\\()?';
      phones.push({ owner: core, variants: [`${prefix}${[...core].join(KNOWN_DIGIT_SEPARATOR)}`], weight: core.length });
    } else {
      if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value)) knownMalformed('A known email address is invalid.');
      emails.push({ owner: value, variants: [escapeRegExp(value)], weight: value.length });
    }
  }
  return Object.freeze({
    names: groupedPattern(names, '(?<![\\p{L}\\p{M}\\p{N}_])', '(?![\\p{L}\\p{M}\\p{N}_])', 'giu'),
    dates: groupedPattern(dates, '(?<![\\p{N}])', '(?![\\p{N}])', 'giu'),
    phones: groupedPattern(phones, '(?<![\\p{N}])', '(?![\\p{N}])', 'gu'),
    emails: groupedPattern(emails, '(?<![A-Za-z0-9._%+-])', '(?![A-Za-z0-9_-]|\\.[A-Za-z0-9])', 'gi'),
    nameTokens,
  });
}

// A capitalised word that is a token (3+ characters) of a known name is
// minimised when it stands next to another known token or an honorific,
// optionally across one initial: "Mrs. Kavya", "PLACEHOLDER KAVYA",
// "Kavya R. Placeholder".
function redactKnownNameTokens(segment, nameTokens, swapName) {
  const words = [...segment.matchAll(/\p{L}[\p{L}\p{M}'’-]*/gu)].map(match => ({ text: match[0], start: match.index, end: match.index + match[0].length }));
  if (words.length < 2) return segment;
  const roles = words.map(({ text }) => {
    const lower = text.toLowerCase();
    // Capitalised, or from a script without letter case (Devanagari, ...).
    if (!/^\p{Ll}/u.test(text) && nameTokens.has(lower)) return 'known';
    if (HONORIFIC_SET.has(lower)) return 'honorific';
    return [...text].length === 1 && /^\p{Lu}$/u.test(text) ? 'initial' : null;
  });
  const adjacent = (left, right) => /^[ .,]{1,3}$/.test(segment.slice(words[left].end, words[right].start));
  const anchors = index => roles[index] === 'known' || roles[index] === 'honorific';
  const linked = (index, step) => {
    const next = index + step;
    if (next < 0 || next >= words.length) return false;
    const [left, right] = step < 0 ? [next, index] : [index, next];
    if (!adjacent(left, right)) return false;
    if (anchors(next)) return true;
    const beyond = next + step;
    if (roles[next] !== 'initial' || beyond < 0 || beyond >= words.length) return false;
    const [farLeft, farRight] = step < 0 ? [beyond, next] : [next, beyond];
    return adjacent(farLeft, farRight) && anchors(beyond);
  };
  const marked = roles.map((role, index) => role === 'known' && (linked(index, -1) || linked(index, 1)));
  const spans = [];
  for (let index = 0; index < words.length; index += 1) {
    if (!marked[index]) continue;
    let last = index;
    while (true) {
      const next = last + 1;
      if (next < words.length && marked[next] && adjacent(last, next)) { last = next; continue; }
      if (next + 1 < words.length && roles[next] === 'initial' && marked[next + 1] && adjacent(last, next) && adjacent(next, next + 1)) { last = next + 1; continue; }
      break;
    }
    spans.push([index, last]);
    index = last;
  }
  let output = segment;
  for (const [first, last] of spans.reverse()) {
    const owner = nameTokens.get(words[first].text.toLowerCase());
    output = `${output.slice(0, words[first].start)}${swapName(owner)}${output.slice(words[last].end)}`;
  }
  return output;
}

function redactKnownIdentifiers(text, known, swap) {
  if (!known) return text;
  const swapKnown = (kind, owner) => {
    swap(kind, 'DIRECT_IDENTIFIER_KNOWN_VALUE', owner);
    return swap(kind, KNOWN_REASONS[kind], owner);
  };
  let value = text;
  const pass = (compiled, kind) => {
    if (!compiled) return;
    const { pattern, owners } = compiled;
    value = outsideTokens(value, segment => segment.replace(pattern, (...args) => {
      const index = args.slice(1, 1 + owners.length).findIndex(group => group !== undefined);
      return swapKnown(kind, owners[index]);
    }));
  };
  pass(known.emails, 'EMAIL');
  // Unknown email addresses too, so a known name inside a local part
  // ("kavya.placeholder@...") never splits an address.
  value = outsideTokens(value, segment => segment.replace(EMAIL_PATTERN, match => swap('EMAIL', 'DIRECT_IDENTIFIER_EMAIL', match)));
  pass(known.dates, 'DOB');
  pass(known.phones, 'PHONE');
  pass(known.names, 'NAME');
  if (known.nameTokens.size > 0) {
    value = outsideTokens(value, segment => redactKnownNameTokens(segment, known.nameTokens, owner => swapKnown('NAME', owner)));
  }
  return value;
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
  const replaceLabelled = (pattern, kind, reason, refine = kept => kept) => {
    value = value.replace(pattern, (match, label, _separator, captured) => {
      const trimmed = captured.replace(/[\s.]+$/u, '');
      const kept = trimmed ? refine(trimmed) : null;
      if (!kept) return match;
      return `${label}: ${swap(kind, reason, kept)}${captured.slice(kept.length)}`;
    });
  };
  const replaceNamed = pattern => {
    value = value.replace(pattern, (match, prefix, name) => {
      const kept = capitalisedNameSpan(name, 1);
      if (!kept) return match;
      return `${prefix} ${swap('NAME', 'DIRECT_IDENTIFIER_PERSON_NAME', kept)}${name.slice(kept.length)}`;
    });
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
  for (const [pattern, kind, reason, refine] of LABELLED_RULES) replaceLabelled(pattern, kind, reason, refine);
  for (const [pattern, kind, reason] of UNLABELLED_RULES) replace(pattern, kind, reason);
  value = value.replace(BRACKETED_PHONE, (match, plus, run) => (
    isIndianPhone(plus, run.split(/\D+/).filter(Boolean)) ? swap('PHONE', 'DIRECT_IDENTIFIER_PHONE', match) : match
  ));
  value = value.replace(DIGIT_RUN, (match, plus, run, offset, whole) => {
    const groups = run.split(GROUP_SEPARATOR);
    if (isIndianPhone(plus, groups)) return swap('PHONE', 'DIRECT_IDENTIFIER_PHONE', match);
    if (isGovernmentId(groups)) return `${plus}${swap('GOV_ID', 'DIRECT_IDENTIFIER_GOVERNMENT_ID', run)}`;
    const labels = runLabels(whole, offset);
    if (cardClassification(groups, labels.card, labels.identifier)) return `${plus}${swap('NUMBER', 'DIRECT_IDENTIFIER_CARD_LIKE_NUMBER', run)}`;
    return match;
  });
  return value;
}

// ---------------------------------------------------------------------------
// Address tails
// ---------------------------------------------------------------------------

// The address clause stops at a full stop, ';' or a line end, so a locality,
// "CITY-PIN", state or masked phone can follow <ADDRESS_n>. The placeholder
// absorbs that tail, but only when it is anchored by an Indian PIN or a
// partially masked phone, so unrelated prose and public insurer numbers stay.
const ADDRESS_TOKEN = /<ADDRESS_[1-9][0-9]{0,5}>/g;
const TAIL_MAX_LINES = 8;
const TAIL_MAX_WORDS = 60;
const TAIL_WINDOW = 240;
// A PIN may be spaced or hyphenated irregularly ("560 001", "56 0001", "5 6 0 0 0 1", "560-001").
const TAIL_PIN = '(?<![\\d\\u20B9])[1-9](?:[ -]?\\d){5}(?!\\d|[,.]\\d)';
const TAIL_MASKED_PHONE = '(?:\\+?\\d{1,2}[ -]?)?[Xx*\\u2022]{3,}(?:[ -][Xx*\\u2022]+)*[ -]?\\d{2,5}(?!\\d)';
const TAIL_ANCHOR = new RegExp(`${TAIL_PIN}|${TAIL_MASKED_PHONE}`, 'gu');
const TAIL_PHONE_LABEL = '(?:(?:mobile|mob|phone|ph|tel|telephone|contact|cell)(?:\\s*(?:no\\.?|number|#))?[\\s.:=-]*)?';
const TAIL_MASKED_PHONE_FIELD = new RegExp(`^[\\s,;]*${TAIL_PHONE_LABEL}${TAIL_MASKED_PHONE}`, 'iu');
const TAIL_STATE_WORD = /^[ ,-]+(\p{L}[\p{L}\p{M}]*)/u;
const TAIL_FUNCTION_WORDS = /^(?:and|or|the|a|an|of|to|in|on|at|for|with|by|from|as|if|not|all|any)$/iu;

// Up to three plain words after the PIN (the state), stopping at policy wording.
function stateWordsAfter(rest) {
  let length = 0;
  for (let count = 0; count < 3; count += 1) {
    const word = rest.slice(length).match(TAIL_STATE_WORD);
    if (!word || TAIL_FUNCTION_WORDS.test(word[1]) || TAIL_POLICY_WORDING.test(word[1])) break;
    length += word[0].length;
  }
  return length;
}
// A field label ("Policy No:", "Email -") starts a new field and ends the tail.
const TAIL_LABEL = /(?:^|[\s,])[\p{L}][\p{L}\p{N}. /&-]{0,30}[:=]/u;
const TAIL_SENTENCE_END = /[.;](?:\s|$)/u;
// Policy wording and amounts are not address text.
const TAIL_POLICY_WORDING = /(?:[₹]|\b(?:rs|inr|sum|insured|premium|limit|cover|covered|coverage|policy|claim|benefit|waiting|period|days|years|per|is|are|will|shall|stamp|duty|helpline|toll|free|customer|care|call|centre|center|number|no|uin)\b)/iu;
// "Plot No 5", "Flat No. 12", "Door #3" are house numbers, not the word "no" in policy wording.
const HOUSE_NUMBER = /\b(?:plot|flat|door|house|shop|room|unit|block|sector|ward|survey|h)\.?\s*(?:no\.?|number|#)/giu;
const maskHouseNumbers = text => text.replace(HOUSE_NUMBER, match => ' '.repeat(match.length));
const hasPolicyWording = text => TAIL_POLICY_WORDING.test(maskHouseNumbers(text));
const TAIL_START_WORD = /^[\p{L}\p{M}\d#]/u;

// A PIN label ("PIN:", "Pin Code -") belongs to the address, not to a new field.
const PIN_LABEL = /\b(?:pin|zip)(?: ?code)?\s*[:=]/giu;
const ADDRESS_WORDS = new Set(['near', 'opp', 'opposite', 'behind', 'beside', 'nr', 'off', 'road', 'rd', 'cross', 'main', 'po', 'ps', 'dist', 'via', 'and', 'of', 'the', 'at', 'post', 'pin', 'code', 'taluk', 'tehsil', 'nagar', 'colony', 'street', 'lane', 'layout', 'phase', 'extn', 'extension']);
const ADDRESS_TOKEN_SHAPE = /^[\p{Lu}\p{Lo}\p{N}#(][\p{L}\p{M}\p{N}/.,()#&:-]*$/u;
const isAddressLike = text => {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  return tokens.length > 0 && tokens.every(token => ADDRESS_TOKEN_SHAPE.test(token) || ADDRESS_WORDS.has(token.toLowerCase().replace(/[.,]+$/u, '')));
};

// Returns how many characters of `line` belong to an address tail and whether
// the tail reached an anchor ("anchored") and the end of the line ("open").
// `like` marks address-shaped text with no anchor, `strong` such text with a
// comma or digit, and `overflow` a line longer than the scan window.
function addressTailInLine(line) {
  const lead = line.match(/^[ \t,;.–—-]*/u)[0].length;
  let body = line.slice(lead, lead + TAIL_WINDOW);
  const scan = body.replace(PIN_LABEL, match => ' '.repeat(match.length));
  const ends = [body.indexOf('<'), scan.search(TAIL_LABEL), body.search(TAIL_SENTENCE_END)].filter(index => index >= 0);
  const cut = ends.length > 0 ? Math.min(...ends) : -1;
  const overflow = cut < 0 && lead + TAIL_WINDOW < line.length;
  const open = cut < 0 && !overflow;
  if (cut >= 0) body = body.slice(0, cut);
  if (body.trim() === '') return { end: 0, anchored: false, open: cut < 0, plain: true };
  // Policy wording after the PIN ("... 56 0001 and cataract surgery is capped ...") ends the tail at the PIN.
  const wording = maskHouseNumbers(body).search(TAIL_POLICY_WORDING);
  if (wording >= 0) {
    let lastAnchor = -1;
    for (const match of body.slice(0, wording).matchAll(TAIL_ANCHOR)) lastAnchor = match.index + match[0].length;
    if (lastAnchor >= 0) body = body.slice(0, lastAnchor + stateWordsAfter(body.slice(lastAnchor, wording)));
  }
  if (!TAIL_START_WORD.test(body) || hasPolicyWording(body) || body.split(/\s+/).length > TAIL_MAX_WORDS) {
    return { end: 0, anchored: false, open: false, plain: false };
  }
  let anchorEnd = -1;
  for (const match of body.matchAll(TAIL_ANCHOR)) anchorEnd = match.index + match[0].length;
  if (anchorEnd < 0) {
    const like = isAddressLike(body);
    return { end: lead + body.trimEnd().length, anchored: false, open, plain: like, like, strong: like && /[,\d]/.test(body), overflow: overflow && like };
  }
  let end = lead + anchorEnd + stateWordsAfter(body.slice(anchorEnd));
  const phone = line.slice(end).match(TAIL_MASKED_PHONE_FIELD);
  if (phone) end += phone[0].length;
  return { end, anchored: true, open: false, plain: true };
}

const TAIL_STATE_LINE = /^[ \t]*\p{Lu}[\p{L}]*(?: \p{Lu}[\p{L}]*){0,2}[ \t]*$/u;

function absorbTailTrailers(text, lineEnd) {
  let end = lineEnd;
  for (let extra = 0; extra < 2 && end < text.length; extra += 1) {
    const newline = text.indexOf('\n', end + 1);
    const nextEnd = newline < 0 ? text.length : newline;
    const next = text.slice(end + 1, nextEnd);
    const phone = next.match(TAIL_MASKED_PHONE_FIELD);
    const isPhone = phone && phone[0].length === next.trimEnd().length;
    const isState = TAIL_STATE_LINE.test(next) && !TAIL_POLICY_WORDING.test(next);
    if (!isPhone && !isState) break;
    end = nextEnd;
  }
  return end;
}

// Walks the text after each <ADDRESS_n>: the rest of its line, then up to a few
// short continuation lines. The tail goes when an anchor (PIN, masked phone) is
// reached, or when address-shaped text with a comma or digit follows, or two or
// more address-shaped lines follow. Address-shaped text that runs past the scan
// limits cannot be judged, so the text is refused rather than sent.
function absorbAddressTails(text) {
  if (!text.includes('<ADDRESS_')) return text;
  let out = '';
  let cursor = 0;
  for (const match of text.matchAll(ADDRESS_TOKEN)) {
    const tokenEnd = match.index + match[0].length;
    if (tokenEnd < cursor) continue;
    let position = tokenEnd;
    let consumedTo = -1;
    const pending = [];
    for (let lineNumber = 0; lineNumber < TAIL_MAX_LINES && position <= text.length; lineNumber += 1) {
      const newline = text.indexOf('\n', position);
      const lineEnd = newline < 0 ? text.length : newline;
      const result = addressTailInLine(text.slice(position, lineEnd));
      if (result.overflow) fail('PRIVACY_ADDRESS_UNCERTAIN', 'Text after an address cannot be judged and is withheld.');
      if (result.anchored) {
        consumedTo = position + result.end;
        // The PIN or phone ended its line: a bare state line or a masked phone
        // line can still follow.
        if (consumedTo >= lineEnd) consumedTo = absorbTailTrailers(text, lineEnd);
        break;
      }
      if (!result.plain) break;
      if (result.end > 0) {
        if (!result.like) break;
        pending.push({ end: position + result.end, strong: result.strong });
      }
      if (!result.open || newline < 0) break;
      if (lineNumber === TAIL_MAX_LINES - 1 && result.like) fail('PRIVACY_ADDRESS_UNCERTAIN', 'Text after an address cannot be judged and is withheld.');
      position = newline + 1;
    }
    // Any address-shaped text straight after a labelled address is part of it; a heading that is mistaken for one is
    // lost, which is the safe side.
    if (consumedTo < 0 && pending.length > 0) consumedTo = pending[pending.length - 1].end;
    if (consumedTo < 0) continue;
    out += text.slice(cursor, tokenEnd);
    cursor = consumedTo;
  }
  return out + text.slice(cursor);
}

// Addresses with no label ("Flat 12, Example Heights, Testville - 560001"): a
// PIN preceded by comma-separated address text on the same line or table cell.
// Insurer, hospital and branch lines are public details and stay.
const PUBLIC_ADDRESS_LINE = /\b(?:hospital|clinic|insurer|insurance|assurance|ltd|limited|corporate|registered|head\s+office|tpa|grievance|ombudsman)\b/iu;
const ADDRESS_COMPONENT_LABEL = /\b(?:ward|sector|block|phase|plot|flat|door|house|po|ps|dist|district|tehsil|taluk|village|vill|near)\s*$/iu;
// A spaced pair of 3-digit groups after a place word is a PIN unless benefit or amount wording sits in the run.
const AMOUNT_CONTEXT = /\b(?:co-?pay|limit|sum|insured|premium|deductible|rent|age|cap|amount|cover|sublimit|rs|inr|waiting|days?|years?|months?|bonus|charges?|fees?|rate|plan|tier|room|claim)\b/iu;
const UNLABELLED_PIN = /(?<![\d₹.])[1-9](?:[ -]?\d){5}(?![\d]|[,.]\d)/gu;

function redactUnlabelledAddresses(value, swap) {
  if (!/[1-9](?:[ -]?\d){5}/u.test(value)) return value;
  const lines = value.split('\n');
  const hasDigit = line => /\d/u.test(line);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (PUBLIC_ADDRESS_LINE.test(line)) continue;
    let rebuilt = '';
    let from = 0;
    for (const pin of line.matchAll(UNLABELLED_PIN)) {
      if (pin.index < from) continue;
      // Look back at most 400 characters, so the work per PIN is bounded however long the line is.
      const windowStart = Math.max(from, pin.index - 400);
      const windowText = line.slice(windowStart, pin.index);
      // A field label ends at ':' unless the colon follows an address component ("Ward: 4").
      let colon = windowText.lastIndexOf(':');
      while (colon > 0 && ADDRESS_COMPONENT_LABEL.test(windowText.slice(Math.max(0, colon - 12), colon))) colon = windowText.lastIndexOf(':', colon - 1);
      const start = windowStart + Math.max(windowText.lastIndexOf('|'), colon) + 1;
      // Only the address-shaped run directly before the PIN is taken, so a long OCR run-on line is judged by its tail.
      const before = line.slice(start, pin.index);
      const pieces = before.split(/(\s+)/u).filter(piece => piece !== '');
      let runStart = pieces.length;
      while (runStart > 0 && (/^\s+$/u.test(pieces[runStart - 1]) || /^[,–—-]+$/u.test(pieces[runStart - 1]) || isAddressLike(pieces[runStart - 1]))) runStart -= 1;
      const candidate = pieces.slice(runStart).join('').slice(-220);
      const candidateStart = pin.index - candidate.length;
      const trimmed = candidate.trim();
      // A capitalised place word right before a contiguous PIN ("Testville 560001") is enough without a comma. A spaced PIN
      // needs a comma, because runs of small numbers ("Copay 100 110") look like one.
      const placeBeforePin = (/^\d{6}$/u.test(pin[0]) || (/^\d{3} \d{3}$/u.test(pin[0]) && !AMOUNT_CONTEXT.test(trimmed))) && /\p{Lu}[\p{L}\p{M}]{2,}[,.]?\s*[,–—-]*\s*$/u.test(trimmed);
      if (trimmed.length < 3 || trimmed.length > 220 || !(/,/u.test(trimmed) || placeBeforePin) || hasPolicyWording(trimmed)
        || !isAddressLike(trimmed.replace(/[,–—-]+(?=\s|$)/gu, ' '))) continue;
      // Lines directly above that carry a house or plot number belong to the same address.
      let top = index;
      while (top > 0 && index - top < 3 && lines[top - 1].trim() && lines[top - 1].length < 120 && !/<[A-Z]+_\d+>/u.test(lines[top - 1])
        && !PUBLIC_ADDRESS_LINE.test(lines[top - 1]) && !hasPolicyWording(lines[top - 1]) && isAddressLike(lines[top - 1].replace(/[,–—-]+(?=\s|$)/gu, ' '))) top -= 1;
      let first = -1;
      for (let above = top; above < index; above += 1) if (hasDigit(lines[above])) { first = above; break; }
      // A list of plan or benefit names before an amount is not an address: the PIN needs a "CITY - PIN" dash, an
      // internal separator ("560 001"), or a house number in the text or just above, and a round amount ("500000")
      // is never a PIN.
      const glued = /[–—-]\s*$/u.test(candidate) || /[ -]/u.test(pin[0]);
      if ((!glued && !placeBeforePin && !/\d/u.test(trimmed) && first < 0) || (!/[ -]/u.test(pin[0]) && /000$/u.test(pin[0]))) continue;
      const end = pin.index + pin[0].length + stateWordsAfter(line.slice(pin.index + pin[0].length));
      const leading = candidate.length - candidate.trimStart().length;
      rebuilt += line.slice(from, candidateStart + leading) + swap('ADDRESS', 'DIRECT_IDENTIFIER_ADDRESS', line.slice(candidateStart + leading, end));
      from = end;
      if (first >= 0) for (let above = first; above < index; above += 1) lines[above] = swap('ADDRESS', 'DIRECT_IDENTIFIER_ADDRESS', lines[above]);
    }
    lines[index] = rebuilt ? rebuilt + line.slice(from) : line;
  }
  return lines.join('\n');
}

// Address fragments with no PIN and no label: a house-number start ("Flat 12, ..."), a landmark ("Near Example
// Temple") or a locality/street name ("Sample Nagar", "Old Example Road"). A comma-chained run of address-shaped
// pieces that holds one of these goes whole. A state or city name on its own is not a fragment: territorial and zone
// wording needs it, and it does not identify anyone. It goes only when it sits in such a run or directly after one.
const LOCALITY_SUFFIX = '(?:Nagar|Colony|Layout|Enclave|Heights|Apartments?|Residency|Vihar|Marg|Chowk|Extension|Road|Street|Lane|Puram|Ganj|Gali|Mohalla|Bazaar|Bazar)';
// Inside prose only the suffixes that are never ordinary benefit wording count.
const INLINE_SUFFIX = '(?:Nagar|Colony|Layout|Enclave|Heights|Apartments?|Residency|Vihar|Marg|Puram|Ganj|Gali|Mohalla)';
const INLINE_LOCALITY = new RegExp(`(?<![\\p{L}\\p{M}\\d.'])(?:#?\\d{1,4}[A-Za-z]?(?:[/-]\\d{1,4})?,?\\s+)?(?:\\p{Lu}[\\p{L}\\p{M}.']*\\s+){1,4}${INLINE_SUFFIX}(?![\\p{L}])(?:\\s?[,;]\\s?\\p{Lu}[\\p{L}\\p{M}]{2,}(?:\\s\\p{Lu}[\\p{L}\\p{M}]{2,})?){0,2}`, 'gu');
// Lowercase or OCR-lowercase lines (no capital letter at all) never carry the capitalisation the main rules need, so they
// get a stricter form: a strong locality suffix, or a house keyword with a number, and a following comma piece.
const LOWER_LOCALITY = /(?<![\p{L}\p{M}\d.'])(?:(?:#?\d{1,4}[a-z]?(?:[/-]\d{1,4})?,?\s+)?(?:[a-z.']+\s+){1,2}(?:nagar|enclave|vihar|puram|gali|mohalla)(?![\p{L}])|(?:flat|house|door|plot|h\.?\s?no\.?)\s*#?\d{1,4}[a-z]?(?:[/-]\d{1,4})?\s*,\s*[a-z.']+(?:\s[a-z.']+){0,3})(?:\s?[,;]\s?[a-z]{3,}(?:\s[a-z]{3,})?){0,2}/gu;
// Devanagari: word run ending in a locality word (नगर, कॉलोनी, विहार...), optional house keyword or number before it.
const DEVA = '[\\p{Script=Devanagari}\\p{M}]';
const DEVA_SUFFIX = '(?:नगर|कॉलोनी|कालोनी|विहार|मार्ग|पुरम|गंज|गली|मोहल्ला|एन्क्लेव|हाइट्स|अपार्टमेंट|रेजिडेंसी)';
const DEVA_LOCALITY = new RegExp(`(?<![\\p{L}\\p{M}\\d])(?:(?:(?:फ्लैट|मकान|प्लॉट|घर)\\s*)?[०-९0-9]{1,4}[,\\s]+)?(?:(?:${DEVA}+\\s+){1,3}${DEVA_SUFFIX}|${DEVA}{2,}${DEVA_SUFFIX})(?![\\p{L}\\p{M}])(?:\\s?[,;،]\\s?${DEVA}{2,}(?:\\s${DEVA}{2,})?){0,2}`, 'gu');
// Comma-less house address ("Flat 12 Example Apartments Testville"): house keyword + number, then 2-5 capitalised words.
const HOUSE_INLINE = /(?<![\p{L}\p{M}\d])(?:Flat|House|H\.?\s?No\.?)\s*#?\d{1,4}[A-Za-z]?(?:[/-]\d{1,4})?\s*,?\s+(?:\p{Lu}[\p{L}\p{M}.']{2,}\s*,?\s*){2,5}/gu;
// A single place word with a glued suffix ("Samplepur") counts only beside a number, because city names alone are kept.
const GLUED_LOCALITY = /\p{Lu}[\p{L}\p{M}]{2,}(?:nagar|pur|halli|palli|puram|ganj|wadi|bagh)(?![\p{L}])/u;
const SECTOR_START = /^\s*Sector\s+\d{1,3}\b/u;
const HOUSE_LINE_ONLY = /^\s*(?:(?:flat|house|door|plot|h\.?\s?no\.?)\s*)?(?:no\.?\s*)?#?\d{1,4}[A-Za-z]?(?:[/-]\d{1,4})?,?\s*$/iu;
const LOCALITY_NAME = new RegExp(`(?:\\p{Lu}[\\p{L}\\p{M}.']*\\s+){1,4}${LOCALITY_SUFFIX}(?![\\p{L}])`, 'u');
// A landmark needs a place noun ("Near Example Temple"), so benefit wording such as "Near Miss Events" or "Behind Ear
// Procedures" stays. Plot and shop numbers need a second address signal ("Plot 3, Lane Surgery" is not an address).
const LANDMARK = /(?:^|[\s,(])(?:Near|Opp\.?|Opposite|Behind|Beside|Nr\.?)\s+(?:The\s+)?(?:\p{Lu}[\p{L}\p{M}.']*\s+){0,3}(?:Temple|Mall|Park|School|Church|Mosque|Masjid|Station|Stop|Circle|Signal|Market|Bank|Chowk|College|Gate|Hospital|Stadium)(?![\p{L}])/u;
const HOUSE_KEYWORD_START = /^\s*(?:flat|house|door|h\.?\s?no)\b[^,]*\d/iu;
const WEAK_HOUSE_START = /^\s*(?:plot|shop)\b[^,]*\d/iu;
const HOUSE_NUMBER_ONLY = /^\s*#?\d{1,4}[A-Za-z]?(?:[/-](?:\d{1,4}|[A-Za-z]))?\s*$/u;
// "12/A", "7-B", "4A": a house number that carries a slash, dash or letter reads as an address start on its own.
const HOUSE_NUMBER_MARKED = /^\s*#?\d{1,4}(?:[A-Za-z]|[/-](?:\d{1,4}|[A-Za-z]))\s*$/u;
const FRAGMENT_PIECE_MAX = 80;

function redactFragmentRun(text, swap) {
  const parts = text.split(/([,;])/u);
  const pieces = [];
  for (let index = 0; index < parts.length; index += 2) pieces.push({ index, text: parts[index] });
  const likeAt = piece => piece.text.trim() !== '' && piece.text.length <= FRAGMENT_PIECE_MAX && !hasPolicyWording(piece.text) && !PUBLIC_ADDRESS_LINE.test(piece.text)
    && isAddressLike(piece.text.replace(/[–—-]+(?=\s|$)/gu, ' '));
  const triggerAt = piece => LOCALITY_NAME.test(piece.text) || LANDMARK.test(piece.text) || HOUSE_KEYWORD_START.test(piece.text);
  let output = '';
  let cursor = 0;
  let runStart = 0;
  while (runStart < pieces.length) {
    if (!likeAt(pieces[runStart])) { runStart += 1; continue; }
    let runEnd = runStart;
    while (runEnd + 1 < pieces.length && likeAt(pieces[runEnd + 1])) runEnd += 1;
    const run = pieces.slice(runStart, runEnd + 1);
    const qualifies = run.some(triggerAt) || (run.length >= 3 && WEAK_HOUSE_START.test(run[0].text)) || (run.length >= 3 && HOUSE_NUMBER_ONLY.test(run[0].text) && run.slice(1).some(piece => /\p{L}/u.test(piece.text)))
      || (run.length >= 2 && SECTOR_START.test(run[0].text))
      || (run.length >= 2 && HOUSE_NUMBER_MARKED.test(run[0].text) && run.slice(1).every(piece => /\p{L}/u.test(piece.text))
        && /^\s*\p{Lu}/u.test(pieces[runEnd + 1]?.text ?? ''))
      || (run.length >= 3 && run.some(piece => GLUED_LOCALITY.test(piece.text)) && run.some(piece => /\d/u.test(piece.text)));
    if (qualifies) {
      const startPiece = run[0];
      const endPiece = run[run.length - 1];
      const leading = startPiece.text.length - startPiece.text.trimStart().length;
      const offset = parts.slice(0, startPiece.index).join('').length;
      const span = parts.slice(startPiece.index, endPiece.index + 1).join('');
      const trailing = endPiece.text.length - endPiece.text.trimEnd().length;
      output += text.slice(cursor, offset + leading) + swap('ADDRESS', 'DIRECT_IDENTIFIER_ADDRESS', span.slice(leading, span.length - trailing));
      cursor = offset + span.length - trailing;
    }
    runStart = runEnd + 1;
  }
  return output + text.slice(cursor);
}

function redactAddressFragments(value, swap) {
  if (!/\p{Lu}/u.test(value)) return value;
  // Public wording (hospital, insurer) is judged piece by piece inside the run, so "Admitted at Sample Hospital,
  // Sample Nagar, Testville" keeps the hospital and loses the locality. Table cells are judged one by one.
  // A cell that opens with public wording ("Hospital Address", "Registered Office: Example Insurance Ltd") is a public
  // address and stays whole.
  const opensPublic = cell => PUBLIC_ADDRESS_LINE.test(cell.trim().split(/\s+/u).slice(0, 2).join(' '));
  return value.split('\n').map(line => (opensPublic(line) ? line : line.split('|').map(cell => (opensPublic(cell) ? cell : redactFragmentRun(cell, swap))).join('|'))).join('\n');
}

// "12/A, Shivaji Park" anywhere in a line, also at its end or after leading words ("Lives at 12/A, ..."): a house number
// with a slash, dash or letter, then capitalised address words and up to two more comma pieces. Clause references
// ("Clause 4/B, Gold Plan") are not addresses.
const HOUSE_MARKED_INLINE = /(?<![\p{L}\p{M}\d.'/-])#?\d{1,4}(?:[A-Za-z]|[/-](?:\d{1,4}|[A-Za-z]))(?![\p{L}\d])\s*,\s*\p{Lu}[\p{L}\p{M}.']+(?:\s+\p{Lu}[\p{L}\p{M}.']+){0,3}(?:\s?,\s?\p{Lu}[\p{L}\p{M}]{2,}(?:\s\p{Lu}[\p{L}\p{M}]{2,})?){0,2}/gu;
const CLAUSE_REFERENCE_BEFORE = /\b(?:exclusions?|category|ward|room|version|benefit|cover|code|no|class|type|clause|section|annexure|annex|table|page|schedule|item|article|rule|para|paragraph|point|note|figure|row|step|tier|plan|part|chapter|appendix)\s*$/iu;

// A locality name inside a sentence ("resides at Sample Nagar, Testville and ...") or on a long comma-less line.
function redactInlineLocalities(value, swap) {
  const sw = match => swap('ADDRESS', 'DIRECT_IDENTIFIER_ADDRESS', match);
  return value.split('\n').map(line => {
    if (PUBLIC_ADDRESS_LINE.test(line.trim().split(/\s+/u).slice(0, 2).join(' '))) return line;
    let out = line.replace(INLINE_LOCALITY, sw);
    out = out.replace(HOUSE_INLINE, match => sw(match.trimEnd()) + match.slice(match.trimEnd().length));
    out = outsideTokens(out, segment => segment.replace(HOUSE_MARKED_INLINE, (match, offset, whole) => (
      CLAUSE_REFERENCE_BEFORE.test(whole.slice(Math.max(0, offset - 16), offset)) || hasPolicyWording(match) || PUBLIC_ADDRESS_LINE.test(match) ? match : sw(match))));
    out = outsideTokens(out, segment => segment.replace(DEVA_LOCALITY, sw));
    if (!/\p{Lu}/u.test(out.replace(/<[A-Z]+_\d+>/gu, ''))) out = outsideTokens(out, segment => segment.replace(LOWER_LOCALITY, sw));
    return out;
  }).join('\n');
}

// A bare house number on its own line directly above a redacted address belongs to it.
function absorbHouseNumberLines(text, swap) {
  const lines = text.split('\n');
  for (let index = 0; index + 1 < lines.length; index += 1) {
    if (lines[index].length < 40 && HOUSE_LINE_ONLY.test(lines[index]) && /^\s*<ADDRESS_\d+>/u.test(lines[index + 1])) {
      lines[index] = swap('ADDRESS', 'DIRECT_IDENTIFIER_ADDRESS', lines[index].trim());
    }
  }
  return lines.join('\n');
}

function redactText(value, state) {
  rejectTabTables(value);
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
  const swap = (kind, reason, raw) => { reasons.add(reason); return placeholder(state, kind, raw); };
  // Caller-supplied known identifiers first, then line structures (name lists,
  // member-table rows), then the per-segment pattern rules.
  const known = redactKnownIdentifiers(withoutLegacy, state.known, swap);
  const lined = redactLineStructures(known, swap);
  const labelled = absorbAddressTails(outsideTokens(lined, segment => redactSegment(segment, state, reasons)));
  // Unlabelled addresses run after labelled ones, so a labelled address keeps its own tail rule; a second pass lets a
  // masked phone line after an unlabelled address go too.
  const unlabelled = outsideTokens(labelled, segment => redactUnlabelledAddresses(segment, swap));
  const fragments = outsideTokens(unlabelled, segment => redactAddressFragments(segment, swap));
  const inline = outsideTokens(fragments, segment => redactInlineLocalities(segment, swap));
  const text = absorbHouseNumberLines(absorbAddressTails(inline), swap);
  return { text, reasons: [...reasons].sort() };
}

// `knownIdentifiers` is required (an empty array is an explicit "none"): a caller that forgets the household's own names,
// dates of birth, phones and emails would store them raw. `regate: true` is for text that already went through this gate
// (stored pages, clauses): only then may gate-minted placeholders appear in the input. Raw input that carries
// placeholder or legacy-token syntax is refused, so it cannot split a credential or phone across a fake token.
export function sanitizeEvidenceTextForStorage(text, { maxBytes = 4_000, knownIdentifiers, regate = false } = {}) {
  if (typeof text !== 'string' || text.trim() === '') fail('PRIVACY_GATE_MALFORMED', 'Evidence text must be non-empty text.');
  if (knownIdentifiers === undefined || knownIdentifiers === null) fail('PRIVACY_GATE_MALFORMED', 'Storage text needs its known identifiers list (empty when none).');
  if (regate !== true && HAS_TOKEN.test(normalizeText(text))) fail('RESTRICTED_EVIDENCE', 'Restricted evidence cannot be sent to a model.');
  if (!Number.isInteger(maxBytes) || maxBytes <= 0 || maxBytes > 16_000) fail('PRIVACY_GATE_MALFORMED', 'Storage text byte limit is invalid.');
  if (Buffer.byteLength(text, 'utf8') > 64_000) fail('EVIDENCE_SOURCE_LIMIT', 'Evidence text exceeds its intake byte limit.');
  const known = compileKnownIdentifiers(knownIdentifiers);
  const redacted = redactText(text, createPlaceholderState(text, known));
  const excerpt = truncateUtf8(redacted.text, maxBytes);
  const reasonCodes = new Set(redacted.reasons);
  if (excerpt.truncated) reasonCodes.add('TEXT_TRUNCATED');
  return Object.freeze({
    text: excerpt.text,
    // Digest of the minimised text: a hash of the raw text would let a guesser confirm a candidate identifier.
    digest: digest(excerpt.text),
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

// Upstream keys are field names from a fixed list (the deterministic decision output and generic amount/count
// fields), keys that name a sensitive value (the value is minimised), id-shaped keys, and any key under a sensitive
// parent ("name": { "first": ... }). A key that is not one of these could carry a name or number, so it is refused.
const STRUCTURED_FIELD_NAMES = new Set([
  'class', 'reason', 'unresolvedcount', 'unknowns', 'score', 'route', 'rulesroute', 'probabilityofapproval', 'kind', 'immediacy',
  'financialexposure', 'evidenceconfidence', 'evidence', 'dimensions', 'coveragedeficiency', 'continuityrisk', 'confirmedpayable', 'citedfactcount',
  'boundary', 'amount', 'note', 'reference', 'contact', 'year', 'negative', 'waitingdays', 'copaypercent', 'suminsured', 'roomrent', 'premium',
  'reviewemail', 'revieweremail', 'status', 'state', 'count', 'total', 'text', 'summary', 'questions', 'citations', 'authorityowner',
].map(structuredKey));
const fieldNameAllowed = (key, inherited) => inherited !== null || STRUCTURED_FIELD_NAMES.has(structuredKey(key)) || STRUCTURED_SENSITIVE_KEYS.has(structuredKey(key))
  || /^(?:id|ids)$/i.test(key) || /(?:^|_)(?:id|ids)$/i.test(key) || /[a-z]Ids?$/.test(key);
const STRUCTURED_KEY_SHAPE = /^[A-Za-z_][A-Za-z0-9_.:-]{0,99}$/;

function sanitizeStructured(value, state, key = '', depth = 0, inherited = null) {
  if (depth > state.limits.maxStructuredDepth) fail('PRIVACY_GATE_MALFORMED', 'Structured evidence is too deeply nested.');
  state.items += 1;
  if (state.items > state.limits.maxStructuredItems) fail('PRIVACY_GATE_MALFORMED', 'Structured evidence has too many items.');
  if (value === null || typeof value === 'boolean') return value;
  const identifierKey = /(?:^|_)(?:id|ids)$/i.test(key) || /Id(?:s)?$/.test(key);
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Identifiers can arrive as JSON numbers ("phone": 9876543210). Under an
    // identifier or sensitive key the number is minimised like its text form;
    // elsewhere an integer is scanned as text and replaced only when a rule
    // minimises (or rejects) it, so amounts and counts stay numbers.
    if (!identifierKey && !STRUCTURED_SENSITIVE_KEYS.has(structuredKey(key)) && !inherited) {
      if (!Number.isInteger(value)) return value;
      const redacted = redactText(String(value), state.placeholders);
      if (redacted.reasons.includes('TEXT_TRUNCATED')) fail('EVIDENCE_SOURCE_LIMIT', 'Structured evidence text exceeds its byte limit.');
      if (redacted.text === String(value)) return value;
      redacted.reasons.forEach(reason => state.reasons.add(reason));
      return redacted.text;
    }
    value = String(value);
  }
  if (typeof value === 'string') {
    if (identifierKey) {
      state.reasons.add('DIRECT_IDENTIFIER_STRUCTURED_ID');
      return placeholder(state.placeholders, 'ID', value);
    }
    const sensitive = STRUCTURED_SENSITIVE_KEYS.get(structuredKey(key)) ?? inherited;
    if (sensitive) {
      const cut = prepareText(value);
      if (cut.capped) fail('EVIDENCE_SOURCE_LIMIT', 'Structured evidence text exceeds its byte limit.');
      const prepared = cut.text;
      rejectRestrictedText(prepared);
      state.reasons.add(sensitive[1]);
      // A value that is exactly one known identifier keeps that identifier's
      // placeholder, so "patientName": "Kavya Placeholder" and the same name in
      // a source share <NAME_n>.
      const swap = (kind, reason, raw) => { state.reasons.add(reason); return placeholder(state.placeholders, kind, raw); };
      const known = redactKnownIdentifiers(prepared.trim(), state.placeholders.known, swap);
      if (/^<[A-Z]+_[1-9][0-9]{0,5}>$/.test(known)) return known;
      return placeholder(state.placeholders, sensitive[0], value);
    }
    const redacted = redactText(value, state.placeholders);
    if (redacted.reasons.includes('TEXT_TRUNCATED')) fail('EVIDENCE_SOURCE_LIMIT', 'Structured evidence text exceeds its byte limit.');
    redacted.reasons.forEach(reason => state.reasons.add(reason));
    return redacted.text;
  }
  // Everything under a sensitive key ("name": { "first": ... }) is that kind of value.
  const below = STRUCTURED_SENSITIVE_KEYS.get(structuredKey(key)) ?? inherited;
  if (Array.isArray(value)) return value.map(item => sanitizeStructured(item, state, key, depth + 1, below));
  plainObject(value, 'Structured evidence value');
  const output = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(childKey)) fail('PRIVACY_GATE_MALFORMED', 'Structured evidence contains an unsafe key.');
    // Keys are field names, never data: an odd shape, or a key the gate would minimise, is refused.
    if (!STRUCTURED_KEY_SHAPE.test(childKey) || redactText(childKey, state.placeholders).text !== childKey || !fieldNameAllowed(childKey, below)) {
      fail('PRIVACY_GATE_MALFORMED', 'Structured evidence contains a key that is not a plain field name.');
    }
    output[childKey] = sanitizeStructured(childValue, state, childKey, depth + 1, below);
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

// `regated: true` marks input that already went through this gate (stored excerpts and what is derived from them): only
// then may gate-minted placeholders appear. Raw input carrying placeholder syntax is refused.
export function sanitizeEvidenceForModel(input, { task = 'model_task', resolveParameterPolicy, limits, knownIdentifiers, regated = false } = {}) {
  const bounded = limitsWithDefaults(limits);
  const known = compileKnownIdentifiers(knownIdentifiers);
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
  if (regated !== true && HAS_TOKEN.test(normalizeText(serialized))) fail('RESTRICTED_EVIDENCE', 'Restricted evidence cannot be sent to a model.');
  const placeholders = createPlaceholderState(serialized, known);

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
    // A cut can split an identifier into an unrecognisable fragment, so a truncated source is refused, as storage drops it.
    if (excerpt.truncated || textReasons.has('TEXT_TRUNCATED')) fail('EVIDENCE_SOURCE_LIMIT', 'Evidence source text exceeds its model byte limit.');
    const safeVersion = redactText(version, placeholders);
    if (textReasons.size > 0 || safeVersion.reasons.length > 0) dataClass = 'CONFIDENTIAL';
    const reasons = new Set([...textReasons, ...safeVersion.reasons]);
    const safeId = opaqueId('source', rawId);
    if (safeIds.has(safeId)) fail('PRIVACY_GATE_MALFORMED', 'Evidence source IDs must be unique.');
    safeIds.add(safeId);
    safeSources.push({ id: safeId, version: safeVersion.text, page: source.page, text: excerpt.text, status: source.status });
    sourceAudit.push(Object.freeze({ sourceId: safeId, digest: digest(excerpt.text), dataClass, page: source.page, version: safeVersion.text, redactionReasonCodes: [...reasons].sort(), inputBytes: Buffer.byteLength(source.text, 'utf8'), outputBytes: Buffer.byteLength(excerpt.text, 'utf8') }));
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
