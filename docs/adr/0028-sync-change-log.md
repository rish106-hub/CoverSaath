# ADR 0028: Sync change log (pull by cursor, snapshot, batched idempotent push)

Status: accepted for the prototype (synthetic data only), pending independent read-only review. This is the sync half; the isolated demo is a later slice. Design: `docs/exec-plans/active/full-system-design.md` section 5. Migration `046_sync_change_log.sql` (renumbered from 031 when rebased onto main at 044; numbers need not be contiguous).

## Context

Two tabs or devices, a flaky network, a refresh and a return after days must converge without losing input. Owner decisions (all recommendations approved): per-household change log; pull by `since` seq; push as batched idempotent mutations; polling first, no SSE; revision mismatch returns the server copy; disjoint-key JSON entities auto-merge; money, policy and member entities never auto-merge; an update of a deleted row returns DELETED.

## Decisions

**D1. Change log written by trigger.** `household_changes(seq, household_id, entity, entity_id, op, revision, subject_adult_id, actor_adult_id, at)`; an AFTER INSERT/UPDATE/DELETE trigger on each synced table writes it, so a route, script, backfill or hand-run SQL cannot change synced data without a cursor entry. It holds ids, revisions and operations only, never a value (tested). Attached today to `household_members`, `household_places`, `adult_preferences`, `onboarding_progress`, `tool_scenarios`, `device_permissions`, `policies`, `service_cases`, `document_uploads`. Later migrations attach theirs with `SELECT public.attach_household_sync('public.<table>', '<entity>'[, '<id column>', '<scope>'])` (rerunnable; scopes `household`, `adult`, `place`).

**D2. Revision trigger that cannot double-bump.** `touch_revision_fn` bumps `revision` (and `updated_at`) only when the writer did not (`NEW.revision = OLD.revision`). The 025-029 repositories bump it themselves and are untouched; a direct SQL UPDATE that forgets still gets a new revision. Attached (BEFORE UPDATE) only where a `revision` column exists: the five user-data tables. `household_members`, `policies`, `service_cases` and `document_uploads` have no revision column and log revision 1 (they are not pushable; a revision column is a later migration's call).

**D3. Seq order is commit order per household.** The log trigger takes the household advisory lock (same key as `locks.js`, computed in SQL) before it allocates a seq, and the lock is held to the end of the transaction. A reader that saw seq N therefore cannot miss a smaller seq that commits later. The application already holds that lock (re-entrant); a direct SQL writer takes it at its first logged row. Cost: writers to one household serialise (already true for the user-data paths); a direct SQL transaction that holds row locks and then logs can deadlock with an app write, which PostgreSQL resolves by aborting one.

**D4. Actor.** `set_config('knowvia.actor', <adult id>, true)` (SET LOCAL) is set inside each user-data write transaction, after ownership is proved, and once for a push. It dies with the transaction. Writes that never set it (direct SQL, members/policies repositories, system purges) log no actor.

**D5. Pull.** `GET /households/{id}/changes?since=&limit=&include=data`: `limit` 1..200 (default 100; above is 400), `include=data` returns the current decrypted entity read through the existing readers, stopping at 256 KB (always at least one item; `hasMore` and `next` resume exactly). `next` is the last scanned seq. Served entities: members, policies, places, preferences, onboarding, scenarios, permissions. `service_cases` and `document_uploads` are logged but not served until they have readers and a visibility rule. Rows only one adult may see (preferences, onboarding, scenarios, permissions, a current location) carry `subject_adult_id` and are shown to that adult alone. A place another member may not read (another adult's own address) is hidden from the feed; its delete shows an id only.

**D6. Snapshot.** `GET /households/{id}/snapshot?cursor=` pages every served entity (200 items or 256 KB per page). The first page reads `seq` (never below `min_seq`) before any entity; the cursor carries it, so every page reports the same `seq`. Consistency is convergence, not isolation: an entity edited after `seq` may appear in its newer state, and its log entry (greater than `seq`) re-delivers that same state, so snapshot then `changes?since=seq` equals the final state (tested with writes between pages). The client continues from `seq` once `hasMore` is false.

**D7. Retention.** The log is trimmed after 30 days by `SyncRepository.purgeChangeLog()` (SQL `purge_household_changes`), which raises each affected household's `household_sync_state.min_seq` to the highest seq removed and also deletes expired push records. A `since` below `min_seq` (or beyond the household's newest seq) is `410 CURSOR_EXPIRED`; the client takes a snapshot. Scheduling: nothing in this repository runs it. A daily Fly/Supabase cron or the existing housekeeping interval can call it; no infrastructure was added. Until it runs the log only grows (about one small row per write).

**D8. Push.** `POST /households/{id}/sync/push` takes 1..50 `{mutationId, entity, id, op, baseRevision, data, baseData?}` (body at most 1 MB, each `data` and `baseData` at most 8 KB). One transaction under the household lock; each item in its own savepoint; the household check is made first, in the same transaction family as every other route. Items are applied only through the existing user-data service methods (so validation, roles, sealing, revision checks, location rules and per-write audit are exactly those of the PUT routes); the push passes `skipThrottle` for its items and has its own limit of 30 pushes a minute per adult. Supported: `places` (upsert, delete), `preferences`, `onboarding`, `scenarios`, `permissions` (upsert). Anything else is a per-item `rejected` (`SYNC_ENTITY_UNSUPPORTED`, `SYNC_OPERATION_UNSUPPORTED`, `SYNC_ID_MISMATCH`, `INVALID_REQUEST`, ...), never a failed batch. `baseRevision` is required (0 means "I believe it does not exist"), so a blind overwrite is impossible.

**D9. Idempotency.** `idempotency_keys` scope `sync:<adult>`, key `<household>:<mutationId>` (the household prefix stops one id aliasing across households and lets erasure find them), 7 day TTL. The record holds a status, code and revision and a keyed HMAC of the request (`blindIndex`), never a value. A replay returns the recorded outcome with `replayed: true` (conflicts and merges re-read the server copy); the same id with a different body is `MUTATION_ID_REUSED`. Applied, merged and conflict outcomes are recorded; rejections are not (they are deterministic and cheap to recompute, and a role change should not be masked by a stored refusal).

**D10. Conflict table.**

| Situation | Result |
| --- | --- |
| `baseRevision` equals the server revision | `applied`, new revision |
| Stale, entity is places, permissions or onboarding | `conflict` `REVISION_CONFLICT` with `serverCopy` (never merged) |
| Stale, preferences or scenarios, `baseData` given, changed keys disjoint (or both sides set the same value) | `merged`: client changes applied onto the server copy, new revision, merged `data` returned |
| Stale, preferences or scenarios, overlapping keys or no `baseData` | `conflict` with `serverCopy` |
| Update where the row no longer exists (`baseRevision` above 0) | `conflict` code `DELETED`, no copy |
| Delete of a place that is already gone | `applied` (idempotent) |
| Delete with a stale revision | `conflict` with `serverCopy` |
| Same `mutationId`, same body | recorded outcome, `replayed: true` |
| Same `mutationId`, different body | `rejected` `MUTATION_ID_REUSED` |

Merge granularity is the top-level key of the document (`prefs`, scenario `inputs`) and, for `review_state`, each entry of `items`. The merged document passes the same validator as a PUT.

**D11. Erasure.** `household_changes` and `household_sync_state` cascade from the household; `SyncRepository.eraseForHousehold` deletes both plus the push records and writes a counts-only audit (`sync.erased`). It must run after `UserDataRepository.eraseForHousehold` (that erasure logs its own deletes). No household-delete flow exists (ADR 0015 D5), so no production caller exists yet; the flow that adds one must call both. Tested, including the cascade.

**D12. Audit.** `sync.push` (item counts by outcome), `sync.snapshot` (first page, `seq`) and `sync.log_purged` (counts), ids and numbers only. Polling is not audited (the user-data GETs are not either).

## Consequences

- Hard to reverse: written rows. Rollback is to stop calling the routes; the triggers can be dropped with `DROP TRIGGER <table>_sync_log` / `_sync_touch` and the two tables left unused (nothing else depends on them). The migration is expand-only.
- Per-process rate limits (one machine).
- Contract the web/BFF repos depend on: the three routes above, the `sync` result statuses and `CURSOR_EXPIRED`.

## Unverified and known limits

- No measured load: the 20 s polling interval, the 240 reads a minute and 30 pushes a minute are guesses. No capacity claim.
- The 256 KB budget is tested with a small override (700 bytes); real entities (at most 16 KB sealed each) rarely reach it, so the production figure itself is not exercised.
- Snapshot is convergent, not point-in-time isolated (D6); an observer reading one page cannot tell an entity was already newer.
- `places` visibility uses `listPlaces` (limit 100, existing reader); a household with more than 100 visible places would hide the rest from the feed until that reader pages.
- Members, policies, cases and documents are not pushable; cases and documents are not served. They need readers, revisions and visibility rules first.
- Merge uses a client-supplied `baseData`; a client that omits it never merges (safe, but conflicts more). A server-side per-revision history would remove the need and costs storage.
- Trigger-taken advisory lock on `document_uploads` updates adds contention for scan workers that update rows without the household lock; not measured.
- The log trigger runs inside the same transaction as the write, so a slow log insert slows the write. Not measured.
- Purge is not scheduled.
- Real deletion of a household was only tested with synthetic SQL rows (the application cannot delete one).
- Independent read-only review is still required (migration, security, consent-adjacent data paths).
