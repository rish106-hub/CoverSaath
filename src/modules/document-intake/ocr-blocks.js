// Stored OCR block contract (knowvia.ocr.v2, ADR 0006 addendum). A page's layout blocks are kept with
// the page so the policy sectioner can read tables, layout tags and block indices back after save.
// Block text is untrusted document evidence. No provider payload, coordinates or model-written image
// descriptions are stored: blocks whose tag the sectioner drops as `model_description` keep their
// index and tag but lose their text, so stored block indices still match the provider reading order.
import { DocumentIntakeError } from './contracts.js';
import { tableRows } from '../ai-analysis/eval-extractor.js';
import { STRUCTURING_DROPPED_TAGS } from '../policy-structuring/sectioner.js';

export const OCR_BLOCKS_VERSION = 'knowvia.ocr.v2';

// Sarvam Document AI section types (docs.sarvam.ai digitise guide). Anything else fails closed.
export const OCR_BLOCK_TAGS = Object.freeze([
  'headline', 'sub-headline', 'section-title', 'header', 'paragraph', 'footer', 'footnote', 'page-number',
  'table', 'image', 'image-caption', 'photograph', 'chart', 'diagram', 'advertisement', 'folio',
]);

export const OCR_BLOCK_LIMITS = Object.freeze({
  maxBlocksPerPage: 2_000,
  maxBlockTextCharacters: 200_000,
  maxTableRows: 2_000,
  maxTableCells: 20_000,
  // Must equal the blocks_json length CHECK in SQLite 012 and PostgreSQL 009.
  maxStoredCharacters: 1_000_000,
});

export const OCR_MODEL_DESCRIPTION_TAGS = Object.freeze(Object.entries(STRUCTURING_DROPPED_TAGS)
  .filter(([, reason]) => reason === 'model_description').map(([tag]) => tag));

const KNOWN_TAGS = new Set(OCR_BLOCK_TAGS);
const DESCRIPTION_TAGS = new Set(OCR_MODEL_DESCRIPTION_TAGS);
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = message => { throw new DocumentIntakeError('OCR_BLOCKS_INVALID', message); };

function checkTag(tag, where) {
  if (tag !== null && !(typeof tag === 'string' && KNOWN_TAGS.has(tag))) invalid(`${where} has an unknown layout tag.`);
}

function checkText(text, where) {
  if (typeof text !== 'string' || text.length > OCR_BLOCK_LIMITS.maxBlockTextCharacters) invalid(`${where} text is missing or too long.`);
}

function checkOrder(readingOrder, previous, where) {
  if (typeof readingOrder !== 'number' || !Number.isFinite(readingOrder)) invalid(`${where} needs a finite reading order.`);
  if (previous !== null && readingOrder < previous) invalid(`${where} is out of reading order.`);
}

function rowsFor(text) {
  const rows = tableRows(text);
  if (rows.length > OCR_BLOCK_LIMITS.maxTableRows || rows.reduce((sum, row) => sum + row.length, 0) > OCR_BLOCK_LIMITS.maxTableCells) {
    invalid('Table block has too many rows or cells.');
  }
  return rows;
}

const freezeBlock = block => Object.freeze({
  ...block, ...(block.rows ? { rows: Object.freeze(block.rows.map(row => Object.freeze([...row]))) } : {}),
});

/**
 * Normalised provider blocks ([{ text, tag, readingOrder }] in reading order) -> stored blocks.
 * pageText is the page text the provider built; the blocks must rebuild it exactly, so a missing,
 * extra or reordered block fails closed.
 */
export function buildStoredBlocks(blocks, pageText, where = 'page') {
  if (!Array.isArray(blocks) || blocks.length > OCR_BLOCK_LIMITS.maxBlocksPerPage) invalid(`${where} blocks must be a bounded array.`);
  let previous = null;
  const stored = blocks.map((block, index) => {
    const at = `${where} block ${index}`;
    if (!plainObject(block)) invalid(`${at} must be an object.`);
    const tag = block.tag ?? null;
    checkTag(tag, at);
    checkText(block.text, at);
    checkOrder(block.readingOrder, previous, at);
    previous = block.readingOrder;
    if (DESCRIPTION_TAGS.has(tag)) return { index, tag, readingOrder: block.readingOrder, text: '', textOmitted: 'model_description' };
    return { index, tag, readingOrder: block.readingOrder, text: block.text, ...(tag === 'table' ? { rows: rowsFor(block.text) } : {}) };
  });
  if (typeof pageText !== 'string' || blocks.map(block => block.text).join('\n') !== pageText) {
    invalid(`${where} blocks do not rebuild the page text.`);
  }
  return Object.freeze(stored.map(freezeBlock));
}

const BLOCK_KEYS = new Set(['index', 'tag', 'readingOrder', 'text', 'rows', 'textOmitted']);

function sameRows(left, right) {
  return Array.isArray(left) && left.length === right.length && left.every((row, index) => Array.isArray(row)
    && row.length === right[index].length && row.every((cell, cellIndex) => cell === right[index][cellIndex]));
}

/**
 * Blocks of an OCR output page: provider blocks are converted with buildStoredBlocks; blocks that are
 * already in stored form (re-validation of a validated output) get the strict stored check.
 */
export function normalizeOutputBlocks(blocks, pageText, pageNumber, where = 'page') {
  if (Array.isArray(blocks) && blocks.length > 0 && blocks.every(block => plainObject(block) && 'index' in block)) {
    return validateStoredBlocks({ version: OCR_BLOCKS_VERSION, page: pageNumber, blocks }, pageNumber);
  }
  return buildStoredBlocks(blocks, pageText, where);
}

/** Strict check of a stored blocks document, used before every write and after every read. */
export function validateStoredBlocks(value, pageNumber) {
  if (!plainObject(value) || Object.keys(value).sort().join() !== 'blocks,page,version') invalid('Stored blocks have an invalid envelope.');
  if (value.version !== OCR_BLOCKS_VERSION) invalid(`Stored blocks must use ${OCR_BLOCKS_VERSION}.`);
  if (!Number.isInteger(pageNumber) || value.page !== pageNumber) invalid('Stored blocks do not match their page.');
  if (!Array.isArray(value.blocks) || value.blocks.length > OCR_BLOCK_LIMITS.maxBlocksPerPage) invalid('Stored blocks must be a bounded array.');
  let previous = null;
  const blocks = value.blocks.map((block, position) => {
    const at = `page ${pageNumber} block ${position}`;
    if (!plainObject(block) || Object.keys(block).some(key => !BLOCK_KEYS.has(key))) invalid(`${at} has unexpected fields.`);
    if (block.index !== position) invalid(`${at} is missing, duplicated or reordered.`);
    if (block.tag !== null) checkTag(block.tag, at);
    checkText(block.text, at);
    checkOrder(block.readingOrder, previous, at);
    previous = block.readingOrder;
    if (DESCRIPTION_TAGS.has(block.tag)) {
      if (block.text !== '' || block.textOmitted !== 'model_description' || 'rows' in block) invalid(`${at} must not keep model-written text.`);
      return { index: position, tag: block.tag, readingOrder: block.readingOrder, text: '', textOmitted: 'model_description' };
    }
    if ('textOmitted' in block) invalid(`${at} cannot omit document text.`);
    if (block.tag === 'table') {
      const rows = rowsFor(block.text);
      if (!sameRows(block.rows, rows)) invalid(`${at} table rows do not match the table text.`);
      return { index: position, tag: block.tag, readingOrder: block.readingOrder, text: block.text, rows };
    }
    if ('rows' in block) invalid(`${at} has rows but is not a table.`);
    return { index: position, tag: block.tag, readingOrder: block.readingOrder, text: block.text };
  });
  return Object.freeze(blocks.map(freezeBlock));
}

/** Serialises a page's stored blocks for source_pages.blocks_json, validating first. */
export function serializeStoredBlocks(pageNumber, blocks) {
  const envelope = { version: OCR_BLOCKS_VERSION, page: pageNumber, blocks };
  validateStoredBlocks(envelope, pageNumber);
  const json = JSON.stringify(envelope);
  if (json.length > OCR_BLOCK_LIMITS.maxStoredCharacters) invalid('Stored blocks exceed the size limit.');
  return json;
}

/** Parses and validates source_pages.blocks_json. Malformed or tampered rows fail closed. */
export function parseStoredBlocks(json, pageNumber) {
  if (typeof json !== 'string' || json.length > OCR_BLOCK_LIMITS.maxStoredCharacters) invalid('Stored blocks are missing or too large.');
  let value;
  try { value = JSON.parse(json); } catch { invalid('Stored blocks are not valid JSON.'); }
  return validateStoredBlocks(value, pageNumber);
}
