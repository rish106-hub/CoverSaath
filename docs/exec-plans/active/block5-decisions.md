# Block 5 decisions needing human approval

Companion to `block5-frontend-audit.md`. Nothing here is decided. Each item names what is blocked, the recommendation, and the review it needs. No slice beyond S0 may start until the decisions it depends on are recorded.

Status for every item: **OPEN**.

| ID | Decision | Recommendation | Blocks | Review required |
| --- | --- | --- | --- | --- |
| D1 | Identity: OTP, magic link, or Google/Microsoft OIDC. Who issues sessions. How the BFF maps a verified identity to an adult and household without exposing `KNOWVIA_BOOTSTRAP_TOKEN`. Recovery, rate limits, abuse model, rollout restriction | Choose after D2. Prefer an identity abstraction so a later OIDC or HRMS route can attach consented claims. OTP proves factor control only, never employer entitlement or insured status | S1 and all later slices | Security-sensitive: independent read-only review (AGENTS.md) |
| D2 | Backend deployment topology: where the API runs, BFF vs reverse proxy, server-to-server auth, cookie/CSRF/CORS policy, change to the Host/Origin allowlist (`src/shared/http/security.js:3-4`) and loopback logic (`:21-30`), clamd availability | Server-only Next BFF in front of a non-public API. Do not widen the allowlist or add CORS for browsers | S1 | Security review; ADR (hard to reverse) |
| D3 | Member and adult-invitation endpoints. Today only the owner exists (`household-repository.js:45`, called only at bootstrap) | New scoped backend work, each adult consents for themselves; guardian/minor rules written first | S2 People/Sharing screens | Consent-sensitive review; legal for invite copy |
| D4 | Citation viewer: page + quote sheet only, or a consent- and ownership-gated route that serves PDF bytes | Page + quote sheet for Block 5. Revisit bytes route after S3 | S3 viewer scope | Security review if a bytes route is chosen |
| D5 | First answer cost: accept one Gemini call (with its own `insurance_question` consent) per first view, or build a deterministic document-first summary layer | Accept the Gemini call for Block 5, shown honestly as "reading"; defer deterministic layer | S3 | Cost owner approval; consent copy to legal |
| D6 | Image intake: PDF-only copy, or a new secure image route (`ALLOWED_MIME_TYPES` already lists jpeg/png in `src/features/input/contracts.js:15`, but the route forces PDF) | PDF-only copy via artboard + regenerate. Never upload JPG/PNG as PDF | S0 copy fix | New route would need security + AI-intake review |
| D7 | Legal review of: consent copy, privacy notice (says previews store nothing), DPDP position, "Files are encrypted. Only people you allow can see them.", "We will email you when it is ready.", "Invites sent...", "17 days", "how much cash to keep ready", "Page 2, line 4", partner/"supported by" logo permissions | Mark all as draft; remove or soften claims the backend cannot back before any public traffic | Public launch of any app route | Legal (AGENTS.md: never treat wording as final) |
| D8 | Marketing repo state: commit, stash or discard 19 modified files plus untracked `docs/` on `codex/lean-agent-operating-model`; branch strategy; regenerate-and-diff before Block 5 work | Owner commits or stashes first; branch Block 5 from a clean base | S0 | Owner |
| D9 | UI home and frontend ADR. Recommended: `Knowvia_website` `/app` route group with server-only BFF. If any UI lands in CoverSaath, an accepted task and ADR for framework/tooling are required first (`check-architecture.mjs:17` rejects `src/ui`) | `Knowvia_website`; no CoverSaath ADR needed unless that changes | S1 | Owner |

## D2 evidence from the 2026-10-22 smoke test

A same-host BFF to a loopback API works without changing any backend control. Anything else (remote API, proxy that rewrites Host, browser calling the API) is refused by `assertLocalRequest` and cannot be fixed by the frontend. Viable options: (1) run the BFF on the same host as the API (simple, no deployment target exists); (2) add a reviewed, narrow server-to-server allowance in the backend (a configured allow-listed Host and a service credential, separate from user bearer tokens) with an ADR and independent security review; (3) put both behind one trusted gateway that terminates TLS and keeps the API loopback-only. Also needed whichever is chosen: backend routes to list a household's cases and consent grants (so BFF state need not live in a cookie), and a per-caller rate-limit key that survives a single trusted peer.

## Not decisions, but follow-ups found

- `docs/iterations/LATEST.md:3` names the wrong branch and says "uncommitted". Update in its own change when durable state is next touched.
- ADR 0007 is missing from `docs/adr/` (0006 then 0008). Confirm whether the gap is intentional.
- `.env.example` omits `POLICY_EVIDENCE_ENABLED` and related flags (verify the full list when fixing).
- Candidate pack references (Taste Skill, GOV.UK question pages, WCAG 2.2, Playwright snapshots, DPDP rules) were not evaluated in this audit; use as review guardrails only, never as a replacement for the approved artboards.
