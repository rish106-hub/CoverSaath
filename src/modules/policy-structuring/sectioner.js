// Deterministic sectioner: Sarvam block pages -> page-bounded chunks for structuring. Never calls a provider.
// Every block is either dropped (with a reason) or lands in exactly one chunk, or in several parts of one chunk.
import { tableRows } from '../ai-analysis/eval-extractor.js';

export const STRUCTURING_DROPPED_TAGS = Object.freeze({
  header: 'boilerplate', footer: 'boilerplate', 'page-number': 'boilerplate',
  image: 'model_description', 'image-caption': 'model_description',
});
const TITLE_TAGS = new Set(['section-title', 'headline']);
const MIN_CHUNK_CHARS = 200;
const MAX_CHUNK_CHARS = 100_000;

function fail(code, message) { throw Object.assign(new Error(message), { code }); }
const invalid = message => fail('STRUCTURING_INPUT_INVALID', message);

function validate(pages, maxChunkChars) {
  if (!Number.isInteger(maxChunkChars) || maxChunkChars < MIN_CHUNK_CHARS || maxChunkChars > MAX_CHUNK_CHARS) invalid('maxChunkChars is out of range.');
  if (!Array.isArray(pages)) invalid('Pages must be an array.');
  const seen = new Set();
  for (const page of pages) {
    if (!page || typeof page !== 'object' || !Number.isInteger(page.page) || page.page < 1) invalid('Each page needs a 1-based integer page number.');
    if (seen.has(page.page)) invalid('Page numbers must be unique.');
    seen.add(page.page);
    if (!Array.isArray(page.blocks)) invalid('Each page needs a blocks array.');
    for (const block of page.blocks) {
      if (!block || typeof block !== 'object' || typeof block.text !== 'string') invalid('Each block needs string text.');
      if (block.tag != null && typeof block.tag !== 'string') invalid('Block tag must be a string or null.');
    }
  }
}

// Packs lines into parts no longer than max; a single overlong line is hard cut.
function pack(lines, max) {
  const parts = [];
  let current = '';
  for (const line of lines) {
    for (let at = 0; at < Math.max(line.length, 1); at += max) {
      const piece = line.slice(at, at + max);
      if (current && current.length + 1 + piece.length > max) { parts.push(current); current = ''; }
      current = current ? `${current}\n${piece}` : piece;
    }
  }
  if (current) parts.push(current);
  return parts;
}

const partId = (base, index) => (index === 0 ? base : `${base}-part${index + 1}`);

function tableText(text) {
  const rows = tableRows(text).map(row => row.join(' | ')).filter(row => row.replace(/[\s|]/g, ''));
  return rows.length ? rows : text.replace(/<[^>]+>/g, ' ').split('\n').map(line => line.trim()).filter(Boolean);
}

export function sectionDocument(pages, { maxChunkChars = 4000 } = {}) {
  validate(pages, maxChunkChars);
  const chunks = [];
  const dropped = [];
  let title = null;
  for (const { page, blocks } of pages) {
    let group = null;
    const flush = () => {
      if (group) chunks.push({ id: `p${page}-b${group.blockIndexes[0]}`, page, blockIndexes: group.blockIndexes, kind: 'text', title: group.title, text: group.lines.join('\n') });
      group = null;
    };
    const pushParts = (blockIndex, kind, parts) => parts.forEach((text, index) => chunks.push({ id: partId(`p${page}-b${blockIndex}`, index), page, blockIndexes: [blockIndex], kind, title, text }));
    for (const [blockIndex, block] of blocks.entries()) {
      const tag = block.tag ?? null;
      if (tag && Object.hasOwn(STRUCTURING_DROPPED_TAGS, tag)) { dropped.push({ page, blockIndex, tag, reason: STRUCTURING_DROPPED_TAGS[tag] }); continue; }
      if (tag === 'table') {
        const rows = tableText(block.text);
        if (!rows.length) { dropped.push({ page, blockIndex, tag, reason: 'empty' }); continue; }
        flush();
        // Each part of a split table repeats the first row, so its header reaches the privacy gate with it.
        const whole = pack(rows, maxChunkChars);
        const header = rows[0];
        const repeat = whole.length > 1 && rows.length > 1 && header.length * 2 < maxChunkChars;
        pushParts(blockIndex, 'table', repeat ? pack(rows.slice(1), maxChunkChars - header.length - 1).map(part => `${header}\n${part}`) : whole);
        continue;
      }
      const text = block.text.trim();
      if (!text) { dropped.push({ page, blockIndex, tag, reason: 'empty' }); continue; }
      if (TITLE_TAGS.has(tag)) { flush(); title = text.replace(/\s+/g, ' ').slice(0, 200); }
      if (text.length > maxChunkChars) {
        flush();
        pushParts(blockIndex, 'text', pack(text.split('\n'), maxChunkChars));
        continue;
      }
      const size = group ? group.lines.reduce((sum, line) => sum + line.length + 1, 0) + text.length : 0;
      if (group && size > maxChunkChars) flush();
      group ??= { blockIndexes: [], lines: [], title };
      group.blockIndexes.push(blockIndex);
      group.lines.push(text);
    }
    flush();
  }
  return Object.freeze({
    chunks: Object.freeze(chunks.map(chunk => Object.freeze({ ...chunk, blockIndexes: Object.freeze(chunk.blockIndexes) }))),
    dropped: Object.freeze(dropped.map(Object.freeze)),
  });
}
