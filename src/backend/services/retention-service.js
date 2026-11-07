import { ERASURE_REASONS } from '../../contracts/data-lifecycle.js';

// Retention sweep (S3). Applies the configured retention periods (readRetentionConfig): a period that is null is not scheduled
// and does nothing. DRY RUN IS THE DEFAULT: without `apply: true` nothing is changed and the result reports candidate counts.
// The sweep is idempotent and bounded (a batch per rule per run: 100 cases or households, 1000 plain rows, 5000 telemetry events;
// document tombstones are pruned per household with a limit of 500 households), runs as the system actor 'retention-sweep', erases through
// the same code as an erasure request, and reports counts only: no id, name or value is returned or logged.
// Periods are engineering placeholders and are not legal advice. FOR LEGAL REVIEW.

const DAY_MS = 86_400_000;
const BATCH = 100; // cases and households per run (each erasure is its own transaction)
const BATCH_ROWS = 1000; // plain rows per run for the delete-only rules (sessions, idempotency keys, expired locations)
const SYSTEM = Object.freeze({ type: 'system', id: 'retention-sweep' });
const ERASED_CASE = `EXISTS (SELECT 1 FROM retention_records WHERE resource_type = 'case' AND resource_id = service_cases.id AND deletion_state IN ('deleted', 'verified'))`;

export function createRetentionService({ database, erasure, lifecycle = null, appEvents, userData, documents, retention, clock = () => new Date() }) {
  const cutoff = days => new Date(clock().getTime() - days * DAY_MS).toISOString();

  return {
    /** @returns {Promise<object>} counts per rule: { dryRun, rules: { name: { scheduled, candidates, applied } } } */
    async sweep({ apply = false } = {}) {
      const dryRun = apply !== true;
      const rules = {};
      const rule = async (name, days, candidatesOf, applyOf) => {
        if (days === null || days === undefined) { rules[name] = { scheduled: false, candidates: 0, applied: 0 }; return; }
        const candidates = await candidatesOf(cutoff(days));
        rules[name] = { scheduled: true, candidates: candidates.length ?? candidates, applied: 0 };
        if (!dryRun) rules[name].applied = await applyOf(cutoff(days), candidates);
      };

      await rule('closedCases', retention.closedCaseDays, async before => database.many(`SELECT id, household_id FROM service_cases
        WHERE status IN ('closed', 'revoked') AND COALESCE(closed_at, updated_at) < CAST(? AS text) AND NOT ${ERASED_CASE} ORDER BY id LIMIT ?`, [before, BATCH]),
      async (before, cases) => {
        let applied = 0;
        for (const item of cases) {
          try {
            const result = await erasure.eraseCase({ householdId: item.household_id, caseId: item.id, actor: SYSTEM, reason: ERASURE_REASONS.retentionExpired });
            if (lifecycle) await lifecycle.finish(item.household_id, result.documentIds);
            applied += 1;
          } catch { /* left for the next run; the transaction rolled back */ }
        }
        return applied;
      });

      // Activity is deliberately generous: any session of an adult with a role in the household counts, even one the adult also
      // uses elsewhere. Reads are not audited and telemetry can be off, so no household-only signal exists, and erring towards
      // keeping a household is the safe side of an irreversible erasure.
      await rule('inactiveHouseholds', retention.inactiveHouseholdDays, async before => database.many(`SELECT households.id FROM households
        WHERE households.status = 'active'
          AND NOT EXISTS (SELECT 1 FROM retention_records WHERE resource_type = 'household' AND resource_id = households.id AND deletion_state IN ('deleted', 'verified'))
          AND COALESCE((SELECT max(occurred_at) FROM audit_events WHERE household_id = households.id), households.created_at) < CAST(? AS text)
          AND NOT EXISTS (SELECT 1 FROM api_sessions JOIN household_roles ON household_roles.adult_user_id = api_sessions.adult_user_id
            WHERE household_roles.household_id = households.id AND COALESCE(api_sessions.last_seen_at, api_sessions.issued_at) >= CAST(? AS text))
        ORDER BY households.id LIMIT ?`, [before, before, BATCH]),
      async (before, found) => {
        let applied = 0;
        for (const item of found) {
          try {
            const result = await erasure.eraseHousehold({ householdId: item.id, actor: SYSTEM, reason: ERASURE_REASONS.retentionExpired });
            if (lifecycle) await lifecycle.finish(item.id, result.documentIds);
            applied += 1;
          } catch { /* left for the next run */ }
        }
        return applied;
      });

      // A batch per run, like the other rules: the dry run reports the whole backlog, an apply deletes at most BATCH_ROWS of it.
      await rule('expiredSessions', retention.expiredSessionDays, async before => (await database.one(
        `SELECT count(*) AS count FROM api_sessions WHERE expires_at < CAST(? AS text) OR revoked_at < CAST(? AS text)`, [before, before])).count,
      async before => (await database.run(`DELETE FROM api_sessions WHERE id IN (SELECT id FROM api_sessions
        WHERE expires_at < CAST(? AS text) OR revoked_at < CAST(? AS text) ORDER BY id LIMIT ?)`, [before, before, BATCH_ROWS])).changes);

      await rule('deletedDocumentTombstones', retention.deletedDocumentTombstoneDays, async before => (await database.one(
        `SELECT count(*) AS count FROM document_uploads WHERE lifecycle_state = 'deleted' AND deleted_at < CAST(? AS text)`, [before])).count,
      async before => (await erasure.pruneDeletedDocuments({ deletedBefore: before })).pruned);

      // The ledger is reported, never deleted: it is the proof that an erasure happened.
      await rule('erasureLedger', retention.erasureLedgerDays, async before => (await database.one(
        `SELECT count(*) AS count FROM retention_records WHERE deletion_state IN ('deleted', 'verified') AND deleted_at < CAST(? AS text)`, [before])).count,
      async () => 0);

      // Housekeeping with fixed expiry that is already stored on each row (no new period).
      const housekeeping = {
        appEvents: dryRun ? Number((await database.one('SELECT count(*) AS count FROM app_events WHERE expires_at < now()')).count) : await appEvents.purgeExpired({ limit: 5000 }),
        idempotencyKeys: dryRun
          ? Number((await database.one('SELECT count(*) AS count FROM idempotency_keys WHERE julianday(expires_at) <= julianday(CAST(? AS text))', [clock().toISOString()])).count)
          : await documents.purgeExpiredIdempotency(clock().toISOString(), { limit: BATCH_ROWS }),
        expiredLocations: dryRun
          ? Number((await database.one(`SELECT count(*) AS count FROM household_places WHERE kind = 'current_location' AND expires_at <= ?`, [clock().toISOString()])).count)
          : await userData.purgeExpiredLocations(null, { limit: BATCH_ROWS }),
      };
      return { dryRun, ranAt: clock().toISOString(), rules, housekeeping };
    },
  };
}
