// Offline tests for the 100-question eval harness: scorer rules, each of the five scores, set validation, unknown
// handling, the synthetic set and the real-mode opt-in. No network, no database, no provider key.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assertValidQuestionSet, formatTable, matchAnswer, parseNumber, scoreQuestion, scoreResults, validateQuestionSet } from '../../scripts/lib/policy-question-eval.mjs';
import { chatToResult, createRealPipeline, readRealConfig } from '../../scripts/lib/real-policy-pipeline.mjs';
import { DEFAULT_SET, parseArgs, runEval } from '../../scripts/eval-policy-questions.mjs';

const item = (overrides = {}) => ({
  id: 'q1', question: 'What is the sum insured?', category: 'sum_insured_limits', expectedAnswer: 500000, expectedFactKey: 'sum_insured',
  expectedSource: { documentKind: 'schedule', page: 2 }, matchRule: { type: 'numeric', tolerance: 0 }, ...overrides,
});
const unknownItem = (overrides = {}) => item({ id: 'u1', expectedAnswer: 'unknown', expectedFactKey: null, expectedSource: null, matchRule: { type: 'unknown' }, ...overrides });
const result = (overrides = {}) => ({
  id: 'q1', retrieved: [{ documentKind: 'schedule', page: 2 }], extractedValue: '5,00,000',
  answer: { value: 'Rs. 5,00,000', citations: [{ documentKind: 'schedule', page: 2 }] }, ...overrides,
});

test('matching rules: exact, numeric tolerance, contains, unknown', () => {
  assert.equal(matchAnswer({ type: 'exact' }, ' Family  Floater ', 'family floater'), true);
  assert.equal(matchAnswer({ type: 'exact' }, 'Annual', 'Annual payment'), false);
  assert.equal(parseNumber('Rs. 5,00,000'), 500000);
  assert.equal(matchAnswer({ type: 'numeric', tolerance: 0 }, 500000, 'Rs. 5,00,000'), true);
  assert.equal(matchAnswer({ type: 'numeric', tolerance: 0 }, 500000, '5,00,001'), false);
  assert.equal(matchAnswer({ type: 'numeric', tolerance: 10 }, 500000, '500005'), true);
  assert.equal(matchAnswer({ type: 'numeric' }, 5, 'no figure'), false);
  assert.equal(matchAnswer({ type: 'contains' }, 'excluded', 'Dental treatment is EXCLUDED unless accident'), true);
  assert.equal(matchAnswer({ type: 'contains' }, 'excluded', 'covered'), false);
  assert.equal(matchAnswer({ type: 'unknown' }, 'unknown', null), true);
  assert.equal(matchAnswer({ type: 'unknown' }, 'unknown', 'unknown'), true);
  assert.equal(matchAnswer({ type: 'unknown' }, 'unknown', 'Rs. 5'), false);
  assert.equal(matchAnswer({ type: 'exact' }, 'x', null), false, 'a value rule never matches an unknown answer');
});

test('all five scores pass on a fully correct hand-built case', () => {
  const row = scoreQuestion(item(), result());
  assert.deepEqual({ ...row }, { id: 'q1', category: 'sum_insured_limits', expectsUnknown: false, extraction: true, retrieval: true, answer: true, citation: true, unsupported: false });
});

test('extraction fails alone when the extracted value is wrong', () => {
  const row = scoreQuestion(item(), result({ extractedValue: '4,00,000' }));
  assert.equal(row.extraction, false);
  assert.equal(row.answer, true);
  assert.equal(scoreQuestion(item(), result({ extractedValue: null })).extraction, false);
});

test('retrieval fails alone when the expected page was not retrieved', () => {
  const row = scoreQuestion(item(), result({ retrieved: [{ documentKind: 'terms', page: 2 }, { documentKind: 'schedule', page: 1 }, { documentKind: 'schedule', page: 2 }].slice(0, 2) }));
  assert.equal(row.retrieval, false);
});

test('answer fails alone on a wrong value; citation fails alone on a wrong page or kind', () => {
  assert.equal(scoreQuestion(item(), result({ answer: { value: '3,00,000', citations: [{ documentKind: 'schedule', page: 2 }] } })).answer, false);
  const wrongPage = scoreQuestion(item(), result({ answer: { value: 'Rs. 5,00,000', citations: [{ documentKind: 'schedule', page: 1 }] }, retrieved: [{ documentKind: 'schedule', page: 1 }, { documentKind: 'schedule', page: 2 }] }));
  assert.equal(wrongPage.citation, false);
  assert.equal(wrongPage.answer, true);
  const wrongKind = scoreQuestion(item(), result({ answer: { value: 'Rs. 5,00,000', citations: [{ documentKind: 'terms', page: 2 }] }, retrieved: [{ documentKind: 'terms', page: 2 }, { documentKind: 'schedule', page: 2 }] }));
  assert.equal(wrongKind.citation, false);
});

test('unsupported claim: value with no citation, citation outside retrieved, or a value for an expected unknown', () => {
  assert.equal(scoreQuestion(item(), result({ answer: { value: 'Rs. 5,00,000', citations: [] } })).unsupported, true);
  assert.equal(scoreQuestion(item(), result({ retrieved: [], answer: { value: 'Rs. 5,00,000', citations: [{ documentKind: 'schedule', page: 2 }] } })).unsupported, true);
  assert.equal(scoreQuestion(unknownItem(), result({ id: 'u1', answer: { value: '10', citations: [{ documentKind: 'schedule', page: 2 }] } })).unsupported, true);
  assert.equal(scoreQuestion(item(), result({ answer: { value: null, citations: [] } })).unsupported, false, 'saying unknown is never an unsupported claim');
});

test('unknown handling: correct unknown passes answer, skips retrieval, extraction and citation', () => {
  const row = scoreQuestion(unknownItem(), { id: 'u1', retrieved: [], extractedValue: null, answer: { value: null, citations: [] } });
  assert.deepEqual([row.answer, row.extraction, row.retrieval, row.citation, row.unsupported], [true, null, null, null, false]);
  const wrong = scoreQuestion(unknownItem(), { id: 'u1', retrieved: [], extractedValue: null, answer: { value: 'unknown', citations: [] } });
  assert.equal(wrong.answer, true);
});

test('scoreResults keeps five separate scores, per-category slices and failing ids; skipped questions leave denominators', () => {
  const questions = [item(), item({ id: 'q2', category: 'waiting_periods' }), unknownItem()];
  const report = scoreResults(questions, [
    result(),
    result({ id: 'q2', answer: { value: '1', citations: [{ documentKind: 'schedule', page: 2 }] } }),
    { id: 'u1', retrieved: [], extractedValue: null, answer: { value: '9', citations: [] } },
  ]);
  assert.deepEqual(Object.keys(report.scores).sort(), ['answer', 'citation', 'extraction', 'questions', 'retrieval', 'unsupported']);
  assert.equal(report.scores.extraction.total, 2);
  assert.equal(report.scores.answer.total, 3);
  assert.deepEqual(report.failing.answer, ['q2', 'u1']);
  assert.deepEqual(report.failing.unsupported, ['u1']);
  assert.equal(report.byCategory.waiting_periods.answer.passed, 0);
  assert.equal(report.expectedUnknown.unsupported.count, 1);
  assert.match(formatTable(report), /failing unsupported: u1/);
  assert.throws(() => scoreResults(questions, [result()]), /no result for/);
});

test('malformed question sets are rejected with a clear error', () => {
  assert.match(validateQuestionSet(null)[0], /JSON object/);
  assert.match(validateQuestionSet({ questions: [] })[0], /non-empty/);
  const bad = {
    questions: [
      item({ id: 'dup' }), item({ id: 'dup' }),
      item({ id: 'a', matchRule: { type: 'fuzzy' } }),
      item({ id: 'b', expectedSource: { documentKind: 'schedule', page: 0 } }),
      item({ id: 'c', expectedAnswer: 'abc' }),
      item({ id: 'd', expectedAnswer: 'unknown', matchRule: { type: 'exact' } }),
      unknownItem({ id: 'e', expectedSource: { documentKind: 'terms', page: 1 } }),
      item({ id: 'f', question: '' }),
    ],
  };
  const text = validateQuestionSet(bad).join('\n');
  for (const expected of [/duplicate id/, /matchRule\.type/, /page 1 or more/, /numeric rule/, /needs matchRule "unknown"/, /no expectedSource/, /question must be/]) assert.match(text, expected);
  assert.throws(() => assertValidQuestionSet(bad), error => error.code === 'QUESTION_SET_INVALID' && /Malformed question set/.test(error.message));
  const conflict = validateQuestionSet({ questions: [item({ id: 'x' }), item({ id: 'y', expectedAnswer: 400000 })] });
  assert.match(conflict.join('\n'), /two different expected values/);
});

test('committed synthetic set: valid, 100 questions, spread, at least 15 unknown, synthetic only', async () => {
  const set = JSON.parse(await readFile(DEFAULT_SET, 'utf8'));
  assert.deepEqual(validateQuestionSet(set), []);
  assert.equal(set.questions.length, 100);
  assert.ok(set.questions.filter(entry => entry.expectedAnswer === 'unknown').length >= 15);
  const categories = new Set(set.questions.map(entry => entry.category));
  for (const name of ['sum_insured_limits', 'waiting_periods', 'exclusions', 'copay_deductible', 'room_rent_sublimits', 'renewal_premium', 'claims_process', 'definitions']) assert.ok(categories.has(name), name);
});

test('synthetic mode runs offline, deterministically, and reports five scores', async () => {
  const first = await runEval({ argv: [], env: {}, fetchImpl: () => { throw new Error('network is forbidden'); } });
  const second = await runEval({ argv: [], env: {} });
  assert.deepEqual(first.report, second.report);
  assert.equal(first.report.mode, 'synthetic');
  assert.equal(first.report.scores.questions, 100);
  assert.match(first.report.limitation, /do not measure real-policy accuracy/);
  for (const name of ['extraction', 'retrieval', 'answer', 'citation', 'unsupported']) assert.ok(name in first.report.scores);
});

test('real mode refuses without the opt-in flag, before any file or network access', async () => {
  const unreachable = () => { throw new Error('must not be called'); };
  await assert.rejects(runEval({ argv: ['--mode', 'real', '--set', '/nonexistent.json'], env: {}, fetchImpl: unreachable }), error => error.code === 'LIVE_NOT_ENABLED');
  await assert.rejects(runEval({ argv: ['--mode', 'real'], env: { RUN_POLICY_QUESTIONS_LIVE: 'true' }, fetchImpl: unreachable }), error => error.code === 'LIVE_NOT_ENABLED');
  assert.throws(() => readRealConfig({ RUN_POLICY_QUESTIONS_LIVE: '1' }), error => error.code === 'LIVE_CONFIG_MISSING' && /EVAL_BASE_URL/.test(error.message));
  assert.throws(() => parseArgs(['--mode', 'live']), /--mode must be/);
});

test('real mode adapter: existing routes only, token sent but never in errors, sources mapped to document kinds', async () => {
  const env = { RUN_POLICY_QUESTIONS_LIVE: '1', EVAL_BASE_URL: 'http://127.0.0.1:8787', EVAL_BEARER_TOKEN: 'secret-token-value-123456', EVAL_HOUSEHOLD_ID: 'hh1', EVAL_DOCUMENT_IDS: 'schedule=docA,terms=docB' };
  const config = readRealConfig(env);
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method ?? 'GET', auth: init.headers.authorization });
    if (url.endsWith('/policy-facts')) return { ok: true, json: async () => ({ facts: url.includes('docA') ? [{ factType: 'sum_insured', state: 'extracted_unverified', value: 500000 }] : [] }) };
    return { ok: true, json: async () => ({ answerStatus: 'evidence_found', reply: 'Sum insured: 500000', sources: [{ tier: 'household_evidence', page: 2, evidenceId: 'docA:sum_insured' }, { tier: 'none', label: 'x' }] }) };
  };
  const [row] = await createRealPipeline(config, { fetchImpl }).run([item()]);
  assert.deepEqual(row.answer.citations, [{ documentKind: 'schedule', page: 2 }]);
  assert.equal(row.extractedValue, '500000');
  assert.ok(calls.every(call => /\/api\/v1\/(documents\/[^/]+\/policy-facts|households\/hh1\/chat)$/.test(call.url)));
  const failing = createRealPipeline(config, { fetchImpl: async () => ({ ok: false, status: 500 }) });
  await assert.rejects(failing.run([item()]), error => !error.message.includes('secret-token'));
  assert.equal(chatToResult(item(), { answerStatus: 'unknown', sources: [{ tier: 'none' }] }, config.documents, null).answer.value, null);
});
