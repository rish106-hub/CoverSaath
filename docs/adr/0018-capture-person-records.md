# ADR 0018: Person records and member details (capture slice 1, migration 032)

Status: accepted for the prototype (synthetic data only). Every consent, notice, health-data and children's-data wording and rule here is a draft that is not final and needs legal review (India DPDP Act 2023: notice, purpose-bound consent, verifiable parental consent for children, correction, erasure, access) before any real user data. Design: `docs/exec-plans/active/capture-everything-design.md` (sections 3 to 5, store B). Owner decisions applied: hybrid storage; health context collected, optional, closed lists, never sent to a model; never-collect list enforced by validators; dependants under 18 keep an age band only; transcripts not stored; policy numbers in a later slice.

## Context

The app can hold only a few kinds of typed data in the backend. The design asks for a typed, validated, sealed, owner-checked, audited and erasable home for the long tail of facts a person can enter (health context, nominees, emergency contacts, advisors, notes, out-of-pocket spend) and for richer member details (gender, age band, mobile, e-mail, preferred channel, who a member depends on).

## Decisions

**D1. Hybrid storage.** Values the database must join, constrain or sum stay in relational tables (later slices). Long-tail values nobody queries inside live in one sealed table, `person_records` (migration 032): one row per (household, subject member, record type, slot), payload sealed with the ADR 0013 column crypto and bound to table, column and row id (AAD). Plain: ids, the closed `record_type`, `source`, `state` and `completeness` enums, `schema_version`, timestamps and the integer `revision`. Adding a record type is a contract change plus a CHECK-list migration, not a new table. Member columns added in the same migration: `gender`, `age_band`, sealed `mobile_ciphertext` and `email_ciphertext`, `mobile_hash` (keyed HMAC, unique per household, lookup only), `preferred_channel`, `lives_with_household`, `dependent_on_member_id`, `guardian_member_id`, `revision`, `deleted_at` (reserved for sync).

**D2. One registry.** `src/contracts/capture-registry.js` is a closed registry of seven record types (`self_profile`, `health_context`, `nominee`, `emergency_contact`, `advisor`, `member_note`, `out_of_pocket_spend`) with a descriptor per field (type, enum, bounds, caps). The validator, `completeness` and `GET /api/v1/capture-schema` all read the same descriptors. Strict keys, 8 KB body cap (`413 PAYLOAD_TOO_LARGE`), NFC text with no control, bidi or separator characters, integer bounds, phone numbers stored as E.164 and dates as `YYYY-MM-DD`. `completeness` (empty, partial, complete) is computed by the server. `source` is client-supplied from a closed list; `state` is set by the server (typed values are `user_stated`; voice, document, digilocker and import values are `extracted_unverified`). There is no route that sets `confirmed_by_user` yet.

**D3. Routes (session bearer, household ownership in the same transaction).** `GET /api/v1/capture-schema`; `GET /households/{id}/records?type=&memberId=`; `GET|PUT|DELETE /households/{id}/records/{type}/{slot}?memberId=`. PUT replaces and takes an integer `revision` via `If-Match` (`409 REVISION_CONFLICT`; `0` means create-if-absent). The existing `POST|PATCH /households/{id}/members` accept the new detail fields; PATCH takes `If-Match` too. Writes are limited to 60 per adult per minute per process. A type has a slot cap (`RECORD_CAPACITY_REACHED`, 429). Every write appends a counts-only audit event (`record.set`, `record.delete`, `household_member.*`) naming ids and fields, never values.

**D4. Guardian rule.** A dependant's records, and anyone's `health_context`, need the household owner, the member themself, or the member's guardian adult (`guardian_member_id`); otherwise `GUARDIAN_REQUIRED` 403. Another real account holder's records are `MEMBER_PROTECTED` (same rule as member and place edits). Viewers cannot write.

**D5. Consent.** `health_context` needs a current grant with data category `health_profile`, `nominee` one with `family_data`. No schema change to `consent_grants` or `consent_scopes`: the grant's `purpose` is the existing `profile_intake`, the scope is `resource_type = profile_field`, `action = collect`, `data_category` as above, held by the acting adult in that household and not revoked or expired. No grant gives `403 CONSENT_REQUIRED`. Revoking the grant erases every household record of the types that category gates, in the same transaction as the revocation (`ConsentRepository.revoke`, audit `person_records.erased`, counts only). Erasure is by household and category, not by the grantor, because records carry no author column. Health context is never inferred, scored, summarised or sent to a model.

**D6. Never-collect list.** `src/contracts/sensitive-identifiers.js` rejects, in any free-text field (registry texts, member names and labels, place and review text), a 12-digit Aadhaar shape, 13 to 19 digit card shapes, a PAN, a CVV/CVC label with digits, and password, UPI/ATM PIN or one-time-code labels with a value: `400 SENSITIVE_IDENTIFIER_REJECTED`. The message names the field and never echoes the value; the value is never logged or audited. The detector is a blunt safety net, not a guarantee. A 91-prefixed phone with no separators is 12 digits and is refused in free text (phone fields have their own validator).

**D7. Children.** A member under 18 keeps an `age_band` and never a date of birth, and has no mobile or e-mail. A dependant may hold contact details only when an age band of 18 or more is known. Adults may hold a date of birth. This tightens the earlier member route, which accepted a date of birth for a dependant.

**D8. Erasure.** Removing a member deletes that member's person records (counted in the `household_member.removed` audit). `UserDataRepository.eraseForHousehold` deletes the household's `person_records`. `person_records` is `ON DELETE CASCADE` from the household and the member as a safety net, and a trigger (`person_records_scope_insert`, `_update`) refuses a record whose member belongs to another household.

**D9. Lockdown.** Row level security is on with no policy and `anon` and `authenticated` hold no privileges (the 016 pattern); `tests/rls-coverage.test.mjs` and a table-specific test cover it.

## Consequences

- Migration 032 is expand-only and rerunnable. Numbers 030 and 031 belong to the auth and sync slices; the sync slice attaches revision and change-log triggers to `person_records` and `household_members` later (a marked comment in the migration).
- Mobile and e-mail of a real adult other than the viewer stay hidden unless that adult granted field access; those of a not-yet-invited placeholder adult are visible to the household that typed them.
- The mobile hash is a keyed HMAC of the data key: rotating the data key requires recomputing it (same as ADR 0015 D6a).
- Not built here: policies, dates, money, claims, desk, invites, export; the user tap that confirms an unverified value; amount strings such as "5 lakh" (amounts are integer paise); `member_note` through the member routes (use the records route).

## Rollback

Application: revert the commits. Database: the migration only adds objects. To undo, drop `person_records` and the added `household_members` columns and constraints after confirming nothing needs them; no existing value was changed.
