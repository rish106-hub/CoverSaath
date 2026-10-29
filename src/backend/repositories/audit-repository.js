import { createHash } from 'node:crypto';
import { householdLock } from '../database/postgres/locks.js';

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  }
  return value;
}

function requireFields({ action, resourceType, resourceId }) {
  if (!action || !resourceType || !resourceId) throw new Error('Audit action, resource type and resource id are required.');
}

const INSERT_EVENT = `
  INSERT INTO audit_events
    (household_id, case_id, actor_type, actor_id, action, resource_type, resource_id,
     event_payload_json, previous_event_hash, event_hash, occurred_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

// Appends to a per-household hash chain. append() returns a Promise: it runs in a transaction
// (a savepoint inside a caller's transaction) that holds the household advisory lock while it reads
// the previous hash and inserts, so concurrent appends cannot fork the chain. Callers that also lock rows must take the household lock first (lock
// order, design section 3); the advisory lock is re-entrant within one transaction.
export class AuditRepository {
  constructor(database, { clock = () => new Date() } = {}) {
    this.database = database;
    this.clock = clock;
  }

  #event({ householdId, caseId, actorType, actorId, action, resourceType, resourceId, payload }, previous) {
    const occurredAt = this.clock().toISOString();
    const payloadJson = JSON.stringify(stable(payload));
    const material = JSON.stringify(stable({ householdId, caseId, actorType, actorId, action, resourceType, resourceId, payload, previous, occurredAt }));
    const eventHash = createHash('sha256').update(material).digest('hex');
    const params = [householdId, caseId, actorType, actorId, action, resourceType, resourceId, payloadJson, previous, eventHash, occurredAt];
    return { occurredAt, eventHash, params };
  }

  async append({ householdId = null, caseId = null, actorType = 'system', actorId = 'local-backend', action, resourceType, resourceId, payload = {} }) {
    const input = { householdId, caseId, actorType, actorId, action, resourceType, resourceId, payload };
    requireFields(input);
    const db = this.database;
    return db.transaction(async () => {
      // Untyped `? IS NULL` fails on PostgreSQL (42P18), so the NULL chain has its own query.
      const previousRow = input.householdId === null
        ? await db.one('SELECT event_hash FROM audit_events WHERE household_id IS NULL ORDER BY id DESC LIMIT 1')
        : await db.one('SELECT event_hash FROM audit_events WHERE household_id = ? ORDER BY id DESC LIMIT 1', [input.householdId]);
      const previous = previousRow?.event_hash ?? null;
      const { occurredAt, eventHash, params } = this.#event(input, previous);
      const { rows: [row] } = await db.query(`${INSERT_EVENT} RETURNING id`, params);
      return { id: row.id, eventHash, previousEventHash: previous, occurredAt };
    }, { locks: [householdLock(input.householdId)] });
  }

  listForCase(caseId) {
    return this.database.many('SELECT * FROM audit_events WHERE case_id = ? ORDER BY id', [caseId]);
  }
}
