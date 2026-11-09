# Runbook: personal data breach and incident response (S6)

Status: DRAFT, prepared 2026-11-07 from the repository at `main` 23ab6d6 and the docs of sibling branches named below. CoverSaath holds synthetic data only today (ADR 0011 D8). This runbook must be in place, reviewed and drilled before any real Indian health data is accepted.

**FOR LEGAL REVIEW.** Every statement about the Digital Personal Data Protection Act, 2023 (DPDP Act), the DPDP Rules, CERT-In directions or any other law in this file is an engineering reading, not legal advice and not final. Deadlines, thresholds, report contents and who must be told are to be confirmed by counsel, including whether and from when each provision is in force.

Companion documents: [processor register](../architecture/processor-register.md), [ADR 0018](../adr/0018-privacy-risk-acceptance.md), [security model](../architecture/security.md), [data architecture](../architecture/data.md), [Fly deploy runbook](fly-deploy.md).

Related, on unmerged branches (refer to them by name; they are not in this checkout):

- `docs/runbooks/db-roles.md` (branch `fix/s1-roles`): least-privilege database roles and the Supabase password rotation cutover.
- `docs/runbooks/secret-hygiene.md` (branch `fix/s1-roles`): secret findings, rotation order, history purge plan.
- `docs/adr/0016-structured-logging-and-error-reporting.md` and `docs/runbooks/observability.md` (branch `patch/m1-logging`): pino logs and Sentry error reporting.
- `docs/architecture/data-lifecycle.md` (branch `patch/s3-erasure`): household erasure, export, tombstones and the retention sweep.

## 1. Scope and definitions

- **Incident:** any event that threatens the confidentiality, integrity or availability of CoverSaath systems or data, including a near miss.
- **Personal data breach (DPDP Act s2(u), FOR LEGAL REVIEW):** any unauthorised processing of personal data, or accidental disclosure, acquisition, sharing, use, alteration, destruction or loss of access to personal data, that compromises its confidentiality, integrity or availability. Engineering reading: loss of availability (for example a lost encryption key, ADR 0013 "Cost") can be a breach, not only a leak.
- **In scope data:** everything listed in the [processor register](../architecture/processor-register.md): household identity (names, dates of birth, contact e-mail and phone), consent records, insurance documents and their OCR text, clauses, answers and evidence facts, profile answers, locations and preferences (ADR 0015), sessions and identities, app events, audit events, and the website waitlist (email, first name; ADR 0011 Consequences).
- **Synthetic-only period:** while only synthetic data exists, an exposure of synthetic data is not a personal data breach. Run the full process anyway as a drill, and check first whether any real data is present (the website waitlist is the most likely place; confirm with the owner).

## 2. Roles

One person can hold several roles at prototype scale. Names are placeholders until the owner fills them in.

| Role | Holder | Duties |
| --- | --- | --- |
| Incident lead | `[OWNER TO NAME]` | Declares the incident and severity, owns the timeline, approves containment that is destructive or user-visible. |
| Technical responder | `[OWNER TO NAME]` | Runs detection, containment, evidence capture and recovery steps below. |
| Grievance officer / contact person for data principals (DPDP Act s8(9), s8(10); FOR LEGAL REVIEW) | `[PLACEHOLDER: name, e-mail, phone; to be published in the privacy notice]` | Receives reports from data principals, sends data-principal notices, answers follow-up questions. |
| Legal counsel | `[OWNER TO NAME]` | Decides whether the event is a notifiable breach, approves every external message, files Board and CERT-In reports. |
| Communications approver | Owner | Final sign-off on any message to users, processors or the public. |

Rules: no external message (to users, the Board, CERT-In, a processor, the press or social media) leaves without legal counsel and the owner approving it (AGENTS.md: ask before external messages). No personal data in chat, tickets, commits or this repository; refer to households by id only.

## 3. Detection sources

What exists in `main` today, and what is pending:

| Source | What it shows | State |
| --- | --- | --- |
| `app_events` table (ADR 0014) | Per-request metadata: route template, status, error code, provider outcome, latency, cost, household and adult ids; client address as a keyed hash. Look for spikes in 401, 403, 404, 429 and `FIELD_ACCESS_REQUIRED`. | In `main`. Retention `APP_EVENTS_RETENTION_DAYS` (default 30). Purged hourly. |
| `audit_events` table | Append-only, hash-chained state changes (consent, documents, erasure, user data), counts and ids only. | In `main`. **Gap:** no code verifies the hash chain (security.md Known gaps). |
| `GET /api/v1/ready` and `npm run db:init` | Schema validator: `tablesWithoutRls`, `apiRoleGrants`, critical triggers. A failure can mean the Data API shield (ADR 0011 D10) was weakened. | In `main`. Detail is loopback only. |
| Supabase advisors (security and performance) and Supabase logs (Postgres, pooler, API) | RLS off, exposed functions, unusual connections, failed logins. Read through the dashboard or the Supabase MCP (`get_advisors`, `query_logs`). | Available; log window per Supabase plan (UNVERIFIED). |
| Fly logs (`fly logs -a knowvia-api --no-tail`) and Fly proxy access logs | Process output, crashes, request URLs. Note: `GET .../passages?q=` carries the query in the URL (ADR 0012 D9), so proxy logs may hold passage text taken from a user's own policy. Treat Fly logs as personal data (section 6). | No machine deployed yet. Fly keeps stdout only for a short window (UNVERIFIED length). |
| pino request logs and Sentry | Request ids, error codes, sanitised stack frames, no personal data by design. | Branch `patch/m1-logging` (ADR 0016), not merged. Sentry off unless `SENTRY_DSN` is set. |
| Vercel runtime logs and deployment events | BFF errors, sign-in failures, unexpected deployments or environment variable changes. | Website repository; not inspected for this runbook. |
| GitHub: secret scanning, Dependabot, CodeQL, dependency review; `gitleaks git .` locally | Leaked keys, vulnerable dependencies. | CI in `main`; gitleaks not in CI (secret-hygiene.md). |
| Provider dashboards and bills (Google Gemini, Sarvam, Supabase, Fly, Vercel) | Spend or usage you did not cause means a leaked key. Model spend is also capped by `ORCHESTRATION_*_BUDGET_USD`. | Manual check. |
| External reports | Data principals (grievance contact), `SECURITY.md` disclosures, a processor's breach notice, CERT-In. | Grievance contact not yet published. |

Not present (do not assume): no alerting, no metrics dashboard, no Grafana (later task M2), no PostHog in any checked-out code, no intrusion detection, no WAF on the Fly plan (ADR 0011 D9).

## 4. Triage and severity

Start the clock when anyone first has reason to believe an incident happened (the "awareness" time). Write it down in UTC and IST.

| Severity | Meaning | Examples | Response |
| --- | --- | --- | --- |
| SEV1 | Personal data confirmed or very likely exposed, altered or lost; or a credential that unlocks it is compromised. | Database password or `DATA_ENCRYPTION_KEY_BASE64` leaked; `KNOWVIA_IDENTITY_TOKEN` leaked (section 11); cross-household read proven (section 12); Data API reachable with grants; lost encryption key; processor reports a breach affecting CoverSaath data. | All roles now. Contain within the hour. Legal decides notification at once (section 7). |
| SEV2 | Suspected exposure, not yet confirmed; or a control failed in a way that could have exposed data. | Unexplained provider spend; `/ready` shows `tablesWithoutRls`; a log line holds a value it should not; a single user bearer token seen outside its store (revoke that session; `KNOWVIA_IDENTITY_TOKEN` is SEV1, not SEV2). | Lead and responder within 4 hours. Treat as SEV1 until ruled out. |
| SEV3 | Control weakness, no sign of data access. | Vulnerable dependency with no known exploit path; a misconfiguration found by an advisor and fixed before use. | Fix in normal work; record. |
| SEV4 | Near miss or drill. | Synthetic data only; secret caught by gitleaks before commit. | Record and review. |

Triage questions (answer in the timeline, facts and assumptions kept separate):

1. Which data categories and which households (ids only)? Real or synthetic?
2. Which component and which processor? (Use the register.)
3. Is it still happening? Is the credential still valid?
4. Confidentiality, integrity or availability, or several?
5. Which consent grants cover the affected data, and what was the stated purpose?
6. Is ciphertext alone exposed (database dump without the key, ADR 0013) or plaintext? Note: plain columns still exist (ADR 0013 D3 "not sealed": dates of birth, `relationship_label`, `policy_answers.question`, parameter values, workflow tasks, audit and outbox JSON).

FOR LEGAL REVIEW: the DPDP Act has no harm threshold for notification as read here; a breach of encrypted data may still need notice. Severity guides urgency, not whether to notify.

## 5. Containment by component

Do the cheapest reversible action first. Capture evidence (section 6) before any restart that would lose it, but never delay stopping an active leak to capture logs. Every secret change is recorded by name only, never by value.

### Global kill switches (backend)

- **Stop public traffic (primary):** `fly scale count 0 -a knowvia-api`, or `fly machine stop <machine-id> -a knowvia-api` (`fly machines list -a knowvia-api` for the id). This works at once and does not depend on app config. `fly.toml` sets `auto_start_machines = false`, so a stopped machine stays stopped until `fly machine start`. UNVERIFIED: whether `fly scale count 0` destroys the machine (the `coversaath_data` volume is kept either way); prefer `fly machine stop` when you want to restart the same machine, and record the machine id first.
- **Stop public traffic (secondary, softer):** empty `PUBLIC_HOSTS` (`src/server/config.js` then yields no public hosts, so the API answers only loopback and returns 403 to every public `Host`; ADR 0011 D9). Caveats: `fly.toml` health check sends `Host: knowvia-api.fly.dev`, so once `PUBLIC_HOSTS` is empty the check gets 403 and fails; a deploy that waits for healthy checks may fail and leave the old release (still serving public traffic) running. `PUBLIC_HOSTS` is set in `fly.toml` `[env]`; whether a `fly secrets set PUBLIC_HOSTS=...` overrides an `[env]` value, and whether Fly accepts an empty secret, is UNVERIFIED. Confirm with a public `curl` that you now get 403 before trusting this switch.
- **Stop provider disclosure:** set `POLICY_EVIDENCE_ENABLED=false`, `POLICY_STRUCTURING_ENABLED=false`, `SARVAM_OCR_ENABLED=false`, `DOCUMENT_READBACK_ENABLED=false`, `CHAT_ENABLED=false` (chat v0, `docs/runbooks/chat-v0.md`). Anything not exactly `true` is off.
- **End sessions:** in SQL as the table owner, `UPDATE api_sessions SET revoked_at = <now ISO UTC> WHERE revoked_at IS NULL;` (all users must sign in again). An identity can be revoked only in SQL (`auth_identities.revoked_at`); this burns it permanently (ADR 0012 D3 (a)), so use it only for a proven takeover.

### Supabase (database `coversaath`, project in `ap-southeast-2`)

1. Rotate the `postgres` password in the Supabase dashboard; update `DATABASE_URL` with `fly secrets set` and in the local untracked env file; restart. Follow `db-roles.md` (branch `fix/s1-roles`) for the runtime role cutover. The current password was already pasted into chat twice and is due for rotation (ADR 0011 D9).
2. Check the Data API shield: run the security advisor; confirm `GET /api/v1/ready` (loopback) reports no `tablesWithoutRls` and no `apiRoleGrants`. If either fails, re-apply migration 016's revokes and stop traffic until fixed.
3. Rotate the Supabase API keys (anon and service role) if any could be exposed, even though the backend does not use them; the website schema `knowvia_web` may.
4. Restrict network access if the plan offers it (UNVERIFIED for the current plan).
5. Do not restore a backup over the live database until evidence is captured; a restore destroys evidence and can resurrect erased data.

### Fly.io (app `knowvia-api`, region `syd`)

1. Rotate a Fly deploy or API token if a token is suspected (Fly dashboard); remove unknown organisation members.
2. `fly secrets list -a knowvia-api` (names and digests only) to check for unexpected changes; `fly releases -a knowvia-api` for unexpected deployments.
3. Rotate app secrets as needed: `KNOWVIA_BOOTSTRAP_TOKEN`, `KNOWVIA_IDENTITY_TOKEN` (also in Vercel, same value, at the same time; if leaked, follow section 11), `GEMINI_API_KEY`, `SARVAM_API_KEY`, `DATABASE_URL`. Encryption keys follow the key-compromise playbook (section 9), not a simple swap.
4. Roll back to a known image: `fly deploy` with the previous image, or `fly machine stop` (fly-deploy.md Rollback).
5. The volume `coversaath_data` holds encrypted document files only if `DOCUMENT_STORAGE_BACKEND=filesystem` was set (default is `database`, so document bytes are in `document_blobs`). `fly.toml` sets `DOCUMENT_STORAGE_PATH=/data/documents`, but under the default backend that path is only the read fallback for older files (`src/server/create-server.js`); check the volume for files before assuming it is empty. Snapshot it before destroying anything. `fly apps destroy` is destructive and needs explicit owner approval.

### Vercel (website and BFF, separate repository)

1. Rotate `KNOWVIA_IDENTITY_TOKEN` together with Fly; rotate the OIDC client secrets and any session-sealing secret the BFF holds (names to be confirmed in the website repository).
2. Check the deployment list and environment variable change history for anything unexpected; roll back to the last known-good deployment or pause the project.
3. Turn on deployment protection for preview URLs if previews could reach real data.
4. Check whether the BFF or access logs recorded query strings (for example passage queries) and purge them if they hold personal data.

### Google Gemini (Gemini Developer API, `generativelanguage.googleapis.com`)

1. Revoke and reissue the API key (Google AI Studio or Google Cloud console); set the new `GEMINI_API_KEY` in Fly.
2. Set `POLICY_EVIDENCE_ENABLED=false` and `POLICY_STRUCTURING_ENABLED=false` until the cause is known.
3. Check usage in the console against `app_events` provider rows; unexplained calls mean a stolen key.
4. What reached Google is bounded by the privacy gate (redacted excerpts, 48,000 bytes per run; security.md). Record which runs and grants were involved from `workflow_runs` and `app_events`, not from content.
5. Ask Google what retention applies to the affected requests (depends on the API tier and terms; see processor register).

### Sarvam (Document AI, `api.sarvam.ai`)

1. Revoke and reissue `SARVAM_API_KEY` in the Sarvam dashboard; set `SARVAM_OCR_ENABLED=false`.
2. Sarvam's public API has no deletion endpoint (security.md Known gaps). Ask Sarvam in writing to delete the affected jobs, quoting the provider job references retained in `ocr_jobs` (do not send document content).
3. Local revocation already erases derived pages; remote deletion is not proved.

### PostHog

Not present in any checked-out code of this repository or the sibling website checkouts inspected (2026-11-07). If it is added or found in a deployed site: disable capture (remove the project key from the build), stop session recording, delete affected persons and events in PostHog, rotate the project and personal API keys, and add it to the register. Treat session recordings as personal data.

### Sentry (branch `patch/m1-logging` only)

Unset `SENTRY_DSN` (reporting stops at once), rotate the DSN, delete affected events and issues in Sentry, and check scrubbing with `tests/logging-leak.test.mjs` on that branch.

### AWS KMS

Not used. Keys are environment variables (security.md: "No managed secrets or KMS"). If KMS is adopted later: on suspected key misuse, disable the key or revoke the grant, review CloudTrail for `Decrypt` calls, and **never schedule key deletion during an incident** (deletion makes every sealed value unreadable, which is itself a breach of availability). Keys must stay in the project's selected Region.

### GitHub

1. Check secret-scanning and Dependabot alerts; run `gitleaks git .` over full history.
2. Revoke any leaked personal access token or deploy key; review repository collaborators and Actions secrets (CI uses none today).
3. A history purge follows `secret-hygiene.md` (branch `fix/s1-roles`): rotate first, purge second, owner approval required for any force-push.
4. `docs/evidence/` remains in git history pending an owner decision (data.md Retention); if it holds anything real, treat that as a SEV2 until reviewed.

## 6. Evidence preservation

1. Open an incident record outside this repository (an access-controlled folder chosen by the owner). Never commit evidence; the `docs/evidence/` history is the lesson.
2. Timeline in UTC with IST alongside: awareness time, each action, who did it, what was observed. Keep facts and assumptions in separate columns.
3. Capture before restarts or rotation where safe:
   - `fly logs -a knowvia-api --no-tail` and `fly releases`, saved to a file; record its sha256.
   - Supabase logs for the window (dashboard export or `query_logs`); advisor output.
   - `app_events` rows for the window (ids, codes, routes; the sealed payload stays sealed).
   - `audit_events` export for the affected households, with `previous_event_hash` and `event_hash`; verify the chain by hand if possible (no tool exists yet).
   - Vercel deployment and environment change history; GitHub audit log.
   - A Supabase backup or point-in-time marker before any repair, if the plan supports it.
4. Store captures encrypted, access limited to the incident roles, each file with its sha256 and who collected it (chain of custody). Fly proxy and app logs may carry `?q=` passage text, and Supabase `query_logs` (Postgres log) output may carry statement text and values, so treat both as personal data: save them straight to the encrypted store, never paste them into chat, tickets, e-mail or this repository, and share only counts, ids and codes. The same applies when an AI assistant or a Supabase MCP tool is used to read them.
5. Minimise: capture ids, codes and counts, not document text, names or contact details. If personal data must be kept as evidence, record why and delete it when the case closes.
6. Retention of incident records: `[OWNER AND LEGAL TO DECIDE]` (ADR 0018 Q1). FOR LEGAL REVIEW: DPDP Rule 6 is read as requiring logs to be kept for at least one year; confirm.

## 7. Notification (FOR LEGAL REVIEW, not final)

Engineering reading only. Counsel decides whether, when and what to notify.

### Data Protection Board of India (DPDP Act s8(6); DPDP Rules, Rule 7)

- On becoming aware of a personal data breach, the Data Fiduciary intimates the Board **without delay** with a description of the breach (nature, extent, timing, location, likely impact).
- Within **72 hours** of becoming aware (or a longer period if the Board allows on request), a further report with: updated and detailed facts; circumstances and reasons; mitigation measures taken or proposed; findings about the person who caused it, if known; remedial steps to prevent recurrence; a report on the intimations given to affected data principals.
- Open points for counsel: the commencement date of the breach-reporting rule, the filing channel and form, and whether a breach of encrypted data or of synthetic test data needs reporting.

### Affected data principals (s8(6); Rule 7)

- Intimate each affected data principal **without delay**, in clear and plain language, through their user account or registered contact: the description of the breach (nature, extent, timing, occurrence); likely consequences relevant to them; mitigation measures taken or being taken; safety measures they can take; and the business contact who can answer their questions.
- Contact channel available today: `adult_users` contact e-mail and phone (sealed). Outbound e-mail is not implemented: `src/integrations/email/email-provider.js` is a stub that refuses every call, and no sending provider is chosen (processor register row 13; security.md: no outbound email). The owner must choose a sending route before real data arrives.

### Other reporting to confirm with counsel

- **CERT-In** (Information Technology Act s70B and the CERT-In directions of 28 April 2022): certain cyber incidents are read as reportable within **6 hours** of noticing them, and logs as kept for 180 days within India. Confirm applicability, because Fly and Supabase logs are outside India today. FOR LEGAL REVIEW: the directions are also read as requiring system clocks to be synchronised to the NTP servers of NIC or NPL (or servers traceable to them), and as requiring a named point of contact for CERT-In. Both are open: Fly machines and Supabase use their own time sources today (UNVERIFIED), and the contact person is `[OWNER TO NAME]`.
- **Processors** must tell CoverSaath of their own breaches; contracts are UNKNOWN (processor register). Counsel to confirm what each processor's terms commit to.
- Sector rules (for example IRDAI) if CoverSaath becomes an insurance intermediary or works under one: counsel to confirm.
- Possible penalties under the DPDP Act Schedule for failing to notify or failing to keep reasonable security safeguards are significant; counsel to confirm amounts.

### Notification clock (template)

| Step | Target (FOR LEGAL REVIEW) | Done (UTC / IST) | By |
| --- | --- | --- | --- |
| Awareness recorded | T0 | | |
| CERT-In report, if applicable | T0 + 6 h | | |
| Board initial intimation | without delay | | |
| Data principal notices | without delay | | |
| Board detailed report | T0 + 72 h | | |
| Processor notices / requests | as needed | | |

## 8. Communication templates (DRAFT, FOR LEGAL REVIEW)

All templates are DRAFT. Counsel approves the final text and channel. Placeholders are in square brackets. Do not send any template unchanged.

### 8.1 Data principal notice (DRAFT, FOR LEGAL REVIEW)

> Subject: [DRAFT] Important information about your CoverSaath data
>
> We are writing to tell you about a security incident that affected some of your information held by CoverSaath.
>
> What happened: On [date] we found that [plain description]. It started on or about [date] and [has been stopped / is being contained].
>
> What information was involved: [list categories, for example your name and e-mail address, an insurance document you uploaded]. [State clearly what was not involved.]
>
> What this may mean for you: [likely consequences in plain words].
>
> What we have done: [containment and fixes].
>
> What you can do: [concrete steps, for example watch for messages that claim to be from your insurer and ask for your policy number; do not share one-time codes].
>
> Questions: contact [grievance officer name], [e-mail], [phone]. If our reply does not resolve your concern, you may have the right to complain to the Data Protection Board of India after using our grievance process [DPDP Act s13(3); FOR LEGAL REVIEW].
>
> [Signature]

### 8.2 Data Protection Board initial intimation (DRAFT, FOR LEGAL REVIEW)

> Data Fiduciary: [legal entity name, address]. Contact: [name, role, e-mail, phone].
> Breach became known on: [date, time IST].
> Description: [nature], [extent: number of data principals and categories], [timing and location of occurrence], [likely impact].
> Immediate measures: [containment so far].
> A detailed report will follow within the period prescribed.

### 8.3 Processor notice or deletion request (DRAFT, FOR LEGAL REVIEW)

> To [processor security contact]. CoverSaath is investigating an incident that may involve data processed under our account [account or project id]. Please [preserve logs for the period X to Y / revoke key ending ... / delete job references ...] and confirm in writing. Please tell us of any related incident on your side.

### 8.4 Internal status update (DRAFT)

> [SEV level] [time UTC]. Known: ... Unknown: ... Actions done: ... Next actions and owners: ... Next update at: ...

## 9. Playbook: encryption key compromise

Keys in scope: `DATA_ENCRYPTION_KEY_BASE64` (column envelopes, app-event payloads, contact hashes; ADR 0013, 0014, 0015) and `DOCUMENT_ENCRYPTION_KEY_BASE64` (document bytes, `CSD1` envelope).

1. Declare SEV1. A leaked key plus any database copy reads every sealed value (ADR 0013 D2).
2. Stop traffic (`PUBLIC_HOSTS` empty) and provider flags off.
3. Treat the database as potentially read: rotate the database password too (section 10), because a key alone is useless without the ciphertext.
4. Generate a new key in a trusted machine; never paste it into chat, tickets or files in the repository.
5. Column key rotation (ADR 0013 D2): set the new key and a new `DATA_ENCRYPTION_KEY_ID`, move the old key into `DATA_ENCRYPTION_PREVIOUS_KEYS_JSON`, run `scripts/encrypt-existing-rows.mjs --rotate` as the table owner in a quiet period, then remove the old key.
   - **Blocker:** contact hashes (`contact_email_hash`, `phone_hash`) are keyed from the data key, and no rehash tool exists (ADR 0015 D6a). Rotating now makes `POST /api/v1/access` miss existing adults and create duplicates. ADR 0015 D6a says do not rotate the data key until a rehash tool exists. Override that only by an owner decision recorded in ADR 0018 (Q5), and disable `POST /access` first (for example by stopping public traffic, or blocking that route at the BFF) so no duplicate adults are created, then rotate. Duplicates already created must be merged later by hand (no tool exists). In a proven key compromise with real data, the owner may decide the exposure outweighs this cost; record the decision and the time.
6. Document key: no rotation tool exists; re-encrypting every document needs a script that is not built (secret-hygiene.md item 3). With synthetic data, re-create the data. With real data, engineering must build and review the re-encryption before the old key is destroyed.
7. Never destroy the old key until every row reads under the new key; losing it loses the data (availability breach).
8. Verify. `npm run verify:user-data` refuses any database that is not on this machine (`scripts/verify-user-data.js` allows only loopback hosts and refuses the `coversaath_dev` database), so it cannot be pointed at the Supabase database. Either run it against a loopback restore or copy of the data, or run a read-only SQL check on the live database that counts `*_ciphertext` values not starting with `enc1.` or `enc2.` (the prefix test the script itself uses; it covers the seven user-data tables in ADR 0015, not every sealed column). Then spot-read sealed columns through the app and confirm `GET /api/v1/ready` passes.
9. Notify per section 7 if real data was present.

## 10. Playbook: database password compromise

1. Declare SEV1 if real data exists; SEV2 otherwise.
2. Rotate the `postgres` password in Supabase at once; update `DATABASE_URL` in Fly secrets and the local untracked env file; restart. Follow `db-roles.md` (branch `fix/s1-roles`) to move the runtime to a least-privilege role in the same change window if it is ready.
3. Review Supabase logs for connections from unknown addresses during the exposure window; capture them first (section 6).
4. Check integrity: call `GET /api/v1/ready` on loopback (on Fly, from inside the machine with `fly ssh console`, then `curl http://127.0.0.1:8080/api/v1/ready`; detail is returned only to loopback callers with no forwarding headers, `isLoopbackRequest` in `src/shared/http/security.js`) or read the Supabase security advisors. **Never run `npm run db:init` during an incident:** it is not read-only, it applies pending migrations (`runPostgresMigrations`) before it validates, and it would change the evidence. Check critical triggers enabled, RLS on every table, no API-role grants, no new roles, functions or extensions. Compare migration checksums in `schema_migrations`.
5. Check audit chain continuity for affected households by hand (no verifier exists).
6. A password holder could read plain columns and ciphertext. If the data key was not also exposed, sealed columns stay protected; plain columns (section 4, question 6) are exposed.
7. Notify per section 7 if real data was present.

## 11. Playbook: identity token compromise (`KNOWVIA_IDENTITY_TOKEN`)

Severity: SEV1. `POST /api/v1/identity-sessions` accepts any caller holding this token (`requireIdentityService` in `src/backend/services/tenant-access-service.js`). The body supplies `issuer` (must be one of `IDENTITY_ISSUERS`), `subject` and `displayName`; the API does not check them against any identity provider. Anyone with the token can therefore mint a session for any adult whose `(issuer, subject)` they know or can guess, and can create new adults and households. Nothing in the API proves the sign-in happened.

1. Declare SEV1. Stop public traffic (section 5, kill switches) if exploitation is suspected; otherwise move fast, because sign-in stays open until the token changes.
2. Capture evidence first (section 6): `app_events` rows with `event_name = 'sign_in'` or the identity-sessions route, `client_hash` values, `api_sessions` rows with `issued_at` in the exposure window, `auth_identities` and `adult_users` rows with `created_at` in the window (ids and timestamps only).
3. Generate a new token (32 to 256 characters, different from `KNOWVIA_BOOTSTRAP_TOKEN`; `src/server/config.js` and `tenant-access-service.js` enforce both). Never paste it into chat or tickets.
4. Rotate in Fly and Vercel together: `fly secrets set KNOWVIA_IDENTITY_TOKEN=...` (restarts the machine) and the same value in the Vercel project environment, then redeploy the website so the BFF reads it. Sign-in fails between the two changes; do them back to back. The old token must be dead in Fly before you rely on the new one.
5. Revoke every session, because any of them may have been minted by the attacker. As the table owner: `UPDATE api_sessions SET revoked_at = <now ISO UTC> WHERE revoked_at IS NULL;`. All users sign in again.
6. Review identities and adults created in the window. For a proven takeover only, set `auth_identities.revoked_at` for the attacker-created or hijacked rows (this burns the identity for good, ADR 0012 D3 (a)). Decide with counsel what to do with households created by the attacker.
7. Determine which households were read: use section 12 steps 2 to 4 for every session issued in the window.
8. Notify per section 7 if real data was present. Follow-up: consider per-request proof from the BFF (a signed assertion) so the shared token alone is not enough.

## 12. Playbook: cross-household read caused by an application bug

Severity: SEV1 once a read of another household's data is proven; SEV2 while suspected. Isolation is application code only (ADR 0018 Q2), so one missing ownership check is enough.

1. Contain: stop public traffic (section 5) or disable the affected feature flag. If the route is known, block it at the BFF as a narrower switch.
2. Find the route. Query `app_events` for the window: `route` (a template, not a raw URL), `method`, `status`, `household_id`, `adult_user_id`, `request_id`, `client_hash`. Look for 200 responses where the `household_id` on the event differs from the household that the adult owns (join `app_events.adult_user_id` to the household membership tables), and for one `client_hash` or adult touching many household ids. Remember `app_events` holds metadata only and has no foreign keys, so rows can exist for ids that were later erased.
3. List affected household ids (ids only, never names): every household whose data the route returned to an adult who is not a member. Separate households that were only probed (403, 404) from those where data was returned (200). Note which data categories the route returns (documents, answers, facts, profile answers).
4. Cross-check `audit_events` for the same households and the same window (consent, document and erasure actions by an actor who is not a member). Reads are not audited, so a missing audit row proves nothing. Verify the hash chain by hand if possible (no tool exists).
5. Hotfix: add the missing ownership check (`requireHousehold`, `requireCase`, `requireRun` in `tenant-access-service.js`) with a test that fails on the old code. Migration, security and consent changes need the independent read-only review (AGENTS.md); do not skip it under pressure. Check sibling routes for the same pattern.
6. Revoke sessions of any adult who read data they were not entitled to, preserve their `app_events` and `audit_events`, and do not contact them without counsel.
7. Notify per section 7 if real data was present: each affected household as a data principal, and the Board, with the route, window and fix in the description. Both the household whose data was read and the reader may be data principals.
8. Add the case to the tenant test suite and review ADR 0018 Q2 (move towards least-privilege role plus per-household RLS).

## 13. Recovery

1. Fix the root cause in a reviewed change (migration, security and consent changes need an independent read-only review, AGENTS.md).
2. Restore service in steps: loopback checks, `/ready`, then `PUBLIC_HOSTS`, then provider flags one at a time.
3. If data was altered or lost, restore from Supabase backup or point-in-time recovery only after evidence capture, and re-run revocation erasure for any grant revoked after the restore point (a restore can bring back erased data). No restore drill has run (data.md).
4. Watch the detection sources closely for at least 7 days.

## 14. Post-incident review

Within 10 working days of closure, blameless, written outside the repository if it names people or holds personal data; a redacted summary may go in `docs/iterations/LATEST.md`.

- Timeline, root cause, contributing factors, what detected it and how late.
- What data and how many data principals; notifications made and their times against the targets.
- What went well, what did not, and which controls failed.
- Actions with owners and dates. Typical follow-ups from current gaps: verify the audit hash chain; alerting on `app_events`; least-privilege runtime role; rehash tool for contact keys; document re-encryption tool; KMS or managed secrets; outbound notification channel; Sarvam deletion route.
- Update this runbook and the processor register.

## 15. Drills

Run a tabletop drill with synthetic data before the first real user and then every six months: one key-compromise, one database-password, one identity-token and one cross-household-read scenario. Record the time to contain and the time to a ready-to-send Board intimation.

## 16. Not verified

Fly and Supabase log retention windows, Supabase backup and PITR on the current plan, Vercel and BFF logging behaviour, whether PostHog is used anywhere deployed, every legal deadline and report content above, whether `fly scale count 0` destroys the machine, whether a Fly secret overrides the `fly.toml` `[env]` value of `PUBLIC_HOSTS` (and accepts an empty value), whether `curl` to loopback works from `fly ssh console` (no machine is deployed yet), clock synchronisation of Fly and Supabase, and whether any real personal data exists today (website waitlist).
