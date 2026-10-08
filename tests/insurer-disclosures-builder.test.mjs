import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';

import { parseXlsx, extractClaimStatus, extractHealthIncurredClaimRatio, extractSolvency, cleanInsurerName } from '../scripts/references/build-insurer-disclosures.mjs';

// Minimal ZIP writer (deflate, CRC not verified by the reader) to build a tiny synthetic xlsx.
function zip(files) {
  const locals = []; const centrals = []; let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = deflateRawSync(Buffer.from(content)); const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(Buffer.byteLength(content), 22); local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(Buffer.byteLength(content), 24); central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data); centrals.push(central, nameBuf); offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

test('parseXlsx reads shared strings, numbers, sparse columns and sheet names', () => {
  const xlsx = zip({
    'xl/workbook.xml': '<workbook><sheets><sheet name=" 56" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/sharedStrings.xml': '<sst><si><t>A &amp; B</t></si><si><r><t>Ra</t></r><r><t>w</t></r></si></sst>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="2"><c r="A2" t="s"><v>0</v></c><c r="C2"><v>12.5</v></c><c r="D2" t="s"><v>1</v></c></row></sheetData></worksheet>',
  });
  const rows = parseXlsx(xlsx).get(' 56');
  assert.deepEqual(rows[0], []);
  assert.equal(rows[1][0], 'A & B');
  assert.equal(rows[1][1], undefined);
  assert.equal(rows[1][2], 12.5);
  assert.equal(rows[1][3], 'Raw');
});

const meta = { url: 'https://example.test/hb.zip', title: 'Synthetic Handbook', fiscalLabel: '2024-25', period: 'FY2024-25', publishedOn: '2026-02-03', solvencyQuarterLabel: 'March 2025', solvencyPeriod: '2025-03-31' };
const pad = (n, row) => Object.assign(new Array(n).fill(null), row);

test('Table 53: health-insurer count ratios with explicit numerator and denominator; general insurers excluded', () => {
  const rows = [
    ['TABLE 53: STATUS OF CLAIMS'],
    pad(8, { 0: 'S.No.', 1: 'Insurer', 2: '2023-24', 4: '2024-25' }).map(v => v),
    [],
    [],
    ['', 'Public Sector Insurers'],
    [1, 'Motor Heavy General Ltd.', 0, 0, 100000, 5000, 0, 0],
    ['', 'Stand-alone Health Insurers'],
    [2, 'Alpha Health Insurance Co. Ltd.*', 0, 0, 900, 100, 0, 0],
    [3, 'Tiny Health Ltd.', 0, 0, 5, 1, 0, 0],
    ['', 'Stand-alone Health Insurers Total', 0, 0, 905, 101, 0, 0],
  ];
  rows[1] = ['', 'Insurer', '2023-24', null, '2024-25'];
  // header block for the 2024-25 columns starts at index 4: start, intimated, paid, repudiated, closed, end
  rows[3] = []; rows[3][4] = 'Claims O/S at start of the period'; rows[3][5] = 'Claims intimated/ booked during the period'; rows[3][6] = 'Claims paid during the period'; rows[3][7] = 'Claims repudiated during the period'; rows[3][8] = 'Claims closed during the period'; rows[3][9] = 'Claims O/S at the end of period';
  const data = (row, paid, rep, closed) => { const r = [...row]; r[4] = 0; r[5] = 0; r[6] = paid; r[7] = rep; r[8] = closed; r[9] = 0; return r; };
  rows[5] = data([1, 'Motor Heavy General Ltd.'], 100000, 5000, 0);
  rows[7] = data([2, 'Alpha Health Insurance Co. Ltd.*'], 900, 100, 0);
  rows[8] = data([3, 'Tiny Health Ltd.'], 5, 1, 0);
  const entries = extractClaimStatus(new Map([['53', rows]]), meta);
  assert.deepEqual(entries.map(e => [e.insurerName, e.metric, e.value]), [
    ['Alpha Health Insurance Co. Ltd.', 'claim_settlement_ratio_count', 90],
    ['Alpha Health Insurance Co. Ltd.', 'repudiation_ratio', 10],
  ]);
  assert.deepEqual([entries[0].basis.numerator, entries[0].basis.denominator], [900, 1000]);
  assert.match(entries[0].source, /TABLE 53/);
  assert.equal(entries[0].period, 'FY2024-25');
  assert.equal(entries[0].publishedOn, '2026-02-03');
});

test('Table 53: a shifted header fails loudly instead of misreading columns', () => {
  const rows = [['TABLE 53: X'], ['', 'Insurer', '2024-25'], [], ['', '', 'wrong', 'wrong', 'wrong', 'wrong', 'wrong', 'wrong']];
  assert.throws(() => extractClaimStatus(new Map([['53', rows]]), meta), /does not match/);
});

test('Table 62 incurred claims ratio is computed from the Total block; Table 49 solvency multiple becomes percent', () => {
  const r62 = [['TABLE 62: HEALTH'], [], [], [], []];
  r62[2] = []; r62[2][2] = '2024-25';
  r62[3] = []; r62[3][2] = 'Government'; r62[3][5] = 'Total';
  r62[4] = []; r62[4][5] = 'Net Earned Premium'; r62[4][6] = 'Claims Incurred (Net)'; r62[4][7] = 'Incurred Claims Ratio';
  r62.push(['', 'Private Sector Insurers']);
  const row = []; row[0] = 1; row[1] = 'Beta General Insurance Co. Ltd.#'; row[5] = 2000; row[6] = 1500; row[7] = 0.75;
  r62.push(row);
  const blank = []; blank[0] = 2; blank[1] = 'Gamma Ltd.'; blank[5] = 0; blank[6] = 0;
  r62.push(blank);
  const ratio = extractHealthIncurredClaimRatio(new Map([['62', r62]]), meta);
  assert.equal(ratio.length, 1);
  assert.equal(ratio[0].value, 75);
  assert.equal(ratio[0].insurerName, 'Beta General Insurance Co. Ltd.');

  const r49 = [['TABLE 49: SOLVENCY'], ['S.No.', 'Insurer', 'Dec 2024', 'March 2025'], [1, 'Beta General Insurance Co. Ltd.#', 1.8, 1.85], [2, 'Delta Ltd.', 1.4, '-']];
  const sol = extractSolvency(new Map([['49', r49]]), meta);
  assert.deepEqual(sol.map(e => [e.insurerName, e.value, e.period]), [['Beta General Insurance Co. Ltd.', 185, '2025-03-31']]);
});

test('cleanInsurerName strips footnote markers only', () => {
  assert.equal(cleanInsurerName('  HDFC ERGO General Insurance Co. Ltd.^^ '), 'HDFC ERGO General Insurance Co. Ltd.');
  assert.equal(cleanInsurerName('$$Zurich Kotak General Insurance Co. (India) Ltd.'), 'Zurich Kotak General Insurance Co. (India) Ltd.');
});
