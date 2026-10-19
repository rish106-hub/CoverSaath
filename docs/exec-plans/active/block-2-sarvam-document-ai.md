# Block 2 Sarvam Document AI

## Outcome

Connect clean Block 1 PDFs to Sarvam's modern Document AI digitise API. Persist only validated,
complete `knowvia.ocr.v1` pages. Keep all decisions deterministic and local.

## Scope

- PDF only. Split into ordered batches of at most 10 pages.
- Sarvam digitise, status and JSON results endpoints.
- Exact document, subject, purpose, action, data category and `sarvam` recipient consent.
- Server-only key. Feature flag off by default.
- Bounded page count, request timeout, safe GET retries, two-second minimum polling, 15-minute job deadline
  and polling concurrency.
- Local invalidation on revocation or deletion.

## Non-goals

- Sarvam Extract.
- Coverage decision changes.
- Accuracy claims without a real consented corpus.
- Deployment or provider account changes.
- Claims that remote provider data was deleted. No public cancellation endpoint was found.

## Owned paths

- `src/integrations/sarvam/**`
- `src/modules/document-intake/**`
- OCR and consent repository methods used by this slice.
- OCR routes and server composition.
- Focused tests and operator documentation.

## Acceptance evidence

- 1, 10, 11, 47 and 100-page split tests preserve exact order.
- Modern endpoint and multipart field tests.
- Partial, missing, duplicate and reordered output fail closed.
- Full local API journey: upload, scan, exact provider consent, split, submit, poll and persist.
- Duplicate start does not resubmit.
- Restart resumes a durable provider job without rereading or resubmitting the source document.
- Ambiguous or dispatched failures cannot be explicitly replayed. Only proven pre-dispatch failures can retry.
- A failed local result transaction rolls back all pages and can reconcile the existing completed provider
  job without another POST. Sanitized lifecycle events are committed with the corresponding job transaction.
- Provider grant revocation cancels the job and erases derived pages without deleting the upload.
- `npm run check`, `npm run eval:safety` and `git diff --check` pass.
- Independent read-only review has no unresolved critical or high findings.

## Rollback

Set `SARVAM_OCR_ENABLED=false`. This stops new calls. Existing local job and page rows remain governed by
normal consent revocation and document deletion. Removing the code does not prove deletion of provider data.

## External verification gap

Automated tests use a mocked Sarvam HTTP boundary. A real provider call, representative corpus evaluation,
account rate-limit check, billed-cost check and retention confirmation remain required before production use.
The opt-in `npm run test:sarvam-live` command performs a one-page synthetic Digitise job. It is excluded from
normal checks because it is billable and requires explicit approval.

## Repository-hosted check status

The latest `main` workflows are already red before this uncommitted slice:

- CI run `39209055663` fails `tests/postgres-julianday.test.mjs`. PostgreSQL accepts
  `2026-01-01T24:01`, while SQLite returns `null`.
- CodeQL run `39226432972` scans the repository and uploads results, but processing fails because default
  setup is enabled at the same time as the repository's advanced CodeQL workflow.

These are separate repository baseline issues. They do not replace the required local checks or the missing
live Sarvam proof.

## Completion audit

| Definition-of-done item | Current evidence | State |
| --- | --- | --- |
| Modern live transport through the existing boundary | `/doc-ai/v1` adapter, mocked contract tests, feature flag off by default | Implemented, live execution pending |
| PDFs longer than 10 pages | Sandboxed 1, 10, 11, 47 and 100-page split tests; mocked 11-page API journey | Verified locally, not against Sarvam |
| `knowvia.ocr.v1` normalization and source-page provenance | Provider adapter, atomic repository tests and coverage-analysis port query | Verified locally |
| Partial and malformed output fails closed | Partial, blank, missing, duplicate, reordered, wrong-job, contradictory usage and oversized-response tests | Verified locally |
| Consent, deletion and in-flight revocation | Pre-submit and pre-commit checks, revocation and deletion race tests | Verified locally |
| Audit, privacy and authority | Sanitized transactional lifecycle events; no raw payload persistence; independent review PASS | Verified locally |
| Existing and new deterministic checks | Local full check, safety evaluation and diff check | Verified locally |
| Current CI failures identified | GitHub run evidence recorded above | Verified |
| Cost, latency and OCR quality | Public list price only; no billable run or labeled corpus | Not verified |
| Provider retention and deletion | No Document AI-specific contractual terms or cancellation endpoint confirmed | Not verified |

Two provider-contract limits remain explicit. The public modern API documentation exposes no idempotency key
or job lookup by client request ID, so an ambiguous POST is blocked from replay but cannot be fully reconciled.
The provider documentation also contains conflicting guidance about Digitise `output_format=json`; the
Document AI overview and results reference allow JSON, while the troubleshooting page says otherwise. A
single approved live synthetic run is required to settle the actual account behavior.

## Verified public contract sources

- [Document AI overview](https://docs.sarvam.ai/api/api-guides-tutorials/document-intelligence/overview)
- [Digitise job](https://docs.sarvam.ai/api-reference/doc-ai/job/digitise)
- [Job results](https://docs.sarvam.ai/api-reference/doc-ai/job/results)
- [Rate limits](https://docs.sarvam.ai/api/getting-started/ratelimits)
- [Pricing](https://docs.sarvam.ai/api/getting-started/pricing)
