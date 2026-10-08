# Policy official-source enrichment and procedure intake — CERT

**Date:** 2026-10-07  
**Owner:** central integration agent  
**Intake role:** GPT-5.6 Sol, low effort (recorded fallback because GPT-5.6 Luna is unavailable)  
**Task class:** S2 — sensitive insurance decision support, external data acquisition, privacy boundaries, and a critical financial presentation invariant.  
**Related handoff:** `docs/iterations/LATEST.md`  
**CERT state:** **CERT = READY for the bounded fake-backed implementation slice defined below.** Live website retrieval, hospital-network confirmation, and publication of insurer statistics remain blocked until their specific gates pass.

## CERT-C: clarify

| Field | Record |
|---|---|
| Task title | Official policy-source enrichment, interactive procedure intake, complete parameter outcomes, and safe estimates |
| North Star / business outcome | A household receives a source-backed explanation of whether a planned procedure may be covered, what is unresolved, and what it may cost, without a misleading optimistic payout headline. |
| Primary user and trigger | An adult managing a family policy uploads an issued policy pack or asks about a planned admission. |
| Problem today | Issued schedule/CIS packs commonly omit controlling wording, specified-disease lists, live hospital-network status, and insurer statistics. The current estimate can display household cost of zero while eligibility is unresolved. Procedure requests omit material facts such as prior diagnosis, declaration, continuity, admission type, and pre-authorisation. The 314 parameters mostly collapse missing outcomes into `Unknown` without recording source attempts or decision relevance. |
| Desired customer outcome | The product resolves the exact issued cover first, adds only matching official public evidence, asks short factual follow-ups, blocks unsafe estimates, and explains every unresolved decision-critical fact and next action. |
| In scope | (1) Critical estimate invariant; (2) use of confirmed cover-start dates by waiting-period checks; (3) typed scenario questions and request contracts; (4) official-source manifest/resolution contracts with fake adapters and immutable provenance; (5) terminal outcome metadata for all 314 parameters; (6) source priority and relevance rules; (7) targeted tests and review. |
| Explicit non-goals | Unrestricted web browsing; AI-selected arbitrary URLs; live production scraping; user-specific claim approval predictions; automated pre-authorisation; hospital or insurer contact; replacing issued documents with public wording; claiming all 314 values are available; ingesting aggregator ratios as authority; changing authentication, cloud deployment, or the broader data migration. |
| Acceptance criteria | See the acceptance section below. |
| Constraints | Preserve existing stack and dirty work; no new dependency in the first slice; public sources only; no patient name, diagnosis, policy number, DOB, or raw policy content in search URLs; deterministic code owns authority and estimate gating; exact UIN/version matching; all external text is untrusted data. |
| Dependencies and stakeholders | Existing policy breakdown service, record repository, 12 sections, procedure check, estimate, UI journey, review workflow, and tests. Later live connectors require insurer/regulator terms review and operations ownership. |
| Risks and unknowns | Version ambiguity, changed insurer HTML, stale hospital lists, hostile content, SSRF/DNS rebinding, silent document mismatch, ratio methodology mismatch, privacy leakage, additional database migration needs, and overlap with current uncommitted live-run/product-beta work. |
| Success metric | Zero wrong-but-Proven values; zero optimistic household-cost headline when eligibility is blocked or unresolved; 314/314 parameters have a justified outcome record; 100% decision-critical fields either established or surfaced as required; official-source fixtures preserve URL, issuer, UIN/version, effective/publication/retrieval dates, content hash, and freshness. |

### Public-page/source additions

- **Target customer:** an Indian household comparing policy evidence with a planned treatment.
- **Message hierarchy:** eligibility first; financial estimate second; operational cashless status third; insurer-level statistics only as context.
- **Proof:** issued documents, exact-version insurer/IRDAI wording, dated insurer disclosures, and dated network evidence.
- **Trust rule:** public evidence supplements but never overwrites customer-specific schedules or endorsements.
- **CTA / conversion event:** answer the next material factual question or request confirmation from the insurer/hospital when live status cannot be established.
- **Objection handled:** “The insurer has a good claim ratio, so will my claim be paid?” — the product explicitly says aggregate statistics do not predict an individual claim.

### Procedure workflow

| Item | Record |
|---|---|
| Actor / precondition | Authorised household adult; policy record exists and applicable consent is active. |
| Happy path | Select patient and procedure → answer factual chips → system resolves issued evidence and exact public wording → deterministic eligibility gate → conditional estimate → cashless guidance with timestamp. |
| Alternative path | User selects `Not sure` or evidence conflicts; result identifies the missing fact and safe next action. |
| Failure path | Source unavailable, stale, mismatched, malicious, or network lookup unconfirmed; system abstains and retains full-bill exposure. |
| Permission boundary | Household data remains tenant-scoped; public-source fetches contain public identifiers only; no external send or insurer action occurs. |
| Irreversible action | None in this slice. Future insurer/hospital contact requires explicit person confirmation. |
| Recovery | Disable connector/source type, replay from the issued pack and stored immutable source snapshots, or revert the isolated change set. |

## Acceptance criteria

1. A known eligibility blocker suppresses an optimistic payout and represents insurer payable as zero and household exposure as the full relevant bill.
2. Any unresolved critical eligibility factor produces a `Coverage not established` headline; the full-bill exposure remains visible and positive scenarios are labelled conditional.
3. Waiting-period logic uses established member cover-start or policy-start evidence and never treats “not found in this pack” as “does not apply.”
4. Procedure intake supports patient, diagnosis/procedure, planned date, planned/emergency/accident, prior diagnosis/treatment/advice/symptoms, proposal declaration, continuity/portability/migration/break, exact hospital branch/address/PIN, pre-authorisation status, prior floater use, and other-policy contribution. Applicable binary questions also support `not_sure` and `prefer_not_to_answer`.
5. User answers persist or flow as `Reported`; they cannot overwrite `Proven` issued-document evidence.
6. Official-source resolution requires insurer legal entity plus exact UIN/product/version/effective-date compatibility. Ambiguous matches abstain.
7. Every public-source fact retains source class, canonical URL, publisher, UIN/version where applicable, publication/effective/retrieval dates, SHA-256, freshness, exact citation, and source-attempt history.
8. Every one of the 314 parameters reaches a justified outcome: `Proven`, `Calculated`, `Reported`, `Dynamic`, `Conflicting`, `NotPermitted`, `RequiredNow`, `RequiredForLaterJourney`, `NotApplicable` with deterministic rule ID, or `Unavailable` with attempted sources and reason. Existing stored states remain readable during transition.
9. Decision relevance for eligibility, waiting periods, money, hospital access, and claim process is deterministic. A model may propose relevance only for non-critical fields and cannot change the terminal state without validation.
10. Claim-settlement and other insurer statistics store raw components, methodology, scope, period, and publisher; they are contextual and never feed individual eligibility or payout.
11. No patient/household identifier or diagnosis is transmitted to public-source endpoints. External content cannot select URLs, tools, credentials, or instructions.
12. Targeted tests, full repository check, fixture evaluation, API E2E, and browser E2E pass; independent review finds no material safety or tenant-boundary defect.

## CERT-E: examine

The repository map and task impact query were completed by the central agent before this intake. Impact is **HIGH**. This intake therefore inspected only the current plan/handoff, manifest, environment-name template, and affected policy/UI contracts.

### Graph areas and current flow

```text
document upload / stored OCR
  → policy-breakdown service
  → section model output + deterministic assembly/citations
  → 314-parameter policy record
  → procedure-check
  → estimate
  → policy routes / UI journey

official-source manifest + fake resolver (new)
  → exact identity/version gate
  → immutable source evidence
  → analysis/parameter terminal outcomes
```

Affected areas:

- `src/modules/policy-breakdown/consumers/estimate.js` and `procedure-check.js`: critical decision and presentation boundary.
- `src/modules/policy-breakdown/contracts.js`, assembly, section definitions, and record persistence: evidence/terminal-state compatibility and provenance.
- `src/modules/policy-breakdown/references/**`: currently operator-supplied dated JSON; no acquisition system exists.
- `src/modules/policy-breakdown/service.js` and `src/server/routes/policy-routes.js`: tenant/consent boundary and request orchestration.
- `src/ui/state/request-builders.js` and procedure/estimate views: current form does not send all required facts.
- policy breakdown, API, frontend, evaluation, and E2E tests.

### Existing tools and capabilities

- Node `>=22.12.0`, npm lockfile, Node test runner, Vite, Playwright, PGlite/Postgres adapters.
- Existing `pdf-lib`, AI SDKs, PostHog, Sarvam/Gemini adapters, structured handoff envelope, reference provider, citation matcher, deterministic consumers, and repository gates.
- Repository scripts used for final verification: `npm run check`, `npm run eval:breakdown`, and `npm run test:e2e`.
- **New application dependencies:** none approved or required for the bounded slice. Use built-in `fetch`, URL parsing, crypto hashing, existing persistence patterns, and fakes. A live HTML/PDF parser may be proposed later only after endpoint samples demonstrate a real gap.
- **Locked dependency install:** `npm ci` completed from the existing `package-lock.json`; `npm ls --depth=0` passed. No application package was added for this slice.

### Dirty-work overlap

The checkout already contains extensive uncommitted product-beta/live-run changes. Relevant overlapping modified or untracked paths include:

- `src/modules/policy-breakdown/consumers/estimate.js`
- `src/modules/policy-breakdown/contracts.js`
- `src/modules/policy-breakdown/service.js`
- `src/modules/policy-breakdown/agents/model-runner.js`
- `src/modules/policy-breakdown/agents/prompts.js`
- `src/modules/policy-breakdown/assembly/assemble-section.js`
- `src/modules/policy-breakdown/verification/citations.js`
- `src/server/routes/policy-routes.js`
- `src/ui/state/request-builders.js` (untracked)
- `src/ui/components/tools-views.js` (untracked)
- `tests/policy-breakdown-api.test.mjs`, `tests/policy-breakdown-pipeline.test.mjs`, `tests/frontend-ui.test.mjs`, and E2E paths
- `.env.example`, `package.json`, `package-lock.json`, and `docs/iterations/LATEST.md`

Agents must treat the working tree as shared state, inspect diffs before edits, never restore another agent's changes, and sequence ownership of overlapping files through the central agent.

## CERT-R: resolve

### System design

1. **Issued evidence stays authoritative.** Customer schedule, endorsements, certificates, and attached benefit documents establish customer-specific facts.
2. **Source identity resolver.** Deterministic code derives or confirms insurer legal entity, product, UIN, variant/version, and effective dates. It emits `matched`, `ambiguous`, `not_found`, or `incompatible`.
3. **Official-source registry.** Versioned allowlist entries define regulator/insurer/TPA host, document type, URL template or exact endpoint, expected MIME/size, freshness, and owner. Retrieved content cannot create another destination.
4. **Acquisition boundary.** A fetch adapter accepts a typed, pre-resolved request. It enforces HTTPS, allowlisted host/redirects, public-address resolution, bounded bytes/time/retries, MIME checks, rate limits, and audit metadata. The first slice uses only a fake adapter and fixtures.
5. **Immutable evidence.** Store content hash plus source metadata and exact evidence location. Public evidence is `Dynamic` when operational/time-sensitive; contractual wording can support `Proven` only after exact-version compatibility and citation checks.
6. **Terminal outcome engine.** A deterministic rule maps each parameter's expected sources, attempts, relevance, and result to a terminal outcome. Critical relevance cannot be delegated to AI.
7. **Scenario intake.** UI collects factual answers as typed enums/booleans/dates and sends them to the existing tenant-authorised policy endpoints. Answers are `Reported` inputs, visibly distinct from document evidence.
8. **Eligibility before estimate.** Procedure check returns blocker/attention/clear plus reasons. Estimate consumes this result before financial arithmetic and applies the acceptance invariants above.
9. **Statistics boundary.** Insurer statistics are stored as raw measures with explicit formula/scope. They render separately from claim-specific coverage.

### Capability decisions

| Need | Existing alternative | Decision / risk | Integration and verification |
|---|---|---|---|
| Safe estimate | Existing deterministic consumers | REQUIRED now; no dependency. Highest-risk defect. | `consumers/estimate.js`, `procedure-check.js`; focused regression tests then full gates. |
| Scenario questions | Existing API/body builder and UI controls | REQUIRED now; extend typed request only. | UI/request validation/API tests/browser flow. |
| Source registry/resolver | Existing operator JSON reference loader | REQUIRED as fake-backed contracts; current loader is insufficient for exact version and attempt provenance. | New focused modules/fixtures; negative tests for mismatch, malicious redirect, stale source, and PII-bearing query. |
| Live fetching | Built-in `fetch` is sufficient initially | BLOCKED until endpoint samples, terms/licence, allowlist, DNS/SSRF control, retention, owner, and rate policy are verified. | Separate live smoke with public identifiers only. |
| AI web agent/scraper | Deterministic registry and fetch adapter | NOT_APPLICABLE. Free-form URL choice and tool execution violate the authority boundary. AI may parse already-fetched bounded evidence into a schema. | Prompt-injection and schema-negative tests if parsing is later enabled. |
| Terminal outcomes | Existing evidence-state contract | REQUIRED, compatibility-safe transition. Do not reinterpret stored `Unknown` records silently. | Contract tests, persistence/replay tests, 314/314 matrix gate. |
| New parser/library | Existing text/PDF handling | NOT_APPLICABLE for the first slice. | Reassess only with representative official endpoint samples. |

### Privacy, security, and trust controls

- Public lookup keys: insurer legal entity, UIN, product/version, effective date, hospital public identity/address/PIN. Do not include member name, phone, DOB, policy number, diagnosis, procedure, uploaded text, or claim details.
- Raw policy/OCR remains RESTRICTED; scenario answers are CONFIDENTIAL/RESTRICTED according to content; public wording and regulator publications are PUBLIC.
- Authorisation occurs before record or scenario access. Source fetching must be independent of tenant secrets and must never expose one tenant's cached request metadata to another.
- Cache only public source content by canonical identity and hash. Do not cache patient-specific request bodies in the public-source cache.
- Enforce SSRF protection, DNS/IP checks, redirect revalidation, allowlisted schemes/hosts, response-size/time bounds, content-type checks, and no credential forwarding.
- Preserve source snapshots and provenance for the defined retention period; deletion/retention policy and legal review must be approved before production.
- Retrieved content is data, never system/developer instruction. Models have no network tool and no commit authority.
- Cashless/network evidence expires and must show retrieval time; final status requires insurer/TPA or hospital confirmation and cannot be inferred from a stale cached page.

### Environment variables by name only

No new variable is required for fake-backed work. Prospective live variables, to be added to `.env.example` only with the live connector change:

- `OFFICIAL_SOURCE_FETCH_ENABLED`
- `OFFICIAL_SOURCE_ALLOWED_HOSTS`
- `OFFICIAL_SOURCE_TIMEOUT_MS`
- `OFFICIAL_SOURCE_MAX_BYTES`
- `OFFICIAL_SOURCE_CACHE_TTL_SECONDS`
- `OFFICIAL_SOURCE_USER_AGENT`
- `HOSPITAL_NETWORK_LOOKUP_ENABLED`

Credentials are not expected for public endpoints. Any future authenticated TPA endpoint needs a separate CERT/security review and secret-broker design.

### Agent dispatch and exclusive ownership

| Agent / role | Task and graph scope | Model / effort | Required tools/skills | Exclusive files for first pass | Expected artifact | Cost/latency target | Fallback | Verification gate |
|---|---|---|---|---|---|---|---|---|
| Safety/backend | Eligibility-first estimate and cover-start waiting-period rules | GPT-5.6 Sol / high because the financial-safety invariant is cross-consumer | Existing Node tests; no new skill/package | `consumers/estimate.js`, `consumers/procedure-check.js`, new focused safety test file | Safe deterministic output and regression tests | No model/provider calls; one bounded pass | Central agent sequences any overlap | Focused tests; no optimistic zero-cost case |
| Source/provenance | Official-source types, registry/resolver, fake adapter, terminal-outcome proposal | GPT-5.6 Sol / high because source authority and privacy are sensitive AI/data design | Built-in Node APIs, existing reference patterns | New files under `references/official/**`, new isolated tests, design note if needed; **do not edit shared contracts/service/database without central handoff** | Typed contracts, fake fixtures, negative tests, compatibility proposal | Zero network and zero provider spend | Keep operator JSON loader unchanged | Unit/contract tests; exact-match and security negatives |
| Product/UI | Interactive factual questions and typed request validation | GPT-5.6 Sol / medium fallback because Terra is unavailable | Existing UI conventions and Playwright | `src/ui/state/request-builders.js`, relevant procedure/estimate view only, new/owned UI tests | Accessible chips/forms and API payload | No provider calls; preserve bundle baseline | UI can ship behind existing journey affordance | Frontend unit + Playwright keyboard/error-state tests |
| Central integration | Shared contract/service/schema edits, conflict resolution, full gates, LATEST update | GPT-5.6 Sol / high | Repository map, apply_patch, npm scripts | Shared files only after specialist handoffs | Integrated slice and evidence | Avoid live calls; stop at fake-backed acceptance | Revert isolated integration edits | `npm run check`, eval, E2E, independent review |
| Independent reviewer | Read-only security, privacy, source-authority, estimate review | GPT-5.6 Sol / high; XHigh only if central records a critical unresolved reason | Read-only diff/tests | None | Findings ordered by severity | Single review pass | Central fixes and re-runs | No material open finding |

No two agents may edit the same file concurrently. In particular, contracts, service, route, repository, migrations, `.env.example`, package files, and `LATEST.md` remain central-integration owned unless explicitly handed off after the specialist returns.

### Implementation sequence

1. Safety agent fixes and proves the eligibility/estimate invariant and start-date logic.
2. In parallel, source/provenance agent builds new fake-backed contracts; product/UI agent builds scenario inputs in its exclusive files.
3. Central agent reviews summaries and targeted diffs, then performs shared contract/service/persistence integration sequentially.
4. Run compatibility migration only if the storage shape requires it; otherwise keep terminal metadata additive.
5. Run all gates and an independent review.
6. Update `docs/iterations/LATEST.md` with evidence and remaining live blockers.
7. Only after legal/security/endpoint verification, create a separate live-connector change with a kill switch and monitored smoke test.

## CERT-T: readiness

| Check | Result |
|---|---|
| Repository map exists and task query succeeded | PASS, reported by central; impact HIGH |
| Requirements/non-goals explicit | PASS |
| Task class and design recorded | PASS, S2 |
| Dependencies/tools callable | PASS for bounded slice; locked install and top-level package verification passed; no new dependency or live network required |
| Permissions/environment known | PASS for bounded slice |
| Agent roles and file ownership clear | PASS, subject to central sequencing of existing dirty overlaps |
| Verification and rollback defined | PASS |
| Live source terms, endpoint samples, privacy retention, operations owner | BLOCKED; not needed for fake-backed slice |
| Live hospital network authority/freshness confirmation | BLOCKED; not needed for fake-backed slice |

### Verification plan

Run the smallest focused tests from each track first, followed by:

```bash
npm run check
npm run eval:breakdown
npm run test:e2e
```

Additional required evidence:

- regression fixture for known blocker, unresolved critical eligibility, and clear eligibility;
- 314/314 terminal-outcome matrix with zero implicit absence;
- exact UIN/version match, ambiguity, stale evidence, unavailable source, malicious redirect/host, oversize/MIME, and PII-query negative tests;
- UI keyboard/focus, validation, `not_sure`, `prefer_not_to_answer`, network error, retry, and degraded-source states;
- cross-tenant denial and withdrawn-consent checks;
- no network/provider call in the bounded slice.

### Rollback

- Keep each track as an isolated, reviewable change set; revert only that change set.
- Feature-disable official-source resolution and hospital lookup independently; issued-pack extraction and existing operator references remain the fallback.
- Keep old stored evidence states readable. If a migration becomes necessary, use additive columns/tables and a forward-fix/restore rehearsal before deleting or reinterpreting data.
- On any mismatch, stale evidence, fetch/security error, or provider degradation, fail to `Unavailable`/required information and retain full-bill exposure.

### Remaining blockers and open decisions

1. Approve the exact initial regulator/insurer/TPA host registry and name its operational owner.
2. Review official endpoint terms, robots/licence expectations, request rate limits, and retention/publication rights.
3. Decide public-source snapshot retention and deletion policy; obtain privacy/legal review for production.
4. Establish exact insurer-product-UIN/version fixtures and representative network-list fixtures.
5. Decide whether genuine active-content PDFs are sanitised into a derived copy or rejected; this is a separate upload-security decision.
6. Live fetch, cashless confirmation, and insurer-statistics publication stay off until these pass. The fake-backed implementation must not be described as live coverage verification.

## CERT handoff

**CERT state:** **CERT = READY** for the bounded fake-backed slice only.  
**Business objective:** safe, source-grounded procedure guidance with complete uncertainty accounting.  
**Approved scope / non-goals:** as recorded above; no unrestricted browser agent, live production scraping, or claim decision automation.  
**Graph findings:** high-impact path from record assembly through procedure check/estimate/API/UI; source acquisition is a new bounded input to the existing structured record.  
**System design:** issued evidence → exact official-source resolution → immutable provenance → terminal outcome engine → factual scenario intake → deterministic eligibility → conditional estimate.  
**Installed and verified tools:** existing repository stack restored with `npm ci`; `npm ls --depth=0` passed; no new application dependency added.  
**Implementation sequence:** safety first; source contracts and UI in parallel; shared integration sequentially; full gates; independent review.  
**Rollback:** isolated change sets, feature-disabled connectors, compatibility-preserving data transition, issued-pack fallback.  
**Critical limitation:** READY does not authorise live public-site retrieval or claim/cashless assertions.
