import { randomUUID } from 'node:crypto';

const id = prefix => `${prefix}-${randomUUID()}`;

const evidenceKind = Object.freeze({
  document_page: 'document',
  adult_statement: 'adult_statement',
  proxy_statement: 'adult_statement',
  institutional_reply: 'institutional_reply',
  calculation: 'calculation',
  fixture: 'fixture',
});

export class EvidenceRepository {
  constructor(database, { clock = () => new Date() } = {}) {
    this.database = database;
    this.clock = clock;
  }

  append({
    id: factId = id('fact'), householdId, caseId = null, policyId = null, subjectMemberId = null,
    factKey, value = null, epistemicState, provenanceKind, sourcePageId = null,
    statementAdultId = null, institutionalSourceRef = null, calculationMethod = null,
    sourceLocator = null, assertedBy, effectiveAt = null, observedAt = this.clock().toISOString(),
    retrievedAt = null, confidenceBasisPoints = null, reviewStatus = 'unreviewed',
    subjectConfirmationState = 'not_applicable', permittedViewers = null, expiresAt = null,
    supersedesFactId = null,
  }) {
    if (!evidenceKind[provenanceKind]) throw new Error('A supported provenance kind is required.');
    if (!factKey || !assertedBy || !epistemicState) throw new Error('Fact key, epistemic state and asserted-by are required.');
    const createdAt = this.clock().toISOString();
    this.database.prepare(`INSERT INTO evidence_facts (
      id, household_id, case_id, policy_id, subject_member_id, fact_key, value_json,
      epistemic_state, evidence_kind, provenance_kind, source_page_id, statement_adult_id,
      institutional_source_ref, calculation_method, source_locator, asserted_by, effective_at,
      observed_at, retrieved_at, confidence_basis_points, review_status,
      subject_confirmation_state, permitted_viewers_json, expires_at, supersedes_fact_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        factId, householdId, caseId, policyId, subjectMemberId, factKey,
        value === null ? null : JSON.stringify(value), epistemicState, evidenceKind[provenanceKind],
        provenanceKind, sourcePageId, statementAdultId, institutionalSourceRef, calculationMethod,
        sourceLocator, assertedBy, effectiveAt, observedAt, retrievedAt, confidenceBasisPoints,
        reviewStatus, subjectConfirmationState,
        permittedViewers === null ? null : JSON.stringify(permittedViewers), expiresAt,
        supersedesFactId, createdAt,
      );
    return this.get(factId);
  }

  recordConflict({ id: conflictId = id('conflict'), factKey, leftFactId, rightFactId }) {
    const createdAt = this.clock().toISOString();
    this.database.prepare(`INSERT INTO fact_conflicts
      (id, fact_key, left_fact_id, right_fact_id, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(conflictId, factKey, leftFactId, rightFactId, createdAt);
    return this.database.prepare('SELECT * FROM fact_conflicts WHERE id = ?').get(conflictId);
  }

  get(factId) {
    const fact = this.database.prepare('SELECT * FROM evidence_facts WHERE id = ?').get(factId);
    if (!fact) return null;
    return {
      ...fact,
      value: fact.value_json === null ? null : JSON.parse(fact.value_json),
      permittedViewers: fact.permitted_viewers_json === null ? null : JSON.parse(fact.permitted_viewers_json),
    };
  }

  listForCase(caseId) {
    return this.database.prepare(`SELECT * FROM evidence_facts
      WHERE case_id = ? ORDER BY fact_key, observed_at, created_at`).all(caseId);
  }
}
