import test from 'node:test';
import assert from 'node:assert/strict';
import { sectionDocument, STRUCTURING_DROPPED_TAGS } from '../src/features/policy-structuring/sectioner.js';

// Synthetic only: fictional insurer, members and numbers.
const table = rows => `<table>${rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}</table>`;
const pages = [
  { page: 1, blocks: [
    { tag: 'header', text: 'Zephyr Mutual Health (synthetic)' },
    { tag: 'headline', text: 'Policy Schedule' },
    { tag: 'paragraph', text: 'Sum Insured: Rs. 5,00,000 for the family floater.' },
    { tag: 'paragraph', text: 'Initial waiting period: 30 days.' },
    { tag: 'image', text: 'A logo of a blue bird.' },
    { tag: 'image-caption', text: 'Logo caption written by a model.' },
    { tag: 'table', text: table([['Benefit', 'Limit'], ['Room Rent', 'Rs. 4,000 per day'], ['Co-pay', '10%']]) },
    { tag: 'paragraph', text: '   ' },
    { tag: 'page-number', text: '1' },
  ] },
  { page: 2, blocks: [
    { tag: 'paragraph', text: 'Continued text without a heading on page two.' },
    { tag: 'section-title', text: 'Waiting Periods' },
    { tag: null, text: 'Pre-existing diseases: 36 months.' },
    { tag: 'footnote', text: 'See clause 4.2 of the synthetic wording.' },
    { tag: 'footer', text: 'Zephyr Mutual Health, fictional address' },
  ] },
];

function blockCoverage(sectioned) {
  const seen = new Map();
  for (const chunk of sectioned.chunks) {
    for (const index of chunk.blockIndexes) {
      const key = `${chunk.page}:${index}`;
      const base = chunk.id.replace(/-part\d+$/, '');
      seen.set(key, [...(seen.get(key) ?? []), base]);
    }
  }
  return seen;
}

test('drops boilerplate, model descriptions and empty blocks with reasons', () => {
  const { dropped } = sectionDocument(pages);
  assert.deepEqual(dropped, [
    { page: 1, blockIndex: 0, tag: 'header', reason: 'boilerplate' },
    { page: 1, blockIndex: 4, tag: 'image', reason: 'model_description' },
    { page: 1, blockIndex: 5, tag: 'image-caption', reason: 'model_description' },
    { page: 1, blockIndex: 7, tag: 'paragraph', reason: 'empty' },
    { page: 1, blockIndex: 8, tag: 'page-number', reason: 'boilerplate' },
    { page: 2, blockIndex: 4, tag: 'footer', reason: 'boilerplate' },
  ]);
  assert.equal(STRUCTURING_DROPPED_TAGS.image, 'model_description');
});

test('groups text under titles, keeps tables as row text and preserves page and block indexes', () => {
  const { chunks } = sectionDocument(pages);
  assert.deepEqual(chunks.map(chunk => [chunk.id, chunk.page, chunk.kind, [...chunk.blockIndexes], chunk.title]), [
    ['p1-b1', 1, 'text', [1, 2, 3], 'Policy Schedule'],
    ['p1-b6', 1, 'table', [6], 'Policy Schedule'],
    ['p2-b0', 2, 'text', [0], 'Policy Schedule'],
    ['p2-b1', 2, 'text', [1, 2, 3], 'Waiting Periods'],
  ]);
  assert.equal(chunks[0].text, 'Policy Schedule\nSum Insured: Rs. 5,00,000 for the family floater.\nInitial waiting period: 30 days.');
  assert.equal(chunks[1].text, 'Benefit | Limit\nRoom Rent | Rs. 4,000 per day\nCo-pay | 10%');
  assert.ok(!chunks.some(chunk => /logo|Zephyr/.test(chunk.text)));
});

test('every non-dropped block lands in exactly one chunk', () => {
  const sectioned = sectionDocument(pages);
  const coverage = blockCoverage(sectioned);
  const dropped = new Set(sectioned.dropped.map(entry => `${entry.page}:${entry.blockIndex}`));
  for (const page of pages) {
    page.blocks.forEach((_, index) => {
      const key = `${page.page}:${index}`;
      if (dropped.has(key)) assert.ok(!coverage.has(key), key);
      else assert.equal(new Set(coverage.get(key)).size, 1, key);
    });
  }
});

test('chunk cap splits text groups and oversize tables on row boundaries', () => {
  const rows = [['Procedure', 'Sub-limit'], ...Array.from({ length: 40 }, (_, at) => [`Synthetic procedure ${at}`, `Rs. ${at + 1},000`])];
  const paragraphs = Array.from({ length: 6 }, (_, at) => ({ tag: 'paragraph', text: `Synthetic clause ${at}: ${'x'.repeat(80)}` }));
  const { chunks } = sectionDocument([{ page: 3, blocks: [{ tag: 'table', text: table(rows) }, ...paragraphs] }], { maxChunkChars: 300 });
  const tableParts = chunks.filter(chunk => chunk.kind === 'table');
  assert.ok(tableParts.length > 1);
  assert.equal(tableParts[0].id, 'p3-b0');
  assert.equal(tableParts[1].id, 'p3-b0-part2');
  for (const part of tableParts) {
    assert.ok(part.text.length <= 300);
    for (const line of part.text.split('\n')) assert.match(line, /^(Procedure \| Sub-limit|Synthetic procedure \d+ \| Rs\. \d+,000)$/);
  }
  // Every part repeats the header row so the privacy gate sees it; each data row lands exactly once.
  assert.ok(tableParts.every(part => part.text.startsWith('Procedure | Sub-limit\n')));
  assert.equal(tableParts.flatMap(part => part.text.split('\n').slice(1)).length, rows.length - 1);
  const textChunks = chunks.filter(chunk => chunk.kind === 'text');
  assert.ok(textChunks.length > 1);
  assert.ok(textChunks.every(chunk => chunk.text.length <= 300));
  assert.deepEqual(textChunks.flatMap(chunk => chunk.blockIndexes), [1, 2, 3, 4, 5, 6]);
});

test('a single oversize text block splits on lines then hard cuts', () => {
  const text = `${'a'.repeat(150)}\n${'b'.repeat(150)}\n${'c'.repeat(700)}`;
  const { chunks } = sectionDocument([{ page: 4, blocks: [{ tag: 'paragraph', text }] }], { maxChunkChars: 300 });
  assert.deepEqual(chunks.map(chunk => chunk.id), ['p4-b0', 'p4-b0-part2', 'p4-b0-part3', 'p4-b0-part4', 'p4-b0-part5']);
  assert.deepEqual(chunks.map(chunk => chunk.text.length), [150, 150, 300, 300, 100]);
  assert.ok(chunks.every(chunk => chunk.text.length <= 300 && chunk.blockIndexes.length === 1 && chunk.blockIndexes[0] === 0));
  assert.equal(chunks.map(chunk => chunk.text).join('').replace(/\n/g, ''), text.replace(/\n/g, ''));
});

test('output is deterministic and frozen', () => {
  const first = sectionDocument(pages);
  assert.deepEqual(sectionDocument(pages), first);
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.chunks[0]) && Object.isFrozen(first.chunks[0].blockIndexes));
});

test('invalid input throws a coded error', () => {
  for (const bad of [null, {}, [{ page: 0, blocks: [] }], [{ page: 1 }], [{ page: 1, blocks: [{ tag: 'paragraph' }] }],
    [{ page: 1, blocks: [{ tag: 3, text: 'x' }] }], [{ page: 1, blocks: [] }, { page: 1, blocks: [] }]]) {
    assert.throws(() => sectionDocument(bad), { code: 'STRUCTURING_INPUT_INVALID' });
  }
  assert.throws(() => sectionDocument(pages, { maxChunkChars: 10 }), { code: 'STRUCTURING_INPUT_INVALID' });
});
