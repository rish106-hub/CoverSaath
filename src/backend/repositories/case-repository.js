import { randomUUID } from 'node:crypto';
import { caseCapacityLock, householdLock } from '../database/postgres/locks.js';
import { assertCaseTransition, emergencyInstruction } from '../state/case-state-machine.js';

const id = prefix => `${prefix}-${randomUUID()}`;
function nextRevision(previous, candidate) {
  const before = Date.parse(previous);
  const after = Date.parse(candidate);
  return new Date(Number.isFinite(after) && after > before ? after : before + 1).toISOString();
}

// The cap counts every case in the database, so the lock that keeps it true under concurrency is one
// fixed global key, like session capacity.
const CASE_CAPACITY_KEY = 'global';

function capacityReached() {
  return Object.assign(new Error('Active case capacity reached.'), { code: 'CASE_CAPACITY_REACHED', statusCode: 429 });
}

function staleRevision() {
  const error = new Error('Case revision is stale.');
  error.code = 'STALE_REVISION';
  return error;
}

// Async PostgreSQL repository (S3.2). Each write and its audit event commit in one transaction
// that takes the household advisory lock first (lock order, design section 3).
export class CaseRepository {
  constructor(database, { clock = () => new Date(), audit } = {}) { this.database = database; this.clock = clock; this.audit = audit; }

  async create({ id: caseId = id('case'), householdId, subjectMemberId = null, openedByAdultId, triggerType, statedEstimateMinor = null, currency = null, maxActiveCases = null }) {
    if (maxActiveCases !== null && (!Number.isSafeInteger(maxActiveCases) || maxActiveCases < 0)) {
      throw new TypeError('maxActiveCases must be a non-negative integer or null.');
    }
    const at = this.clock().toISOString();
    const emergency = triggerType === 'emergency' ? 1 : 0;
    // With a cap, the count and the insert run in one transaction under the global case-capacity lock
    // (taken before the household lock), so concurrent creations cannot all pass the check.
    return this.database.transaction(async () => {
      if (maxActiveCases !== null) {
        const { count } = await this.database.one(`SELECT count(*) AS count FROM service_cases
          WHERE status NOT IN ('closed', 'revoked')`, []);
        if (count >= maxActiveCases) throw capacityReached();
      }
      await this.database.run(`INSERT INTO service_cases
        (id, household_id, subject_member_id, opened_by_adult_id, trigger_type, status, emergency_mode,
         stated_estimate_minor, currency, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'created', ?, ?, ?, ?, ?)`,
      [caseId, householdId, subjectMemberId, openedByAdultId, triggerType, emergency, statedEstimateMinor, currency, at, at]);
      await this.audit?.append({ householdId, caseId, actorType: 'adult_user', actorId: openedByAdultId, action: 'case.created', resourceType: 'case', resourceId: caseId, payload: { triggerType, emergencyInstruction: emergencyInstruction(triggerType) } });
      return this.get(caseId);
    }, { locks: [...(maxActiveCases !== null ? [caseCapacityLock(CASE_CAPACITY_KEY)] : []), householdLock(householdId)] });
  }

  async get(caseId) {
    const record = await this.database.one('SELECT * FROM service_cases WHERE id = ?', [caseId]);
    return record ? { ...record, revision: record.updated_at, emergencyInstruction: emergencyInstruction(record.trigger_type) } : null;
  }

  async transition(caseId, toStatus, { expectedRevision, actorType = 'system', actorId = 'local-backend', payload = {} } = {}) {
    if (!expectedRevision) throw new Error('Expected case revision is required.');
    // The household is needed for the lock, which comes before the row lock.
    const located = await this.database.one('SELECT household_id FROM service_cases WHERE id = ?', [caseId]);
    if (!located) throw new Error('Case not found.');
    return this.database.transaction(async () => {
      const current = await this.database.one('SELECT * FROM service_cases WHERE id = ? FOR UPDATE', [caseId]);
      if (!current) throw new Error('Case not found.');
      if (current.household_id !== located.household_id) throw staleRevision();
      if (current.updated_at !== expectedRevision) throw staleRevision();
      assertCaseTransition(current.status, toStatus);
      const updatedAt = nextRevision(current.updated_at, this.clock().toISOString());
      const closedAt = toStatus === 'closed' ? updatedAt : current.closed_at;
      const changed = await this.database.run(`UPDATE service_cases SET status = ?, updated_at = ?, closed_at = ?
        WHERE id = ? AND updated_at = ?`, [toStatus, updatedAt, closedAt, caseId, expectedRevision]);
      if (changed.changes !== 1) throw staleRevision();
      await this.audit?.append({ householdId: current.household_id, caseId, actorType, actorId, action: 'case.transitioned', resourceType: 'case', resourceId: caseId, payload: { from: current.status, to: toStatus, ...payload } });
      return this.get(caseId);
    }, { locks: [householdLock(located.household_id)] });
  }
}
