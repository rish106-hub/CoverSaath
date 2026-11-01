// Application-side word matching over decrypted clauses (ADR 0013). Clause text and titles are sealed in the database, so
// PostgreSQL can no longer build a tsvector over them. The repository decrypts a bounded set of clauses (the case's
// consented documents only) and ranks them here. English stemming stands in for the earlier `to_tsvector('english', ...)`:
// a Porter-style stemmer plus the common English stop words, applied identically to the query and the clause.

const STOP_WORDS = new Set(('i me my myself we our ours ourselves you your yours yourself yourselves he him his himself she her hers '
  + 'herself it its itself they them their theirs themselves what which who whom this that these those am is are was were be been '
  + 'being have has had having do does did doing a an the and but if or because as until while of at by for with about against '
  + 'between into through during before after above below to from up down in out on off over under again further then once here '
  + 'there when where why how all any both each few more most other some such no nor not only own same so than too very s t can '
  + 'will just don should now').split(' '));

const isVowel = (word, i) => {
  const c = word[i];
  if ('aeiou'.includes(c)) return true;
  return c === 'y' && i > 0 && !isVowel(word, i - 1);
};

// m in Porter's notation: the number of vowel-consonant sequences in the stem.
function measure(stem) {
  let count = 0;
  let previousVowel = false;
  for (let i = 0; i < stem.length; i += 1) {
    const vowel = isVowel(stem, i);
    if (previousVowel && !vowel) count += 1;
    previousVowel = vowel;
  }
  return count;
}
const hasVowel = stem => [...stem].some((_, i) => isVowel(stem, i));
const endsDouble = stem => stem.length >= 2 && stem.at(-1) === stem.at(-2) && !isVowel(stem, stem.length - 1);
const endsCvc = stem => {
  const n = stem.length;
  if (n < 3 || isVowel(stem, n - 1) || !isVowel(stem, n - 2) || isVowel(stem, n - 3)) return false;
  return !'wxy'.includes(stem[n - 1]);
};

const STEP2 = [['ational', 'ate'], ['tional', 'tion'], ['enci', 'ence'], ['anci', 'ance'], ['izer', 'ize'], ['abli', 'able'], ['alli', 'al'],
  ['entli', 'ent'], ['eli', 'e'], ['ousli', 'ous'], ['ization', 'ize'], ['ation', 'ate'], ['ator', 'ate'], ['alism', 'al'],
  ['iveness', 'ive'], ['fulness', 'ful'], ['ousness', 'ous'], ['aliti', 'al'], ['iviti', 'ive'], ['biliti', 'ble']];
const STEP3 = [['icate', 'ic'], ['ative', ''], ['alize', 'al'], ['iciti', 'ic'], ['ical', 'ic'], ['ful', ''], ['ness', '']];
const STEP4 = ['al', 'ance', 'ence', 'er', 'ic', 'able', 'ible', 'ant', 'ement', 'ment', 'ent', 'ion', 'ou', 'ism', 'ate', 'iti', 'ous', 'ive', 'ize'];

// Longest suffix first, sorted once at load (not per word).
const byLongestSuffix = table => Object.freeze([...table].sort((a, b) => b[0].length - a[0].length));
const STEP2_SORTED = byLongestSuffix(STEP2);
const STEP3_SORTED = byLongestSuffix(STEP3);
const STEP4_SORTED = Object.freeze([...STEP4].sort((a, b) => b.length - a.length));

function replaceSuffix(word, table, minMeasure) {
  for (const [suffix, replacement] of table) {
    if (word.endsWith(suffix)) {
      const stem = word.slice(0, -suffix.length);
      return measure(stem) > minMeasure ? stem + replacement : word;
    }
  }
  return word;
}

// Bounded memo of stems: real text repeats a small vocabulary. Cleared when full, so memory stays bounded.
const STEM_MEMO_LIMIT = 50_000;
const stemMemo = new Map();

/** Porter (1980) stemmer for lower-case ASCII-letter words; other words are returned unchanged. */
export function stem(input) {
  const known = stemMemo.get(input);
  if (known !== undefined) return known;
  const result = stemUncached(input);
  if (stemMemo.size >= STEM_MEMO_LIMIT) stemMemo.clear();
  stemMemo.set(input, result);
  return result;
}

function stemUncached(input) {
  let word = input;
  if (word.length <= 2 || !/^[a-z]+$/.test(word)) return word;
  // Step 1a
  if (word.endsWith('sses')) word = word.slice(0, -2);
  else if (word.endsWith('ies')) word = word.slice(0, -2);
  else if (!word.endsWith('ss') && word.endsWith('s')) word = word.slice(0, -1);
  // Step 1b
  let cleanup = false;
  if (word.endsWith('eed')) {
    if (measure(word.slice(0, -3)) > 0) word = word.slice(0, -1);
  } else if (word.endsWith('ed') && hasVowel(word.slice(0, -2))) { word = word.slice(0, -2); cleanup = true; }
  else if (word.endsWith('ing') && hasVowel(word.slice(0, -3))) { word = word.slice(0, -3); cleanup = true; }
  if (cleanup) {
    if (/(at|bl|iz)$/.test(word)) word += 'e';
    else if (endsDouble(word) && !'lsz'.includes(word.at(-1))) word = word.slice(0, -1);
    else if (measure(word) === 1 && endsCvc(word)) word += 'e';
  }
  // Step 1c
  if (word.endsWith('y') && hasVowel(word.slice(0, -1))) word = `${word.slice(0, -1)}i`;
  // Steps 2 and 3
  word = replaceSuffix(word, STEP2_SORTED, 0);
  word = replaceSuffix(word, STEP3_SORTED, 0);
  // Step 4
  for (const suffix of STEP4_SORTED) {
    if (!word.endsWith(suffix)) continue;
    const base = word.slice(0, -suffix.length);
    if (measure(base) > 1 && (suffix !== 'ion' || /[st]$/.test(base))) word = base;
    break;
  }
  // Step 5
  if (word.endsWith('e')) {
    const base = word.slice(0, -1);
    if (measure(base) > 1 || (measure(base) === 1 && !endsCvc(base))) word = base;
  }
  if (measure(word) > 1 && endsDouble(word) && word.endsWith('l')) word = word.slice(0, -1);
  return word;
}

/** Stemmed, de-duplicated query terms without stop words, at most `max`. */
export function queryTerms(query, max = 24) {
  const words = String(query ?? '').normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  const terms = [];
  for (const word of new Set(words)) {
    if (STOP_WORDS.has(word)) continue;
    const term = stem(word);
    if (!terms.includes(term)) terms.push(term);
    if (terms.length === max) break;
  }
  return terms;
}

const WORD = /[\p{L}\p{N}]{2,}/gu;

/**
 * Score of `texts` (clause text, then title) for `terms`; 0 means no match. Any term matches (OR), like the earlier
 * tsquery. More distinct terms rank first, then term frequency (each term counted up to 10 times), then a bonus when matched
 * terms sit close together. One pass over each text, no token array: only a count and a first position per matched term.
 */
export function scoreClause(terms, ...texts) {
  if (terms.length === 0) return 0;
  const wanted = new Set(terms);
  const matched = new Map();
  let index = 0;
  for (const value of texts) {
    if (!value) continue;
    const text = String(value).normalize('NFKC').toLowerCase();
    WORD.lastIndex = 0;
    for (let match = WORD.exec(text); match !== null; match = WORD.exec(text)) {
      if (STOP_WORDS.has(match[0])) continue;
      const token = stem(match[0]);
      if (wanted.has(token)) {
        const seen = matched.get(token);
        if (seen === undefined) matched.set(token, { count: 1, first: index });
        else if (seen.count < 10) seen.count += 1;
      }
      index += 1;
    }
  }
  if (matched.size === 0) return 0;
  let frequency = 0;
  let low = Infinity;
  let high = -Infinity;
  for (const { count, first } of matched.values()) {
    frequency += count;
    if (first < low) low = first;
    if (first > high) high = first;
  }
  // Distance between the first occurrences of the matched terms: the closer, the higher.
  const proximity = matched.size > 1 ? 100 / (1 + high - low) : 0;
  return matched.size * 1000 + frequency * 10 + proximity;
}
