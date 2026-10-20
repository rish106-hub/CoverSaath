// Retrieval recall for the question pipeline (ADR 0008). Pure scoring: given stored clauses, an FTS `search`, and
// owner-verified golden questions, report how many expected clauses the first context and the sweep context reach.
// It makes no provider call and measures retrieval only, never answer accuracy.
//
// Honest accounting: the headline recall is end to end, over every expected clause. An expected clause that cannot
// be found in stored text, or that the privacy gate withholds, is a miss, not an exclusion from the denominator.
// The sweep is never seeded from golden data: it uses the model's recorded first-pass findings when given, else the
// question alone (a lower bound on what the sweep reaches).
import { INVESTIGATION_LIMITS, checklistFor, clauseBudget, gateClauses, selectContext, selectSweepContext } from './investigate.js';

const ratio = (hit, total) => (total ? hit / total : null);
const invalid = message => Object.assign(new Error(message), { code: 'RECALL_INPUT_INVALID' });

function recordedSeed(list) {
  if (!Array.isArray(list)) throw invalid('Recorded first-pass findings must be an array.');
  return list.map(finding => ({
    subject: typeof finding?.subject === 'string' ? finding.subject : '',
    quote: typeof finding?.quote === 'string' ? finding.quote : '',
    clauseIds: Array.isArray(finding?.clauseIds) ? finding.clauseIds.filter(id => typeof id === 'string') : [],
  }));
}

/**
 * golden: [{ id, question, expected: [{ page, quote }] }]. Expected quotes must be printed in a clause on that page.
 * firstPassFindings: optional { [questionId]: [{ subject, quote, clauseIds }] }, recorded from real first-pass model
 * output for the same policy, so the sweep is measured against what the model actually returned.
 */
export function evaluateRecall({ clauses, search, golden, maxInputBytes = INVESTIGATION_LIMITS.maxInputBytes, knownIdentifiers = [], firstPassFindings = null }) {
  if (!Array.isArray(golden) || !golden.length) throw invalid('Golden questions are required.');
  if (!Number.isInteger(maxInputBytes) || maxInputBytes <= 0) throw invalid('maxInputBytes must be a positive integer.');
  const { sent } = gateClauses(clauses, knownIdentifiers);
  const sentById = new Map(sent.map(clause => [clause.clauseId, clause]));
  const caps = { maxInputBytes, payloadMarginBytes: INVESTIGATION_LIMITS.payloadMarginBytes };
  const results = golden.map(item => {
    const expected = item.expected.map(({ page, quote }) => {
      const stored = clauses.find(entry => entry.page === page && entry.text.includes(quote));
      if (!stored) return { page, quote, clauseId: null, reason: 'not_in_stored_text' };
      if (!sentById.get(stored.clauseId)?.text.includes(quote)) return { page, quote, clauseId: null, reason: 'withheld_by_gate' };
      return { page, quote, clauseId: stored.clauseId, reason: null };
    });
    const questions = [{ text: item.question }];
    const checklist = checklistFor(item.question);
    const context = selectContext({ gated: sent, checklist, question: item.question, search, budgetBytes: clauseBudget({ questions, checklist, clauses: [] }, caps) });
    const recorded = firstPassFindings && Object.hasOwn(firstPassFindings, item.id);
    const findings = recorded ? recordedSeed(firstPassFindings[item.id]) : [{ subject: item.question, quote: '', clauseIds: [] }];
    const wireFindings = findings.map((finding, index) => ({ finding_id: `f${index + 1}`, subject: finding.subject, quote: finding.quote, clause_ids: finding.clauseIds }));
    const sweepBudget = clauseBudget({ questions, findings: wireFindings, clauses: [] }, caps);
    const first = new Set(context.clauses.map(clause => clause.clauseId));
    const sweep = new Set([...first, ...selectSweepContext({ context, gated: sent, findings, search, budgetBytes: sweepBudget }).clauses.map(clause => clause.clauseId)]);
    const resolved = expected.filter(entry => entry.clauseId);
    const inFirst = resolved.filter(entry => first.has(entry.clauseId)).length;
    const inSweep = resolved.filter(entry => sweep.has(entry.clauseId)).length;
    return {
      id: item.id, path: context.path, sweepSeed: recorded ? 'recorded_first_pass' : 'question_only',
      expected: expected.length, found: inSweep,
      unresolvable: expected.length - resolved.length,
      notInStoredText: expected.filter(entry => entry.reason === 'not_in_stored_text').length,
      withheldByGate: expected.filter(entry => entry.reason === 'withheld_by_gate').length,
      firstRecall: ratio(inFirst, expected.length), sweepRecall: ratio(inSweep, expected.length),
      retrievalRecall: ratio(inSweep, resolved.length),
      missed: expected.filter(entry => !entry.clauseId || !sweep.has(entry.clauseId)).map(entry => entry.page),
    };
  });
  const scored = results.filter(result => result.expected > 0);
  const mean = key => {
    const values = scored.map(result => result[key]).filter(value => value !== null);
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  };
  const expectedTotal = results.reduce((sum, result) => sum + result.expected, 0);
  return {
    questions: results.length,
    // Headline: every expected clause across all questions, unresolvable ones counted as misses.
    endToEndRecall: ratio(results.reduce((sum, result) => sum + result.found, 0), expectedTotal),
    meanFirstRecall: mean('firstRecall'), meanSweepRecall: mean('sweepRecall'),
    // Diagnostic only: recall over expected clauses that exist in gated text. Never report it as the headline.
    meanRetrievalRecall: mean('retrievalRecall'),
    expected: expectedTotal,
    unresolvable: results.reduce((sum, result) => sum + result.unresolvable, 0),
    results,
  };
}
