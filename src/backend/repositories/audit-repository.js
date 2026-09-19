import { createHash, randomUUID } from 'node:crypto';

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

  append({ householdId = null, caseId = null, actorType = 'system', actorId = 'local-backend', action, resourceType, resourceId, payload = {} }) {
    if (!action || !resourceType || !resourceId) throw new Error('Audit action, resource type and resource id are required.');
    const previous = this.database.prepare(`
      SELECT event_hash FROM audit_events
      WHERE (household_id = ? OR (? IS NULL AND household_id IS NULL))
      ORDER BY id DESC LIMIT 1
    `).get(householdId, householdId)?.event_hash ?? null;
    const occurredAt = this.clock().toISOString();
    const payloadJson = JSON.stringify(stable(payload));
    const material = JSON.stringify(stable({ householdId, caseId, actorType, actorId, action, resourceType, resourceId, payload, previous, occurredAt }));
    const eventHash = createHash('sha256').update(material).digest('hex');
    const result = this.database.prepare(`
      INSERT INTO audit_events
        (household_id, case_id, actor_type, actor_id, action, resource_type, resource_id,
         event_payload_json, previous_event_hash, event_hash, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(householdId, caseId, actorType, actorId, action, resourceType, resourceId, payloadJson, previous, eventHash, occurredAt);
    return { id: Number(result.lastInsertRowid), eventHash, previousEventHash: previous, occurredAt };
  }

  listForCase(caseId) {
    return this.database.prepare('SELECT * FROM audit_events WHERE case_id = ? ORDER BY id').all(caseId);
  }
}

