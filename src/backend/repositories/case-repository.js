import { randomUUID } from 'node:crypto';
import { assertCaseTransition, emergencyInstruction } from '../state/case-state-machine.js';

const id = prefix => `${prefix}-${randomUUID()}`;
function nextRevision(previous, candidate) {
  const before = Date.parse(previous);
  const after = Date.parse(candidate);
  return new Date(Number.isFinite(after) && after > before ? after : before + 1).toISOString();
}

export class CaseRepository {
  constructor(database, { clock = () => new Date(), audit } = {}) { this.database = database; this.clock = clock; this.audit = audit; }

  create({ id: caseId = id('case'), householdId, subjectMemberId = null, openedByAdultId, triggerType, statedEstimateMinor = null, currency = null }) {
    const at = this.clock().toISOString();
    const emergency = triggerType === 'emergency' ? 1 : 0;
    this.database.prepare(`INSERT INTO service_cases
      (id, household_id, subject_member_id, opened_by_adult_id, trigger_type, status, emergency_mode,
       stated_estimate_minor, currency, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'created', ?, ?, ?, ?, ?)`)
      .run(caseId, householdId, subjectMemberId, openedByAdultId, triggerType, emergency, statedEstimateMinor, currency, at, at);
    this.audit?.append({ householdId, caseId, actorType: 'adult_user', actorId: openedByAdultId, action: 'case.created', resourceType: 'case', resourceId: caseId, payload: { triggerType, emergencyInstruction: emergencyInstruction(triggerType) } });
    return this.get(caseId);
  }

  get(caseId) {
    const record = this.database.prepare('SELECT * FROM service_cases WHERE id = ?').get(caseId);
    return record ? { ...record, revision: record.updated_at, emergencyInstruction: emergencyInstruction(record.trigger_type) } : null;
  }

  transition(caseId, toStatus, { expectedRevision, actorType = 'system', actorId = 'local-backend', payload = {} } = {}) {
    if (!expectedRevision) throw new Error('Expected case revision is required.');
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const current = this.database.prepare('SELECT * FROM service_cases WHERE id = ?').get(caseId);
      if (!current) throw new Error('Case not found.');
      if (current.updated_at !== expectedRevision) { const error = new Error('Case revision is stale.'); error.code = 'STALE_REVISION'; throw error; }
      assertCaseTransition(current.status, toStatus);
      const updatedAt = nextRevision(current.updated_at, this.clock().toISOString());
      const closedAt = toStatus === 'closed' ? updatedAt : current.closed_at;
      const changed = this.database.prepare(`UPDATE service_cases SET status = ?, updated_at = ?, closed_at = ?
        WHERE id = ? AND updated_at = ?`).run(toStatus, updatedAt, closedAt, caseId, expectedRevision);
      if (changed.changes !== 1) { const error = new Error('Case revision is stale.'); error.code = 'STALE_REVISION'; throw error; }
      this.audit?.append({ householdId: current.household_id, caseId, actorType, actorId, action: 'case.transitioned', resourceType: 'case', resourceId: caseId, payload: { from: current.status, to: toStatus, ...payload } });
      this.database.exec('COMMIT');
      return this.get(caseId);
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

