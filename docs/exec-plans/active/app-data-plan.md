# App data plan: storing what the Knowvia app shows (draft for owner approval)

Status: **proposal, nothing built.** Author: lead (Opus), 2026-11-01. Needs owner approval before any migration, and an independent read-only review per AGENTS.md (migration + security change).

Goal: every data point the Knowvia app (repo `Knowvia Frontend`, spec `BUILD-SPEC.md`, design canvas v21) shows is fetched from this backend's database, through the app's server-side BFF, for the synthetic seed household **Meera Rao, meera.rao@company.com**.

## 1. Starting point

**Branch state (dependency).** `main` has migrations 001–020 (E1: auth identities, profile answers, column encryption prep, document blobs). `feat/ui-backend-stack` adds 021–024 (sealed column checks, app events, shared rate limits and spend ledger, hot-path indexes) and is **not merged**. New migrations below are numbered from **025** and assume 021–024 land first. Owner decision D1: merge `feat/ui-backend-stack` into `main` first.

**Already in the schema, but no API route yet (no migration needed):**

| App need | Existing table | Gap |
|---|---|---|
| Family members (adults and dependents) | `household_members` (kind, relationship, date of birth) | routes to list / add / edit / remove |
| Policies by person | `policies`, `policy_members`, `insurers` | routes to list; seed path for the dry run |
| Profile answers | `profile_answers` (encrypted values) | already routed on the stack branch; confirm |
| Desk cases (partly) | `service_cases` | trigger types don't cover claim disputes, refunds or pre-auth; no thread |
| Documents, reading | `document_uploads`, `document_blobs`, `source_pages`, `evidence_facts`, `policy_answers` | already routed; phase 2 of the app |

**Not stored anywhere:** invites, dates and reminders, premium payments and dues, hospital bills and claim settlements, desk threads and escalation, wallet passes, notification preferences, beta sign-up idempotency.

## 2. Principles (from AI.md / AGENTS.md, applied)

1. Household ownership checked on every read and write (`requireHousehold`).
2. Personal and financial text is stored encrypted with the E1 column helper (`*_ciphertext`); lookups use a keyed hash column (`*_hash`, HMAC with a server key), never plaintext.
3. Every new table: RLS on, deny by default, no Data API grants (migration 016 pattern), an erasure path wired into household / member revocation, and a test proving erasure.
4. Contacting anyone (WhatsApp, SMS, email) needs a `consent_scopes` grant with action `contact` and goes through `integration_outbox` with human approval rules as today. Calendars stay client-side (`.ics` / prefilled Google URL): no provider, no storage beyond the date itself.
5. Derived numbers (health score, gaps, stress test, fit score, inflation projection, 80D total) are **computed by deterministic code at read time**, not stored. Models never write money or eligibility.
6. Amounts in minor units (`bigint`, paise) + `currency` (INR). Dates `text` ISO, matching the existing schema style.
7. Synthetic data only in seeds, fixtures and tests.

## 3. New tables (migrations 025–030)

### 025 `adult_email_index`: idempotent beta access
`adult_users` gains `contact_email_hash text UNIQUE` (HMAC of the lower-cased email) and a backfill. `POST /api/v1/households` with an email that already exists returns `409 ACCOUNT_EXISTS` instead of a second household; a new bootstrap-guarded `POST /api/v1/access` returns the existing adult's household and issues a fresh session (dev and beta only, rate-limited). Why: the beta form must be safe to submit twice.

### 026 `household_invites`: add family by mobile, auto-onboard
| Column | Notes |
|---|---|
| `id`, `household_id` FK, `member_id` FK `household_members` | member row created first (kind adult or dependent) |
| `relationship_label` | Spouse, Mother, Sister… |
| `phone_ciphertext`, `phone_hash` | E.164; hash for dedupe per household |
| `channel` | `whatsapp` \| `sms` |
| `status` | `draft` → `sent` → `joined` \| `expired` \| `revoked` |
| `token_hash`, `expires_at` | single-use join link |
| `invited_by_adult_id`, `accepted_adult_id`, `consent_grant_id` | |
| `created_at`, `updated_at` | |
Join flow: accepting creates an `adult_users` row, links `household_members.adult_user_id`, adds a `household_roles` row (`member`), marks `joined`. Erasure: revoking the member deletes the invite.

### 027 `household_dates` and `reminders`
`household_dates`: `id`, `household_id`, `policy_id?`, `member_id?`, `kind` (`renewal`, `tax_proof`, `cover_ends`, `waiting_period_ends`, `premium_due`, `custom`), `due_on`, `title_ciphertext`, `source` (`document`, `user`, `system`), `source_page_id?`, `status` (`upcoming`, `done`, `dismissed`).
`reminders`: `id`, `household_id`, `date_id` FK, `channel` (`whatsapp`, `email`, `in_app`), `remind_at`, `status` (`scheduled`, `queued`, `sent`, `cancelled`, `failed`), `outbox_id?`, `consent_grant_id`. Calendar buttons write nothing here.

### 028 `premium_payments` and `premium_dues`: Money desk
`premium_payments`: `id`, `household_id`, `policy_id?`, `payer_member_id?`, `amount_minor`, `currency`, `paid_on`, `method` (`card`, `upi`, `netbanking`, `payroll`, `unknown`), `source` (`gmail`, `upload`, `manual`), `source_ref_hash` (dedupe the same email/receipt), `receipt_document_id?`, `match_state` (`unmatched`, `matched`, `duplicate`), `matched_due_id?`, `tax_section` (`80D` or null).
`premium_dues`: `id`, `household_id`, `policy_id`, `due_on`, `amount_minor`, `currency`, `state` (`expected`, `paid`, `overdue`).
Reconcile (amount ± Rs 1, date window, policy) is deterministic code; it writes only `match_state` / `matched_due_id`. "Money on its way back" = sum of `duplicate` payments with an open refund case.

### 029 `claims`: hospital bill vs paid
`id`, `household_id`, `policy_id`, `member_id`, `service_case_id?`, `hospital_name_ciphertext`, `admitted_on`, `discharged_on`, `billed_minor`, `approved_minor`, `paid_minor`, `currency`, `status` (`draft`, `filed`, `pre_auth`, `approved`, `short_settled`, `settled`, `rejected`), `settlement_document_id?`. Gap = billed − paid, computed.

### 030 Desk: coordination with insurers and TPAs
- `service_cases.trigger_type` CHECK widened with `claim_dispute`, `refund`, `pre_auth`, `document_request`; new columns `escalation_level` (0 insurer, 1 grievance officer, 2 Bima Bharosa, 3 ombudsman), `counterparty_kind` (`insurer`, `tpa`, `hospital`), `counterparty_name_ciphertext`, `next_update_on`.
- `case_steps`: `case_id`, `step` (`raised`, `with_tpa`, `awaiting_documents`, `decision`, `resolved`), `state`, `at`.
- `case_messages`: `id`, `case_id`, `author_kind` (`user`, `knowvia`, `insurer`, `tpa`, `hospital`), `body_ciphertext`, `sent_at`, `channel` (`in_app`, `email`, `phone_note`), `document_id?`.

### Later (031+, separate approval)
- `wallet_passes` (`policy_id`, `member_id`, `platform` apple/google/samsung, `serial`, `status`): needs Apple and Google wallet issuer accounts (paid, owner).
- `notification_preferences` (per adult and channel, verified flag, consent id).
- `assistant_turns`: **recommend not storing transcripts**; store only intent, route and timestamps if analytics are wanted. Owner decision.
- Reference data that is not household data (hospitals, blood stock, plan catalogue, advisors, learn posts): fetch from sources (ABDM HFR, e-RaktKosh, the curated product workflow already in 014/015) behind adapters with a short-lived cache table; no personal data.

## 4. API routes (all under `/api/v1`, session bearer, ownership checked)

| Area | Routes |
|---|---|
| Access | `POST /access` (bootstrap-guarded, idempotent by email) |
| Members | `GET/POST /households/{id}/members`, `PATCH/DELETE /households/{id}/members/{memberId}` |
| Invites | `POST /households/{id}/invites`, `POST /invites/{id}/send`, `POST /invites/accept` (token), `POST /invites/{id}/revoke` |
| Policies | `GET /households/{id}/policies`, `GET /policies/{id}` (members, dates) |
| Dates, reminders | `GET/POST /households/{id}/dates`, `PATCH /dates/{id}`, `POST /dates/{id}/reminders`, `DELETE /reminders/{id}` |
| Money | `GET/POST /households/{id}/payments`, `POST /households/{id}/reconcile`, `GET /households/{id}/dues` |
| Claims | `GET/POST /households/{id}/claims`, `PATCH /claims/{id}` |
| Desk | `GET /households/{id}/cases?kind=desk`, `GET/POST /cases/{id}/messages`, `POST /cases/{id}/escalate` |
| Overview | `GET /households/{id}/overview`: one read for Home (members, policies, next dates, open cases, money summary) so the app makes one call per page |

The app's BFF maps these 1:1 under `/api/app/*`; screens keep using adapters.

## 5. Seed for the dry run
`npm run seed:demo-household` (new script, local only, refuses to run unless `DATABASE_URL` points at loopback and the database name is not `coversaath_dev`): creates Meera Rao's household through the services (not raw SQL) with 5 members, 3 policies, dates, payments, one claim, 3 desk cases, matching the canvas numbers. Idempotent by email hash.

## 6. Order of work (each a Sonnet medium worktree; lead reviews)
1. **D1** merge `feat/ui-backend-stack` → `main` (owner).
2. **B-A** (no migration): members, policies, overview routes on existing tables + seed of members/policies. Unblocks most of the Home and Family screens immediately.
3. **B-B** 025 + 026: access idempotency, invites.
4. **B-C** 027 + 028: dates, reminders, payments, reconcile.
5. **B-D** 029 + 030: claims, desk.
6. ADR 0014 "App data model" recording sections 2–3; independent read-only review of B-B to B-D; then apply migrations to Supabase **only on owner approval**.

Checks per slice: `npm run check`, `npm run eval:safety`, `git diff --check`, erasure tests for every new table, ownership-denied tests for every route.

## 7. Owner decisions
- D1 merge order above.
- D2 approve migrations 025–030 (local first; Supabase later, separately).
- D3 WhatsApp/SMS provider for invites and reminders (paid; until then the outbox records the message and the UI shows it as queued).
- D4 store assistant transcripts or not (recommendation: no).
- D5 wallet pass issuer accounts (Apple, Google): later.
