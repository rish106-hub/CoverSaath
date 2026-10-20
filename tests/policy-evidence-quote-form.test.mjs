import test from 'node:test';
import assert from 'node:assert/strict';
import { investigate } from '../src/features/policy-evidence/index.js';

// Synthetic. The model only sees privacy-gated text, so a quote can carry placeholders such as <NAME_1>. Such a quote
// cites the right clause and page but is not verbatim source text; every source says which form it is.
const NAME = 'Ishaan Synthetic';
const clauses = [
  { clauseId: 'd:p1', documentId: 'd', sourceVersion: '1', page: 1, blockIndexes: [0], sectionPath: ['Policy Schedule'], kind: 'schedule_fact', text: `Policy issued to ${NAME} for the period 01-01-2026 to 31-12-2026.`, digest: 'a'.repeat(64) },
  { clauseId: 'd:p2', documentId: 'd', sourceVersion: '1', page: 2, blockIndexes: [0], sectionPath: ['Room Rent'], kind: 'limit', text: 'Room rent is capped at 1% of sum insured per day.', digest: 'b'.repeat(64) },
];

test('sources are marked verbatim or privacy-redacted against the stored text', async () => {
  const call = Object.assign(async ({ payload }) => {
    if (!payload.findings) {
      const schedule = payload.clauses.find(clause => clause.clause_id === 'd:p1');
      const quote = schedule.text.match(/Policy issued to .* for the period/)[0];
      assert.ok(/<NAME_\d+>/.test(quote), 'the model sees a placeholder, never the name');
      return { json: { findings: [
        { clause_ids: ['d:p1'], quote, subject: 'policy period', conditions: [], exceptions: [] },
        { clause_ids: ['d:p2'], quote: 'Room rent is capped at 1% of sum insured per day.', subject: 'room rent', conditions: [], exceptions: [] },
      ] } };
    }
    return { json: { overrides: [] } };
  }, { maxInputBytes: 64_000 });
  const { answer } = await investigate({ question: 'What is the policy period and room rent?', clauses, call, consentCheck: async () => {}, knownIdentifiers: [{ kind: 'NAME', value: NAME }] });
  const byClause = Object.fromEntries(answer.sources.map(source => [source.clauseId, source]));
  assert.equal(byClause['d:p1'].verbatim, false);
  assert.equal(byClause['d:p2'].verbatim, true);
  assert.ok(!JSON.stringify(answer).includes(NAME), 'the stored answer never carries the raw name');
});

test('reading the whole policy never reports a clause kind as absent; the retrieved path says what was not read', async () => {
  const call = Object.assign(async ({ payload }) => (payload.findings ? { json: { overrides: [] } } : { json: { findings: [] } }), { maxInputBytes: 64_000 });
  const whole = await investigate({ question: 'Is there a room rent limit?', clauses, call, consentCheck: async () => {} });
  assert.equal(whole.answer.contextPath, 'whole_policy');
  assert.ok(!whole.answer.unknowns.some(line => /clause was found/.test(line)), 'classifier labels are hints, not evidence of absence');
  const many = Array.from({ length: 40 }, (_, index) => ({ ...clauses[1], clauseId: `d:x${index}`, page: index + 1, text: `Clause ${index} ${'policy wording '.repeat(40)}`, digest: String(index).padStart(64, '0') }));
  const small = Object.assign(call, { maxInputBytes: 6_000 });
  const retrieved = await investigate({ question: 'Is there a room rent limit?', clauses: many, call: small, consentCheck: async () => {}, search: () => [] });
  assert.equal(retrieved.answer.contextPath, 'retrieved');
  assert.ok(retrieved.answer.unknowns.some(line => /not read/.test(line)));
  assert.ok(!retrieved.answer.unknowns.some(line => /^No \w+ clause was found/.test(line)));
});
