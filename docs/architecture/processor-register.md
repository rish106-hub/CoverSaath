# Processor register

Status: DRAFT, prepared 2026-11-07 from the repository at `main` 23ab6d6, `.env.example`, `fly.toml`, ADRs 0011 to 0015, and the docs of the sibling branches named below. Synthetic data only today (ADR 0011 D8). Not a legal record of processing.

**FOR LEGAL REVIEW.** Whether each party is a Data Processor under the DPDP Act, 2023 (s2(k), s8(2): a processor may be engaged only under a valid contract), whether cross-border transfer is permitted (s16 and any restriction notified under it), and the retention and erasure duties (s8(7)) are for counsel to confirm. Nothing here is a statement that any contract, data processing agreement (DPA) or transfer is lawful.

Legend:

- **Grounding:** `code` = seen in this repository's code or config; `doc` = named in an ADR or runbook only; `branch` = only on an unmerged branch; `none` = not found anywhere inspected.
- **UNVERIFIED** = not checked against the provider's own terms, dashboard or account.
- **Contract/DPA:** UNKNOWN for every row. No signed contract, DPA, or record of accepted online terms is in the repository. Owner action is listed per row.

Related: [incident response runbook](../runbooks/incident-response.md), [ADR 0018](../adr/0018-privacy-risk-acceptance.md), [security model](security.md), [data architecture](data.md).

## Summary

| # | Party | Touches personal or derived data? | Grounding | Region today | Cross-border from India |
| --- | --- | --- | --- | --- | --- |
| 1 | Supabase | Yes, all of it (master database) | code, doc (ADR 0011) | `ap-southeast-2` Sydney | Yes |
| 2 | Fly.io | Yes, all of it in transit and in memory; documents on the volume if the filesystem backend is used | code (`fly.toml`), doc | `syd` Sydney | Yes |
| 3 | Vercel | Yes: website, BFF, sign-in, waitlist, proxied uploads | doc (ADR 0011 D7, 0012 D1); website repository | UNVERIFIED | Likely yes |
| 4 | Google (Gemini API) | Yes: redacted document excerpts and structuring input | code | Global endpoint, no region pinned | Yes |
| 5 | Sarvam | Yes: whole insurance PDFs for OCR | code | UNVERIFIED (Indian company) | UNVERIFIED |
| 6 | PostHog | Not found | none | n/a | n/a |
| 7 | Sentry | Only scrubbed error metadata, by design | branch (`patch/m1-logging`, ADR 0016) | UNVERIFIED | Likely yes |
| 8 | AWS KMS | No (not used) | none (security.md: no KMS) | n/a | n/a |
| 9 | Grafana | No (not used; later task M2) | branch mention only | n/a | n/a |
| 10 | GitHub | Source, docs, CI; possibly old evidence in history | code (`.github/`), doc | US (UNVERIFIED) | Yes, if real data is ever committed |
| 11 | Gnani (voice) | Recipient of raw health speech (audio) and TTS text once enabled. None today (off by default) | code (adapter, off unless `GNANI_VOICE_ENABLED=true`; wire format from docs.gnani.ai, not exercised live) | Not stated in the docs (O5 open) | UNVERIFIED |
| 12 | Pine Labs (payments) | Planned: payer and order details. None today | code (stub, refuses all calls today) | n/a | UNVERIFIED |
| 13 | Institutional e-mail sender (provider not chosen) | Planned: approved question text and recipient address. None today | code (stub, refuses all calls today) | n/a | UNVERIFIED |
| 14 | Intake connectors (camera, e-mail forward, voice, Gmail, Outlook, insurer and HR portals, DigiLocker, WhatsApp) | Planned: documents, mail, voice. None today | code (stubs, refuse all calls today) | n/a | UNVERIFIED |

## 1. Supabase

- **Role:** hosts the master PostgreSQL 17 database `coversaath` and the website schema `knowvia_web` (ADR 0011 D1, D2, segment map).
- **Data categories:** every table in `public`: households, adults (names, contact e-mail and phone, dates of birth in plain), members, roles, sessions (token digests), identities (subject sha256), consent grants and revocations, document rows and, with the default `DOCUMENT_STORAGE_BACKEND=database`, encrypted document bytes in `document_blobs` (ADR 0013 D8); OCR pages and blocks, clauses, answers, evidence facts, parameter observations, workflow runs and tasks, profile answers, places and locations, preferences, onboarding, scenarios (ADR 0015), `app_events`, `audit_events`, rate-limit and budget rows (ADR 0014). Website: waitlist e-mail and first name, voice notes (ADR 0011).
- **Protection:** application-layer AES-256-GCM on the columns in ADR 0013 D3 and ADR 0015 D1; keys stay on Fly, not in Supabase. Plain columns remain (dates of birth, `relationship_label`, `policy_answers.question`, parameter values, workflow tasks, audit and outbox JSON, ids). TLS with pinned CA (ADR 0011 D4). RLS on, Data API roles revoked (D10).
- **Purpose:** system of record for the service.
- **Region / cross-border:** Sydney, Australia. Accepted for synthetic data only; real data needs Mumbai (`ap-south-1`) or legal sign-off (ADR 0011 D8; ADR 0018 Q4 related).
- **Retention:** as long as the database exists; erasure paths per data.md and ADR 0015 D5; backups and PITR per Supabase plan (UNVERIFIED), which keeps erased rows until backups expire.
- **Sub-processors:** Supabase runs on AWS (`aws-0-<region>.pooler.supabase.com`, ADR 0011 D3). Supabase's own sub-processor list UNVERIFIED.
- **Contract/DPA:** UNKNOWN. **Owner action:** confirm plan; accept or sign Supabase's DPA; download its sub-processor list; confirm backup retention and whether backups can be region-pinned; decide the Mumbai move before real data.

## 2. Fly.io

- **Role:** runs the API container `knowvia-api` (ADR 0011 D7, D9; `fly.toml`). Not deployed yet (fly-deploy.md).
- **Data categories:** all request and response bodies in transit and in process memory (TLS terminates at the Fly proxy); app secrets in Fly secrets (`DATABASE_URL`, `DOCUMENT_ENCRYPTION_KEY_BASE64`, `DATA_ENCRYPTION_KEY_BASE64`, `KNOWVIA_BOOTSTRAP_TOKEN`, `KNOWVIA_IDENTITY_TOKEN`, provider keys); encrypted volume `coversaath_data` at `/data` holding document files only if `DOCUMENT_STORAGE_BACKEND=filesystem` is set (default is `database`; `DOCUMENT_STORAGE_PATH=/data/documents` in `fly.toml` is then only the read fallback for older files, `src/server/create-server.js`); stdout logs; proxy access logs including URLs (passage queries travel as `?q=`, ADR 0012 D9); client IP (`Fly-Client-IP`).
- **Purpose:** compute host.
- **Region / cross-border:** `syd` Sydney; Fly has no Mumbai region (ADR 0011 D7).
- **Retention:** log retention UNVERIFIED (ADR 0016 says "a short window"); volume until destroyed; secrets until removed.
- **Sub-processors:** UNVERIFIED (Fly's own list).
- **Contract/DPA:** UNKNOWN. **Owner action:** accept Fly's DPA if offered; confirm log retention and access-log contents; confirm that Fly staff access to secrets and volumes is governed by its terms.

## 3. Vercel

- **Role:** hosts the website and the Next.js BFF, the only client of the API (ADR 0012 D1). Code lives in the sibling website repository, not inspected in depth here.
- **Data categories (from ADRs, UNVERIFIED in website code):** OIDC sign-in exchange and provider tokens (sealed by the BFF), issuer and subject sent to the API, display name and contact e-mail, the API session token, every document upload and response passing through, waitlist e-mail and first name written to `knowvia_web`, `KNOWVIA_IDENTITY_TOKEN` and the Supabase CA (`DATABASE_SSL_CA`, LATEST.md), runtime and access logs.
- **Purpose:** website, sign-in, server-side proxy.
- **Region / cross-border:** function region UNVERIFIED (Vercel's default is a US region unless configured).
- **Retention:** runtime log retention per plan, UNVERIFIED.
- **Sub-processors:** Vercel runs on major clouds; list UNVERIFIED. The OIDC identity providers in `IDENTITY_ISSUERS` (for example Google) are separate parties the owner should add when chosen.
- **Contract/DPA:** UNKNOWN. **Owner action:** confirm plan, function region (pin to `bom1` Mumbai if available on the plan), log retention, and that the BFF logs no query strings or bodies; accept the DPA; list the identity providers.

## 4. Google (Gemini Developer API)

- **Role:** model provider for policy evidence and structuring. `@ai-sdk/google` `createGoogleGenerativeAI` with an API key (`live-coverage-runtime.js`, `structuring-runtime.js`); `field-adjudicator.js` calls `https://generativelanguage.googleapis.com/v1beta/models/`. This is the Gemini Developer API, not Vertex AI.
- **Data categories:** document-derived excerpts that passed the privacy gate (known names, dates of birth, phones and e-mails replaced by placeholders; restricted data and cards refused; 48,000 bytes per run cap; security.md). Policy text and clause content. No direct identifiers by design, but residual health and policy details remain. Only with a current grant whose recipient is exactly `google-gemini`.
- **Purpose:** propose extractions and answers (model output is only `extracted_unverified`, `conflicting` or `unknown`).
- **Region / cross-border:** global endpoint; processing location not pinned. Cross-border.
- **Retention:** depends on the API tier and Google's terms (UNVERIFIED). FOR LEGAL REVIEW: unpaid tiers of the Gemini Developer API have been offered on terms that allow use of content to improve products; paid use has different terms. Confirm which applies to the key used.
- **Sub-processors:** Google's list, UNVERIFIED.
- **Contract/DPA:** UNKNOWN. **Owner action:** use a paid, billing-enabled project; confirm data-use, retention and abuse-monitoring terms; consider Vertex AI with a regional endpoint (`asia-south1`) if residency matters (ADR 0018 Q4). Feature flags off by default.

## 5. Sarvam

- **Role:** OCR (Document AI) via `src/integrations/sarvam/doc-ai-transport.js`, base `https://api.sarvam.ai`. Off unless `SARVAM_OCR_ENABLED=true`.
- **Data categories:** whole insurance PDFs (personal and medical content: names, policy numbers, members, health conditions), split into segments; returns page text. Only clean, consented documents with an exact `sarvam` grant.
- **Purpose:** read uploaded documents.
- **Region / cross-border:** Sarvam is an Indian company; hosting region UNVERIFIED.
- **Retention:** UNVERIFIED. No deletion or cancellation endpoint in the public API (security.md Known gaps). CoverSaath retains the provider job reference.
- **Sub-processors:** UNVERIFIED (cloud host).
- **Contract/DPA:** UNKNOWN. **Owner action:** get Sarvam's terms and DPA in writing, its hosting region, retention of uploaded files and outputs, a deletion procedure for job references, and breach-notice commitments.

## 6. PostHog

- **Grounding:** none. No reference in this repository's code or config, and none found in the sibling checkouts `Knowvia_website`, `Knowvia_website-clean`, `CoverSaath frontend` and `Knowvia Frontend` (searched 2026-11-07).
- **Owner action:** confirm it is not used on any deployed site. If it is added: no autocapture on authenticated pages, no session recording of document or answer screens, EU or other chosen region, retention set, DPA, and add the row here before launch.

## 7. Sentry

- **Grounding:** branch `patch/m1-logging` only (ADR 0016). Off unless `SENTRY_DSN` is set.
- **Data categories (by design):** error type, a trusted error code, sanitised relative stack frames, request id tag, request method. No user, request body, breadcrumbs or local variables (ADR 0016 D4). Residual risk: a scrubber miss.
- **Purpose:** error reporting.
- **Region / cross-border:** Sentry org region UNVERIFIED (US or EU data residency is chosen at org creation).
- **Retention:** per Sentry plan, UNVERIFIED.
- **Contract/DPA:** UNKNOWN. **Owner action:** choose the org region, accept the DPA, set event retention, enable server-side scrubbing as a second layer.

## 8. AWS KMS

- **Grounding:** none. Keys are environment variables (security.md: "No managed secrets or KMS"; evidence-first-reasoning.md: "Key in env file; no KMS").
- **Data categories:** none today. If adopted, KMS would hold key material only, never data, and would log key use.
- **Owner action:** decide whether to move `DATA_ENCRYPTION_KEY_BASE64` and `DOCUMENT_ENCRYPTION_KEY_BASE64` into KMS envelope encryption. If so, create keys only in the project's selected Region (no multi-Region keys), confirm the Region in AWS Settings, and add the row with contract status.

## 9. Grafana

- **Grounding:** named only as a later task (M2) in ADR 0016 D1 on branch `patch/m1-logging`.
- **Owner action:** before any log or metric shipping, add the row with region, retention and DPA; ship only the scrubbed metadata lines.

## 10. GitHub

- **Role:** source control, CI (`.github/workflows/ci.yml`, `dependency-review.yml`), Dependabot, CodeQL default setup.
- **Data categories:** code, docs, synthetic fixtures. CI runs with no secrets (security.md). Risk items: `docs/evidence/` stays in git history pending an owner decision (data.md Retention); local untracked files with secrets (`.claude/launch.json`) could be committed by mistake (secret-hygiene.md, branch `fix/s1-roles`).
- **Purpose:** development.
- **Region / cross-border:** GitHub stores data in the US by default (UNVERIFIED for this account).
- **Retention:** until history is rewritten; forks and caches may keep copies.
- **Contract/DPA:** UNKNOWN (GitHub's standard terms). **Owner action:** confirm repository visibility; decide on `docs/evidence/`; add gitleaks to CI; keep real data out of the repository entirely.

## 11. Gnani (voice)

- **Grounding:** code, off by default. `src/integrations/gnani/voice-provider.js` is live only when `GNANI_VOICE_ENABLED` is exactly `true` and `GNANI_API_KEY_ID` is set (`GNANI_BASE_URL` optional, default `https://api.vachana.ai`, https only; `GNANI_TTS_VOICE` for TTS; `GNANI_QUEUE_WAIT_MS` default 3000). `transcribe` (WAV, ogg/opus, m4a or mp3 up to 512 KB and 15 s; en-IN, hi-IN or Hinglish) and `synthesize` (text up to 25 words) need `authorization` with `authorized: true`, `purpose: 'voice_intake'` and `recipients` including `gnani`. `transfer` and `verifyWebhook` stay refused. Wire format (STT `POST /stt/v3` multipart, TTS `POST /api/v1/tts/inference`, header `X-API-Key-ID`) comes from docs.gnani.ai and is isolated in `gnani-transport.js`; not exercised live. The account allows one active request: calls are single-flight in process (queue of 5, 3 s wait, then a coded busy error; multi-machine needs a DB lease, ADR 0022 D5). Circuit breaker: 3 consecutive retryable failures open it for 60 s. A TTS cache holds only strings with no digits, number words, dates, months or rupee amounts; personal headlines are always synthesised fresh. Local stub: `scripts/gnani-stub.mjs`.
- **Data categories:** recipient of raw health speech (audio of the user speaking; may include names, policy details, health information) and of short read-back text. Transcripts are never logged by the adapter; only a numeric `voice_queue_wait_ms` metric is emitted. FOR LEGAL REVIEW.
- **Purpose-registry recipient:** no recipient list exists for `voice_intake` yet in `src/contracts/data-purpose-registry.js`; `gnani` is documented here only. Add a registry row and the consent text naming Gnani with the voice route (architecture-v1 B3).
- **Region / cross-border:** the docs do not state the hosted region. The homepage claims cloud and on-prem options and IRDAI residency support, but this is unverified for `api.vachana.ai`, so O5 stays open. **Retention:** not stated for the API. Sub-processors UNVERIFIED.
- **Contract/DPA:** UNKNOWN. **Owner action:** before enabling, get Gnani's terms, DPA, hosting region, audio and transcript retention, a deletion route, and more concurrency than one request; keep `GNANI_API_KEY_ID` out of Fly secrets until then. Live run needs owner approval.

## 12. Pine Labs (payments)

- **Grounding:** code (stub, refuses all calls today). `src/integrations/pine-labs/payment-provider.js` needs `PINE_LABS_CLIENT_ID` and `PINE_LABS_CLIENT_SECRET`; `createHostedCheckout`, `getPayment`, `reconcile`, `verifyWebhook` and `normalizeEvent` all throw.
- **Planned data categories:** hosted checkout means card and bank details are entered on the provider's page, not ours; CoverSaath would hold order ids, amounts, payment status and webhook payloads. Payer name, e-mail and phone may be sent to create the order. Role text in code: explicitly approved hosted premium checkout and reconciliation.
- **Region / cross-border, retention, sub-processors:** UNVERIFIED. Nothing is called today.
- **Contract/DPA:** UNKNOWN. **Owner action:** before enabling, get Pine Labs terms and DPA, confirm what payer data is sent, webhook signing and replay protection, and regulatory position for taking premium payments (FOR LEGAL REVIEW); never store card data.

## 13. Institutional e-mail sender

- **Grounding:** code (stub, refuses all calls today). `src/integrations/email/email-provider.js` needs `EMAIL_API_KEY` and `EMAIL_FROM`; `sendApprovedMessage`, `getDelivery`, `verifyWebhook` and `normalizeEvent` all throw. No sending provider is chosen. The sender is not yet usable for breach notices either (incident-response.md section 7).
- **Planned data categories:** an exact approved question text, the recipient address (an insurer or institution), delivery status, replies (treated as evidence only). The question text may carry policy or health details.
- **Region / cross-border, retention, sub-processors:** UNVERIFIED; depends on the provider chosen.
- **Contract/DPA:** UNKNOWN. **Owner action:** choose a provider, then add its full row; keep `EMAIL_API_KEY` out of Fly secrets until then.

## 14. Intake connector stubs

- **Grounding:** code (stubs, refuse all calls today). `createIntakeConnectorStubs` (`src/integrations/intake/intake-connector-stubs.js`) builds fail-closed stubs for every connector in `src/contracts/intake-connectors.js` that is not `available`: `camera`, `email_forward`, `voice` (availability `stub`) and `gmail`, `outlook`, `insurer_portal`, `hr_portal`, `digilocker`, `whatsapp` (availability `later`). Each stub's `health()` reports `status: not_built`, `networkAttempted: false`; every other method throws. Only `upload` is live, through the document route.
- **Planned data categories (from the connector descriptors):** document bytes (camera, e-mail forward, WhatsApp), document candidates from mailboxes and portals (Gmail, Outlook, insurer and HR portals, DigiLocker; scopes such as `inbox:search_insurance_mail`, `portal:fetch_policy`, `registry:fetch_policy`), voice prefill (voice). Mailbox access is broad and sensitive; each connector's notice key ends `-draft-legal-review`.
- **Region / cross-border, retention, sub-processors:** UNVERIFIED per connector. Nothing is called today.
- **Contract/DPA:** UNKNOWN per connector. **Owner action:** each connector gets its own register row, scope minimisation review, revocation path and OAuth token storage design (tokens are credentials: sealed, rotatable) before it is built.

## Gaps and follow-ups

- No contract, DPA or transfer assessment exists for any party.
- Supabase, Fly.io, Google (Gemini) and GitHub process outside India today. Vercel and Sentry are likely outside India (region UNVERIFIED). Sarvam is the only live party that may process in India, and even that is UNVERIFIED.
- Rows 11 to 14 are code stubs: they make no network call and hold no data today (`createProviderBoundary` always refuses; `networkAttempted: false`). Each needs a full row (region, retention, DPA) before it is enabled.
- Two backup and log layers (Supabase backups, Fly and Vercel logs) can hold data after in-app erasure; their retention is unknown.
- Identity providers for sign-in, an e-mail sender for breach notices, and any analytics tool are not yet chosen and must be added here when they are.
- Review this register at every new integration and before real data.
