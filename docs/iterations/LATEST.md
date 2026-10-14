# Latest iteration

## Objective

Prepare the first evidence-completion MVP slice: a versioned canonical policy parameter registry, separate acquisition and resolution status, privacy-safe evidence before AI, and document-level consent enforcement.

## Requirements and classification

- Task class: S2.
- Scope is evidence completion inside the current monolith.
- Redis, Kafka, microservices, new vendors, and new application dependencies are out of scope.
- AI remains extraction-only. Deterministic code owns consent, redaction, state transitions, source authority, and release.
- Full intake: [evidence-completion-mvp-intake.md](../exec-plans/active/evidence-completion-mvp-intake.md).

## Design and graph impact

- Pin every new run to an immutable parameter registry version.
- Track acquisition separately from evidence resolution.
- Revalidate exact document consent at source selection and before model dispatch.
- Run a deterministic minimisation and redaction gate before building any AI request.
- Preserve existing source hierarchy, provenance, bounded schemas, and deterministic release controls.
- Map impact: 38 direct callers, 60 symbols, 26 files, and 6 modules across coverage analysis, document intake, backend, insurance rules, and AI runtime.

AI DESIGN = VERIFIED

## Changed files

- `docs/exec-plans/active/evidence-completion-mvp-intake.md`
- `docs/iterations/LATEST.md`

No product code changed during CERT.

## Tools, model, and effort

- Repository map supplied by the central integration owner using repomap.
- CERT role used GPT-5.6 Sol at low effort because GPT-5.6 Luna was unavailable.
- Bundled Node runtime: `24.19.0`.
- pnpm: `11.25.0` for readiness inspection only. The application remains npm-lockfile based.
- No dependencies, skills, plugins, services, or CLIs were added to the application.

## Verification evidence

- Architecture boundary check passed for 101 source files.
- 54 targeted tests passed with 0 failures.
- Tests covered policy decomposition, workflow contracts, document intake, OCR, consent, migrations, backend access, and live AI schema/budget boundaries.
- No provider network call and no real personal data were used.

## Review findings

- The prose parameter catalogue and runtime parameter list are not one versioned contract.
- Generic OCR text reaches coverage input before parameter-level deterministic handling.
- Case-level analysis consent does not revalidate every document grant during source selection.
- No deterministic PII minimisation gate precedes the live AI request builders.
- Existing quarantine, revocation cleanup, source provenance, bounded schemas, and deterministic release gates should be extended rather than replaced.

## Risks and next action

- Privacy/legal review is required before production use of real sensitive documents.
- Applicability, mixed-consent, expiry, revocation-race, and identifier-leak tests are mandatory.
- Specialists must use exclusive file ownership and return concise handoffs before central integration.
- Next action: implement in the order recorded in the intake, then run targeted checks, full tests, build, and independent security/privacy review.

CERT = READY
