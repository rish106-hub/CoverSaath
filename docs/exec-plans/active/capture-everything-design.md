# Capture-everything design: the backend takes every fact a person can humanely enter

Status: **design only, nothing built, no migration written.** Author: Sonnet 5.5, 2026-11-03, base `main` at 23ab6d6. Owner asked (2026-11-03): "prepare the backend to capture all the info which the user can humanely enter, design first before coding."

Needs, per AGENTS.md before any build: owner approval of section 9, ADR 0016, independent read-only review (migration + security + consent + privacy change), local database only. Consent, notice and health-data wording is **not final: mark for legal review** (India DPDP Act 2023 duties: notice, purpose-bound consent, verifiable parental consent for children, correction, erasure, access).

## 1. Outcome, scope, non-goals

Outcome: anything a person can type, tap, say or photograph in the Knowvia app has a typed, validated, sealed, owner-checked, audited, erasable home in the backend, so a refresh, a second device or a returning user loses nothing.

In scope: field catalogue (section 3), storage architecture (4), capture rules (5), routes (6), migration plan (7), proof (8).
Non-goals: UI redesign, empty-state work in the frontend (separate), Supabase/Fly changes, provider calls, new infrastructure, any model reading of captured text.

## 2. Facts today (verified on `main`)

| Area | State |
|---|---|
| Household, owner adult, session, sign-out, idempotent beta access (`POST /access`) | built |
| Members: sealed `display_name`, plain `relationship_label`, `date_of_birth`, kind adult/dependent; routes list/add/edit/remove | built (B-A) |
| Device permissions, places (registered address, saved places, 24 h coarse current location), Settings preferences, onboarding progress, 7 tool scenarios | built (migrations 025-029, ADR 0015) |
| Adult contact: sealed phone + HMAC hashes | built (029) |
| Profile answers (7 closed questions) | built (018) |
| Policies, insurers, policy_members (masked number, dates, kind, verification state) | schema exists; **no create/edit route, no sum insured, premium, terms** |
| Documents, OCR, evidence facts, consent grants | built; document-derived only |
| Member mobile, email, channel, gender, health context, nominees, emergency contacts, dates and reminders, payments and dues, claims, desk cases and messages, invites, notes | **not stored anywhere** (frontend mock or browser only) |

## 3. Field catalogue: everything a person can humanely enter

Sensitivity tiers drive sealing, consent scope and review depth.
- **T1 personal**: identifies or contacts a person. Sealed.
- **T2 sensitive**: health, money, precise location, children's data. Sealed, purpose-specific consent, listed in the legal-review pack.
- **T3 never collected**: see 3.12.
- Operational ids, enums the database must constrain, timestamps, revision counters stay plain.

Every field is optional at the API (a half-filled form saves). `required` below means required to mark that record `complete`.

### 3.1 Account and self (adult) , T1
Name (built), e-mail (built), mobile (built), date of birth, gender (closed list + "prefer not to say"), preferred language (BCP-47 from the 10 voice languages), preferred contact channel (whatsapp, sms, email), occupation band (closed list), employer name (free, 80), city/state (built via address).

### 3.2 Family members , T1, children T2
Per member: name (built), relation (built), kind (built), date of birth or age band (see D5), gender, mobile, e-mail, preferred channel, lives with household (bool), financially dependent on (member id), is covered by employer (bool), short note (200). Dependents under 18: guardian adult id required; no direct contact fields.

### 3.3 Places , T2 (built)
Registered address, home/work/other saved places, current location. Add: per-member registered address (column exists), "second address" is just a saved place.

### 3.4 Health context , T2 (new; owner decision D1)
Per member, all optional, closed lists plus a capped free-text:
- conditions and pre-existing conditions: closed list (diabetes, hypertension, asthma, heart disease, thyroid, kidney, cancer history, mental health, other) + `since` year + `onTreatment` + note (200);
- past surgeries and hospital stays: year, kind (closed), hospital note (120);
- current regular medicines: names only (up to 10, 60 each), no doses by default;
- height cm, weight kg, smoker/tobacco (never, former, current), alcohol (never, occasional, regular);
- planned: surgery, pregnancy, treatment (bool + month);
- allergies (closed + note), blood group (closed 8 values);
- preferred hospital and doctor notes (120 each), emergency medical note (300).
No diagnosis is inferred, scored or sent to a model. Value is `user_stated`, never `confirmed`.

### 3.5 Policies entered by hand , T2 (new)
Insurer (closed list from `insurers` + "other" with name), product name, kind (group, personal, top-up, unknown), policy number (sealed full value; masked form derived for display), proposer, policy start, end, renewal date, sum insured, premium amount, frequency (monthly, quarterly, half-yearly, annual), premium due date, deductible, co-pay %, room-rent cap, riders (closed list + other), waiting periods (initial, pre-existing, specific: months), no-claim bonus %, covered members (member ids + member reference number), employer (group), TPA name, insurer helpline, agent/advisor name and mobile, portability history (bool), notes (300). Source for each: `user_typed`, `document`, `digilocker`, `voice`.

### 3.6 Dates and reminders , T1
Renewal, premium due, tax-proof deadline, waiting period end, cover end, custom (title 80). Reminder lead times (days before: 0, 1, 7, 15, 30), channel, on/off.

### 3.7 Money , T2
Premium payment: policy, payer member, amount (paise), paid on, method (card, upi, netbanking, payroll, cheque, unknown), receipt document id, tax section tag (80D, 80C, none). Expected premium dues (derived from 3.5, user can override). Out-of-pocket medical spend entries (amount, date, member, category) for the tax tool.

### 3.8 Claims and hospital bills , T2
Member, policy, hospital name, admitted/discharged dates, reason (closed + 120 note), billed, approved, paid (paise), status (draft, filed, pre-auth, approved, short-settled, settled, rejected), claim reference (sealed), TPA reference (sealed), settlement document id, dispute note (300).

### 3.9 Desk: cases and messages , T1
Case subject, counterparty kind (insurer, tpa, hospital) and name, escalation level, next-update date, message thread (body up to 2000, sealed, author kind, channel, optional document).

### 3.10 People around the household , T1
Nominees per policy (name, relation, share %, DOB), emergency contacts (up to 5: name, relation, mobile, rank), advisors (name, firm, mobile, e-mail, sharing scope), invites (member, mobile, channel, status).

### 3.11 Already built, kept: permissions (6), preferences, onboarding, scenarios (tax, premium rise, hospital bill, inflation, compare, stress, review), documents, consent grants.

### 3.12 Never collected (T3), enforced by validators that reject the shape
Aadhaar number, PAN (store at most "PAN on file" boolean if ever needed), full bank account, card number, CVV, UPI PIN, passwords, OTPs, biometrics, government photo ID images outside the document pipeline, caste or religion, call or chat transcripts (D4). A free-text field whose value matches a 12-digit Aadhaar, a 16-digit card or a PAN pattern is rejected with `SENSITIVE_IDENTIFIER_REJECTED` (400) and the value is never logged.

## 4. Storage architecture

Two stores, one rule set.

**A. Relational tables** where deterministic code must join, constrain, sort or sum: members, policies and `policy_terms`, `household_dates`, `reminders`, `premium_payments`, `premium_dues`, `claims`, `case_messages`, `household_invites`. Plain columns only for ids, enums, dates, and amounts the database must range-check (CHECK >= 0). Free text and identifiers sealed with the E1 column helper bound to table, column, row id.

**B. Generic sealed record store** `person_records` for the long tail where nothing queries inside the value: health context, nominees, emergency contacts, advisors, member notes, outpocket spend.
`id, household_id, subject_member_id NULL, record_type CHECK IN (registry), slot, payload_ciphertext, schema_version, completeness (plain: empty|partial|complete), source, revision, created_at, updated_at`, UNIQUE (household_id, subject_member_id, record_type, slot). Each `record_type` has a validator in `src/contracts/capture-registry.js` (closed enums, bounds, caps, strict keys). Adding a new type is a contract change plus a CHECK-list migration, not a new table.

Why hybrid: per-field tables for everything (about 12 migrations, each reviewed) is slow and the long tail never joins; one JSON table for everything loses constraints on money and dates that the reconcile, reminder and compare code rely on.

**C. Capture schema endpoint** `GET /api/v1/capture-schema` returns the registry (field keys, types, enums, limits, tier, required-for-complete). The frontend generates and tests forms from it; a static test fails when a UI input is not in the registry. One source of truth.

## 5. Capture rules (apply to every record)

1. Household ownership checked in the same transaction as the write; session adult must be an adult of that household; a dependent record needs the guardian or an adult member of the household.
2. Sealed values bind table, column, row id (AAD). Audit events carry ids and field names, never values.
3. `PUT` replace with integer `revision` and `If-Match`; stale gives `409 REVISION_CONFLICT`. `PATCH` only on tables A with explicit field lists. Payload cap 8 KB (notes 2 KB each), unknown keys rejected, NFC text, no control or bidi characters (reuse `cleanText`). Per-adult write limit 60/min.
4. **Provenance on every record**: `source` in (`user_typed`, `voice`, `document`, `digilocker`, `import`) and `state` in (`user_stated`, `extracted_unverified`, `conflicting`, `confirmed_by_user`). Voice and document values arrive as `extracted_unverified` and need a user tap to become `confirmed_by_user`. User-stated never overrides document evidence: a mismatch is stored as `conflicting` for the existing conflict flow. Deterministic code, not a model, sets state.
5. Tolerant input, canonical storage. Client and server both accept "5 lakh", "5,00,000", `03/11/26`, `098765 43210`; server stores paise integers, ISO dates, E.164 phones. Rejections name the field and the rule, not the value.
6. Draft saves: partial records are legal; `completeness` is computed by the server from the registry, never trusted from the client.
7. Consent: T2 records need a current consent grant for purpose `health_profile`, `money_records` or `family_data` (child data: `guardian_confirmed`). No grant gives `403 CONSENT_REQUIRED`. Revoking the grant erases that purpose's derived records in the same transaction (AI.md invariant 3).
8. Erasure: every table has a household erasure path and a member-removal path (extends `MEMBER_HAS_RECORDS`). Test per table.
9. RLS deny-by-default and no Data API grants (migration 016 pattern) on every table.
10. Export (DPDP access right): `GET /households/{id}/export` returns the owner their own decrypted data as JSON, rate-limited, audited (D6, later slice).

## 6. Routes (`/api/v1`, session bearer; BFF mirrors under `/api/app/*`)

| Area | Routes | Audit action |
|---|---|---|
| Schema | `GET /capture-schema` | none |
| Self | `GET/PUT /households/{id}/me/profile` | `profile.set` |
| Members | extend `POST/PATCH /members` with gender, mobile, email, channel, notes | `member.set` |
| Records | `GET /households/{id}/records?type=&memberId=`; `GET/PUT/DELETE /households/{id}/records/{type}/{slot}?memberId=` | `record.set`, `record.delete` |
| Policies | `GET/POST /households/{id}/policies`; `GET/PATCH/DELETE /policies/{id}`; `PUT /policies/{id}/members` | `policy.set` |
| Dates | `GET/POST /households/{id}/dates`; `PATCH/DELETE /dates/{id}`; `PUT /dates/{id}/reminder` | `date.set` |
| Money | `GET/POST /households/{id}/payments`; `PATCH/DELETE /payments/{id}`; `GET /households/{id}/dues` | `payment.set` |
| Claims | `GET/POST /households/{id}/claims`; `PATCH/DELETE /claims/{id}` | `claim.set` |
| Desk | `GET /households/{id}/cases?kind=desk`; `GET/POST /cases/{id}/messages` | `case_message.add` |
| Invites | `POST /households/{id}/invites`, `/invites/{id}/send`, `/invites/accept`, `/invites/{id}/revoke` | `invite.*` |
| Export | `GET /households/{id}/export` | `export.read` |

New error codes: `CONSENT_REQUIRED` 403, `SENSITIVE_IDENTIFIER_REJECTED` 400, `RECORD_NOT_FOUND` 404, `RECORD_TYPE_UNKNOWN` 400, `GUARDIAN_REQUIRED` 403.

## 7. Migration plan (numbered after 029; supersedes the 025-030 numbering in `app-data-plan.md`)

| # | Adds |
|---|---|
| 030 | `person_records` (store B) + `capture_consents` purpose list in `consent_scopes` CHECK |
| 031 | member columns: gender, `mobile_ciphertext`, `mobile_hash`, `email_ciphertext`, channel, lives_with, dependent_on, notes_ciphertext |
| 032 | `policy_terms` (sealed number, sum insured, premium, frequency, riders, waiting periods, advisor) 1:1 with `policies`, plus `policy_members` reference columns |
| 033 | `household_dates`, `reminders` |
| 034 | `premium_payments`, `premium_dues` |
| 035 | `claims` |
| 036 | `case_messages`, `service_cases` desk columns |
| 037 | `household_invites` |

Each is expand-only and safe to rerun; sealed columns carry the `^enc[12][.]` CHECK from 021.

## 8. Proof (what "captured" means)

1. **Registry round trip**: a generated test iterates every registry field, PUTs a synthetic value through the HTTP API, reads it back, and asserts equality.
2. **Plaintext scan**: after the round trip, read every column of every capture table directly and assert no submitted value appears in plaintext (extends `verify:persistence`).
3. **Ownership**: cross-household read/write refused for every route; dependent without guardian refused.
4. **Consent**: no grant gives 403; revoke erases that purpose's rows.
5. **Erasure**: household and member removal delete every row; test per table.
6. **Fuzz**: unicode, bidi, control characters, 100 KB bodies, prototype keys, Aadhaar/PAN/card patterns, SQL metacharacters, duplicate submit, stale revision, parallel writes.
7. **Frontend coverage test**: every `<input>`, `<select>`, `<textarea>` and `useState` that holds typed text is mapped to a registry field or on an allow-list of pure view state.
8. Standard gates: `REQUIRE_POSTGRES=1 npm run check`, `npm run eval:safety`, `git diff --check`, `gitleaks git .`. Real browser journey: fill every form once and reload.

## 9. Owner decisions (recommended answer first)

- **D1 Health context (3.4)**: collect it, optional, closed lists, consent purpose `health_profile`, never sent to a model. Alternative: defer to a later release. Biggest legal exposure in this design.
- **D2 Hybrid storage (section 4)**: recommended. Alternative: tables for everything.
- **D3 Never-collect list (3.12)**: confirm Aadhaar, PAN, bank, card are out.
- **D4 Transcripts and chat text**: do not store; keep intent and timestamps only.
- **D5 Children**: store date of birth sealed, or age band only? Recommend age band for dependents under 18, DOB for adults.
- **D6 Export right** in this design or later: recommend a later slice, tables built so it is possible.
- **D7 Policy number**: sealed full number (needed to talk to insurers) vs masked only. Recommend sealed full, masked for display.
- **D8 Order**: 030 + 031 first (profile, members, health, nominees), then 032, 033, 034, 035, 036, 037.
- **D9 Legal review** of notice, consent purposes and child-data flow before any real user data. Until then synthetic data only.

## 10. Order of work (each a Sonnet 5.5 medium worktree, lead reviews)

1. ADR 0016 from sections 3-5, after D1-D9.
2. P3a: migrations 030-031, registry, routes, tests.
3. Independent read-only review (fresh agent, no edit rights).
4. P3b: 032-034. Review. P3c: 035-037. Review.
5. BFF routes and browser adapters, form generation from the capture schema, frontend coverage test.
6. Extended `verify:persistence` run; paste the matrix into `jtbd.md`.
7. Supabase and Fly only on the owner's say-so.

## 11. Risks

- Health and children's data raise legal exposure: gate behind D1/D9, synthetic data only until legal review.
- Sealed columns cannot be searched; anything we need to look up gets a keyed hash (phone, e-mail) and nothing else.
- Key loss makes sealed data unrecoverable: the owner must back up `DATA_ENCRYPTION_KEY_BASE64` before real users.
- Free-text fields invite identifiers: the identifier patterns reject the common ones but not all; no model reads these fields.
- Single process: the per-adult write limit is per machine, as with the rest of the API.
