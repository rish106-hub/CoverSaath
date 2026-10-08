import { randomUUID } from 'node:crypto';
import { assertCaseTransition, emergencyInstruction } from '../state/case-state-machine.js';

const id = prefix => `${prefix}-${randomUUID()}`;
function nextRevision(previous, candidate) {
  const before = Date.parse(previous);
  const after = Date.parse(candidate);
  return new Date(Number.isFinite(after) && after > before ? after : before + 1).toISOString();
}

const staleRevision = () => Object.assign(new Error('Case revision is stale.'), { code: 'STALE_REVISION' });

export class CaseRepository {
  constructor(database, { clock = () => new Date(), audit } = {}) { this.database = database; this.clock = clock; this.audit = audit; }

  async create({ id: caseId = id('case'), householdId, subjectMemberId = null, openedByAdultId, triggerType, statedEstimateMinor = null, currency = null }) {
    const at = this.clock().toISOString();
    const emergency = triggerType === 'emergency' ? 1 : 0;
    await this.database.transaction(async tx => {
      await tx.query(`INSERT INTO service_cases
        (id, household_id, subject_member_id, opened_by_adult_id, trigger_type, status, emergency_mode,
         stated_estimate_minor, currency, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, 'created', $6, $7, $8, $9, $10)`,
      [caseId, householdId, subjectMemberId, openedByAdultId, triggerType, emergency, statedEstimateMinor, currency, at, at]);
      await this.audit?.append({ householdId, caseId, actorType: 'adult_user', actorId: openedByAdultId, action: 'case.created', resourceType: 'case', resourceId: caseId, payload: { triggerType, emergencyInstruction: emergencyInstruction(triggerType) } });
    });
    return this.get(caseId);
  }

  async get(caseId) {
    const record = await this.database.one('SELECT * FROM service_cases WHERE id = $1', [caseId]);
    return record ? { ...record, revision: record.updated_at, emergencyInstruction: emergencyInstruction(record.trigger_type) } : null;
  }

  /** Optimistic transition: the row is locked, the expected revision compared, then updated in one transaction. */
  async transition(caseId, toStatus, { expectedRevision, actorType = 'system', actorId = 'local-backend', payload = {} } = {}) {
    if (!expectedRevision) throw new Error('Expected case revision is required.');
    await this.database.transaction(async tx => {
      const current = await tx.one('SELECT * FROM service_cases WHERE id = $1 FOR UPDATE', [caseId]);
      if (!current) throw new Error('Case not found.');
      if (current.updated_at !== expectedRevision) throw staleRevision();
      assertCaseTransition(current.status, toStatus);
      const updatedAt = nextRevision(current.updated_at, this.clock().toISOString());
      const closedAt = toStatus === 'closed' ? updatedAt : current.closed_at;
      const changed = await tx.run(`UPDATE service_cases SET status = $1, updated_at = $2, closed_at = $3
        WHERE id = $4 AND updated_at = $5`, [toStatus, updatedAt, closedAt, caseId, expectedRevision]);
      if (changed.rowCount !== 1) throw staleRevision();
      await this.audit?.append({ householdId: current.household_id, caseId, actorType, actorId, action: 'case.transitioned', resourceType: 'case', resourceId: caseId, payload: { from: current.status, to: toStatus, ...payload } });
    });
    return this.get(caseId);
  }
}
