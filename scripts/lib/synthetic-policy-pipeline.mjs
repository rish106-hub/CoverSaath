// Offline stand-in for the P0 pipeline, used only by `eval:questions` in synthetic mode. No network, no database,
// no provider key, no cost, fully deterministic. What is REAL here: buildClauses (the repo's clause builder) and
// shapeQuery (the repo's query shaping). What is STUBBED: OCR (the fixture is already OCR-shaped blocks), retrieval
// (in-memory term overlap standing in for PostgreSQL full-text search), extraction (regexes from the fixture standing in
// for the model structuring step), and answering (a topic matcher standing in for the chat answer). So scores prove
// the harness works end to end; they say nothing about real extraction, retrieval or answer quality.
import { buildClauses } from '../../src/features/policy-evidence/index.js';
import { shapeQuery } from '../../src/features/policy-evidence/retrieval-terms.js';
import { SYNTHETIC_DOCUMENTS, SYNTHETIC_FACTS, syntheticStoredPages } from '../fixtures/synthetic-eval-policy.mjs';

export const TOP_K = 3;

export function createSyntheticPipeline({ topK = TOP_K } = {}) {
  const kindOf = new Map(SYNTHETIC_DOCUMENTS.map(doc => [doc.documentId, doc.documentKind]));
  const clauses = SYNTHETIC_DOCUMENTS.flatMap(doc => buildClauses(syntheticStoredPages(doc.documentKind), { documentId: doc.documentId, sourceVersion: 'synthetic-eval-v1' }).clauses)
    .map(clause => ({ ...clause, documentKind: kindOf.get(clause.documentId) }));

  // Stub extraction: every fact rule is tried on every line of every clause, so the page and document are discovered, not copied.
  const extracted = new Map();
  for (const rule of SYNTHETIC_FACTS) {
    const pattern = new RegExp(rule.pattern);
    for (const clause of clauses) {
      const line = clause.text.split('\n').map(text => pattern.exec(text)).find(Boolean);
      if (line && !extracted.has(rule.factKey)) extracted.set(rule.factKey, { factKey: rule.factKey, value: line.slice(1).filter(Boolean).join('-'), documentKind: clause.documentKind, page: clause.page });
    }
  }

  const termsOf = question => shapeQuery(question, { dropStopwords: true, synonyms: true }).toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}-]*/gu) ?? [];
  const hits = (text, term) => text.includes(term) || (term.length >= 6 && text.includes(term.slice(0, 5)));

  function retrieve(question) {
    const terms = [...new Set(termsOf(question))];
    return clauses
      .map((clause, order) => ({ clause, order, score: terms.filter(term => hits(clause.text.toLowerCase(), term)).length }))
      .filter(entry => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.order - b.order)
      .slice(0, topK)
      .map(entry => ({ documentKind: entry.clause.documentKind, page: entry.clause.page }));
  }

  function answer(question, retrieved) {
    const lower = question.toLowerCase();
    let best = null;
    for (const rule of SYNTHETIC_FACTS) {
      const fact = extracted.get(rule.factKey);
      if (!fact || !retrieved.some(entry => entry.documentKind === fact.documentKind && entry.page === fact.page)) continue;
      const score = Math.max(0, ...rule.topics.filter(topic => lower.includes(topic)).map(topic => topic.length));
      if (score > 0 && (!best || score > best.score)) best = { score, fact };
    }
    return best
      ? { value: best.fact.value, citations: [{ documentKind: best.fact.documentKind, page: best.fact.page }] }
      : { value: null, citations: [] };
  }

  return Object.freeze({
    async run(questions) {
      return questions.map(item => {
        const retrieved = retrieve(item.question);
        return { id: item.id, retrieved, extractedValue: item.expectedFactKey ? (extracted.get(item.expectedFactKey)?.value ?? null) : null, answer: answer(item.question, retrieved) };
      });
    },
  });
}
