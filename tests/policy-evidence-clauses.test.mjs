import test from 'node:test';
import assert from 'node:assert/strict';
import { buildClauses, classifyClause } from '../src/features/policy-evidence/index.js';
import { QUESTION_CONSENT_SCOPE, validateAnswer, validateFinding } from '../src/contracts/index.js';

// Synthetic only.
const stored = {
  pages: [
    { page: 1, status: 'stored', blocks: [
      { tag: 'headline', text: 'Policy Schedule' },
      { tag: 'paragraph', text: 'Sum Insured: Rs. 5,00,000. Policy period one year.' },
      { tag: 'footer', text: 'footer' },
    ] },
    { page: 2, status: 'stored', blocks: [
      { tag: 'section-title', text: 'Waiting Periods' },
      { tag: 'paragraph', text: 'Pre-existing diseases are covered after a waiting period of 36 months.' },
      { tag: 'section-title', text: 'Exclusions' },
      { tag: 'paragraph', text: 'We will not pay for cosmetic surgery.' },
    ] },
  ],
};
const identity = { documentId: 'doc-1', sourceVersion: 'src-v1' };

test('B1: clause build is deterministic and page-bound', () => {
  const a = buildClauses(stored, identity);
  const b = buildClauses(stored, identity);
  assert.deepEqual(a.clauses.map(c => [c.clauseId, c.digest]), b.clauses.map(c => [c.clauseId, c.digest]));
  assert.ok(a.clauses.every(c => c.page >= 1 && c.documentId === 'doc-1'));
  assert.ok(!a.clauses.some(c => c.text.includes('footer')));
  assert.equal(new Set(a.clauses.map(c => c.clauseId)).size, a.clauses.length);
});

test('B1: kinds are assigned from clause text', () => {
  const kinds = Object.fromEntries(buildClauses(stored, identity).clauses.map(c => [c.sectionPath[0], c.kind]));
  assert.equal(kinds['Waiting Periods'], 'waiting_period');
  assert.equal(kinds.Exclusions, 'exclusion');
  assert.equal(classifyClause(null, 'Hello'), 'other');
});

test('B1: pages without stored blocks fail closed', () => {
  assert.throws(() => buildClauses({ pages: [{ page: 1, status: 'erased', blocks: null }] }, identity), { code: 'STRUCTURING_BLOCKS_UNAVAILABLE' });
  assert.throws(() => buildClauses(stored, { documentId: '', sourceVersion: 'x' }), { code: 'CLAUSE_INPUT_INVALID' });
});

test('B0: finding quotes must come from cited clauses; states are capped', () => {
  const byId = new Map(buildClauses(stored, identity).clauses.map(c => [c.clauseId, c.text]));
  const clauseId = [...byId.keys()].find(id => byId.get(id).includes('36 months'));
  const finding = { findingId: 'f1', clauseIds: [clauseId], quote: '36 months', subject: 'policy', conditions: [], exceptions: [], state: 'extracted_unverified' };
  assert.deepEqual(validateFinding(finding, byId), []);
  assert.ok(validateFinding({ ...finding, clauseIds: ['nope'] }, byId).length);
  assert.ok(validateFinding({ ...finding, quote: 'invented' }, byId).length);
  assert.ok(validateFinding({ ...finding, state: 'proven' }, byId).length);
});

test('B0: answers are never bare verdicts and the question scope is legal-review marked', () => {
  const answer = { question: 'q', covered: [], limited_or_excluded: [], conditions: [], overrides_checked: [], unknowns: [], calculations: [], sources: [], state: 'insufficient_evidence', legalReview: 'required' };
  assert.ok(validateAnswer(answer).length, 'insufficient evidence needs unknowns');
  assert.deepEqual(validateAnswer({ ...answer, unknowns: ['no clause'] }), []);
  assert.ok(validateAnswer({ ...answer, unknowns: ['x'], legalReview: undefined }).length);
  assert.equal(QUESTION_CONSENT_SCOPE.legalReview, 'required');
  assert.equal(QUESTION_CONSENT_SCOPE.dataCategory, 'insurance_question');
});
