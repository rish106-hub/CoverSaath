// Deterministic rule extractor for the parse-accuracy eval. It reads Sarvam layout blocks only,
// never sends anything to a provider, and never claims more than extracted_unverified.
// image and image-caption blocks are model-written descriptions, not document text, so they are skipped.

const SKIPPED_TAGS = new Set(['image', 'image-caption']);
const decode = text => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

export function tableRows(html) {
  return [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(row => [...row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)]
    .map(cell => decode(cell[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()));
}

export function flattenBlock(block) {
  return block.tag === 'table' ? tableRows(block.text).map(row => row.join(' | ')).join('\n') : block.text;
}

function* blocksOf(pages) {
  for (const page of pages) {
    for (const [blockIndex, block] of page.blocks.entries()) {
      if (!SKIPPED_TAGS.has(block.tag)) yield { page: page.page, blockIndex, block };
    }
  }
}

// First non-empty cell after a cell whose text matches `label`, across all tables.
function labelled(pages, label, { onPage } = {}) {
  for (const { page, blockIndex, block } of blocksOf(pages)) {
    if (block.tag !== 'table' || (onPage && page !== onPage)) continue;
    for (const row of tableRows(block.text)) {
      const at = row.findIndex(cell => label.test(cell));
      if (at < 0) continue;
      const value = row.slice(at + 1).find(cell => cell);
      if (value) return { value, page, blockIndex };
    }
  }
  return null;
}

function inText(pages, pattern, group = 1) {
  for (const { page, blockIndex, block } of blocksOf(pages)) {
    if (block.tag === 'table') continue;
    const match = pattern.exec(block.text);
    if (match) return { value: match[group].trim(), page, blockIndex };
  }
  return null;
}

function inTables(pages, pattern, group = 1) {
  for (const { page, blockIndex, block } of blocksOf(pages)) {
    if (block.tag !== 'table') continue;
    const match = pattern.exec(flattenBlock(block));
    if (match) return { value: match[group].trim(), page, blockIndex };
  }
  return null;
}

function insuredTable(pages) {
  for (const { page, blockIndex, block } of blocksOf(pages)) {
    if (block.tag !== 'table') continue;
    const rows = tableRows(block.text);
    if (rows[1]?.[0] === "Insured Person's Name" && rows[1]?.[1] === 'Relationship with Policyholder') return { rows, page, blockIndex };
  }
  return null;
}

function premiumNames(pages) {
  for (const { page, blockIndex, block } of blocksOf(pages)) {
    if (block.tag !== 'table') continue;
    const rows = tableRows(block.text);
    if (rows[0]?.[0] === 'Premium Details (₹)' && rows[1]?.[0] === 'Particulars') return { names: rows[1].slice(1), page, blockIndex };
  }
  return null;
}

function sumRow(pages, label) {
  for (const { page, blockIndex, block } of blocksOf(pages)) {
    if (block.tag !== 'table') continue;
    const row = tableRows(block.text).find(cells => label.test(cells[0] ?? ''));
    if (row) return { value: String(row.slice(1).reduce((sum, cell) => sum + Number(cell.replace(/[^\d]/g, '')), 0)), page, blockIndex };
  }
  return null;
}

function period(pages) {
  const cell = labelled(pages, /^Period of Insurance$/i);
  const match = cell && /(\d{2}-\d{2}-\d{4}).*?(\d{2}-\d{2}-\d{4})/.exec(cell.value);
  return match ? { start: match[1], end: match[2], page: cell.page, blockIndex: cell.blockIndex } : null;
}

function periodFromText(pages) {
  const hit = inText(pages, /for the period (\d{2}-\d{2}-\d{4}) to (\d{2}-\d{2}-\d{4})/i, 0);
  const match = hit && /(\d{2}-\d{2}-\d{4}) to (\d{2}-\d{2}-\d{4})/i.exec(hit.value);
  return match ? { start: match[1], end: match[2], page: hit.page, blockIndex: hit.blockIndex } : null;
}

// Each field: primary signal (table cell) and an independent second signal (free text or another table).
// `labels` lets the harness find the quoted block when a field is missing and a page hint exists.
export const FIELD_SPECS = Object.freeze({
  insurer: {
    labels: /insurance company/i,
    primary: pages => inText(pages, /^(.*General Insurance Company Limited)$/im),
    second: pages => inText(pages, /Thank you for choosing (.+?) as your preferred/i),
  },
  plan_name: {
    labels: /Sum Insured\s*[–-]/,
    primary: pages => inTables(pages, /Insured Person's Details and Sum Insured\s*[–-]\s*(.+?)\s*\|?\s*$/m),
    second: pages => inTables(pages, /Plans \| (Optima[^|\n]*)/),
  },
  policy_number: {
    labels: /policy (number|no|reference)/i,
    primary: pages => labelled(pages, /^Policy Number$/i),
    second: pages => inText(pages, /policy reference no (\d+)/i),
  },
  policy_type: { labels: /policy type/i, primary: pages => labelled(pages, /^Policy Type$/i), second: () => null },
  policyholder_name: {
    labels: /policyholder name/i,
    primary: pages => labelled(pages, /^Policyholder Name$/i),
    second: pages => inText(pages, /^Dear (?:MR |MRS |MS )?(.+)$/im),
  },
  insured_members: {
    labels: /insured person'?s? (name|details)/i,
    primary: pages => {
      const table = insuredTable(pages);
      return table && { value: table.rows.slice(2).map(row => row[0]).filter(Boolean), page: table.page, blockIndex: table.blockIndex };
    },
    second: pages => { const hit = premiumNames(pages); return hit && { value: hit.names, page: hit.page, blockIndex: hit.blockIndex }; },
  },
  policy_period_start: {
    labels: /period of insurance/i,
    primary: pages => { const p = period(pages); return p && { value: p.start, page: p.page, blockIndex: p.blockIndex }; },
    second: pages => { const p = periodFromText(pages); return p && { value: p.start, page: p.page, blockIndex: p.blockIndex }; },
  },
  policy_period_end: {
    labels: /period of insurance/i,
    primary: pages => { const p = period(pages); return p && { value: p.end, page: p.page, blockIndex: p.blockIndex }; },
    second: pages => { const p = periodFromText(pages); return p && { value: p.end, page: p.page, blockIndex: p.blockIndex }; },
  },
  base_sum_insured: {
    labels: /sum insured/i,
    primary: pages => labelled(pages, /^Base sum Insured per insured person/i),
    second: pages => { const table = insuredTable(pages); const col = table?.rows[1].indexOf('Base Sum Insured'); return col >= 0 ? { value: table.rows[2][col], page: table.page, blockIndex: table.blockIndex } : null; },
  },
  total_premium: {
    labels: /premium/i,
    primary: pages => inText(pages, /received an amount of\s*₹?\s*([\d,]+)/i),
    second: pages => sumRow(pages, /^Total Premium after discount/i),
  },
  room_rent_limit: { labels: /room rent/i, primary: pages => labelled(pages, /^Room Rent$/i), second: () => null },
  icu_limit: { labels: /\bICU\b/, primary: pages => labelled(pages, /^ICU$/i), second: () => null },
  co_payment: {
    labels: /co-?pay/i,
    primary: pages => inTables(pages, /co-?pay(?:ment)?[^|\n]*\|\s*([^|\n]+)/i) ?? inText(pages, /co-?payment of ([^.\n]+)/i),
    second: () => null,
  },
  initial_waiting_period: {
    labels: /initial waiting/i,
    primary: pages => inTables(pages, /Initial waiting Period \(Code-Excl03\):\s*([^|\n]+?)(?: for all| \|)/i),
    second: () => null,
  },
  specified_disease_waiting_period: {
    labels: /specified disease/i,
    primary: pages => inTables(pages, /Specified Disease\/Procedure waiting period \(Code-Excl02\):\s*([^|\n]+?)\s*\|/i),
    second: () => null,
  },
  ped_waiting_period: {
    labels: /PED wait/i,
    primary: pages => labelled(pages, /^PED wait period applicable from policy inception$/i),
    second: pages => inTables(pages, /Pre-existing diseases waiting period \(Code-Excl01\):\s*([^|\n]+?)\s*\|/i),
  },
  add_ons_opted: {
    labels: /add-?ons?/i,
    primary: pages => {
      for (const { page, blockIndex, block } of blocksOf(pages)) {
        if (block.tag !== 'table') continue;
        const rows = tableRows(block.text);
        if (rows[0]?.[0] !== 'Name of Plan / Add-ons') continue;
        return { value: rows.slice(2).filter(row => row[0] !== 'Base Plan as opted' && row[1] && !/^not opted$/i.test(row[1])).map(row => row[0]), page, blockIndex };
      }
      return null;
    },
    second: () => null,
  },
  exclusions_present: {
    labels: /special conditions/i,
    primary: pages => {
      for (const { page, blockIndex, block } of blocksOf(pages)) {
        if (block.tag !== 'table') continue;
        const rows = tableRows(block.text);
        if (rows[0]?.[0] === 'Special Conditions/ Exclusions') return { value: rows.length > 2 ? 'yes' : 'no', page, blockIndex };
      }
      return null;
    },
    second: pages => inText(pages, /pre-existing medical conditions, waiting period/i, 0) && { value: 'yes', page: 4, blockIndex: -1 },
  },
});

export const FIELD_NAMES = Object.freeze(Object.keys(FIELD_SPECS));

// Normalised equality used by both disagreement detection and scoring.
export function normalizeValue(value) {
  if (Array.isArray(value)) return value.map(normalizeValue).sort().join(';');
  let text = String(value ?? '').toLowerCase().replace(/[₹]|\brs\.?|\binr\b/g, '').replace(/\bltd\b\.?/g, 'limited').replace(/\s+/g, ' ').trim();
  const date = /^(\d{2})-(\d{2})-(\d{4})$/.exec(text);
  if (date) return `${date[3]}-${date[2]}-${date[1]}`;
  text = text.replace(/(\d{1,3}(?:,\d{2,3})+)/g, match => match.replace(/,/g, ''));
  const lakhs = /^(\d+(?:\.\d+)?) lakhs?$/.exec(text);
  if (lakhs) return String(Number(lakhs[1]) * 100000);
  const years = /^(\d+) years?$/.exec(text);
  if (years) return `${Number(years[1]) * 12} months`;
  return text.replace(/^(mr|mrs|ms) /, '');
}

function agrees(field, primary, second) {
  if (field === 'ped_waiting_period') {
    const options = String(second).toLowerCase().replace(/months?/g, '').split('/').map(part => part.trim());
    return options.includes(normalizeValue(primary).replace(' months', ''));
  }
  return normalizeValue(primary) === normalizeValue(second);
}

const empty = value => value == null || value === '';

export function extractFields(pages, names = FIELD_NAMES) {
  const out = {};
  for (const field of names) {
    const spec = FIELD_SPECS[field];
    if (!spec) { out[field] = { value: null, state: 'unknown', page: null, second: null }; continue; }
    const primary = spec.primary(pages);
    const second = spec.second(pages);
    if (empty(primary?.value)) {
      out[field] = { value: null, state: 'unknown', page: null, second: second ? { value: second.value, page: second.page, blockIndex: second.blockIndex } : null };
      continue;
    }
    const disagree = second && !empty(second.value) && !agrees(field, primary.value, second.value);
    out[field] = {
      value: primary.value, page: primary.page, blockIndex: primary.blockIndex,
      state: disagree ? 'conflicting' : 'extracted_unverified',
      second: second && !empty(second.value) ? { value: second.value, page: second.page, blockIndex: second.blockIndex } : null,
    };
  }
  return out;
}

// Candidate golden values for the owner to verify by eye. Same extractor, so every entry is a claim, not truth.
export function draftCandidates(pages) {
  const extracted = extractFields(pages);
  return {
    note: 'DRAFT. Owner must confirm each value against the PDF, set confirmed=true, then save as golden.json. Use value "unknown" when the PDF does not state the field.',
    fields: Object.fromEntries(Object.entries(extracted).map(([field, hit]) => [field, {
      value: hit.value ?? 'unknown', page: hit.page, confirmed: false,
    }])),
  };
}
