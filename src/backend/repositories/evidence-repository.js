import { randomUUID } from 'node:crypto';
import { jsonParam, parseJson } from '../database/value-codec.js';

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

  async append({
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
    await this.database.query(`INSERT INTO evidence_facts (
      id, household_id, case_id, policy_id, subject_member_id, fact_key, value_json,
      epistemic_state, evidence_kind, provenance_kind, source_page_id, statement_adult_id,
      institutional_source_ref, calculation_method, source_locator, asserted_by, effective_at,
      observed_at, retrieved_at, confidence_basis_points, review_status,
      subject_confirmation_state, permitted_viewers_json, expires_at, supersedes_fact_id, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26)`, [
      factId, householdId, caseId, policyId, subjectMemberId, factKey,
      jsonParam(value), epistemicState, evidenceKind[provenanceKind],
      provenanceKind, sourcePageId, statementAdultId, institutionalSourceRef, calculationMethod,
      sourceLocator, assertedBy, effectiveAt, observedAt, retrievedAt, confidenceBasisPoints,
      reviewStatus, subjectConfirmationState,
      jsonParam(permittedViewers), expiresAt,
      supersedesFactId, createdAt,
    ]);
    return this.get(factId);
  }

  async recordConflict({ id: conflictId = id('conflict'), factKey, leftFactId, rightFactId }) {
    const createdAt = this.clock().toISOString();
    await this.database.query(`INSERT INTO fact_conflicts
      (id, fact_key, left_fact_id, right_fact_id, created_at) VALUES ($1, $2, $3, $4, $5)`,
    [conflictId, factKey, leftFactId, rightFactId, createdAt]);
    return this.database.one('SELECT * FROM fact_conflicts WHERE id = $1', [conflictId]);
  }

  async get(factId) {
    const fact = await this.database.one('SELECT * FROM evidence_facts WHERE id = $1', [factId]);
    if (!fact) return null;
    return {
      ...fact,
      value: parseJson(fact.value_json),
      permittedViewers: parseJson(fact.permitted_viewers_json),
    };
  }

  listForCase(caseId) {
    return this.database.query(`SELECT * FROM evidence_facts
      WHERE case_id = $1 ORDER BY fact_key, observed_at, created_at`, [caseId]);
  }
}
