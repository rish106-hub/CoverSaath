// ADR 0017 D6 / corpus section 8: seeded mutation fuzzing over the enforced redact rows of the golden corpus.
// Enforced mutators must leak nothing or be refused (fail closed counts as a pass). Confusable mutators are
// exploratory and report counts only. A failure prints the seed, the iteration, the row id and the mutator names, never
// a generated value. SYNTHETIC DATA ONLY.
import assert from 'node:assert/strict';
import test from 'node:test';
import { gateText } from '../src/features/ai-analysis/privacy-evidence-gate.js';
import { CORPUS } from './support/privacy-corpus.mjs';
import { prng } from './support/corpus-rows.mjs';
import { leaks } from './support/leak-oracle.mjs';

const SEEDS = [1, 2, 3, 0x5EC2];
const EXTRA = process.env.PRIVACY_FUZZ_SEED ? [Number(process.env.PRIVACY_FUZZ_SEED) >>> 0] : [];
const PER_SEED = 1800;
const EXPLORATORY = 300;

const base = CORPUS.filter(row => row.status === 'enforced' && row.expect === 'redact' && row.mustNotContain.length > 0);
// Wording wrapped around a mutated row. Wording that holds a run of four or more digits is left out: the oracle compares
// four-digit windows, so a toll-free number could look like a fragment of a generated phone by chance.
const longestRun = text => Math.max(0, ...(text.replace(/(\d)[\s.\-/·]+(?=\d)/g, '$1').match(/\d+/g) ?? []).map(run => run.length));
const wording = CORPUS.filter(row => row.category === 'preserve' && !row.input.includes('\n') && longestRun(row.input) < 4);
const IDENTIFIER_CATEGORIES = new Set(['aadhaar', 'pan', 'phone', 'email', 'abha']);

const pick = (random, list) => list[Math.floor(random() * list.length)];
const SEPARATORS = [' ', '  ', '\t', ' ', ' ', ' ', '-', '‐', '–', '.', '/', '·'];
const INVISIBLES = ['​', '‌', '‍', '⁠', '﻿', '­'];
const DIGIT_SCRIPTS = [0x0966, 0x0660, 0xFF10, 0x09E6];
const LABEL_SWAPS = [['Aadhaar', 'Adhaar'], ['Aadhaar', 'AADHAAR'], ['Aadhaar', 'UID'], ['UID', 'Aadhaar number'], ['Phone', 'Mobile'], ['Mobile', 'फ़ोन'], ['PAN', 'PAN No.'], ['Email', 'ईमेल']];

// Each mutator returns a new input (or null when it does not apply to this one).
const MUTATORS = Object.freeze({
  separators(input, random) {
    const joins = [...input.matchAll(/(?<=\d)[ \-.](?=\d)/g)];
    if (!joins.length) return null;
    const at = pick(random, joins);
    return `${input.slice(0, at.index)}${pick(random, SEPARATORS)}${input.slice(at.index + 1)}`;
  },
  digit_script(input, random) {
    if (!/\d/.test(input)) return null;
    const zero = pick(random, DIGIT_SCRIPTS);
    return input.replace(/\d/g, digit => String.fromCodePoint(zero + Number(digit)));
  },
  invisibles(input, random) {
    const spots = [...input.matchAll(/(?<=[0-9A-Za-z])(?=[0-9A-Za-z])/g)];
    if (!spots.length) return null;
    const at = pick(random, spots);
    return `${input.slice(0, at.index)}${pick(random, INVISIBLES)}${input.slice(at.index)}`;
  },
  case_flip(input, random) {
    const pattern = /\b([A-Za-z]{3,})(?=\s*[:\-.]?\s*[\dA-Z])/g;
    const hits = [...input.matchAll(pattern)];
    if (!hits.length) return null;
    const at = pick(random, hits);
    const flipped = [...at[1]].map(character => (random() < 0.5 ? character.toUpperCase() : character.toLowerCase())).join('');
    return `${input.slice(0, at.index)}${flipped}${input.slice(at.index + at[1].length)}`;
  },
  label_variant(input, random) {
    const options = LABEL_SWAPS.filter(([from]) => input.includes(from));
    if (!options.length) return null;
    const [from, to] = pick(random, options);
    return input.replace(from, to);
  },
  context(input, random) {
    const around = pick(random, wording).input;
    return random() < 0.5 ? `${around}\n${input}` : `${input}\n${around}`;
  },
  table_cell(input, random) {
    if (input.includes('\n') || input.includes('|')) return null;
    return `| ${pick(random, ['Field', 'Item', 'Detail'])} | Value |\n| ${pick(random, ['Reference', 'Note', 'Proposer'])} | ${input} |`;
  },
  line_split(input, random) {
    // A break after a label colon, or between two groups of four or more digits (never inside a date or a name).
    const joins = [...input.matchAll(/(?<=:) (?=[\dA-Za-z])|(?<=\d{4}) (?=\d{4})/g)];
    if (!joins.length) return null;
    const at = pick(random, joins);
    return `${input.slice(0, at.index)}\n${input.slice(at.index + 1)}`;
  },
});

const CONFUSABLES = Object.freeze({ O: '0', I: '1', l: '1', S: '5', B: '8' });
function confusable(input, random) {
  const spots = [...input.matchAll(/\d/g)].filter(match => Object.values(CONFUSABLES).includes(match[0]));
  if (!spots.length) return null;
  const at = pick(random, spots);
  const letter = pick(random, Object.entries(CONFUSABLES).filter(([, digit]) => digit === at[0]))[0];
  return `${input.slice(0, at.index)}${letter}${input.slice(at.index + 1)}`;
}

// Mutators that make no sense for a category are skipped for it: a lower-cased name is not a name the gate promises to find.
const SKIPPED = Object.freeze({ case_flip: new Set(['name_latin', 'name_devanagari', 'name_variant', 'member_table', 'dob_address']), table_cell: new Set(['name_latin', 'name_devanagari', 'name_variant', 'member_table', 'dob_address', 'ocr_noise']), context: new Set([]) });

// Fuzz-found gaps in gate v10, tracked here (the list may only shrink). Each pairs a corpus variant with the mutator that
// defeats it: a name list whose values start on the line after their label, and a bracketed STD landline split by a line break.
const FUZZ_KNOWN_GAPS = Object.freeze(new Set([
  'name_list_and|line_split', 'name_list_pipe_two|line_split', 'std_landline_bracketed|line_split',
  // A bare split PAN is found only in upper case (a lower-case "table 1500 a" must stay readable); a labelled one in any case.
  'split_by_spaces_bare|case_flip',
]));

function mutate(row, random, names) {
  let input = row.input;
  const applied = [];
  for (const name of names) {
    if (SKIPPED[name]?.has(row.category)) continue;
    if (name === 'table_cell' && !IDENTIFIER_CATEGORIES.has(row.category)) continue;
    if (FUZZ_KNOWN_GAPS.has(`${row.variant}|${name}`)) continue;
    const next = name === 'confusable' ? confusable(input, random) : MUTATORS[name](input, random);
    if (next !== null && next !== input) { input = next; applied.push(name); }
  }
  return { input, applied };
}

function runSeed(seed, count, { allowed, exploratory }) {
  const random = prng(seed);
  const failures = [];
  let leaked = 0;
  let refused = 0;
  let run = 0;
  for (let iteration = 0; iteration < count; iteration += 1) {
    const row = pick(random, base);
    const names = [];
    const picks = 1 + Math.floor(random() * 3);
    for (let at = 0; at < picks; at += 1) names.push(pick(random, allowed));
    if (exploratory && !names.includes('confusable')) names.push('confusable');
    const { input, applied } = mutate(row, random, names);
    if (!applied.length) continue;
    run += 1;
    let output;
    try {
      output = gateText(input, { knownIdentifiers: row.knownIdentifiers }).text;
    } catch (error) {
      if (error?.code === 'RESTRICTED_EVIDENCE' || error?.code === 'EVIDENCE_SOURCE_LIMIT') { refused += 1; continue; }
      failures.push({ seed, iteration, id: row.id, applied, error: error?.code ?? 'ERROR' });
      continue;
    }
    if (leaks(output, row.mustNotContain) > 0) {
      leaked += 1;
      failures.push({ seed, iteration, id: row.id, applied });
    }
  }
  return { failures, leaked, refused, run };
}

// On a failure, retry with each mutator removed in turn. A mutator whose removal stops the leak is REQUIRED to reproduce it;
// the list returned names those required mutators.
function shrink(failure) {
  const row = CORPUS.find(candidate => candidate.id === failure.id);
  const set = [];
  for (const dropped of failure.applied) {
    const remaining = failure.applied.filter(name => name !== dropped);
    const outcomes = [];
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const { input } = mutate(row, prng(failure.seed + attempt), remaining);
      try { outcomes.push(leaks(gateText(input, { knownIdentifiers: row.knownIdentifiers }).text, row.mustNotContain) > 0); } catch { outcomes.push(false); }
    }
    if (!outcomes.some(Boolean)) set.push(dropped);
  }
  return set;
}

const ENFORCED = Object.keys(MUTATORS);

test('fuzz: the tracked gap list only shrinks', () => {
  assert.ok(FUZZ_KNOWN_GAPS.size <= 4);
});

test('fuzz: enforced mutators leak nothing and fail closed', t => {
  let total = 0;
  let refused = 0;
  const failures = [];
  for (const seed of [...SEEDS, ...EXTRA]) {
    const result = runSeed(seed, PER_SEED, { allowed: ENFORCED, exploratory: false });
    total += result.run;
    refused += result.refused;
    failures.push(...result.failures);
  }
  t.diagnostic(`enforced fuzz: mutations=${total} refusals=${refused} failures=${failures.length}`);
  const report = failures.slice(0, 10).map(failure => `seed=${failure.seed} iteration=${failure.iteration} row=${failure.id} mutators=${failure.applied.join('+')} required=${shrink(failure).join('|') || 'n/a'} ${failure.error ?? ''}`);
  assert.deepEqual(report, []);
  assert.ok(total >= 5_000, `only ${total} mutations applied`);
});

test('fuzz: confusable mutations are exploratory and report counts only', t => {
  const result = runSeed(0xC0FFEE, EXPLORATORY, { allowed: ['separators', 'invisibles', 'context'], exploratory: true });
  t.diagnostic(`exploratory fuzz: mutations=${result.run} leaks=${result.leaked} refusals=${result.refused}`);
  assert.ok(result.run > 0);
});
