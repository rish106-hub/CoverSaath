# ADR 0015: User-data store (permissions, places, preferences, onboarding, scenarios, contact lookup)

Status: accepted for the prototype (synthetic data only). Permission and location wording, retention and the 24 hour location expiry are drafts for legal review. The spec was absorbed into this ADR and [data.md](../architecture/data.md) and deleted.

## Context

Until now only sign-up, session and sign-out reached the backend. Settings, the Emergency location button, onboarding choices, calculator inputs and similar state lived in the browser and were lost on refresh. The owner asked for all of it, including location, to be stored in the backend, encrypted, with proof that nothing is stored in the clear.

## Decisions

**D1. Sealed values (migrations 025 to 029).** Everything a person typed, chose or that says where they are is sealed with the column crypto of ADR 0013, bound to table, column and row id (AAD), and a CHECK constraint on each `*_ciphertext` column forces the `enc1.`/`enc2.` envelope. Plain: ids, foreign keys, timestamps, revisions and small closed enums the database constrains (permission, state, place kind, tool).

**D2. Ownership and audit.** The adult comes from the session and must belong to the household, checked in the same transaction as the write. A viewer manages their own data but not household places. Every write appends an audit event (`permission.set`, `place.set`, `place.delete`, `preferences.set`, `onboarding.set`, `scenario.set`, `access.*`) carrying ids and field names, never values.

**D3. Revisioned idempotent PUT.** Integer `revision`, stale `If-Match` is `409 REVISION_CONFLICT`, 8 KB cap, unknown keys rejected, 60 writes per adult per minute.

**D4. Location minimisation.** `current_location` needs a granted `location` permission, is rounded to about 1 km unless Emergency asks for `exact`, is hidden after 24 hours at read time and removed by a purge, and is deleted in the same transaction when the permission becomes `denied` or `revoked`.

**D5. Erasure.** Removing a member deletes that member's places. `UserDataRepository.eraseForHousehold` deletes every household row in the five new tables (`device_permissions`, `household_places`, `adult_preferences`, `onboarding_progress`, `tool_scenarios`; audit `user_data.erased`, counts only). The sealed `adult_users` columns (`phone_ciphertext`, `phone_hash`, `contact_email_hash`) live on the adult row and go with it. There is no household-delete or household-erasure flow yet (audit rows and household roles reference a household without cascade, by design), so `eraseForHousehold` has no production caller; the flow that adds one must call it. Every foreign key of the new tables is ON DELETE CASCADE as a safety net (tested from the catalogue).

**D6. Contact lookup (029).** `phone_ciphertext`, `phone_hash` and `contact_email_hash` (keyed HMAC derived from the data key, unique) make `POST /api/v1/access` idempotent per e-mail (bootstrap-guarded). `scripts/backfill-adult-contacts.mjs` hashes older adults; a shared e-mail is skipped, never merged.

**D4a. Lazy location purge.** An expired coordinate is unreadable at once (the read filter), but is physically deleted only on the owner household's next places call; the purge is scoped to that household and a request never deletes another household's rows. `purgeExpiredLocations()` with no argument is for a maintenance job only (none runs yet).

**D6a. Key rotation.** The contact hashes are keyed by a value derived from the data key, so after a key rotation `POST /access` will not find existing adults and would create duplicates. Rotating the data key therefore REQUIRES recomputing `contact_email_hash` and `phone_hash` first. No tool does this yet (`--rehash` was promised in a comment and is removed); a test shows a different key finds no adult. Do not rotate the key until it exists.

**D7. Verification.** `npm run verify:user-data` (`DATABASE_URL`, loopback only, never `coversaath_dev`, read-only) reports row counts and how many `*_ciphertext` values lack the sealed prefix; it prints no values and exits 1 on any plaintext. A URL with query parameters is refused (they can override host and database) and the client is built from the validated host, port and database.

## Consequences

- Hard to reverse: written rows (removed only by the erasure paths). Migrations are additive; rollback is to stop calling the routes and leave the tables unused. 029 only adds nullable columns.
- Open owner decisions: seal the permission state too (costs the CHECK and querying), exact location only in Emergency, address at sign-up or only later.
- Per-process rate limit applies (one machine). No capacity claim is made.
- Not covered: household sharing grants, invites, payments, claims, desk threads. Independent read-only review is still required before merge.

## Known limits (follow-ups, behaviour unchanged)

- `If-Match` is optional on PUT: a client that omits it overwrites without a conflict check.
- `surface` on a permission is client-supplied and not trusted for any decision.
- `POST /access` is bootstrap-guarded but has no separate per-e-mail rate limit.
- A 409 for a revision mismatch does not distinguish a stale write from a concurrent create.
- AAD binds table, column and row id but not the household, so a sealed value copied between rows of the same column id space is bound only by row id.
