import { createHash } from 'node:crypto';
import { jsonParam } from '../database/value-codec.js';

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  }
  return value;
}

export class AuditRepository {
  constructor(database, { clock = () => new Date() } = {}) {
    this.database = database;
    this.clock = clock;
  }

  /**
   * Appends to the household's hash chain. A transaction-scoped advisory lock serialises writers per household
   * (it is held until the enclosing transaction ends); a unique index on the previous hash is the backstop.
   */
  async append({ householdId = null, caseId = null, actorType = 'system', actorId = 'local-backend', action, resourceType, resourceId, payload = {} }) {
    if (!action || !resourceType || !resourceId) throw new Error('Audit action, resource type and resource id are required.');
    return this.database.transaction(async tx => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`audit:${householdId ?? ''}`]);
      const previous = (await tx.one(`SELECT event_hash FROM audit_events
        WHERE household_id = $1::text OR ($1::text IS NULL AND household_id IS NULL)
        ORDER BY id DESC LIMIT 1`, [householdId]))?.event_hash ?? null;
      const occurredAt = this.clock().toISOString();
      const material = JSON.stringify(stable({ householdId, caseId, actorType, actorId, action, resourceType, resourceId, payload, previous, occurredAt }));
      const eventHash = createHash('sha256').update(material).digest('hex');
      const row = await tx.one(`INSERT INTO audit_events
          (household_id, case_id, actor_type, actor_id, action, resource_type, resource_id,
           event_payload_json, previous_event_hash, event_hash, occurred_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [householdId, caseId, actorType, actorId, action, resourceType, resourceId, jsonParam(stable(payload)), previous, eventHash, occurredAt]);
      return { id: Number(row.id), eventHash, previousEventHash: previous, occurredAt };
    });
  }

  listForCase(caseId) {
    return this.database.query('SELECT * FROM audit_events WHERE case_id = $1 ORDER BY id', [caseId]);
  }
}
