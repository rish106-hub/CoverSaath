# Full system design: auth + JWT, sealed real-time capture, sync, isolated demo

Status: **design only, nothing built.** Author: Sonnet 5.5, 2026-11-03, base `main` 23ab6d6. Owner asks (2026-11-03): complete schema, every data point sealed in real time, push and fetch syncing, working login incl. OAuth, JWT for the web app, a schema for the demo data, and a **"View demo" button on top with the demo fully isolated from the real path**.
Companion files: `schema-v2-reference.sql` (DDL, reference only), `capture-everything-design.md` (field catalogue; its section 7 migration numbers are superseded by section 8 here).

Needs before any build: owner answers (section 11), ADR 0016 (auth) and 0017 (sync + demo), a new dependency decision (`jose`), independent read-only review for every migration, auth, consent and security slice, local database only. Consent, notice and privacy wording is not final: legal review.

Correction to AI.md: `POST /api/v1/identity-sessions` already exists on `main` (ADR 0012 D3, migration 017). It is off until a server credential is set and the BFF does not call it yet. "No login routes" is stale.

## 1. Architecture at a glance

```
Browser ──(sealed httpOnly cookie, same-origin, CSRF guard)──> Next.js BFF ──(Bearer JWT, server to server)──> Knowvia API ──> Postgres
   real path :  /signin  /home ...  cookie __Host-kv_session   API /api/v1/**         household.kind = 'real'
   demo path :  /demo/** (View demo)  cookie __Host-kv_demo    API /api/v1/demo/**    household.kind = 'demo'  (clone of 'template')
```

The browser never sees a token and never calls the API (ADR 0012 D1). "JWT for the web app" means the BFF holds a short-lived JWT access token and a rotating refresh token inside a sealed cookie.

## 2. Login and credentials

Passwordless by default. No password table: nothing to breach, nothing to reset. Methods, in build order:

| # | Method | How | Cost / owner action |
|---|---|---|---|
| 1 | Beta access (exists) | name + e-mail to `POST /access`, bootstrap-guarded | none; close when open sign-up ships |
| 2 | Google OIDC | BFF runs auth code + PKCE + state + nonce, verifies the `id_token` against Google's JWKS, then calls `POST /identity-sessions {issuer, subject}` | free; owner creates the Google Cloud OAuth client |
| 3 | E-mail one-time code / magic link | `auth_challenges` (kind `email_otp` / `magic_link`), 6 digits, 10 min, 5 attempts, keyed hash only | needs an e-mail provider; free tier exists; owner approves |
| 4 | Apple Sign in | same flow as Google; Apple sends the name once, capture it on first sign-in | paid Apple Developer account; owner approves |
| 5 | Phone OTP | `auth_challenges` kind `phone_otp` | SMS provider + India DLT registration (paid, slow); owner approves, build last |
| 6 | Passkeys (WebAuthn) | `webauthn_credentials` holds the public key only | free; phishing-resistant; build after 3 |

Rules for every method:
- Identity key is `(issuer, keyed hash of subject)` in `auth_identities`, never an e-mail address (ADR 0012 D3). Issuer comes from an allow-list.
- **No auto-link by e-mail.** Linking a second method needs a fresh session (re-auth within 5 minutes) and writes `linked_via_session_id`.
- Sign-in creates or reuses exactly one adult and one household (`session_capacity` lock as today). Revoked identity stays burned.
- Recovery = redo a verified method. There is no support back door.
- Notice acceptance (`notice_acceptances`) is recorded at sign-up and on each notice version; health, children and location notices are separate rows.
- Rate limits: per destination hash 5 codes/hour, per IP prefix 20 challenges/hour, per identity 10 sign-ins/hour. Failed verification gives one generic coded error (no enumeration).
- Every sign-in, refresh, reuse, sign-out and link writes an audit event with ids only.

## 3. JWT design

- **Issuer: the Knowvia API** (it owns sessions and revocation). Algorithm **EdDSA (Ed25519) only**. Library: `jose`, pinned, with `algorithms: ['EdDSA']`, required `iss`, `aud`, `exp`, `sub`, `sid`. Hand-rolled JWT is rejected (algorithm-confusion and claim-check mistakes). Needs ADR 0016 because it adds a dependency.
- **Access token**: lifetime 10 minutes.
  `{ iss:"https://api.knowvia…", aud:"knowvia-bff", sub:<adult id>, hid:<household id>, sid:<session id>, jti, iat, exp, scp:["household:rw"], amr:"google", knd:"web" }`.
  No name, e-mail, phone or any personal data in a token.
- **Refresh token**: opaque 256-bit random, stored only as keyed hash in `auth_refresh_tokens`. Rotates on every use, 30-day sliding, 90-day absolute (`api_sessions.absolute_expires_at`). **Reuse of a used token revokes the whole session** (`revoked_reason = refresh_reuse`).
- **Revocation is instant**: the API checks `api_sessions.revoked_at` for `sid` on every request (indexed primary-key read). A valid signature is necessary, not sufficient.
- **Keys**: private key in a Fly secret per `kid`; public JWKS in `auth_signing_keys`; states `next → active → retiring → revoked`; rotate every 90 days with a 15-minute overlap. JWKS at `/.well-known/jwks.json`, loopback and BFF host only (the API still answers 403 to unknown hosts).
- **BFF handling**: sealed AES-GCM cookie `__Host-kv_session` (Secure, HttpOnly, SameSite=Lax, Path=/) holds `{access, refresh, exp}`. The BFF refreshes single-flight 60 seconds before expiry or on a 401, then rewrites the cookie. State-changing BFF routes keep the same-origin guard plus a per-session CSRF token header.
- **Compatibility**: today's opaque bearer (`session_kind = 'bearer'`) keeps working for scripts and tests. `POST /identity-sessions` gains `?format=jwt` and returns `{accessToken, refreshToken, expiresIn}`. Nothing existing breaks.
- **Endpoints added**: `POST /auth/refresh`, `POST /auth/signout` (one session) , `POST /auth/signout-all`, `GET /auth/sessions` (the person's devices), `DELETE /auth/sessions/{id}`, `POST /auth/challenge`, `POST /auth/verify`, `POST /auth/link`.

## 4. Real-time sealed capture (how "everything is encrypted as it is stored" holds)

1. A write request is validated against the capture registry, sealed with the E1 column helper in the same request, and inserted in one transaction. The ack is sent only after commit. No queue, no async step, no plaintext buffer on disk.
2. Sealed columns: every typed value, identifier, free text, JSON payload (`*_ciphertext`, `^enc[12][.]` CHECK, AAD = table.column.row id). Plain: ids, FKs, closed enums, dates, revisions, and the **amounts the deterministic code ranges over** (section 11, D10).
3. Lookup by keyed HMAC columns only (phone, e-mail, receipt ref); never by plaintext.
4. Reads decrypt per page (list cap 200) in the API; the BFF forwards over TLS. Measure with `scripts/soak.mjs` before any capacity claim.
5. **Optional crypto-shred (D9)**: `household_keys` gives each household its own data key wrapped by a master key. Erasure destroys the key, which also defeats retained Supabase backups. Today one key covers all rows.
6. Proof: plaintext-scan helper reads every column of every capture table directly and fails if any submitted value appears (extends `verify:persistence`).

## 5. Push and fetch sync

Goal: two tabs/devices, flaky network, refresh and return-after-days all converge without data loss.

**Versioning.** Every synced row has `id`, `revision` (bumped only by DB trigger), `updated_at`, and a tombstone (`deleted_at`) where deletes must propagate.

**Change log.** `household_changes(seq, household_id, entity, entity_id, op, revision, actor, at)`, written by an AFTER trigger on every synced table, so no route, script or backfill can change data without a cursor entry. The log holds no values.

**Fetch (pull).**
- `GET /households/{id}/changes?since=<seq>&limit=200[&include=data]` returns `{items:[{seq, entity, id, op, revision, data?}], next, hasMore}`. `include=data` adds the decrypted entity (bounded by 200 items or 256 KB).
- `GET /households/{id}/snapshot?cursor=` pages every entity at one consistent `seq`; used for first load and when `since` is below the low-water mark (`410 CURSOR_EXPIRED`).
- Log is trimmed after 30 days; `household_sync_state.min_seq` records the floor.

**Push.**
- `POST /households/{id}/sync/push` takes up to 50 `{mutationId, entity, id, op, baseRevision, data}`. Each item is its own savepoint; the response lists `applied | conflict | rejected` with the new revision or the server copy.
- Idempotent: `mutationId` is stored in `idempotency_keys` (scope `sync:<adult>`); a retry returns the first result.
- Conflicts: `baseRevision != current` returns `409`-style item result with the server copy. Disjoint-key JSON entities (preferences, scenarios, review state) merge automatically; money, claims, policies, members never auto-merge (client shows both). Update of a deleted row returns `DELETED`.

**Live updates.** Phase 1: BFF polls `changes` every 20 s while the tab is focused and on focus/online events (works with the Supabase pooler, no new infrastructure). Phase 2 (only if measured need): `GET /households/{id}/events` server-sent events carrying only `{seq}`; one machine, so in-process fan-out.

**Client.** Forms write through a small outbox (queued mutation ids) so a refresh or offline moment never drops input; UI states "Saving", "Saved", "Could not save, retry" (spec 5). Server time is authoritative; client time is informational.

## 6. Isolated demo ("View demo")

Requirement: a **View demo** button in the top bar (landing and signed-out pages, and a small "Exit demo" in-app) opens a full, believable Knowvia with the synthetic Rao family, **sharing nothing with the real path**.

**Isolation rules (all enforced, none by convention):**

| Layer | Real path | Demo path |
|---|---|---|
| Routes (web) | `/home`, `/policies`, `/family` … | `/demo/home`, `/demo/policies`, `/demo/family` … (own route group `src/app/demo/`, own layout with a "Demo" top bar and exit) |
| Guard | `proxy.ts` needs `kv_session` | `/demo/**` needs `kv_demo` only; real routes ignore `kv_demo` and demo routes ignore `kv_session` |
| Cookie | `__Host-kv_session` | `__Host-kv_demo` (separate sealed key derivation; never both read in one handler) |
| BFF | `/api/app/**` | `/api/demo/**` (own handlers; no shared mutable code path except pure view components and read-only formatters) |
| API | `/api/v1/households/**` | `/api/v1/demo/**` accepting only JWTs with `knd:"demo"`, `aud:"knowvia-demo"`; real routes reject them and demo routes reject real tokens |
| Data | `households.kind = 'real'` | `kind = 'demo'`, a per-visitor **clone of the `template` household** |
| Session | `api_sessions.session_kind = 'web'` | `'demo'`, TTL 60 minutes, no refresh, `amr = demo`, no `adult_users` e-mail or phone |
| Writes | full | **allowed inside the visitor's own clone** (the demo feels real) but never leave it; wiped at expiry |
| Outbound | consented providers | **blocked**: no OCR, model, e-mail, WhatsApp, SMS, upload of real files, no sign-in linking, no export; DB trigger on `integration_outbox` refuses any row whose household kind is not `real` |
| Rate limit | per adult | per IP prefix: 5 demo starts/hour, 20 writes/min/session, global cap of 50 live demos |
| Analytics | normal | tagged `demo`; never counted as users |
| Erasure | on request | purge job deletes expired demo households through the normal erasure path every 5 minutes |

**Flow.** Click View demo → `POST /api/demo/start` (BFF, no credentials) → API `POST /api/v1/demo/sessions` clones the template into a new `demo` household (service code decrypts and re-seals each row, because the AAD binds the new row id), mints a demo JWT, BFF sets `__Host-kv_demo` and redirects to `/demo/home`. A visitor who later signs up starts a **new real household**: demo data is never converted or copied into real data, and the demo household is erased.

**Template.** One household with `kind = 'template'`, `template_version` (unique), built only by `npm run seed:demo-template` (local and staging, refuses on `coversaath_dev`, `SEED_ALLOW=1`, non-production) through the services, never raw SQL, so every sealed value goes through the same code as real data. Re-running with a new version creates a new template; clones record `cloned_from_household_id`.

**Synthetic dataset (the Rao family).** Entirely invented. E-mails use `example.com`; phone numbers are never reused from real contacts, are stored sealed, and cannot be messaged because outbound is blocked for demo households.

| Table | Rows | Content |
|---|---|---|
| households / adult_users | 1 / 1 | "Rao family"; owner Meera Rao (placeholder adult, no real e-mail) |
| household_members | 5 | Meera (self, adult), Rohan (spouse, adult), Kabir (child, age band 6-12), mother, father (parents, 60+) |
| household_places | 4 | registered address (fictional Pune lines + valid pincode), home, work, no current location |
| adult_preferences, onboarding_progress | 1, 1 | completed, WhatsApp + e-mail channels, en-IN |
| device_permissions | 3 | notifications granted, location dismissed, calendar denied |
| person_records | 10 | self_profile, one health_context for the father (synthetic condition), 2 nominees, 2 emergency contacts, 1 advisor, 3 notes |
| policies / policy_terms / policy_members | 3 / 3 / 8 | employer group, personal floater, senior top-up; terms filled; members mapped |
| household_dates / reminders | 8 / 6 | renewal, premium due, tax proof, waiting period end |
| premium_payments / premium_dues | 9 / 6 | includes one duplicate payment (refund case) and one overdue |
| claims | 2 | one short-settled (billed vs paid gap), one pre-auth |
| service_cases / case_steps / case_messages | 3 / 15 / 12 | claim dispute, refund, document request |
| tool_scenarios | 7 | tax, premium rise, hospital bill, inflation, compare, stress, review |
| document_uploads | 0 | no files; demo blocks upload |

Every number matches the canvas so the demo equals the design. A static test fails if the template contains a value that looks like a real identifier (Aadhaar/PAN/card patterns, non-example.com domains).

**What this fixes.** The signed-in real path stops showing hard-coded Meera data: real users see real (or empty) state, and Meera appears only under `/demo`. That is the earlier "demo data on `/home`" issue.

## 7. Roles and authorization (unchanged model, stated once)

`household_roles` (owner, member, operator, backup_operator, viewer) stays. Every route: JWT valid → `sid` live → household from token equals path household (`USER_DATA_HOUSEHOLD_MISMATCH` otherwise) → role allows the verb → same-transaction ownership check on the row. Members (adults in the household) see household-level data they have a role for; children's and health records need the owner or the guardian. Demo tokens satisfy only `/api/v1/demo/**`.

## 8. Migration plan (numbered after 029; DDL in `schema-v2-reference.sql`)

| # | Adds | Review focus |
|---|---|---|
| 030 | signing keys, refresh tokens, challenges, devices, passkeys, notice acceptance, `api_sessions` + `auth_identities` columns | security |
| 031 | `touch_revision`, `household_changes`, `household_sync_state`, log triggers | integrity, performance |
| 032 | `person_records`, member contact columns | privacy, minimisation |
| 033 | `policy_terms` | money correctness |
| 034 | dates, reminders | consent for channels |
| 035 | payments, dues | reconcile rules |
| 036 | claims | |
| 037 | desk columns, `case_messages`, `case_steps` | |
| 038 | `household_invites` | token handling |
| 039 | `household_keys` (only if D9 = yes) | crypto |
| 040 | demo columns, outbox trigger | isolation |

Order of build (each a Sonnet 5.5 medium worktree, independent read-only review after each): **A** 030 + JWT + Google OIDC + BFF cookie; **B** 031 + sync routes; **C** 040 + demo path + View demo button (small, high value, can ship before capture tables, using the existing seven user-data tables); **D** 032-038 with form generation from the capture schema; **E** verify script + soak.

## 9. Frontend changes implied (separate repo, after the API slices)

- Top bar: **View demo** (landing, sign-in, pricing pages) → `POST /api/demo/start`. In demo: "Demo" label, **Exit demo** returns to `/`. No defensive or sample copy beyond that single exit control.
- `src/app/demo/**` route group reusing view components; adapters selected by route group, not by an env flag, so a demo screen can never call a real route.
- `proxy.ts` matcher gains `/demo/:path*` with its own cookie check; real matcher unchanged.
- Sign-in page: Google button returns when OIDC is live (method 2); beta form stays until closed.
- Replace `data/mock/*` on the real path with adapter reads and empty states; the mock files move under `demo` fixtures or are deleted once the template exists.

## 10. Proof

1. Contract tests: token claims, `alg` allow-list (rejects `none`, HS256, RS256), expiry, wrong `aud`, wrong `knd`, tampered signature, revoked `sid`, rotated key overlap.
2. Refresh: rotation, reuse revokes the session, absolute cap, concurrent refresh single-flight.
3. OIDC: state/nonce mismatch, replayed code, unlisted issuer, unverified e-mail, link without re-auth.
4. Sync: two-client convergence, idempotent retry, stale revision, delete vs update, cursor expiry, snapshot consistency, 200-item and 256 KB bounds.
5. Sealed at rest: round trip every registry field; direct SQL plaintext scan finds none.
6. **Demo isolation**: real token on demo route → 401/403; demo token on real route → 401/403; demo cookie ignored by real BFF routes and vice versa; no outbox row can exist for a demo household (trigger test); clone shares no ids with the template; expiry purge leaves zero rows; 51st concurrent demo refused; demo start rate limit.
7. Standard gates: `REQUIRE_POSTGRES=1 npm run check`, `npm run eval:safety`, `git diff --check`, `gitleaks git .`, browser journey: View demo → edit → reload → exit → sign up fresh → no demo data on the real path.

## 11. Owner decisions (recommended first)

- **D1** Passwordless only (no password table). Alternative: add argon2id passwords (`crypto.argon2` exists in Node 24.7+), more liability.
- **D2** First methods: Google OIDC then e-mail code. Apple, phone OTP later (paid).
- **D3** Add the `jose` dependency (ADR 0016). Alternative: node:crypto only, more risk.
- **D4** Token lifetimes: access 10 min, refresh 30 days sliding, 90 absolute, demo 60 min.
- **D5** Demo writes allowed in the visitor's own clone (recommended); alternative read-only demo.
- **D6** Demo caps: 50 live, 5 starts/hour/IP prefix.
- **D7** Build order C early: ship View demo + isolation before the capture tables.
- **D8** Sync live updates: polling first, SSE only when measured.
- **D9** Per-household data keys (crypto-shred): recommend yes before real users; needs a key-backup runbook.
- **D10** Policy amounts stay plain for deterministic code, or sealed with application-side range checks.
- **D11** From capture design: health context (D1 there), children's age band (D5), never-collect list (D3), transcripts not stored (D4), export route later (D6).
- **D12** Paid or account steps the owner must do: Google OAuth client, e-mail provider, later Apple and SMS/DLT.

## 12. Risks

- Auth is the highest-risk slice: independent review is mandatory; no custom crypto.
- Per-process rate limits and SSE fan-out assume one Fly machine.
- Demo abuse (bot starts) is bounded by caps and the purge job; watch cost and database size.
- Key loss makes sealed data unrecoverable: back up the master key before real users.
- Clone cost: re-sealing about 100 rows per demo start; measure, and cache a pre-decrypted template in memory if slow.
- Cookie `__Host-` prefix needs Secure and Path=/; the local dev host needs a localhost exception (plain `kv_*` names in dev only).
