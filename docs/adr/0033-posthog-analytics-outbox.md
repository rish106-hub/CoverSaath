# ADR 0033: Product analytics through a consent-gated outbox (PostHog)

- Status: Accepted (2026-11-11), off by default (`ANALYTICS_ENABLED`). Not independently reviewed (standing order).
- Synthetic data only. The analytics purpose, its notice and its consent wording are an engineering reading and are **FOR LEGAL REVIEW**; `complete.md` D6 keeps `ANALYTICS_ENABLED=false` until the S5 notices name analytics as a purpose.
- Related: ADR 0018 (purpose registry), 0030 (provider calls), 0011 (hosting), plan `docs/exec-plans/active/complete.md` section 4 (event spec) and D6.

## Context

The plan wants product analytics without ever sending content. Server-side events fit the architecture (no browser calls to the API, no personal data in a client SDK), and the worker already exists.

## Decisions

**D1. Nine allowlisted events, no free text.** `src/contracts/analytics-events.js` lists the events (`cover_uploaded, insurer_confirmed, parse_completed, conflict_resolved, declaration_added, premium_recorded, chat_turn, voice_turn, hospital_search`) and, per event, the only property keys allowed, each a closed vocabulary, a bounded whole number or a boolean. No name, policy number, UIN, address, message or amount fits any shape. An unlisted key or a value outside its shape rejects the whole event. The allowlist is validated on enqueue, again on drain, and mirrored (with a drift test) in the app.

**D2. Outbox table `analytics_outbox` (057).** `id, household_id, event, distinct_id_hash, properties_json, created_at, sent_at`. Events are written by `track()` (never throws, never blocks a user flow) and sent by a worker timer (`ANALYTICS_DRAIN_MS`, default 15 s) through the PostHog adapter (`src/integrations/posthog/`, `posthog-node` pinned, imported only through `src/integrations/index.js`). Rows are locked `SKIP LOCKED` while sent. A failed send leaves the row for the next drain (no retry inside the SDK, five-second timeout). Sent rows are purged after seven days.

**D3. Gates, all of which must hold to store a row:** `ANALYTICS_ENABLED` is exactly `true`; `ANALYTICS_DISTINCT_ID_SALT` is 16+ characters; the household holds an active `analytics` consent grant with the scope `{ resource_type: household, action: share, data_category: usage_events, recipient: posthog }`. The drain re-checks the grant per household before sending and deletes the unsent rows of a household that withdrew. With no `POSTHOG_API_KEY` or `POSTHOG_HOST` (https only, never defaulted) no client exists and nothing is read or sent. Migration 057 widens two CHECKs (grant purpose `analytics`, scope resource type `household`); nothing is removed.

**D4. Distinct id is a keyed hash.** `HMAC-SHA256(household_id, ANALYTICS_DISTINCT_ID_SALT)`, hex. The raw household id is never sent, never in `properties_json`. Rotating the salt starts a new identity per household (old events stay under the old hash). GeoIP is off and `$process_person_profile` is false, so PostHog creates no person profile.

**D5. Erasure.** The table is household-linked (a deviation from the minimal column list, chosen so erasure is one `DELETE ... WHERE household_id = ?` and is provable in the erasure world). Household erasure deletes the rows; withdrawal drops unsent rows at the next drain. Events already delivered to PostHog are outside this database: deleting them is a PostHog project operation and a retention question for legal review (the plan has no period yet).

**D6. Registry.** `analytics` is a purpose in `src/contracts/data-purposes.js` (notice `notice_analytics`, consenter self, retention until consent ends); `analytics_outbox` is in the data registry, the lifecycle map and the column audit. `distinct_id_hash` is classified as a derived identifier and `properties_json` as derived content.

## Consequences

- Event points that exist today are wired at the route layer (document upload, product confirmation, conflict resolution, declaration, premium, chat turn) and in the holdings memorise step (parse completed). `voice_turn` (no audio duration is known server side) and `hospital_search` (routes land with the network-hospitals branch) are allowlisted but not yet emitted.
- A new dependency, `posthog-node`, is added with a measured need: the plan names PostHog and the SDK owns batching, timeouts and the wire format.
- Rollback: set `ANALYTICS_ENABLED` off (nothing stores or sends); the table and widened CHECKs are expand-only and can stay.
