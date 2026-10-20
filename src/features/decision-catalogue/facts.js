// B3-1 evidence-to-facts bridge. A fact is only ever built from clauses the caller supplies as live rows of the same
// household (scoping is enforced upstream by ClauseRepository.listClauses; the index cannot re-prove it). Nothing is invented: page, version and document come from the evidence index, never from the candidate.
import {
  CONTRACTUAL_SOURCES, FACT_ORIGINS, NON_CONTRACTUAL_SOURCES, SELECTIONS, VERIFIED_STATES,
  deepFreeze, digestOf, isIsoDate, isRecord, text,
} from './contracts.js';

const reject = (code, candidateIndex) => ({ code, candidateIndex });
const list = (value, max, item = v => text(v, 500)) =>
  Array.isArray(value) && value.length <= max ? value.map(item) : value == null ? [] : null;

/** Authority comes from origin and review, never from what the candidate claims about itself. */
export function establishState({ origin, reviewStatus, hasValue, explicitState }) {
  if (explicitState === 'unknown' || (explicitState === 'not_permitted' && origin !== 'model')) return explicitState;
  if (!hasValue) return 'unknown';
  if (origin === 'model') return 'extracted_unverified';
  if (origin === 'human_review') return reviewStatus === 'accepted' ? 'proven' : 'reported';
  if (origin === 'official_source') return reviewStatus === 'accepted' ? 'proven' : 'dynamic';
  return 'reported'; // deterministic facts are produced by rules, never ingested
}

const MAX_CLAUSES = 20;

const INGESTIBLE_ORIGINS = ['model', 'human_review', 'official_source'];

/**
 * @param candidates   untrusted fact proposals
 * @param context      { householdId, evidenceIndex, origin, reviewStatus, verifiedPolicyIds }
 *   `origin`, `reviewStatus` and `verifiedPolicyIds` are attestations by the calling channel for the WHOLE batch
 *   (a model channel, a reviewer session, a curated source load). A candidate cannot assert its own authority:
 *   one origin per call, and a candidate field that disagrees is rejected.
 */
export function ingestFacts(candidates, { householdId, evidenceIndex, origin, reviewStatus = 'not_reviewed', verifiedPolicyIds = new Set() }) {
  if (!Array.isArray(candidates) || candidates.length > 500) throw new TypeError('Fact candidates must be a bounded array.');
  if (!text(householdId, 128) || !(evidenceIndex instanceof Map)) throw new TypeError('A household and an evidence index are required.');
  if (!INGESTIBLE_ORIGINS.includes(origin)) throw new TypeError('A supported batch origin is required.');
  const facts = [];
  const rejected = [];
  const seen = new Set();
  candidates.forEach((raw, index) => {
    const c = isRecord(raw) ? raw : {};
    const factType = text(c.factType, 80);
    const topic = c.topic == null || c.topic === '' ? '' : text(c.topic, 120);
    const sourceType = text(c.sourceType, 60);
    const documentId = text(c.documentId, 128);
    const sourceVersion = text(c.sourceVersion, 128);
    if (!factType || topic === null || !sourceType || !documentId || !sourceVersion) return rejected.push(reject('FACT_MALFORMED', index));
    if (!Object.hasOwn(CONTRACTUAL_SOURCES, sourceType) && !NON_CONTRACTUAL_SOURCES.includes(sourceType)) return rejected.push(reject('FACT_SOURCE_TYPE_UNSUPPORTED', index));
    // Only a human-reviewed batch may carry contractual standing. A model or an official-source load informs; it cannot control.
    if (origin !== 'human_review' && Object.hasOwn(CONTRACTUAL_SOURCES, sourceType)) return rejected.push(reject('FACT_AUTHORITY_EXCEEDED', index));
    if ((c.origin !== undefined && c.origin !== origin) || (c.reviewStatus !== undefined && c.reviewStatus !== reviewStatus) || c.inputFactIds !== undefined) return rejected.push(reject('FACT_AUTHORITY_EXCEEDED', index));
    if (c.supersedes !== undefined && (origin === 'model' || !Array.isArray(c.supersedes) || c.supersedes.length > 20 || c.supersedes.some(id => !text(id, 80)))) return rejected.push(reject(origin === 'model' ? 'FACT_AUTHORITY_EXCEEDED' : 'FACT_QUALIFIERS_MALFORMED', index));
    if (c.value !== undefined && c.value !== null && JSON.stringify(c.value ?? null).length > 2000) return rejected.push(reject('FACT_VALUE_TOO_LARGE', index));
    const selection = c.selection ?? 'unspecified';
    if (!SELECTIONS.includes(selection)) return rejected.push(reject('FACT_SELECTION_UNSUPPORTED', index));

    if ((c.subject !== undefined && !isRecord(c.subject)) || (c.effective !== undefined && !isRecord(c.effective))) return rejected.push(reject('FACT_SUBJECT_MALFORMED', index));
    const subjectIn = isRecord(c.subject) ? c.subject : {};
    const memberId = subjectIn.memberId == null ? null : text(subjectIn.memberId, 128);
    const scope = subjectIn.scope ?? (memberId ? 'member' : 'policy');
    if ((subjectIn.memberId != null && !memberId) || !['policy', 'member', 'rider', 'event'].includes(scope)
      || (scope === 'member' && !memberId) || (scope === 'policy' && memberId)) return rejected.push(reject('FACT_SUBJECT_MALFORMED', index));

    const conditions = list(c.conditions, 20);
    const exceptions = list(c.exceptions, 20);
    const overrides = list(c.overrides, 20);
    if (!conditions || !exceptions || !overrides || [...conditions, ...exceptions, ...overrides].some(item => item === null)) return rejected.push(reject('FACT_QUALIFIERS_MALFORMED', index));

    const effective = isRecord(c.effective) ? { from: c.effective.from ?? null, to: c.effective.to ?? null } : { from: null, to: null };
    for (const bound of [effective.from, effective.to]) if (bound !== null && !isIsoDate(bound)) return rejected.push(reject('FACT_DATE_MALFORMED', index));
    if (effective.from && effective.to && effective.from > effective.to) return rejected.push(reject('FACT_DATE_MALFORMED', index));

    const hasValue = c.value !== undefined && c.value !== null;
    if (c.explicitState !== undefined && !(c.explicitState === 'unknown' || (c.explicitState === 'not_permitted' && origin !== 'model'))) return rejected.push(reject('FACT_AUTHORITY_EXCEEDED', index));
    const state = establishState({ origin, reviewStatus, hasValue, explicitState: c.explicitState });
    if (c.claimedState !== undefined && c.claimedState !== state) return rejected.push(reject('FACT_AUTHORITY_EXCEEDED', index));

    const clauseIds = Array.isArray(c.clauseIds) && c.clauseIds.length <= MAX_CLAUSES ? [...new Set(c.clauseIds.map(id => text(id, 128)))].sort() : null;
    if (!clauseIds || clauseIds.includes(null)) return rejected.push(reject('FACT_EVIDENCE_MALFORMED', index));
    let page = null;
    if (clauseIds.length) {
      for (const id of clauseIds) {
        const evidence = evidenceIndex.get(id);
        if (!evidence || evidence.live !== true) return rejected.push(reject('EVIDENCE_NOT_LIVE', index));
        if (evidence.householdId !== householdId) return rejected.push(reject('EVIDENCE_OUT_OF_SCOPE', index));
        if (evidence.documentId !== documentId || evidence.sourceVersion !== sourceVersion) return rejected.push(reject('EVIDENCE_SOURCE_MISMATCH', index));
        page ??= evidence.page;
      }
    }
    if (!clauseIds.length) return rejected.push(reject('FACT_EVIDENCE_REQUIRED', index));

    const policyId = c.policyId == null ? null : text(c.policyId, 128);
    if (c.policyId != null && !policyId) return rejected.push(reject('FACT_POLICY_MALFORMED', index));
    const association = policyId
      ? { policyId, basis: text(c.policyAssociation?.basis, 80) ?? 'unstated', verified: verifiedPolicyIds.has(policyId) }
      : { policyId: null, basis: 'unresolved', verified: false };

    const core = {
      policyId, documentId, sourceVersion, clauseIds, factType, topic, memberId, scope, selection,
      value: hasValue ? c.value : null, conditions, exceptions, overrides, effective,
      origin, reviewStatus, sourceType, familyId: text(c.familyId, 128) ?? documentId,
      associationVerified: association.verified, supersedes: c.supersedes ?? [], state,
      caseId: text(c.caseId, 128), registryKey: text(c.registryKey, 80), unit: text(c.unit, 40), completeness: text(c.completeness, 200),
    };
    const factId = `fact-${digestOf(core).slice(0, 32)}`;
    if (seen.has(factId)) return; // idempotent: an identical proposal adds nothing
    seen.add(factId);
    facts.push(deepFreeze({
      factId, householdId, caseId: text(c.caseId, 128),
      policyId, association, documentId, sourceVersion,
      familyId: text(c.familyId, 128) ?? documentId,
      sourceType, declaredSourceType: text(c.declaredSourceType, 60), contractual: sourceType in CONTRACTUAL_SOURCES,
      clauseIds, page, factType, topic,
      registryKey: text(c.registryKey, 80),
      subject: { memberId, scope },
      selection, value: core.value, unit: text(c.unit, 40),
      conditions, exceptions, overrides, effective,
      state, origin, reviewStatus,
      verified: VERIFIED_STATES.includes(state),
      supersedes: c.supersedes ?? [],
      completeness: text(c.completeness, 200),
    }));
  });
  return { facts, rejected };
}
