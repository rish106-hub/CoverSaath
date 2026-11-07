# ADR 0018: Privacy risk-acceptance decisions before real data

- Status: Proposed. Owner decisions pending. **FOR LEGAL REVIEW** in full: every option and recommendation below is an engineering view, not legal advice.
- Date: 2026-11-07
- Related: ADR 0011 (Supabase + Fly, D8 residency), ADR 0013 (encryption, D10 RLS), ADR 0014 (app events), ADR 0015 (user data), [incident response runbook](../runbooks/incident-response.md), [processor register](../architecture/processor-register.md). On unmerged branches: `docs/architecture/data-lifecycle.md` (branch `patch/s3-erasure`), ADR 0016 (branch `patch/m1-logging`). ADR numbers 0016 and 0017 are used on other branches.

## Context

CoverSaath holds synthetic data only. Before real Indian health-insurance data arrives, five risks need an explicit owner choice, because code alone cannot decide them and each touches DPDP Act duties (s8(5) safeguards, s8(7) erasure, s16 transfer; FOR LEGAL REVIEW). Today the repository either leaves them open (data.md Retention: "Not decided") or makes a default that nobody has accepted.

## Q1. Retention periods

Facts: idempotency keys 24 h (decided); sessions `SESSION_TTL_SECONDS` but rows never purged; `app_events` 30 days default (ADR 0014); current location 24 h (ADR 0015 D4); audit events kept forever; derived data after consent expiry not erased (security.md, review F3); no period for documents, cases or incident records; backups follow the Supabase plan.

Options:

- **A. Keep the defaults, decide later.** No work. Risk: storage limitation duty unmet; expired consents leave derived data.
- **B. Fixed schedule now.** Proposed starting values for counsel: documents and derived data erased when consent is revoked or expires, or 30 days after the household closes; `app_events` 30 days; expired session rows purged after 30 days; app logs 30 days (ADR 0016) or the period counsel requires; audit events and incident records for the period counsel sets (DPDP Rule 6 is read as at least one year for logs; CERT-In directions as 180 days; confirm); backups no longer than the shortest erasure promise the notice makes.
- **C. Per-purpose schedule in `retention_records` with legal holds.** Most flexible; more build.

Recommendation: **B now, with expiry treated like revocation** (erase derived data on expiry), using the retention sweep on branch `patch/s3-erasure`. Move to C only if a legal hold is needed. FOR LEGAL REVIEW: every number.

## Q2. Household isolation model

Facts: isolation is enforced in application code on every read and write; RLS is deny-all for the Data API only; the runtime role bypasses RLS; `FORCE ROW LEVEL SECURITY` was rejected (ADR 0013 D10, D11). One bug in an ownership check can expose another household.

Options:

- **A. Accept application-only isolation** for the prototype, with the existing tenant tests and an independent review of each new route.
- **B. Least-privilege non-bypass runtime role plus per-household RLS policies** keyed on a session setting (`set_config('app.household_id', ...)`) inside each transaction, then `FORCE ROW LEVEL SECURITY`. Defence in depth; needs session-mode pooling (already required, ADR 0011 D3) and careful work on cross-household system jobs (sweeps, workers).
- **C. Separate database or schema per household.** Strongest; does not fit one shared master database or the cost target.

Recommendation: **A until real data, B before real data at scale**, starting with the least-privilege role (`db-roles.md`, branch `fix/s1-roles`) and policies on the tables that hold content (documents, pages, clauses, facts, answers, user data). Record the residual risk until B ships.

## Q3. Audit foreign-key residue after erasure

Facts: `audit_events` is append-only, hash-chained, and has foreign keys to `households` and `service_cases`, so a household erasure leaves content-free tombstones (household, cases, the adult a case names, and redacted rows of append-only stores). Free-text revocation reasons in old audit payloads stay (data-lifecycle.md, branch `patch/s3-erasure`).

Options:

- **A. Accept content-free tombstones** (ids, enums, digests, timestamps). Proved by the erasure canary test on that branch. Ids are pseudonymous but still link to the audit chain.
- **B. Drop the two audit foreign keys** so tombstones can be deleted; audit rows keep orphan ids. Smaller residue; audit-adjacent schema change needing independent review.
- **C. Pseudonymise ids in audit at erasure** (rewrite with a keyed hash). Breaks the append-only hash chain; not recommended.

Recommendation: **A for the prototype, B before real data**, plus restricting revocation reasons to a code so no free text enters audit payloads. FOR LEGAL REVIEW: whether content-free tombstones and a retained audit chain meet the erasure duty, and how long the chain may be kept.

## Q4. Cross-border processing for Gemini (and the hosting region)

Facts: the Gemini Developer API endpoint is global; excerpts pass a privacy gate but still carry health and policy content. Supabase and Fly are in Sydney; Vercel region unknown (processor register). ADR 0011 D8 already blocks real data in Sydney pending a decision.

Options:

- **A. Keep the Gemini Developer API** on a paid project, relying on the gate and DPDP s16 (transfer allowed unless a country is restricted; FOR LEGAL REVIEW) and Google's terms.
- **B. Move to Vertex AI in `asia-south1` (Mumbai)** with a regional endpoint and enterprise data terms. Same models where available; small adapter change; cost and model availability to check.
- **C. No external model for real data** until a local or Indian-hosted option is chosen; deterministic read-back only (ADR 0012 D9).

Recommendation: **B before real data**, together with moving the database to Mumbai and pinning the Vercel function region; **C** as the default until B is done (keep `POLICY_EVIDENCE_ENABLED` and `POLICY_STRUCTURING_ENABLED` off for real households). Never use an unpaid tier with real data. FOR LEGAL REVIEW: transfer position, sector rules, and the notice and consent wording that names the recipient (`google-gemini`).

## Q5. Data key rotation before the contact rehash tool exists

Facts: `contact_email_hash` and `phone_hash` are keyed from a value derived from `DATA_ENCRYPTION_KEY_BASE64`. After a rotation, `POST /api/v1/access` finds no existing adult and would create a duplicate. No rehash tool exists, and ADR 0015 D6a says not to rotate until it does. A key compromise (incident-response.md section 9) may force a rotation anyway. Duplicate adults cannot be merged by any tool today.

Options:

- **A. Never override D6a.** Build the rehash tool first. Safest for data integrity; leaves a compromised key in use until the tool ships.
- **B. Override only by owner decision, recorded here, with `POST /access` disabled first.** The owner records the date, the incident and the accepted cost (manual merge of duplicates later), then rotates the key with `scripts/encrypt-existing-rows.mjs --rotate` as in the runbook.
- **C. Build the rehash tool now**, before real data. Removes the conflict; small build, needs review.

Recommendation: **C before real data; B only as a recorded break-glass in a proven compromise until C ships.** FOR LEGAL REVIEW: whether continuing to use a known-compromised key is acceptable for any period once real data is present.

## Decision

None yet. The owner records a choice per question here (option, date, accepted residual risk) after counsel reviews. Until then, real data stays blocked (ADR 0011 D8).

## Consequences

- Choosing B in Q1, Q2 or Q3 creates build work (sweep rules, a runtime role and policies, a migration dropping two foreign keys); each needs its own plan and an independent review (AGENTS.md).
- Q4 B changes a provider and region; the processor register and consent recipient strings must change with it.
- Rollback: this ADR changes no code. Each later implementation carries its own rollback.
