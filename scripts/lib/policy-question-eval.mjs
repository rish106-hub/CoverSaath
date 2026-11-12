// Deterministic scorer for the 100-question policy eval (E1). Pure: no network, no model, no clock, no file access.
// Five scores, never blended: extraction, retrieval recall, answer, citation, unsupported claims.
// Each score has its own denominator (a question that does not apply is skipped for that score, not counted right).

export const MATCH_RULES = Object.freeze(['exact', 'numeric', 'contains', 'unknown']);
export const SCORE_NAMES = Object.freeze(['extraction', 'retrieval', 'answer', 'citation', 'unsupported']);
const ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isUnknown = value => value === null || value === undefined || (typeof value === 'string' && value.trim().toLowerCase() === 'unknown');

/** First number in the text; strips thousands separators (including 5,00,000). NaN when none. */
export function parseNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  const match = /-?\d+(?:\.\d+)?/.exec(String(value ?? '').replace(/(?<=\d),(?=\d)/g, ''));
  return match ? Number(match[0]) : NaN;
}

/** Returns a list of readable problems; an empty list means the set is valid. */
export function validateQuestionSet(set) {
  const problems = [];
  if (!isObject(set)) return ['Question set must be a JSON object.'];
  if (!Array.isArray(set.questions) || set.questions.length === 0) return ['Question set needs a non-empty "questions" array.'];
  const seen = new Set();
  set.questions.forEach((item, index) => {
    const at = `questions[${index}]${isObject(item) && typeof item.id === 'string' ? ` (${item.id})` : ''}`;
    if (!isObject(item)) { problems.push(`${at}: must be an object.`); return; }
    if (typeof item.id !== 'string' || !ID_PATTERN.test(item.id)) problems.push(`${at}: id must be a short string of letters, digits, dot, dash or underscore.`);
    else if (seen.has(item.id)) problems.push(`${at}: duplicate id.`);
    else seen.add(item.id);
    if (typeof item.question !== 'string' || !item.question.trim() || item.question.length > 500) problems.push(`${at}: question must be a non-empty string of at most 500 characters.`);
    if (typeof item.category !== 'string' || !KEY_PATTERN.test(item.category)) problems.push(`${at}: category must be a lowercase snake_case string.`);
    const rule = item.matchRule;
    if (!isObject(rule) || !MATCH_RULES.includes(rule.type)) { problems.push(`${at}: matchRule.type must be one of ${MATCH_RULES.join(', ')}.`); return; }
    const expectsUnknown = isUnknown(item.expectedAnswer);
    if (!expectsUnknown && typeof item.expectedAnswer !== 'string' && typeof item.expectedAnswer !== 'number') problems.push(`${at}: expectedAnswer must be a string, a number or "unknown".`);
    if (rule.type === 'unknown' && !expectsUnknown) problems.push(`${at}: matchRule "unknown" needs expectedAnswer "unknown".`);
    if (rule.type !== 'unknown' && expectsUnknown) problems.push(`${at}: expectedAnswer "unknown" needs matchRule "unknown".`);
    if (rule.type === 'numeric') {
      if (!expectsUnknown && !Number.isFinite(parseNumber(item.expectedAnswer))) problems.push(`${at}: numeric rule needs a numeric expectedAnswer.`);
      if (rule.tolerance !== undefined && !(Number.isFinite(rule.tolerance) && rule.tolerance >= 0)) problems.push(`${at}: matchRule.tolerance must be a number of at least 0.`);
    }
    if (item.expectedFactKey !== null && item.expectedFactKey !== undefined && (typeof item.expectedFactKey !== 'string' || !KEY_PATTERN.test(item.expectedFactKey))) problems.push(`${at}: expectedFactKey must be null or a snake_case key.`);
    const source = item.expectedSource;
    if (expectsUnknown) {
      if (source !== null && source !== undefined) problems.push(`${at}: an unknown answer has no expectedSource; use null.`);
      if (item.expectedFactKey) problems.push(`${at}: an unknown answer has no expectedFactKey.`);
    } else if (!isObject(source) || typeof source.documentKind !== 'string' || !source.documentKind || !Number.isInteger(source.page) || source.page < 1) {
      problems.push(`${at}: expectedSource must be { documentKind, page } with page 1 or more.`);
    }
  });
  const keyed = new Map();
  for (const item of set.questions.filter(entry => isObject(entry) && entry.expectedFactKey && !isUnknown(entry.expectedAnswer))) {
    const value = String(item.expectedAnswer).trim().toLowerCase();
    if (keyed.has(item.expectedFactKey) && keyed.get(item.expectedFactKey) !== value) problems.push(`${item.id}: fact key ${item.expectedFactKey} has two different expected values.`);
    keyed.set(item.expectedFactKey, value);
  }
  return problems;
}

export function assertValidQuestionSet(set) {
  const problems = validateQuestionSet(set);
  if (problems.length) {
    const shown = problems.slice(0, 20).join('\n- ');
    throw Object.assign(new Error(`Malformed question set:\n- ${shown}${problems.length > 20 ? `\n- and ${problems.length - 20} more` : ''}`), { code: 'QUESTION_SET_INVALID', problems });
  }
  return set;
}

const normalise = value => String(value).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

/** Does `actual` satisfy the rule? An unknown actual (null, undefined, "unknown") satisfies only the unknown rule. */
export function matchAnswer(rule, expected, actual) {
  if (rule.type === 'unknown') return isUnknown(actual);
  if (isUnknown(actual)) return false;
  if (rule.type === 'exact') return normalise(actual) === normalise(expected);
  if (rule.type === 'contains') return normalise(actual).includes(normalise(expected));
  if (rule.type === 'numeric') {
    const a = parseNumber(actual); const e = parseNumber(expected);
    return Number.isFinite(a) && Number.isFinite(e) && Math.abs(a - e) <= (rule.tolerance ?? 0);
  }
  throw new Error(`Unknown match rule ${rule.type}`);
}

const sameSource = (a, b) => normalise(a.documentKind) === normalise(b.documentKind) && a.page === b.page;

/**
 * One result per question, from either pipeline:
 *   { id, retrieved: [{documentKind,page}], extractedValue: string|null (value extracted for the expected fact key),
 *     answer: { value: string|null, citations: [{documentKind,page}] } }
 * Returns verdicts per score: true or false, or null when the score does not apply to that question.
 */
export function scoreQuestion(item, result) {
  const expectsUnknown = isUnknown(item.expectedAnswer);
  const retrieved = result.retrieved ?? [];
  const citations = result.answer?.citations ?? [];
  const value = result.answer?.value ?? null;
  const answered = !isUnknown(value);
  return {
    id: item.id, category: item.category, expectsUnknown,
    extraction: item.expectedFactKey ? (!isUnknown(result.extractedValue) && matchAnswer(item.matchRule, item.expectedAnswer, result.extractedValue)) : null,
    retrieval: item.expectedSource ? retrieved.some(entry => sameSource(entry, item.expectedSource)) : null,
    answer: matchAnswer(item.matchRule, item.expectedAnswer, value),
    citation: item.expectedSource ? citations.some(entry => sameSource(entry, item.expectedSource)) : null,
    // Unsupported: asserted a value for a question whose answer is "unknown", or asserted a value with no cited
    // passage that was among the retrieved passages.
    unsupported: answered && (expectsUnknown || citations.length === 0 || !citations.some(cite => retrieved.some(entry => sameSource(entry, cite)))),
  };
}

const tally = (rows, name) => {
  const applicable = rows.filter(row => row[name] !== null);
  const passed = applicable.filter(row => row[name] === true).length;
  return { passed, total: applicable.length, rate: applicable.length ? passed / applicable.length : null };
};

export function scoreResults(questions, results) {
  const byId = new Map(results.map(result => [result.id, result]));
  const missing = questions.filter(item => !byId.has(item.id)).map(item => item.id);
  if (missing.length) throw Object.assign(new Error(`Pipeline returned no result for: ${missing.slice(0, 10).join(', ')}`), { code: 'RESULT_MISSING' });
  const rows = questions.map(item => scoreQuestion(item, byId.get(item.id)));
  const summarise = subset => {
    const count = subset.filter(row => row.unsupported).length;
    return {
      questions: subset.length,
      extraction: tally(subset, 'extraction'),
      retrieval: tally(subset, 'retrieval'),
      answer: tally(subset, 'answer'),
      citation: tally(subset, 'citation'),
      unsupported: { count, total: subset.length, rate: subset.length ? count / subset.length : null },
    };
  };
  const categories = [...new Set(rows.map(row => row.category))].sort();
  return {
    scores: summarise(rows),
    byCategory: Object.fromEntries(categories.map(category => [category, summarise(rows.filter(row => row.category === category))])),
    expectedUnknown: summarise(rows.filter(row => row.expectsUnknown)),
    // For the four accuracy scores a failure is false; for unsupported a failure is true.
    failing: {
      extraction: rows.filter(row => row.extraction === false).map(row => row.id),
      retrieval: rows.filter(row => row.retrieval === false).map(row => row.id),
      answer: rows.filter(row => row.answer === false).map(row => row.id),
      citation: rows.filter(row => row.citation === false).map(row => row.id),
      unsupported: rows.filter(row => row.unsupported).map(row => row.id),
    },
    rows,
  };
}

const pct = score => (score.rate === null ? 'n/a' : `${(score.rate * 100).toFixed(1)}%`);
const cell = (summary, name) => (name === 'unsupported' ? `${summary.unsupported.count}/${summary.unsupported.total}` : `${summary[name].passed}/${summary[name].total} ${pct(summary[name])}`);

/** Short fixed-width table for stdout. Counts and ids only; never prints answers or document text. */
export function formatTable(report) {
  const header = ['group', 'n', 'extraction', 'retrieval', 'answer', 'citation', 'unsupported (lower is better)'];
  const row = (label, summary) => [label, String(summary.questions), ...SCORE_NAMES.map(name => cell(summary, name))];
  const table = [header, row('ALL', report.scores), ...Object.entries(report.byCategory).map(([name, summary]) => row(name, summary)), row('expected-unknown', report.expectedUnknown)];
  const widths = header.map((_, index) => Math.max(...table.map(line => line[index].length)));
  const lines = table.map(line => line.map((text, index) => text.padEnd(widths[index])).join('  ').trimEnd());
  lines.push('');
  for (const name of SCORE_NAMES) lines.push(`failing ${name}: ${report.failing[name].length ? report.failing[name].join(' ') : 'none'}`);
  return lines.join('\n');
}
