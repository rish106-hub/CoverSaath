// Page text derived from a PDF's own bytes: content-stream text operators decoded through each font's ToUnicode map or a
// known simple encoding. Runs inside the permission-restricted child (pdf-text-child.mjs); never on the main process.
//
// Fail closed. A page is `established` only when every glyph shown on it decodes to Unicode through a mapping the file
// itself declares (ToUnicode) or a standard single-byte encoding. An unsupported font, an unmapped glyph, an unreadable or
// filtered stream we cannot decode, an encrypted file or any limit breach makes that page `unestablished` with a reason code.
// Nothing is guessed, OCR'd or inferred. Image-only pages are unestablished (`no_text`). Invisible text (rendering mode 3
// or 7, the usual OCR layer of a scanned page) and optional-content sections fail the page, and so does malformed content
// (an unterminated string, an operator inside an open array or dictionary, an unbalanced bracket): text that a viewer may
// or may not show is never evidence. Residual: text drawn off the page box or in the background colour is not detected. Text layout is approximate: lines
// follow text-positioning operators, so callers compare text with whitespace normalised.
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef, decodePDFRawStream } from 'pdf-lib';

export const PDF_TEXT_EXTRACTOR_VERSION = 'pdf-content-text/v1';
export const PDF_TEXT_LIMITS = Object.freeze({
  maxPages: 600,
  maxPageChars: 200_000,
  maxStreamBytes: 8 * 1024 * 1024,
  maxTotalStreamBytes: 96 * 1024 * 1024,
  maxOperators: 2_000_000,
  maxFormDepth: 3,
});

class PageFailure extends Error { constructor(reason) { super(reason); this.reason = reason; } }
const failPage = reason => { throw new PageFailure(reason); };

// ---- Content stream tokenizer ----------------------------------------------------------------------------------------------

const WS = new Uint8Array(256);
for (const c of [0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]) WS[c] = 1;
const DELIM = new Uint8Array(256);
for (const c of '()<>[]{}/%') DELIM[c.charCodeAt(0)] = 1;
const HEXV = new Int8Array(256).fill(-1);
for (let i = 0; i < 10; i += 1) HEXV[0x30 + i] = i;
for (let i = 0; i < 6; i += 1) { HEXV[0x41 + i] = 10 + i; HEXV[0x61 + i] = 10 + i; }

// Yields { op, operands } with operands as: { t: 'str', bytes } | { t: 'num', v } | { t: 'name', v } | { t: 'arr', v: [...] } | { t: 'other' }.
function* operations(buf, limits) {
  let i = 0;
  let operands = [];
  const stack = [];
  let count = 0;
  const push = value => { (stack.length ? stack[stack.length - 1] : operands).push(value); };
  while (i < buf.length) {
    const c = buf[i];
    if (WS[c]) { i += 1; continue; }
    if (c === 0x25) { while (i < buf.length && buf[i] !== 0x0a && buf[i] !== 0x0d) i += 1; continue; }
    if (c === 0x28) { // literal string
      const out = [];
      let depth = 1; i += 1;
      while (i < buf.length && depth > 0) {
        const b = buf[i];
        if (b === 0x5c) {
          const n = buf[i + 1];
          if (n === undefined) break;
          const map = { 0x6e: 0x0a, 0x72: 0x0d, 0x74: 0x09, 0x62: 0x08, 0x66: 0x0c, 0x28: 0x28, 0x29: 0x29, 0x5c: 0x5c };
          if (map[n] !== undefined) { out.push(map[n]); i += 2; continue; }
          if (n >= 0x30 && n <= 0x37) {
            let v = 0; let k = 0;
            while (k < 3 && buf[i + 1 + k] >= 0x30 && buf[i + 1 + k] <= 0x37) { v = v * 8 + (buf[i + 1 + k] - 0x30); k += 1; }
            out.push(v & 0xff); i += 1 + k; continue;
          }
          if (n === 0x0d) { i += buf[i + 2] === 0x0a ? 3 : 2; continue; }
          if (n === 0x0a) { i += 2; continue; }
          out.push(n); i += 2; continue;
        }
        if (b === 0x28) depth += 1;
        if (b === 0x29) { depth -= 1; if (depth === 0) { i += 1; break; } }
        out.push(b); i += 1;
      }
      if (depth !== 0) failPage('content_malformed');
      push({ t: 'str', bytes: Uint8Array.from(out) });
      continue;
    }
    if (c === 0x3c && buf[i + 1] === 0x3c) { stack.push([]); i += 2; continue; } // dict operand (marked content): kept opaque
    if (c === 0x3e && buf[i + 1] === 0x3e) { if (!stack.length) failPage('content_malformed'); stack.pop(); if (!stack.length) operands.push({ t: 'other' }); else stack[stack.length - 1].push({ t: 'other' }); i += 2; continue; }
    if (c === 0x3c) { // hex string
      const nibbles = []; i += 1;
      while (i < buf.length && buf[i] !== 0x3e) { if (HEXV[buf[i]] >= 0) nibbles.push(HEXV[buf[i]]); else if (!WS[buf[i]]) failPage('content_malformed'); i += 1; }
      if (i >= buf.length) failPage('content_malformed');
      i += 1;
      if (nibbles.length % 2) nibbles.push(0);
      const bytes = new Uint8Array(nibbles.length / 2);
      for (let k = 0; k < bytes.length; k += 1) bytes[k] = nibbles[2 * k] * 16 + nibbles[2 * k + 1];
      push({ t: 'str', bytes });
      continue;
    }
    if (c === 0x5b) { stack.push([]); i += 1; continue; }
    if (c === 0x5d) { if (!stack.length) failPage('content_malformed'); const arr = stack.pop(); push({ t: 'arr', v: arr }); i += 1; continue; }
    if (c === 0x2f) { let j = i + 1; while (j < buf.length && !WS[buf[j]] && !DELIM[buf[j]]) j += 1; push({ t: 'name', v: Buffer.from(buf.subarray(i + 1, j)).toString('latin1') }); i = j; continue; }
    if (c === 0x7b || c === 0x7d || c === 0x29 || c === 0x3e) { i += 1; continue; }
    let j = i;
    while (j < buf.length && !WS[buf[j]] && !DELIM[buf[j]]) j += 1;
    const word = Buffer.from(buf.subarray(i, j)).toString('latin1');
    i = j;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) { push({ t: 'num', v: Number(word) }); continue; }
    // An operator keyword (anything but true/false/null) inside an open array or dictionary is malformed content.
    if (stack.length) { if (!['true', 'false', 'null'].includes(word)) failPage('content_malformed'); stack[stack.length - 1].push({ t: 'other' }); continue; }
    if (word === 'BI') { // inline image: skip to the EI that ends its data
      let k = i;
      while (k < buf.length && !(buf[k - 1] !== undefined && WS[buf[k - 1]] && buf[k] === 0x49 && buf[k + 1] === 0x44 && (WS[buf[k + 2]] ?? 1))) k += 1;
      k += 3;
      while (k < buf.length && !(WS[buf[k - 1]] && buf[k] === 0x45 && buf[k + 1] === 0x49 && (k + 2 >= buf.length || WS[buf[k + 2]] || DELIM[buf[k + 2]]))) k += 1;
      i = k + 2; operands = []; continue;
    }
    count += 1;
    if (count > limits.maxOperators) failPage('content_too_large');
    yield { op: word, operands };
    operands = [];
  }
  if (stack.length) failPage('content_malformed');
}

// ---- Fonts -----------------------------------------------------------------------------------------------------------------

const GLYPH_NAMES = (() => {
  const map = new Map([
    ['space', ' '], ['exclam', '!'], ['quotedbl', '"'], ['numbersign', '#'], ['dollar', '$'], ['percent', '%'], ['ampersand', '&'],
    ['quotesingle', "'"], ['quoteright', '’'], ['quoteleft', '‘'], ['parenleft', '('], ['parenright', ')'], ['asterisk', '*'],
    ['plus', '+'], ['comma', ','], ['hyphen', '-'], ['minus', '−'], ['period', '.'], ['slash', '/'], ['colon', ':'], ['semicolon', ';'],
    ['less', '<'], ['equal', '='], ['greater', '>'], ['question', '?'], ['at', '@'], ['bracketleft', '['], ['backslash', '\\'],
    ['bracketright', ']'], ['asciicircum', '^'], ['underscore', '_'], ['grave', '`'], ['braceleft', '{'], ['bar', '|'], ['braceright', '}'],
    ['asciitilde', '~'], ['bullet', '•'], ['endash', '–'], ['emdash', '—'], ['quotedblleft', '“'], ['quotedblright', '”'],
    ['rupee', '₹'], ['fi', 'fi'], ['fl', 'fl'], ['degree', '°'], ['section', '§'], ['paragraph', '¶'], ['ellipsis', '…'],
  ]);
  ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'].forEach((name, d) => map.set(name, String(d)));
  for (let k = 0; k < 26; k += 1) { map.set(String.fromCharCode(97 + k), String.fromCharCode(97 + k)); map.set(String.fromCharCode(65 + k), String.fromCharCode(65 + k)); }
  return map;
})();

function glyphToUnicode(name) {
  if (GLYPH_NAMES.has(name)) return GLYPH_NAMES.get(name);
  const uni = /^uni([0-9A-F]{4})$/.exec(name);
  if (uni) return String.fromCharCode(parseInt(uni[1], 16));
  return null;
}

const WIN_ANSI = new TextDecoder('windows-1252');
const MAC_ROMAN = new TextDecoder('macintosh');
const NON_SYMBOLIC_STANDARD = new Set(['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique', 'Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic', 'Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique']);

function hexToBytes(hex) { return Uint8Array.from(hex.match(/../g) ?? [], h => parseInt(h, 16)); }

/** ToUnicode CMap: codespace lengths plus bfchar/bfrange entries. Returns null on anything it does not understand. */
function parseToUnicode(bytes) {
  const text = Buffer.from(bytes).toString('latin1');
  const lengths = new Set();
  const map = new Map();
  const utf16 = hex => { const b = hexToBytes(hex); let s = ''; for (let k = 0; k + 1 < b.length; k += 2) s += String.fromCharCode((b[k] << 8) | b[k + 1]); return s; };
  for (const block of text.matchAll(/begincodespacerange([\s\S]*?)endcodespacerange/g)) {
    for (const m of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) lengths.add(m[1].length / 2);
  }
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g)) map.set(m[1].toLowerCase(), utf16(m[2]));
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<([0-9A-Fa-f]+)>|\[([^\]]*)\])/g)) {
      const width = m[1].length;
      const lo = parseInt(m[1], 16); const hi = parseInt(m[2], 16);
      if (!(hi >= lo) || hi - lo > 65_535) return null;
      const list = m[5] !== undefined ? [...m[5].matchAll(/<([0-9A-Fa-f]*)>/g)].map(x => x[1]) : null;
      for (let code = lo; code <= hi; code += 1) {
        const key = code.toString(16).padStart(width, '0');
        if (list) { if (list[code - lo] === undefined) return null; map.set(key, utf16(list[code - lo])); continue; }
        const base = hexToBytes(m[4]);
        const last = (base[base.length - 2] << 8 | base[base.length - 1]) + (code - lo);
        const head = utf16(m[4]).slice(0, -1);
        map.set(key, head + String.fromCharCode(last & 0xffff));
      }
    }
  }
  // A code mapped to nothing would silently delete a glyph; it reads as unmapped instead.
  for (const [key, value] of map) if (!value) map.delete(key);
  if (!map.size) return null;
  if (!lengths.size) for (const key of map.keys()) lengths.add(key.length / 2);
  return { lengths: [...lengths].sort((a, b) => b - a), map };
}

function lookup(dict, key, type) { try { return dict.lookupMaybe(PDFName.of(key), type); } catch { return undefined; } }

function streamBytes(stream, budget, limits) {
  if (!(stream instanceof PDFRawStream)) failPage('stream_unsupported');
  let out;
  try { out = decodePDFRawStream(stream).decode(); } catch { failPage('stream_filter_unsupported'); }
  if (out.length > limits.maxStreamBytes) failPage('content_too_large');
  budget.total += out.length;
  if (budget.total > limits.maxTotalStreamBytes) failPage('content_too_large');
  return out;
}

function buildFont(fontDict, budget, limits) {
  const subtype = lookup(fontDict, 'Subtype', PDFName)?.decodeText();
  const toUnicode = fontDict.lookup(PDFName.of('ToUnicode'));
  if (toUnicode instanceof PDFRawStream) {
    const cmap = parseToUnicode(streamBytes(toUnicode, budget, limits));
    if (!cmap) failPage('font_tounicode_unreadable');
    return bytes => {
      let s = '';
      for (let k = 0; k < bytes.length;) {
        let hit = false;
        for (const len of cmap.lengths) {
          if (k + len > bytes.length) continue;
          const key = Buffer.from(bytes.subarray(k, k + len)).toString('hex');
          if (cmap.map.has(key)) { s += cmap.map.get(key); k += len; hit = true; break; }
        }
        if (!hit) failPage('glyph_unmapped');
      }
      return s;
    };
  }
  if (subtype === 'Type0' || subtype === 'Type3') failPage('font_without_unicode_map');
  const baseFont = lookup(fontDict, 'BaseFont', PDFName)?.decodeText() ?? '';
  const encoding = fontDict.lookup(PDFName.of('Encoding'));
  let base = null;
  let differences = new Map();
  const nameOf = value => (value instanceof PDFName ? value.decodeText() : null);
  if (encoding instanceof PDFName) base = nameOf(encoding);
  else if (encoding instanceof PDFDict) {
    base = nameOf(encoding.lookup(PDFName.of('BaseEncoding')));
    const diff = encoding.lookup(PDFName.of('Differences'));
    if (diff instanceof PDFArray) {
      let code = 0;
      for (let k = 0; k < diff.size(); k += 1) {
        const item = diff.lookup(k);
        if (item instanceof PDFNumber) code = item.asNumber();
        else if (item instanceof PDFName) { differences.set(code, item.decodeText()); code += 1; }
      }
    }
  } else if (encoding !== undefined) failPage('font_encoding_unsupported');
  if (!base) {
    // No declared base encoding: only a non-symbolic standard font has a known built-in encoding (StandardEncoding).
    const plain = baseFont.replace(/^[A-Z]{6}\+/, '');
    if (!NON_SYMBOLIC_STANDARD.has(plain)) failPage('font_encoding_unknown');
    base = 'StandardEncoding';
  }
  if (!['WinAnsiEncoding', 'MacRomanEncoding', 'StandardEncoding'].includes(base)) failPage('font_encoding_unsupported');
  return bytes => {
    let s = '';
    for (const b of bytes) {
      if (differences.has(b)) {
        const u = glyphToUnicode(differences.get(b));
        if (u === null) failPage('glyph_unmapped');
        s += u; continue;
      }
      if (b >= 0x20 && b <= 0x7e) {
        if (base === 'StandardEncoding' && b === 0x27) s += '’';
        else if (base === 'StandardEncoding' && b === 0x60) s += '‘';
        else s += String.fromCharCode(b);
        continue;
      }
      // 0x81, 0x8D, 0x8F, 0x90 and 0x9D are undefined in WinAnsiEncoding (TextDecoder maps them to C1 controls).
      if (b >= 0x80 && base === 'WinAnsiEncoding') {
        const u = WIN_ANSI.decode(Uint8Array.of(b));
        if (u === '\ufffd' || (u.charCodeAt(0) >= 0x80 && u.charCodeAt(0) < 0xa0)) failPage('glyph_unmapped');
        s += u; continue;
      }
      if (b >= 0x80 && base === 'MacRomanEncoding') { s += MAC_ROMAN.decode(Uint8Array.of(b)); continue; }
      failPage('glyph_unmapped');
    }
    return s;
  };
}

// ---- Page walk -------------------------------------------------------------------------------------------------------------

function pageText(contentBytes, resources, budget, limits, depth = 0) {
  const lines = [];
  let line = '';
  const fonts = new Map();
  const fontDicts = resources instanceof PDFDict ? lookup(resources, 'Font', PDFDict) : undefined;
  const xobjects = resources instanceof PDFDict ? lookup(resources, 'XObject', PDFDict) : undefined;
  let current = null;
  const states = [];
  const invisible = { mode: false };
  let chars = 0;
  const breakLine = () => { if (line.trim()) lines.push(line.replace(/\s+/g, ' ').trim()); line = ''; };
  const show = bytes => {
    if (!current) failPage('text_without_font');
    if (invisible.mode) failPage('invisible_text');
    const text = current(bytes);
    line += text;
    chars += text.length;
    if (chars > limits.maxPageChars) failPage('page_text_too_large');
  };
  for (const { op, operands } of operations(contentBytes, limits)) {
    switch (op) {
      case 'q': states.push({ current, mode: invisible.mode }); break;
      case 'Q': if (states.length) { const saved = states.pop(); current = saved.current; invisible.mode = saved.mode; } break;
      case 'Tr': { const mode = operands[0]?.v; if (!Number.isInteger(mode) || mode < 0 || mode > 7) failPage('content_malformed'); invisible.mode = mode === 3 || mode === 7; break; }
      case 'BDC': case 'BMC': if (operands[0]?.t === 'name' && operands[0].v === 'OC') failPage('optional_content'); break;
      case 'BT': breakLine(); break;
      case 'ET': breakLine(); break;
      case 'Tf': {
        const name = operands.find(o => o.t === 'name')?.v;
        if (!name) failPage('content_malformed');
        if (!fonts.has(name)) {
          const dict = fontDicts?.lookupMaybe(PDFName.of(name), PDFDict);
          if (!dict) failPage('font_missing');
          fonts.set(name, buildFont(dict, budget, limits));
        }
        current = fonts.get(name);
        break;
      }
      case 'Td': case 'TD': if ((operands[1]?.v ?? 0) !== 0) breakLine(); else line += ' '; break;
      case 'Tm': breakLine(); break;
      case 'T*': breakLine(); break;
      case 'Tj': if (operands[0]?.t === 'str') show(operands[0].bytes); break;
      case "'": case '"': breakLine(); { const str = operands.findLast(o => o.t === 'str'); if (str) show(str.bytes); } break;
      case 'TJ': {
        for (const item of operands[0]?.v ?? []) {
          if (item.t === 'str') show(item.bytes);
          else if (item.t === 'num' && item.v < -250 && !line.endsWith(' ')) line += ' ';
        }
        break;
      }
      case 'Do': {
        const name = operands.find(o => o.t === 'name')?.v;
        const form = name ? xobjects?.lookup(PDFName.of(name)) : undefined;
        if (!(form instanceof PDFRawStream)) break;
        if (lookup(form.dict, 'Subtype', PDFName)?.decodeText() !== 'Form') break; // images carry no text
        if (depth >= limits.maxFormDepth) failPage('form_nesting_too_deep');
        breakLine();
        const inner = pageText(streamBytes(form, budget, limits), lookup(form.dict, 'Resources', PDFDict) ?? resources, budget, limits, depth + 1);
        if (inner) lines.push(inner);
        break;
      }
      default: break;
    }
  }
  breakLine();
  return lines.join('\n');
}

function contentStreams(page) {
  const contents = page.node.Contents();
  if (!contents) return [];
  if (contents instanceof PDFArray) return Array.from({ length: contents.size() }, (_, k) => contents.lookup(k));
  return [contents];
}

/**
 * @returns {{ extractor, status: 'established'|'unestablished', pageCount, pages: Array<{ page, status, text?, reason? }>, reason? }}
 *          `established` only when every page is.
 */
export async function extractPdfPageTexts(bytes, limitsOverride = {}) {
  const limits = { ...PDF_TEXT_LIMITS, ...limitsOverride };
  const result = (status, extra) => ({ extractor: PDF_TEXT_EXTRACTOR_VERSION, status, ...extra });
  let doc;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: false, updateMetadata: false, throwOnInvalidObject: true });
  } catch (error) {
    return result('unestablished', { pageCount: 0, pages: [], reason: /encrypt/i.test(String(error?.message)) ? 'encrypted' : 'unreadable' });
  }
  let pageCount;
  try { pageCount = doc.getPageCount(); } catch { return result('unestablished', { pageCount: 0, pages: [], reason: 'unreadable' }); }
  if (pageCount < 1 || pageCount > limits.maxPages) return result('unestablished', { pageCount, pages: [], reason: 'page_count_out_of_range' });
  const budget = { total: 0 };
  let pageList;
  try { pageList = doc.getPages(); } catch { return result('unestablished', { pageCount: 0, pages: [], reason: 'unreadable' }); }
  const pages = pageList.map((page, index) => {
    try {
      const resources = page.node.Resources();
      const chunks = contentStreams(page).map(stream => {
        const resolved = stream instanceof PDFRef ? doc.context.lookup(stream) : stream;
        return streamBytes(resolved, budget, limits);
      });
      // Separate streams of one page are concatenated with whitespace, as the specification requires.
      const joined = Buffer.concat(chunks.flatMap(chunk => [Buffer.from(chunk), Buffer.from('\n')]));
      const text = pageText(joined, resources, budget, limits);
      if (!text.trim()) return { page: index + 1, status: 'unestablished', reason: 'no_text' };
      return { page: index + 1, status: 'established', text };
    } catch (error) {
      return { page: index + 1, status: 'unestablished', reason: error instanceof PageFailure ? error.reason : 'page_unreadable' };
    }
  });
  return result(pages.every(page => page.status === 'established') ? 'established' : 'unestablished', { pageCount, pages });
}

// Exported for tests of the CMap decoder in isolation; not part of the input feature's public surface.
export { parseToUnicode };
