// Block 2 to Block 3 adapter. A stored evidence answer becomes candidate facts for the `model` channel only: the
// answer is model-assisted evidence, so every fact stays `extracted_unverified` until a reviewer says otherwise.
// Document, version and page come from the stored clauses, never from the answer.
import { text } from './contracts.js';

// Document kind (Block 1) to contract layer. A kind with no contractual standing cannot control a result.
const SOURCE_TYPE_BY_KIND = Object.freeze({
  policy_wording: 'policy_wording', policy_schedule: 'issued_schedule', endorsement: 'endorsement', employer_benefit_booklet: 'group_benefit_booklet',
});

const qualifiers = list => (Array.isArray(list) ? list : []).filter(item => typeof item === 'string').map(item => item.trim().slice(0, 500)).filter(Boolean).slice(0, 20);
const topicOf = subject => (text(subject, 400) ?? '').toLowerCase().replace(/\s+/g, ' ').slice(0, 120);

/**
 * @param answer       stored policy answer (covered, limited_or_excluded, conditions)
 * @param clauseRows   ClauseRepository rows for the answer's documents
 * @param documentKinds Map documentId -> Block 1 document kind
 */
export function answerToCandidates(answer, { clauseRows, documentKinds, policyId }) {
  const clauseById = new Map((clauseRows ?? []).map(row => [row.clauseId, row]));
  // Only a requester-named set is an assertion about the policy. Otherwise the system picked the one authorised document.
  const basis = answer?.documentAssociation?.basis ?? 'system_selected';
  const candidates = [];
  const skipped = [];
  const push = (entry, bucket, effect) => {
    const ids = Array.isArray(entry?.clauseIds) ? [...new Set(entry.clauseIds)] : [];
    const clauses = ids.map(id => clauseById.get(id));
    const first = clauses[0];
    const topic = topicOf(entry?.subject);
    if (!ids.length || clauses.some(clause => !clause) || !topic) return skipped.push({ bucket, reason: 'unresolvable_evidence' });
    if (clauses.some(clause => clause.documentId !== first.documentId || clause.sourceVersion !== first.sourceVersion)) return skipped.push({ bucket, reason: 'spans_documents' });
    candidates.push({
      policyId, policyAssociation: { basis },
      documentId: first.documentId, sourceVersion: first.sourceVersion, familyId: first.documentId,
      // The upload label is requester-set, so a model reading of it never gets contractual standing. The label is kept
      // as `declaredSourceType` for a reviewer.
      sourceType: 'user_statement',
      declaredSourceType: SOURCE_TYPE_BY_KIND[documentKinds?.get(first.documentId)] ?? null,
      clauseIds: ids,
      factType: `finding.${effect}`, topic,
      // The quote stays in the clause. The fact carries the effect, links and the model's short condition/exception strings
      // (the same strings /questions already returns behind the same consent gate). Legal review pending.
      completeness: 'member_scope_not_established',
      value: { effect, findingId: entry.findingId ?? null },
      conditions: qualifiers(entry.conditions), exceptions: qualifiers(entry.exceptions), overrides: qualifiers(entry.overrides),
    });
  };
  for (const entry of answer?.covered ?? []) push(entry, 'covered', 'covers');
  for (const entry of answer?.limited_or_excluded ?? []) push(entry, 'limited_or_excluded', entry.effect === 'excludes' ? 'excludes' : 'limits');
  for (const entry of answer?.conditions ?? []) push({ ...entry, conditions: [] }, 'conditions', entry.effect === 'excludes' ? 'excludes' : 'conditions');
  return { candidates, skipped };
}
