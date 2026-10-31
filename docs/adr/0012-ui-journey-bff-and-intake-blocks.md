# ADR 0012: UI journey, BFF boundary and intake blocks

Status: proposed (2026-10-31). Synthetic data only. All consent, privacy and notice wording named here is DRAFT and needs legal review. Related: ADR 0011 (hosting), `docs/exec-plans/active/ui-journey.md`.

## Context

CoverSaath has no frontend. The website repository holds a Next.js BFF and the UI. The API sends no CORS headers and rejects unknown Host and Origin values, so a browser can never call it. The UI journey needs: sign-in, a list of the caller's own cases and permissions, a member-card document kind, a registry of intake channels, and later read-back of values and passages.

## Decisions

- **D1. The BFF is the only client.** The browser never calls `/api/v1`. The BFF calls it server to server. Host, Origin, CORS, rate-limit and session-TTL logic do not change.
- **D2. Intake connector registry.** `src/contracts/intake-connectors.js` holds 10 frozen descriptors (upload, camera, email_forward, gmail, outlook, insurer_portal, hr_portal, digilocker, whatsapp, voice). Only upload is `available`; camera, email_forward and voice are `stub`; the rest are `later`. Stubs in `src/integrations/intake/` fail closed with `UnconfiguredConnectorError` and make no network call. `GET /api/v1/integrations` lists them with health and reports `documentScan.mode`.
- **D3. Identity sessions (planned, run V1a).** A later expand-only migration 017 (`auth_identities`, RLS on) and `POST /api/v1/identity-sessions` behind a server credential map (issuer, subject) to an adult. Not built in run C. The threat model (account takeover, enumeration, token leakage, replay, bootstrap-token refusal) is recorded here when V1a is built.
- **D4. Two consent moments.** Keep the document; read these N documents (U3). A reading grant covers only documents that exist when the user consents.
- **D5. Scanning is on in hosting** (`DOCUMENT_SCAN_MODE=clamd`, U4). Until then the UI says documents wait for security checks.
- **D6. Read-only list routes.** `GET /api/v1/households/{id}/cases` and `/consents` return the caller's own records, bounded (limit 1-100, default 50, newest first, `truncated` flag), after `requireHousehold`. Cases never expose estimate, currency or member. Consent status is computed in SQL with the same `julianday` comparison as `requireActive`, so a NULL expiry reads as active (no expiry) and an unparseable expiry reads as expired. The cases list returns only cases the caller opened (`opened_by_adult_id`), not cases they only participate in. No new error codes.
- **D7. `member_card` is an accepted upload kind.** The database already allowed it. Other kinds stay refused.
- **D8. Voice intake is a contract only** (`voice-intake/v0`). Prefill values are `extracted_unverified` or `unknown`, never verified. No audio is captured.
- **D9. Read-back routes for values and passages: pending U5.** This would change the AI.md line "No route returns OCR text". Nothing is built or changed until the lead approves.
- **D10. JPEG/PNG intake by conversion to a one-page PDF: pending U10.** Nothing is built.

## Consequences

Additive code only: no migration, no new dependency, no change to existing consent, tenant, audit or erasure logic. Deferred: U6 (stored confirmed renewal date), U7 (Gemini top-up), U8 (data residency; synthetic data only until decided). Before any open sign-up with paid OCR (U9), a per-household page cap or subject allow-list is needed; it is not part of this change.
