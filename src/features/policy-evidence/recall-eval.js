// Retrieval recall for the question pipeline (ADR 0008). Pure scoring: given stored clauses, an FTS `search`, and
// owner-verified golden questions, report how many expected clauses the first context and the sweep context reach.
// It makes no provider call and measures retrieval only, never answer accuracy.
import { INVESTIGATION_LIMITS, checklistFor, gateClauses, selectContext, selectSweepContext } from './investigate.js';

const ratio = (hit, total) => (total ? hit / total : null);

/** golden: [{ id, question, expected: [{ page, quote }], documentId? }]. Expected quotes must be printed in a clause on that page. */
export function evaluateRecall({ clauses, search, golden, budgetBytes = INVESTIGATION_LIMITS.contextBudgetBytes, knownIdentifiers = [] }) {
  if (!Array.isArray(golden) || !golden.length) throw Object.assign(new Error('Golden questions are required.'), { code: 'RECALL_INPUT_INVALID' });
  const { sent } = gateClauses(clauses, knownIdentifiers);
  const results = golden.map(item => {
    const expected = item.expected.map(({ page, quote }) => {
      const clause = sent.find(entry => entry.page === page && entry.text.includes(quote));
      return { page, quote, clauseId: clause?.clauseId ?? null };
    });
    const unresolvable = expected.filter(entry => !entry.clauseId).length;
    const context = selectContext({ gated: sent, checklist: checklistFor(item.question), question: item.question, search, budgetBytes });
    const first = new Set(context.clauses.map(clause => clause.clauseId));
    // The sweep is seeded by the expected clauses' subjects the way a first pass would: question as subject, expected quote as finding.
    const findings = [{ subject: item.question, quote: item.expected[0]?.quote ?? '' }];
    const sweep = new Set(selectSweepContext({ context, gated: sent, findings, search, budgetBytes }).clauses.map(clause => clause.clauseId));
    const resolved = expected.filter(entry => entry.clauseId);
    const inFirst = resolved.filter(entry => first.has(entry.clauseId));
    const inSweep = resolved.filter(entry => sweep.has(entry.clauseId));
    return {
      id: item.id, path: context.path, expected: expected.length, unresolvable,
      firstRecall: ratio(inFirst.length, resolved.length), sweepRecall: ratio(inSweep.length, resolved.length),
      missed: resolved.filter(entry => !sweep.has(entry.clauseId)).map(entry => entry.page),
    };
  });
  const scored = results.filter(result => result.firstRecall !== null);
  const mean = key => (scored.length ? scored.reduce((sum, result) => sum + result[key], 0) / scored.length : null);
  return { questions: results.length, meanFirstRecall: mean('firstRecall'), meanSweepRecall: mean('sweepRecall'), unresolvable: results.reduce((sum, result) => sum + result.unresolvable, 0), results };
}
