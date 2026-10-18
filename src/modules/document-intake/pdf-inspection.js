import { inflateSync } from 'node:zlib';
import { DocumentIntakeError } from './contracts.js';

// Server-side structural and active-content inspection for untrusted PDF bytes.
// Every pass is a single linear byte scan (no regular expressions on file content).
// Only object streams (/Type /ObjStm) are inflated, each with a hard output cap.

export const PDF_INSPECTION_LIMITS = Object.freeze({
  maxPages: 500,
  maxObjectStreams: 2000,
  maxStreamInflatedBytes: 8 * 1024 * 1024,
  maxTotalInflatedBytes: 64 * 1024 * 1024,
});

const ACTIVE_NAMES = new Set([
  'JavaScript', 'JS', 'Launch', 'EmbeddedFile', 'EmbeddedFiles', 'RichMedia',
  'XFA', 'SubmitForm', 'ImportData', 'GoToE', 'Sound', 'Movie',
]);

const EOF_WINDOW = 1024;
const MAX_NAME_BYTES = 64; // longer names cannot match any name we look for
const MAX_KEYWORD_BYTES = 16;
const ENDSTREAM = Buffer.from('endstream', 'latin1');
const EOF_MARKER = Buffer.from('%%EOF', 'latin1');

// Byte classes: 0 regular, 1 whitespace, 2 delimiter.
const CLASS = new Uint8Array(256);
for (const c of [0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]) CLASS[c] = 1;
for (const c of '()<>[]{}/%') CLASS[c.charCodeAt(0)] = 2;

const HEX = new Int8Array(256).fill(-1);
for (let i = 0; i < 10; i += 1) HEX[0x30 + i] = i;
for (let i = 0; i < 6; i += 1) { HEX[0x41 + i] = 10 + i; HEX[0x61 + i] = 10 + i; }

const fail = (code, message) => { throw new DocumentIntakeError(code, message); };

function toBuffer(bytes) {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof Uint8Array) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return fail('PDF_STRUCTURE_INVALID', 'The PDF could not be read.');
}

function resolveLimits(limits) {
  const merged = { ...PDF_INSPECTION_LIMITS, ...(limits ?? {}) };
  for (const key of Object.keys(PDF_INSPECTION_LIMITS)) {
    if (!Number.isSafeInteger(merged[key]) || merged[key] < 0) throw new TypeError(`PDF inspection limit ${key} must be a non-negative integer.`);
  }
  return merged;
}

function readHeaderVersion(buf) {
  // %PDF-1.x or %PDF-2.x at byte 0.
  if (buf.length < 8 || buf.toString('latin1', 0, 5) !== '%PDF-') return null;
  const major = buf[5];
  if ((major !== 0x31 && major !== 0x32) || buf[6] !== 0x2e || buf[7] < 0x30 || buf[7] > 0x39) return null;
  return buf.toString('latin1', 5, 8);
}

function decodeName(buf, start, end) {
  if (end - start > MAX_NAME_BYTES) return '';
  let out = '';
  for (let i = start; i < end; i += 1) {
    const c = buf[i];
    if (c === 0x23 && i + 2 < end) {
      const hi = HEX[buf[i + 1]];
      const lo = HEX[buf[i + 2]];
      if (hi >= 0 && lo >= 0) { out += String.fromCharCode(hi * 16 + lo); i += 2; continue; }
    }
    out += String.fromCharCode(c);
  }
  return out;
}

function parseInteger(buf, start, end) {
  // Returns a non-negative safe integer, or null when the token is not one.
  if (end - start > 15 || end <= start) return null;
  let value = 0;
  for (let i = start; i < end; i += 1) {
    const d = buf[i] - 0x30;
    if (d < 0 || d > 9) return null;
    value = value * 10 + d;
  }
  return value;
}

const OBJ_TAIL = Buffer.from('bj', 'latin1');
const TRAILER_TAIL = Buffer.from('railer', 'latin1');
const STARTXREF_TAIL = Buffer.from('tartxref', 'latin1');
const XREF_TAIL = Buffer.from('ref', 'latin1');
const MAX_GAP = 32;

const matchAt = (buf, k, end, tail) => k + tail.length <= end && buf.compare(tail, 0, tail.length, k, k + tail.length) === 0;
const isDigit = c => c >= 0x30 && c <= 0x39;

// `k` is the index of "obj"; true when it is preceded by "<digits> <digits> "
// and followed by whitespace, a delimiter or the end of the range.
function isObjectHeader(buf, k, start, end) {
  if (k + 3 < end && CLASS[buf[k + 3]] === 0) return false;
  let j = k - 1;
  for (let pass = 0; pass < 2; pass += 1) {
    const wsStop = Math.max(start, j - MAX_GAP);
    const wsFrom = j;
    while (j >= wsStop && CLASS[buf[j]] === 1) j -= 1;
    if (j === wsFrom) return false;
    const digitStop = Math.max(start, j - 10);
    const digitFrom = j;
    while (j >= digitStop && isDigit(buf[j])) j -= 1;
    if (j === digitFrom) return false;
  }
  return true;
}

/**
 * Viewers reach objects through xref byte offsets, so an object header or a
 * trailer placed inside bytes this scanner skips (stream data, comments,
 * literal strings) would be live but unseen. Rejects any such range that holds
 * `N G obj`, `trailer <<`, `startxref`, or `xref` + EOL + digit at a line start.
 * One linear pass with O(1) bounded look-around per candidate byte; random
 * binary data needs a multi-byte exact structure to match.
 */
function assertNoHiddenStructure(buf, start, end) {
  for (let k = start; k < end; k += 1) {
    const c = buf[k];
    let hidden = false;
    if (c === 0x6f) { // o
      hidden = matchAt(buf, k + 1, end, OBJ_TAIL) && isObjectHeader(buf, k, start, end);
    } else if (c === 0x74) { // t
      if (matchAt(buf, k + 1, end, TRAILER_TAIL)) {
        let j = k + 7;
        const stop = Math.min(end, j + MAX_GAP);
        while (j < stop && CLASS[buf[j]] === 1) j += 1;
        hidden = j + 1 < end && buf[j] === 0x3c && buf[j + 1] === 0x3c;
      }
    } else if (c === 0x73) { // s
      hidden = matchAt(buf, k + 1, end, STARTXREF_TAIL);
    } else if (c === 0x78) { // x
      if ((k === start || buf[k - 1] === 0x0a || buf[k - 1] === 0x0d) && matchAt(buf, k + 1, end, XREF_TAIL)) {
        let j = k + 4;
        const stop = Math.min(end, j + MAX_GAP);
        while (j < stop && (buf[j] === 0x20 || buf[j] === 0x09)) j += 1;
        if (j < end && (buf[j] === 0x0a || buf[j] === 0x0d)) {
          while (j < stop && CLASS[buf[j]] === 1) j += 1;
          hidden = j < end && isDigit(buf[j]);
        }
      }
    }
    if (hidden) fail('PDF_STRUCTURE_INVALID', 'The PDF has hidden or malformed structure.');
  }
}

function freshObjectState() {
  return {
    dictDepth: 0,
    isObjStm: false,
    hasN: false,
    hasFirst: false,
    length: null,
    lengthState: 0,
    filterState: 0, // 1 after /Filter, 2 inside filter array
    filters: null,
    filterInvalid: false,
    decodeParmsState: 0,
    decodeParmsIndirect: false,
    predictorState: 0,
    predictor: false,
  };
}

/**
 * Tokenizes `buf` linearly and reports names, page objects and (raw mode only)
 * object-stream data ranges. Approximations, all deliberate:
 * - Comments run to end of line and literal strings honour nesting and
 *   backslash escapes; names inside either are ignored, as a PDF parser does.
 *   An unterminated literal string is rejected rather than guessed at.
 * - A hex string ends at the first byte that is not hex or whitespace, so a
 *   malformed `<` cannot swallow following names.
 * - Stream data is skipped using a direct, in-bounds /Length only when
 *   `endstream` follows it; otherwise the first `endstream` after the data
 *   start ends the stream. A forged /Length that lands exactly on a later
 *   `endstream` hides the bytes in between, exactly as a /Length-honouring
 *   viewer would treat them.
 * - `/Type /Page` is counted once per raw object number (incremental updates
 *   that redefine a page do not double count). Inside object streams each
 *   occurrence counts, which can only over-count.
 * - Skipped bytes (stream data, comment text, literal string contents) are
 *   checked by assertNoHiddenStructure for object headers and trailers. That
 *   check does not allow comments inside `N G obj`, so a header split by a
 *   comment inside skipped bytes is not detected.
 * This is a bounded heuristic over untrusted bytes, not a full PDF parser.
 */
function scan(buf, mode, findings, limits) {
  const raw = mode === 'raw';
  const length = buf.length;
  let i = 0;
  let prevName = null; // decoded name of the immediately preceding token, if it was a name
  let num1 = null; // last two integer tokens, used to find "N G obj"
  let num2 = null;
  let objectNumber = null;
  let state = freshObjectState();

  const resetObject = () => { state = freshObjectState(); };

  const onValueToken = (kind, value) => {
    // Feed the per-object dictionary state machines (raw mode only).
    if (state.lengthState === 1) {
      if (kind === 'int') { state.length = value; state.lengthState = 2; } else { state.length = null; state.lengthState = 0; }
    } else if (state.lengthState === 2) {
      state.lengthState = kind === 'int' ? 3 : 0;
    } else if (state.lengthState === 3) {
      if (kind === 'keyword' && value === 'R') state.length = null; // indirect length: unknown
      state.lengthState = 0;
    }
    if (state.filterState === 1) {
      if (kind === 'name') { state.filters = [value]; state.filterState = 0; }
      else if (kind === '[') { state.filters = []; state.filterState = 2; }
      else { state.filterInvalid = true; state.filterState = 0; }
    } else if (state.filterState === 2) {
      if (kind === 'name' && state.filters.length < 8) state.filters.push(value);
      else if (kind === 'name') state.filterInvalid = true;
      else if (kind === ']') state.filterState = 0;
      else state.filterInvalid = true;
    }
    if (state.decodeParmsState === 1) {
      if (kind === 'int') state.decodeParmsIndirect = true;
      state.decodeParmsState = 0;
    }
    if (state.predictorState === 1) {
      if (kind !== 'int' || value > 1) state.predictor = true;
      state.predictorState = 0;
    }
  };

  const onName = name => {
    if (raw) onValueToken('name', name);
    if (ACTIVE_NAMES.has(name)) findings.active = true;
    if (name === 'Encrypt') findings.encrypted = true;
    if (prevName === 'Type') {
      if (name === 'Page') {
        if (!raw) findings.pages += 1;
        else if (objectNumber === null) findings.pages += 1;
        else if (!findings.pageObjects.has(objectNumber)) { findings.pageObjects.add(objectNumber); findings.pages += 1; }
      } else if (name === 'ObjStm' && raw && state.dictDepth === 1) {
        state.isObjStm = true;
      }
    }
    if (raw) {
      if (state.dictDepth === 1) {
        if (name === 'Length') state.lengthState = 1;
        else if (name === 'Filter') state.filterState = 1;
        else if (name === 'DecodeParms') state.decodeParmsState = 1;
        else if (name === 'N') state.hasN = true;
        else if (name === 'First') state.hasFirst = true;
      }
      if (name === 'Predictor') state.predictorState = 1;
    }
    prevName = name;
  };

  const skipStream = () => {
    // `i` points just past the `stream` keyword.
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a) i += 2;
    else if (buf[i] === 0x0a || buf[i] === 0x0d) i += 1;
    const start = i;
    let end = -1;
    let next = -1;
    if (state.length !== null && start + state.length <= length) {
      let j = start + state.length;
      const limit = Math.min(length, j + 64);
      while (j < limit && CLASS[buf[j]] === 1) j += 1;
      if (j + ENDSTREAM.length <= length && buf.compare(ENDSTREAM, 0, ENDSTREAM.length, j, j + ENDSTREAM.length) === 0) {
        end = start + state.length;
        next = j + ENDSTREAM.length;
      }
    }
    if (end < 0) {
      const k = buf.indexOf(ENDSTREAM, start);
      if (k < 0) fail('PDF_STRUCTURE_INVALID', 'The PDF has an unterminated stream.');
      end = k;
      if (end > start && buf[end - 1] === 0x0a) end -= 1;
      if (end > start && buf[end - 1] === 0x0d) end -= 1;
      next = k + ENDSTREAM.length;
    }
    // Every raw stream body is skipped for name matching, so it must not hide
    // objects or trailers that a viewer could reach through an xref offset.
    assertNoHiddenStructure(buf, start, end);
    // An object stream is any stream whose dictionary has /N and /First, even
    // when /Type is missing, indirect or wrong.
    if (state.isObjStm || (state.hasN && state.hasFirst)) {
      findings.objectStreamCount += 1;
      if (findings.objectStreamCount > limits.maxObjectStreams) findings.tooManyObjectStreams = true;
      else {
        findings.objectStreams.push({
          start, end,
          filters: state.filters,
          unsupported: state.filterInvalid || state.filterState !== 0 || state.decodeParmsIndirect || state.predictor,
        });
      }
    }
    i = next;
    resetObject();
  };

  while (i < length) {
    const c = buf[i];
    const cls = CLASS[c];
    if (cls === 1) { i += 1; continue; }
    if (c === 0x25) { // % comment to end of line
      const commentStart = i + 1;
      while (i < length && buf[i] !== 0x0a && buf[i] !== 0x0d) i += 1;
      if (raw) assertNoHiddenStructure(buf, commentStart, i);
      continue;
    }
    if (c === 0x2f) { // name
      const start = i + 1;
      i = start;
      while (i < length && CLASS[buf[i]] === 0) i += 1;
      onName(decodeName(buf, start, i));
      continue;
    }
    prevName = null;
    if (c === 0x28) { // literal string
      let depth = 1;
      i += 1;
      const stringStart = i;
      while (i < length) {
        const s = buf[i];
        if (s === 0x5c) { i += 2; continue; }
        if (s === 0x28) depth += 1;
        else if (s === 0x29 && (depth -= 1) === 0) break;
        i += 1;
      }
      if (i >= length) fail('PDF_STRUCTURE_INVALID', 'The PDF has an unterminated string.');
      if (raw) assertNoHiddenStructure(buf, stringStart, i);
      i += 1;
      if (raw) onValueToken('string');
      continue;
    }
    if (c === 0x3c) {
      if (buf[i + 1] === 0x3c) {
        i += 2;
        if (raw) { onValueToken('<<'); state.dictDepth += 1; }
        continue;
      }
      i += 1; // hex string
      while (i < length && (HEX[buf[i]] >= 0 || CLASS[buf[i]] === 1)) i += 1;
      if (buf[i] === 0x3e) i += 1;
      if (raw) onValueToken('string');
      continue;
    }
    if (c === 0x3e) {
      if (buf[i + 1] === 0x3e) {
        i += 2;
        if (raw) { onValueToken('>>'); if (state.dictDepth > 0) state.dictDepth -= 1; }
      } else i += 1;
      continue;
    }
    if (cls === 2) { // [ ] { } and stray )
      i += 1;
      if (raw) onValueToken(c === 0x5b ? '[' : c === 0x5d ? ']' : 'delim');
      continue;
    }
    // Regular token: number or keyword.
    const start = i;
    while (i < length && CLASS[buf[i]] === 0) i += 1;
    if (!raw) continue;
    const intValue = parseInteger(buf, start, i);
    if (intValue !== null) {
      onValueToken('int', intValue);
      num1 = num2;
      num2 = intValue;
      continue;
    }
    const keyword = i - start <= MAX_KEYWORD_BYTES ? buf.toString('latin1', start, i) : '';
    onValueToken('keyword', keyword);
    if (keyword === 'obj') {
      objectNumber = num1;
      resetObject();
    } else if (keyword === 'endobj') {
      objectNumber = null;
      resetObject();
    } else if (keyword === 'stream') {
      skipStream();
    } else if (keyword === 'trailer' || keyword === 'xref' || keyword === 'startxref') {
      objectNumber = null;
      resetObject();
      if (keyword === 'trailer') state.dictDepth = 0;
    }
    num1 = null;
    num2 = null;
  }
}

function inflateObjectStream(buf, stream, limits, findings) {
  const filters = stream.filters ?? [];
  if (stream.unsupported || filters.length > 1 || (filters.length === 1 && filters[0] !== 'FlateDecode')) {
    fail('PDF_UNSUPPORTED_ENCODING', 'The PDF uses an unsupported object stream encoding.');
  }
  const data = buf.subarray(stream.start, stream.end);
  if (filters.length === 0) return data;
  const allowed = Math.min(limits.maxStreamInflatedBytes, limits.maxTotalInflatedBytes - findings.inflatedBytes);
  if (allowed <= 0) fail('PDF_RESOURCE_LIMIT', 'The PDF exceeds the decompression limit.');
  let output;
  try {
    output = inflateSync(data, { maxOutputLength: allowed });
  } catch (error) {
    if (error?.code === 'ERR_BUFFER_TOO_LARGE') fail('PDF_RESOURCE_LIMIT', 'The PDF exceeds the decompression limit.');
    fail('PDF_STRUCTURE_INVALID', 'The PDF has an unreadable object stream.');
  }
  if (output.length > allowed) fail('PDF_RESOURCE_LIMIT', 'The PDF exceeds the decompression limit.');
  findings.inflatedBytes += output.length;
  return output;
}

export function inspectPdf(bytes, limits = PDF_INSPECTION_LIMITS) {
  const resolved = resolveLimits(limits);
  const buf = toBuffer(bytes);
  const pdfVersion = readHeaderVersion(buf);
  if (!pdfVersion) fail('PDF_STRUCTURE_INVALID', 'The file does not have a valid PDF header.');
  if (buf.subarray(Math.max(0, buf.length - EOF_WINDOW)).indexOf(EOF_MARKER) < 0) {
    fail('PDF_STRUCTURE_INVALID', 'The PDF is missing its end-of-file marker.');
  }

  const findings = {
    active: false,
    encrypted: false,
    pages: 0,
    pageObjects: new Set(),
    objectStreamCount: 0,
    tooManyObjectStreams: false,
    objectStreams: [],
    inflatedBytes: 0,
  };

  scan(buf, 'raw', findings, resolved);
  if (findings.encrypted) fail('PDF_PASSWORD_REQUIRED', 'The PDF is password protected.');
  if (findings.active) fail('PDF_ACTIVE_CONTENT', 'The PDF contains active or embedded content.');
  if (findings.tooManyObjectStreams) fail('PDF_RESOURCE_LIMIT', 'The PDF has too many object streams.');
  if (findings.pages > resolved.maxPages) fail('PDF_PAGE_LIMIT', 'The PDF has too many pages.');

  for (const stream of findings.objectStreams) {
    const content = inflateObjectStream(buf, stream, resolved, findings);
    scan(content, 'objstm', findings, resolved);
    if (findings.encrypted) fail('PDF_PASSWORD_REQUIRED', 'The PDF is password protected.');
    if (findings.active) fail('PDF_ACTIVE_CONTENT', 'The PDF contains active or embedded content.');
    if (findings.pages > resolved.maxPages) fail('PDF_PAGE_LIMIT', 'The PDF has too many pages.');
  }

  if (findings.pages === 0) fail('PDF_STRUCTURE_INVALID', 'The PDF has no pages.');
  return Object.freeze({ pageCount: findings.pages, objectStreamCount: findings.objectStreamCount, pdfVersion });
}
