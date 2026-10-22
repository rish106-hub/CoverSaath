// Evidence checks for a curated insurer wording. Pure: bytes and text in, codes out. No network, no clock.
//
// What this proves: the archived bytes hash to the recorded digest, and (when page text is supplied) the printed UIN, the
// wording version and every quoted passage appear in that text. What it does not prove: that the page text was extracted
// faithfully from the PDF. The curated repository passes only text derived from the archived bytes by the PDF text
// extractor (ADR 0010); a human checker must still read the real source, since a file's own font maps could misstate text. A check that cannot be made is reported as a human-review item, never as a pass.
import { extractUins, sha256Hex } from './curated-products.js';

const SHA256 = /^[0-9a-f]{64}$/;
export const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_PAGES = 600;
const MAX_PAGE_CHARS = 200_000;

// Whitespace and case are layout noise in extracted text; everything else must match.
const squash = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

/** Page text is optional, but when present it must be a bounded array of strings. */
export function normalisePageTexts(pageTexts) {
  if (pageTexts == null) return null;
  if (!Array.isArray(pageTexts) || pageTexts.length < 1 || pageTexts.length > MAX_PAGES
    || pageTexts.some(page => typeof page !== 'string' || page.length > MAX_PAGE_CHARS)) return undefined;
  return pageTexts;
}

/**
 * @param record { uin, wordingVersion, contentSha256 }
 * @param bytes the exact archived source bytes
 * @param pageTexts one string per page, or null when no text was supplied
 * @param facts optional [{ page, quote }] to check against the page text
 * @returns { blocking: string[], humanReview: string[], computedSha256 } — `blocking` empty means no machine check failed;
 *          it never means the wording is correct.
 */
export function verifySourceEvidence({ record, bytes, pageTexts = null, facts = [] }) {
  const blocking = [];
  const humanReview = [];
  const isBuffer = bytes instanceof Uint8Array;
  const computedSha256 = isBuffer && bytes.length > 0 && bytes.length <= MAX_SOURCE_BYTES ? sha256Hex(bytes) : null;
  if (!computedSha256) blocking.push('source_bytes_invalid');
  if (isBuffer && computedSha256 && !(bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d)) blocking.push('not_a_pdf');
  if (typeof record?.contentSha256 !== 'string' || !SHA256.test(record.contentSha256)) blocking.push('digest_malformed');
  else if (computedSha256 && computedSha256 !== record.contentSha256) blocking.push('digest_mismatch');

  const pages = normalisePageTexts(pageTexts);
  if (pages === undefined) { blocking.push('page_text_invalid'); return { blocking, humanReview, computedSha256 }; }
  if (pages === null) {
    humanReview.push('page_text_unavailable', 'uin_not_machine_checked', 'wording_version_not_machine_checked');
    if (facts.length) humanReview.push('quotes_not_machine_checked');
    return { blocking, humanReview, computedSha256 };
  }
  const all = pages.join('\n');
  const printed = extractUins(all);
  if (printed.length === 0) blocking.push('uin_not_printed');
  else if (printed.length > 1) blocking.push('several_uins');
  else if (printed[0] !== record.uin) blocking.push('uin_mismatch');
  if (!squash(record.wordingVersion) || !squash(all).includes(squash(record.wordingVersion))) blocking.push('wording_version_not_printed');
  facts.forEach((fact, i) => {
    if (!Number.isSafeInteger(fact?.page) || fact.page < 1 || fact.page > pages.length) blocking.push(`page_out_of_range:${i}`);
    else if (typeof fact.quote !== 'string' || squash(fact.quote).length < 8 || !squash(pages[fact.page - 1]).includes(squash(fact.quote))) blocking.push(`quote_not_on_page:${i}`);
  });
  return { blocking, humanReview, computedSha256 };
}
