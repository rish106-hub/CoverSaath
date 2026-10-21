# Block 5 frontend audit (audit only, no UI built)

Audit of the backend `CoverSaath` at `56f4fa5` (branch `block4/household-reasoning`, clean) and the marketing repo `Knowvia_website` at `f0166f5` (branch `codex/lean-agent-operating-model`, **dirty working tree**: 19 modified files plus untracked `docs/`). Source: `~/Downloads/Knowvia_Block5_Research_and_Repo_Audit.md` (the research pack), checked against code.

Nothing was built, changed or deployed. No UI, no dependency, no backend change, no provider call. Synthetic-only repo rules still apply.

Labels: IMPLEMENTED (code exists) · NOT_IMPLEMENTED (absent, not planned or assumed) · MOCK (marketing static UI, no backend call) · UNVERIFIED (inferred, not run). Nothing here is EXTERNALLY_VALIDATED or PRODUCTION_READY.

Line numbers are for the commits above. Marketing line numbers shift with the dirty tree; re-resolve before relying on them. Paths marked `K:` are in `Knowvia_website`, all others in `CoverSaath`.

## 0. Verdict

The backend is a guarded local API, not a product backend a browser can use. Marketing onboarding is a static mock with no handler that calls an API. Block 5 is therefore blocked on identity, deployment topology and member management before any real screen can work. Slice 0 (design baseline) is the only unblocked work.

### Corrections to the research pack

| Pack claim | Finding | Evidence |
| --- | --- | --- |
| Latest `main` df93e98 | Audited branch is `56f4fa5`; `main` was not re-audited | `git log` |
| `scripts/gen_site.py` | Lives at `K:scripts/design-port/gen_site.py` | file listing |
| Upload accepts only PDF (implied by route) | HTTP route forces `application/pdf`; the shared validator `ALLOWED_MIME_TYPES` still lists jpeg and png, so PDF-only is a route rule, not a contract rule | `src/server/routes/v1-backend-routes.js:468`, `src/features/input/contracts.js:15` |
| No prod reviewer route (inferred) | `POST /cases/{id}/decision-catalogue/reviews` and `POST /households/{id}/catalogue-reviewers` exist. Household confirmer = self confirmation, never `proven`. Independent reviewers are operator-granted only, route gated by `CATALOGUE_INDEPENDENT_REVIEW_ENABLED` (default off) | `v1-backend-routes.js:362-391` |
| Document states: received, quarantined, scanning, processing, unreadable... | Document DTO has only 5 states: `received_pending_checks`, `accepted`, `rejected`, `deletion_pending`, `deleted`. Quarantine, scanning, scan-disabled and scan-failed are all `received_pending_checks`. OCR and structuring states come from separate job resources | `src/backend/services/document-upload-service.js:32-52` |
| `LATEST.md` is current | Stale: says branch `block3/synthetic-acceptance`, "uncommitted"; actual branch `block4/household-reasoning`, committed (`9722b5b`, `786d90a`, `56f4fa5`) | `docs/iterations/LATEST.md:3` |

## 1. EXISTING_COMPONENT_MAP

### Marketing repo (`Knowvia_website`)

Next 16.3.8, React 19.2.8, TypeScript, vitest 5.0.3 (`K:package.json`). No Tailwind, no shadcn, no Playwright, no `.github/workflows`.

| Route | Component | Source artboard | Status |
| --- | --- | --- | --- |
| `/` | `src/components/home/*` | `Main.dc.html` | MOCK (landing; waitlist posts to `src/app/api/waitlist`, separate Postgres) |
| `/onboarding` | `OnboardingStart.tsx` | `O1-Start` | MOCK |
| `/onboarding/coming-up` | `OnboardingComingUp.tsx` | `O2-Event` | MOCK (local toggle only, `onClick={o.pick}` L39) |
| `/onboarding/people` | `OnboardingPeople.tsx` | `O3-People` | MOCK |
| `/onboarding/sharing` | `OnboardingSharing.tsx` | `O4-Sharing` | MOCK (one switch, `onClick={v.toggle}` L95) |
| `/onboarding/add-policies` | `OnboardingAddPolicies.tsx` | `O5-Upload` | MOCK (file input L43 has no `onChange`) |
| `/onboarding/reading` | `OnboardingReading.tsx` | `O6-Reading` | MOCK (CSS gradient bar L30, no progress signal) |
| `/onboarding/your-cover` | `OnboardingCoverDesktop.tsx`, `OnboardingCoverMobile.tsx` | `O7-Matrix-*` | MOCK (hardcoded "Brother, 24", "Brother") |
| `/for-partners`, `/privacy`, `/terms` | pages | | static |

Model files `design/claude-design/o1..o7-*-model.js` hold the hardcoded example data.

Generated code: `scripts/design-port/README.md` forbids hand edits; regenerate with `python3 scripts/design-port/gen_site.py design/claude-design .`.

### Backend (`CoverSaath`)

All HTTP routes are in `src/server/routes/v1-backend-routes.js` under `/api/v1`.

| Capability | Route / function | Line | Status |
| --- | --- | --- | --- |
| Health, live, ready | `GET /health`, `/live`, `/ready` | 201, 207 | IMPLEMENTED |
| Create household + owner + session | `POST /households` (bootstrap token) | 218-236 | IMPLEMENTED |
| Integrations status | `GET /integrations` (`hrms: on_hold, manual_upload_only`) | 243-251 | IMPLEMENTED |
| Revoke session | `POST /sessions/current/revoke` | 253 | IMPLEMENTED |
| Household matrix | `GET /households/{id}` | 257 | IMPLEMENTED |
| Consent grant | `POST /consents` (subject adult only) | 261 | IMPLEMENTED |
| Consent revoke | `POST /consents/{id}/revoke` | 284 | IMPLEMENTED |
| Field access read | `GET /households/{id}/members/{m}/fields/{f}/access` | 298 | IMPLEMENTED |
| Cases | `POST /cases`, `GET /cases/{id}` | 309, 331 | IMPLEMENTED |
| Questions (Gemini, consent gated) | `POST/GET /cases/{id}/questions[/{answerId}]` | 339 | IMPLEMENTED |
| Catalogue review | `POST /cases/{id}/decision-catalogue/reviews` | 362 | IMPLEMENTED (limits above) |
| Designate confirmer | `POST /households/{id}/catalogue-reviewers` | 380 | IMPLEMENTED |
| Decision catalogue / handoff | `GET /cases/{id}/decision-catalogue` | 397 | IMPLEMENTED |
| Block 4 preview | `POST /households/{id}/coverage-preview` | 415 | IMPLEMENTED (stateless) |
| Source pack | `GET /cases/{id}/source-pack` | 426 | IMPLEMENTED |
| Upload (raw PDF) | `POST /cases/{id}/documents` | 459-470 | IMPLEMENTED |
| List documents | `GET /cases/{id}/documents` | 471 | IMPLEMENTED |
| Deletion inventory | `GET /cases/{id}/documents/deletion-inventory` | 440 | IMPLEMENTED |
| Document metadata / delete | `GET`, `DELETE /documents/{id}` | 560, 538 | IMPLEMENTED (metadata only) |
| OCR job + refresh | `POST /documents/{id}/ocr-jobs`, `POST /ocr-jobs/{id}/refresh` | 477, 500 | IMPLEMENTED |
| Structuring runs | `POST/GET /documents/{id}/structuring-runs` | 518 | IMPLEMENTED |
| Login / OTP / magic link / session re-issue | | | **NOT_IMPLEMENTED** |
| Member creation, adult invitation | `households.addMember` is called only at bootstrap (`:231`); no route | `src/backend/repositories/household-repository.js:45` | **NOT_IMPLEMENTED** (HTTP) |
| CORS headers / cross-origin | | | **NOT_IMPLEMENTED** |
| Serve source PDF bytes | | | **NOT_IMPLEMENTED** |
| OCR text or clause read route | | | **NOT_IMPLEMENTED** |
| Document-first summary without a model call | | | **NOT_IMPLEMENTED** |
| HRMS, insurer, TPA, DigiLocker, hospital-network lookup | `hrms: on_hold`; Block 4 emits `dynamic_check` only | `v1-backend-routes.js:248` | **NOT_IMPLEMENTED** |
| Email / notification transport | | | **NOT_IMPLEMENTED** |

## 2. DESIGN_TOKENS_AND_PRESERVATION_RULES

Palette from the research pack (re-verify against `K:src/app/design.css` in S0; only the `#163F42` theme colour was confirmed in `K:src/app/layout.tsx:21`): Tide `#163F42`, Harbour `#176F69`, Forest `#0F4A3A`, Mist `#F3F7F6`, Lime `#C8E6A0`, Gold `#E0A02B`, Ink `#1A3034`, Muted `#55696D`, Border `#CFDCDA`. Fonts: Newsreader as `--font-display`, Source Sans 3 as `--font-body` (`K:src/app/layout.tsx:8-9`). Shared stylesheet `K:src/app/design.css` is generated from the `<style>` block of `Main.dc.html` only (`gen_site.py:123-125`).

Preservation rules:
1. Artboards in `design/claude-design/` are the source. Change an artboard, regenerate, review the diff. Never hand-edit generated onboarding or landing files.
2. Product-only components live in an isolated route group (`/app`) and bridge tokens through CSS variables; they do not edit generated markup.
3. No default shadcn palette, no Inter default, no gradients, glass or emoji-as-interface. Unknown must differ from confirmed by shape and wording, not colour alone.
4. Four primitives only: person, policy/document, evidence/citation, next action.
5. Respect reduced motion. No animated percentage without a real backend progress signal.

Generator gaps (S0):
- Only `Main.dc.html`'s `<style>` is emitted. Per-artboard `<style>` blocks (upload focus ring, reading fade-out) are dropped (`gen_site.py:124`).
- `gen_site.py:102` maps `Extra-States.dc.html`, but that file is absent from `design/claude-design/`.
- Family naming is inconsistent: Brother in `OnboardingPeople.tsx:83` and cover screens, "your sister" in `OnboardingSharing.tsx:103`.
- `gen_site.py`, `design.css`, `Main.dc.html` and home components are already modified in the working tree. Regenerate-and-diff before any Block 5 work (decision D8).

## 3. SCREEN_TO_ENDPOINT_AND_REAL_STATE_MATRIX

| Screen | Today | Real endpoint(s) | Real states to render | Gap |
| --- | --- | --- | --- | --- |
| Start (`O1`) | `<Link href="/onboarding/coming-up">` labelled "Send code" (`OnboardingStart.tsx:47`); input defaults `you@example.in` | none | not signed in, code sent, wrong code, rate-limited, expired | OTP **NOT_IMPLEMENTED**. D1 |
| Coming up (`O2`) | local toggles | none (routing question is client state) | n/a | none needed |
| People (`O3`) | hardcoded You/Maa/Papa/Brother; edit and add have no handler | `GET /households/{id}` (read only) | owner only, no dependants, field permissions | member create **NOT_IMPLEMENTED**. D3 |
| Sharing (`O4`) | one switch; copy "Invites sent" | consents, field-access GET | invite pending, adult consented, revoked | invitations **NOT_IMPLEMENTED**. D3 |
| Add policies (`O5`) | accepts `.pdf,.jpg,.jpeg,.png`, copy "PDF, JPG or PNG, up to 15 MB each" (L38, L43); no `onChange` | `POST /cases`, `POST /consents`, `POST /cases/{id}/documents` | received_pending_checks, accepted, rejected, deletion_pending, deleted | PDF only (D6). Scan needs clamd (see section 4) |
| Reading (`O6`) | CSS timer; copy "We will email you when it is ready." (`OnboardingReading.tsx:68`) | `POST /documents/{id}/ocr-jobs`, `POST /ocr-jobs/{id}/refresh`, structuring runs | awaiting OCR consent, job queued/running/succeeded/failed/cancelled, unreadable | client must poll refresh; no email transport |
| Your cover (`O7`) | hardcoded matrix | `POST /cases/{id}/questions`, `GET /decision-catalogue`, `POST /households/{id}/coverage-preview` | known/unverified/conflicting/unknown, `dynamic_check`, ≤2 prompts | first answer costs a Gemini call (D5). Previews mostly `insufficient_evidence` or `conditional` without review |
| Citation sheet | none | answer `sources` | page + quote + clauseId | no line numbers, no PDF bytes (D4) |
| Delete / revoke | none | `DELETE /documents/{id}`, deletion-inventory, `POST /consents/{id}/revoke`, `POST /sessions/current/revoke` | deletion_pending, deleted | revocation erases the derived answer; UI must say so |

Error shapes differ: route errors are `{ error: { code, message } }` (`src/server/create-server.js:184`), while `publicError` returns `{ error: "string" }` (`src/shared/http/errors.js:5-12`), and the local guard throws `failure(403, ...)` with no code (`src/shared/http/security.js:8-10`). The BFF must normalise both.

Consent chain a first answer needs (from `tests/support/household-api-harness.mjs`, UNVERIFIED in this audit; confirm in S2): bootstrap → case → consent (collect) → upload → scan → consent (sarvam, `recipient: 'sarvam'`, `v1-backend-routes.js:492`) → OCR job + polled refresh → consent (Gemini, `insurance_question`, `src/contracts/policy-evidence.js:20`) → question. Three distinct grants. The question service re-checks consent before commit (`src/backend/services/policy-evidence-service.js:93-101,220`).

## 4. IDENTITY_CONSENT_AND_DEPLOYMENT_GAPS

| # | Gap | Evidence | Severity |
| --- | --- | --- | --- |
| G1 | No user-facing auth. A session exists only from `POST /households` with `KNOWVIA_BOOTSTRAP_TOKEN` (`requireBootstrap`, `src/backend/services/tenant-access-service.js:33-37`). Session TTL is 8 h default (`src/backend/repositories/auth-repository.js:6`), `maxActiveSessions` 100. On expiry there is no re-issue; the only path is a new household. | `v1-backend-routes.js:218-236` | P0 |
| G2 | Bootstrap token must never reach a browser. A BFF must hold it server-side and map a verified identity to an adult and household. No identity-to-adult mapping exists. | `.env.example:6` | P0 |
| G3 | Network origin: guard allows Host `127.0.0.1/localhost:8787/:5173` and Origin `:5173` only, rejects `sec-fetch-site: cross-site`; server binds `127.0.0.1:8787`. A Vercel-hosted browser cannot reach it. No CORS. | `src/shared/http/security.js:3-11`, `src/server/server.js:7` | P0 |
| G4 | Proxy headers (`forwarded`, `x-forwarded-*`, `x-real-ip`) make `isLoopbackRequest` false (`security.js:21-30`). A reverse proxy in front of the API changes which paths treat the caller as loopback. Needs security review. | same | P0 |
| G5 | No deployment target exists (AGENTS.md). Azure staging runbook exists (`docs/runbooks/azure-staging.md`) but is Free tier and `DOCUMENT_SCAN_MODE=disabled`. | `docs/runbooks/azure-staging.md:77` | P0 |
| G6 | `DOCUMENT_SCAN_MODE` defaults `disabled` (`src/server/config.js:21`, `.env.example:18`): uploads stay quarantined forever, shown to clients as `received_pending_checks`. Needs clamd (ADR 0005). | `docs/adr/0005-...md:16` | P1 |
| G7 | No member or adult-invitation HTTP route. Only the owner exists, so Block 4 `memberId` is the owner. Another adult's consent cannot be collected (`CONSENT_SUBJECT_REQUIRED`, `v1-backend-routes.js:266-270`). | | P1 |
| G8 | Consent copy, privacy notice, DPDP position and the "encrypted" claim are unreviewed. Treated as draft until legal review (D7). | AGENTS.md | P0 |
| G9 | Two repos, two runtimes, two stores (waitlist Postgres vs SQLite). Waitlist DB must not hold household data. | `K:src/app/api/waitlist` | P1 |

OTP proves control of an authentication factor. It does not prove employer entitlement, group-policy enrolment or insured-member status.

## 5. AUTOFILL_FIELD_SOURCE_AND_ASSURANCE_MATRIX

State vocabulary: `user_reported`, `extracted_unverified`, `identity_verified`, `reviewed`, `not_available`. Model output is never above `extracted_unverified` (AGENTS.md).

| Field | Source available now | Assurance | Not authorised by OTP alone |
| --- | --- | --- | --- |
| Name | user input; later OIDC profile | `user_reported` / `identity_verified` (identity only) | policy member match |
| Email / phone | OTP or magic link | factor control proven | insured status |
| DOB | optional user input; schedule candidate | `user_reported` / `extracted_unverified` | do not require at sign-in |
| Employer | optional user pick; corporate login tenant (later) | `user_reported` | group enrolment |
| Job title | optional only; not needed for first answer | `user_reported` | |
| Group policy / certificate ID | schedule, e-card, benefits booklet | `extracted_unverified` | not discoverable from email domain |
| Insurer / product / version | issuer selection + document text | `extracted_unverified` until UIN/wording/endorsement reconciled | |
| Family members | schedule candidates + deliberate adult invites | each adult decides own sharing | auto-enrolment by relation |
| Coverage conditions | Block 2/3 pipeline | `extracted_unverified` until Block 3 review | |
| Hospital network | none; Block 4 `dynamic_check` | not checked | |
| Cash to keep ready | none; Block 4 does no cash or reimbursement arithmetic | NOT_IMPLEMENTED | |
| HRMS data | none (`hrms: on_hold`) | NOT_IMPLEMENTED | |

## 6. EXPLICIT_USER_JOURNEYS

Principle: sign in → bring one PDF → see what Knowvia read → confirm only necessary context. No fake data, no invented line numbers.

| Step | Loading | Failure | Unknown / empty |
| --- | --- | --- | --- |
| Sign in | code sending | wrong or expired code, rate limit, factor unreachable | not signed in |
| Routing question (employer / personal / both / not sure) | none | none | "not sure" is valid |
| Consent (collect) | grant POST | `CONSENT_SUBJECT_REQUIRED`, expired | missing / revoked → blocks upload |
| Upload PDF | bytes sent, idempotent retry on same key | not a PDF, >15 MiB, `DOCUMENT_STORAGE_NOT_CONFIGURED` (503), rejected, network drop | `received_pending_checks` has no ETA when scan is disabled |
| OCR consent + job | job queued/running (real status) | job failed/cancelled, unreadable, provider off | awaiting OCR permission |
| Ask / first answer | Gemini call (cost, latency) | `CONSENT_SCOPE_REQUIRED`, `CONSENT_REQUIRED`, stale evidence | answer `unknown`, "Not confirmed" |
| Evidence view | none | revoked consent erases answer | candidate fields labelled "From page N, needs confirmation" |
| Block 4 preview | none | stale/revoked source, 1-5 ref limit | `insufficient_evidence`, `conditional`, `dynamic_check` shown "not checked" |
| Follow-up | none | none | ≤2 prompts, skip and "I do not know" always available |
| Next action | none | none | one action; cashless and legal conclusions stay pending |
| Delete / revoke | `deletion_pending` | partial failure | |

Screens required (pack): not signed in, empty, no document, untrusted extraction, incomplete OCR, scan failed, consent missing/revoked, wrong account, wait/retry, reviewer pending, conflict, no member association, offline, no external insurer data, completed preview.

## 7. RISK_REGISTER

| ID | Sev | Risk | Mitigation (decision) |
| --- | --- | --- | --- |
| R1 | P0 | No user auth; only bootstrap token path | D1 identity workstream, independent security review |
| R2 | P0 | No deployable origin; guard blocks non-loopback; no CORS | D2 topology + BFF, ADR |
| R3 | P0 | Bootstrap token leakage to client or logs | server-only BFF secret; bundle scan test |
| R4 | P0 | Unbacked privacy claims shown pre-launch ("Files are encrypted. Only people you allow can see them." `OnboardingAddPolicies.tsx:136`; "We will email you..." `OnboardingReading.tsx:68`; "Invites sent..." `OnboardingSharing.tsx:106`; "Adults you add get an invite..." `OnboardingPeople.tsx:104`) | D7 legal review; remove or soften copy |
| R5 | P0 | JPG/PNG copy and file filter while backend is PDF-only | D6; fix artboard, regenerate (S0) |
| R6 | P1 | No member creation, single-adult household | D3 |
| R7 | P1 | No PDF viewer; citations are page + quote | D4 |
| R8 | P1 | Block 4 previews mostly empty without Block 3 review | household confirmer route exists (`:362,380`); UX for self-confirmation |
| R9 | P1 | Every first answer is a paid Gemini call with its own consent | D5 |
| R10 | P1 | Scan disabled by default; clients see only `received_pending_checks` | clamd in topology (D2); optional DTO change to expose scan state |
| R11 | P1 | Home claims "17 days" (`K:src/components/home/StoriesSection.tsx:44`) and "how much cash to keep ready" (`landing-model.js:162`, also at `HEAD:...:182`); Block 4 does neither | D7 reword |
| R12 | P1 | Home previews "Page 2, line 4"; backend has page + quote only (`src/contracts/policy-evidence.js:34,67`) | reword to page + quote; never invent lines |
| R13 | P2 | No Playwright, baselines or CI in marketing repo; dirty tree | S0, D8 |
| R14 | P2 | Docs stale: `LATEST.md:3`; ADR 0007 missing (`docs/adr/` jumps 0006 → 0008); no frontend ADR; `.env.example` omits `POLICY_EVIDENCE_ENABLED` and other flags | separate follow-up |
| R15 | P2 | Error shape inconsistency | BFF normaliser |

## 8. MINIMAL_BLOCK5_BUILD_GRAPH

UI home (recommended, needs D9 confirm): `Knowvia_website`, isolated `/app` route group + server-only BFF. Reasons: keeps artboards, generator and fonts; CoverSaath `scripts/check-architecture.mjs:17,47` fails on `src/ui` and AGENTS.md says no active UI.

| Slice | Scope | Blocked by | Owned paths (proposed) | Acceptance | Rollback |
| --- | --- | --- | --- | --- | --- |
| S0 | Decide dirty tree; port missing artboard styles in generator; token inventory → CSS variable bridge; Playwright + 320/375/768/1024/1440 baselines of existing routes; PDF-only copy via artboard + regenerate | D8 | `K:scripts/design-port/`, `K:design/claude-design/`, `K:tests/visual/` | generator diff clean after regenerate; snapshots stable twice; `npm run check` green in both repos | revert commit |
| S1 | Auth workstream + BFF skeleton; server-only secrets | D1, D2 | `K:src/app/(app)/`, `K:src/server/` | no token in client bundle; expiry and recovery test; rate-limit test; independent read-only security review | feature flag off |
| S2 | Household read; per-scope consent UI; PDF upload with real statuses; OCR job polling | S1, D3 | `K:src/app/(app)/` | states driven only by backend; idempotent retry; wrong-account and revoked paths tested | flag off |
| S3 | Evidence, unknown, citation view from Block 3 handoff; "Not confirmed" distinct beyond colour | S2, D5 | same | quote must appear in cited clause; no line numbers; a11y checks | flag off |
| S4 | Block 4 adapter; server resolves `sources`; client keeps `scenario.answers`; ≤2 prompts, skip, don't-know; `dynamic_check` shown "not checked" | S3 | same | contract fixtures from `household-reasoning.md`; stale/revoked source failure | flag off |
| S5 | Delete / revoke, error / offline / wrong account, WCAG 2.2 AA, privacy + security review | S4 | same | keyboard, focus, contrast, reduced-motion checks; legal sign-off recorded | flag off |
| Future | HRMS / OIDC / issuer adapters | partner access | none | none scoped (`hrms: on_hold`) | n/a |

## 9. Unverified

- Test suites were not re-run; no check ran against these claims.
- The consent chain in section 3 comes from reading the route and service code and the research pack, not from running the harness.
- Browser preflight and cross-origin behaviour are inferred from `security.js`, not exercised.
- Live landing pixels were not inspected; marketing working tree was not regenerated.
- Palette hex values other than `#163F42` come from the pack, not re-extracted from CSS.
- `main` (df93e98 in the pack) was not re-audited.
