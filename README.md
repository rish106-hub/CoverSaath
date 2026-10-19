# CoverSaath backend

CoverSaath is a backend-first health-insurance evidence system.

The repository has no active user interface. A UI can be added later against the authenticated `/api/v1` contract.

This is not an insurance adviser, claims platform, or production-ready service. Use synthetic data only.

## Current boundary

- Node 25 or later. CI uses Node 26.
- SQLite is the application runtime.
- PostgreSQL schema and tests exist under ADR 0004.
- The API listens on `127.0.0.1:8787`.
- Provider integrations fail closed and default off.
- No deployment target exists.

Deterministic code owns consent, authorization, eligibility, money, state transitions, and release decisions. Model output remains unverified or conflicting.

## Repository map

```text
src/
├── agents/          bounded insurance-analysis specialists
├── backend/         database, repositories, services, and case state
├── contracts/       API, workflow, authority, and persistence contracts
├── evaluation/      offline safety evaluation
├── features/
│   ├── input/       file validation, protected storage, scanning, and OCR
│   ├── ai-analysis/ model boundary, privacy gate, prompts, and schemas
│   ├── coverage-analysis/ persisted analysis workflow and parameter registry
│   ├── insurance-rules/ deterministic insurance rules
│   └── policy-structuring/ document sectioning and unverified extraction
├── integrations/    fail-closed provider adapters
├── server/          API composition, routes, and response policies
└── shared/          framework-free shared HTTP helpers
```

Supporting paths:

```text
tests/               unit, integration, security, and journey tests
scripts/             database and evaluation commands
working/             current product behaviour sources
building/            policy decomposition and parameter catalogue
docs/adr/             durable architecture decisions
docs/architecture/    current system, data, and security maps
docs/runbooks/        local and recovery procedures
docs/exec-plans/      active and completed risky-work plans
```

File and directory names use lowercase kebab-case. Directories carry architectural categories. Filenames describe one responsibility.

## Install and run

```sh
npm ci
npm run db:init
npm run dev
```

Create an ignored `.env.local` from [.env.example](.env.example). Set a 32-character or longer `KNOWVIA_BOOTSTRAP_TOKEN` for local API bootstrap. Legacy `knowvia` identifiers remain until a compatibility migration exists.

Health endpoints:

```text
GET /api/v1/health
GET /api/v1/live
GET /api/v1/ready
```

All other application routes require the documented session, household, consent, and ownership checks.

## Verification

```sh
npm run check
npm run eval:safety
git diff --check
```

`npm run build` validates the backend entry point. It does not produce frontend assets or deploy anything.

Tests use synthetic records. Mocked provider tests do not prove live provider behaviour, OCR accuracy, insurer decisions, or production safety.

## Data and security rules

- Never commit real policy documents, medical records, credentials, or personal data.
- Check household ownership on every protected read and write.
- Require current, exact consent before each provider call and before commit.
- Pass model-bound evidence through the privacy gate.
- Keep model output below deterministic authority.
- Erase derived data after revocation.
- Keep migrations append-only after merge.
- Return coded, client-safe errors.

See [AGENTS.md](AGENTS.md), [security architecture](docs/architecture/security.md), and [data architecture](docs/architecture/data.md) before changing these boundaries.

## Known limits

- SQLite remains a single-machine runtime.
- PostgreSQL is not the application runtime yet.
- Authentication is local prototype authentication, not production identity.
- Live provider journeys and production deployment remain unverified.
- Consent and privacy-notice wording requires legal review.
- No capacity or load-test numbers exist.

## Naming

The public project name is CoverSaath. Existing database values, contract versions, environment variables, and persisted `knowvia` identifiers remain unchanged until a compatibility plan covers old data and callers.
