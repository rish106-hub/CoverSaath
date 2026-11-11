# User-data store: everything the app collects is stored in the backend, sealed (spec for P1, P2a, P2b, V1)

Status: **spec, nothing built.** Author: lead (Opus), 2026-11-01. Owner asked for this on 2026-11-01 (prompt 65): location permission, current location, registered address and "all of those details", encrypted, stored in the backend, with proof that nothing is bypassed. Supersedes the "B-B/B-C" order in `app-data-plan.md` for the tables below; the claims/payments/desk tables there stay later work.

Needs, per AGENTS.md: independent read-only review (migration + security + consent change), ADR 0014, local database only. Consent and permission wording is **not final: mark for legal review**.

## 1. Audit of today (facts, 2026-11-01)

Real backend writes: sign-up (household + owner), session, sign-out. Everything else the user types or taps is mock or lives only in the browser: Settings (`localStorage`), the Emergency "Allow location" button (no-op), onboarding choices, family add/invite (mock adapter), calculator inputs, compare weights, stress levers, review edits, sharing toggles. After a refresh these are lost. That is the gap this spec closes.

## 2. Rules (apply to every table below)

1. Column crypto is the E1 helper (ADR 0013) used by `household-app-repository.js` for member names. Bind the sealed value to table, column and row id (AAD). Fixtures and tests use synthetic data only.
2. What is sealed: every value a person typed, chose or that identifies where they are: address parts, coordinates, phone, free text, preference JSON, calculator inputs. What stays plain: ids, foreign keys, timestamps, revision counters and small closed enums that the database must constrain or query (permission name, state, place kind, tool name). Decision for the owner to confirm: the permission **state** (granted/denied) is a plain enum; if they want it sealed too it costs the CHECK constraint and the ability to query "who denied location".
3. Household ownership checked on every read and write, in the same transaction as the write (see B-A `MEMBER_PROTECTED` fix for the pattern). The session adult must be an adult of that household.
4. Every write appends an audit event (`action` names below). Audit payloads carry ids and field names, never values.
5. Every table gets RLS deny-by-default and no Data API grants (migration 016 pattern), an erasure path, and a test proving erasure.
6. Writes are idempotent `PUT` (replace) with an integer `revision`; a stale `If-Match` returns coded `409 REVISION_CONFLICT`. Payload cap 8 KB, unknown keys rejected, per-adult write rate limit of 60 per minute.
7. Location minimisation: `current_location` is stored rounded to 2 decimals (about 1 km) unless the request says `precision: "exact"` from the Emergency flow; it expires after 24 hours and is purged by a read-time filter plus a purge function. Revoking the location permission deletes it at once.

## 3. Migrations (numbered after the last one on `feat/app-data-ba`; B-A adds none, so 025 onward)

**025 `device_permissions`**: `id`, `household_id`, `adult_user_id`, `permission` CHECK IN (`location`,`notifications`,`contacts`,`calendar`,`microphone`,`camera`), `state` CHECK IN (`granted`,`denied`,`dismissed`,`revoked`), `surface` CHECK IN (`onboarding`,`emergency`,`settings`,`family`,`other`), `wording_version text`, `decided_at`, `updated_at`, UNIQUE (`adult_user_id`,`permission`).

**026 `household_places`**: `id`, `household_id`, `adult_user_id` NULL, `member_id` NULL, `kind` CHECK IN (`registered_address`,`current_location`,`saved_place`), `label_ciphertext` NULL, `payload_ciphertext` NOT NULL (JSON: address `{line1,line2,landmark,city,state,pincode,country}` or location `{lat,lng,accuracyM}`), `precision` CHECK IN (`exact`,`coarse`), `source` CHECK IN (`user_typed`,`device_gps`,`document`,`digilocker`), `captured_at`, `expires_at` NULL, `revision`. Partial unique indexes: one `registered_address` per (`household_id`,`member_id`); one `current_location` per `adult_user_id`. Address validation (6-digit pincode, state list) happens on the plaintext before sealing.

**027 `adult_preferences`** (PK `adult_user_id`; `household_id`; `prefs_ciphertext`; `schema_version`; `revision`; `updated_at`) holding Settings: sources, notification channels, sharing defaults, voice language, reduced motion, theme. **`onboarding_progress`** (PK `adult_user_id`; `state_ciphertext` with step, chosen way, people toggles, wallet choice; `completed_at`; `revision`).

**028 `tool_scenarios`**: `id`, `household_id`, `adult_user_id`, `tool` CHECK IN (`tax`,`premium_rise`,`hospital_bill`,`inflation`,`compare_weights`,`stress_levers`,`review_state`), `inputs_ciphertext`, `schema_version`, `revision`, `updated_at`, UNIQUE (`adult_user_id`,`tool`). Per-tool input validators live in `src/contracts/` (numbers bounded, enums closed).

**029 `adult_contacts`** (this is plan item 025 renumbered): `adult_users` gains `phone_ciphertext`, `phone_hash`, `contact_email_hash` UNIQUE (HMAC, lower-cased) with backfill; `POST /api/v1/access` returns the existing household for a known email and issues a fresh session (bootstrap-guarded, rate limited) so the beta form is idempotent.

Later, separate approval: household sharing grants, invites (plan item 026), dates and reminders, payments, claims, desk threads.

## 4. Routes (`/api/v1`, session bearer; the adult comes from the session)

| Area | Routes | Audit action |
|---|---|---|
| Permissions | `GET /households/{id}/permissions`; `PUT /households/{id}/permissions/{permission}` | `permission.set` |
| Places | `GET /households/{id}/places`; `PUT /households/{id}/places/{kind}?memberId=`; `DELETE /households/{id}/places/{kind}?memberId=` | `place.set`, `place.delete` |
| Preferences | `GET/PUT /households/{id}/preferences` | `preferences.set` |
| Onboarding | `GET/PUT /households/{id}/onboarding` | `onboarding.set` |
| Scenarios | `GET /households/{id}/scenarios`; `GET/PUT /households/{id}/scenarios/{tool}` | `scenario.set` |
| Access | `POST /access` | `access.reused` / `access.created` |

Revoking `location` (PUT state `revoked` or `denied`) deletes that adult's `current_location` in the same transaction. Removing a member (B-A `DELETE /members/{id}`) deletes that member's places; extend the existing `MEMBER_HAS_RECORDS` check accordingly. Household erasure deletes all rows above.

## 5. BFF and UI wiring (P2a, P2b) and the field matrix (V1 asserts this)

BFF routes under `/api/app/*` map 1:1 (same-origin guard + sealed cookie). Browser adapters replace mocks and `localStorage`. Every save shows a small state next to the control: "Saving", "Saved", or "Could not save, retry"; failures never drop the user's input silently. Theme keeps a `localStorage` copy only as a first-paint cache; the backend value wins after load.

| UI control (file) | Stored as | Table |
|---|---|---|
| Beta sign-up name, email (AccessCard) | household + owner | existing |
| Sign-in phone (SignIn) | `phone_ciphertext` | 029 |
| Allow location (EmergencyView, Flow) | permission `location` | 025 |
| Browser GPS result (EmergencyView) | `current_location` | 026 |
| Registered address (new field in Settings and onboarding people step) | `registered_address` | 026 |
| Saved places (Emergency "Home / Work") | `saved_place` | 026 |
| Notification and wallet permissions | permission rows | 025 |
| Settings: sources, notify, sharing, voice, reduced motion, theme (SettingsView, ThemeProvider) | preferences | 027 |
| Onboarding step, way, people toggles (Flow) | onboarding | 027 |
| Add member / relation / mobile / channel (AddMemberSheet, FamilyView) | members (B-A) + invites (later) | existing |
| Tools: regime, premiums, cover, rates, share (ToolsPage) | scenarios `tax`, `premium_rise`, `hospital_bill` | 028 |
| Inflation planner who, case, rate, years | scenarios `inflation` | 028 |
| Compare kind, band, weights, scenario | scenarios `compare_weights` | 028 |
| Stress who, scenario, levers | scenarios `stress_levers` | 028 |
| Review accept/edit state (ReviewView) | scenarios `review_state` | 028 |

V1 (`npm run verify:persistence`, frontend repo, plus a backend SQL helper): signs up Meera Rao through the BFF, performs every write above through the BFF, reads Postgres directly (loopback only, database name must not be `coversaath_dev`), asserts one row per item, asserts no plaintext fragment of any submitted value appears in any column of those tables, asserts a cross-household read is refused, asserts revoking location erased the current location, then prints this matrix with PASS/FAIL per row and exits non-zero on any FAIL. A static test in the frontend lists every `useState` holding user input in the files above and fails when one is not wired to an adapter write (allow-list for pure view state such as open/closed).

## 6. Order of work (each a Sonnet medium worktree, lead reviews)

1. B-A final and merged locally (in progress), plus `fix/ports-test-column-crypto`.
2. **P1** migrations 025-029 + routes + tests + docs (branch off B-A).
3. Independent read-only review of P1 (fresh agent, no edit rights) + ADR 0014.
4. **P2a** BFF + adapters + Settings + Emergency location + onboarding + address field; **P2b** tools, compare, stress, review, family.
5. **V1** verify script; run it; paste the real matrix into jtbd.md.
6. Only then Supabase, and only on the owner's say-so.

## 7. Owner decisions

- D6 (implicit yes by request): these tables. Confirm sealing of permission state (section 2.2).
- D10: current location kept 24 hours at about 1 km, exact only in Emergency. Confirm or change.
- D11: do we need the registered address collected at sign-up, or only in Settings and onboarding?
