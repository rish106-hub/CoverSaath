# Runbook: curated insurer sources

Scope: the trusted insurer-source workflow on a developer's local SQLite database, with synthetic documents only. There is no production deployment, no production curator or checker, and no genuine insurer record. Nothing in this runbook makes a record genuinely verified: that needs a real insurer document, a real curator and a different real checker (see [block-3-acceptance.md](../exec-plans/active/block-3-acceptance.md)). Roles and identity limits: [reviewer-security.md](../architecture/reviewer-security.md).

Code: `src/backend/repositories/curated-product-repository.js`, `src/features/decision-catalogue/source-verification.js`, `scripts/curated-source.mjs`. Tables: `source_curator_grants`, `curated_source_archives`, `curated_product_submissions` (SQLite 018, PostgreSQL 014).

## 1. Configure a local test environment

- Use a separate database under `.local/`, for example `DATABASE_PATH=.local/curated-trial.sqlite`. Never point these commands at a database holding household data you care about; they write audit rows and archive bytes that are never deleted.
- `CURATED_SOURCE_HOSTS` must list the exact DNS names a source may come from (comma separated). Unset or empty refuses every registration (`SOURCE_HOSTS_NOT_CONFIGURED`). IP addresses, `localhost`, `.local` and `.internal` names are refused at startup. For synthetic trials use a reserved test name such as `wording.synthetic-insurer.test`. The allowlist limits where a source may be named; it does not prove a source is official or reusable.
- `npm run db:init` creates and migrates the database (see [local-database.md](local-database.md)).
- No network access is needed or used. Every document is a local file a person already downloaded.

## 2. Generate synthetic evidence

`tests/support/synthetic-policies.mjs` builds deterministic, clearly labelled ("SYNTHETIC TEST DATA - NOT A REAL POLICY") PDFs with fictional insurers, UINs and policy numbers, plus their page texts and a scenario manifest. The page texts are generator output, not text extracted from the PDF. Use them for trials and tests only; never register them in a database that serves households.

Files the CLI needs:

- `metadata.json`: `{ "uin", "insurer", "productName", "wordingVersion", "sourceUrl", "sourceVersionId", "retrievedOn", "effectiveFrom"? }`. `sourceUrl` must be `https://` on an allowlisted host; `retrievedOn` must be within 400 days.
- `document.pdf`: the exact bytes. The SHA-256 is computed from these bytes.
- `pageTexts.json` (optional): one string per page. Without it nothing is machine-checked and the checker must attest the UIN, version and every quote.
- `facts.json`: `[{ "factType", "topic", "value", "page", "quote" }]`. Types: `room_rent_limit`, `icu_limit`, `copay`, `deductible`, `sublimit`, `waiting_period`, `exclusion`, `restoration`, `bonus`. Values use the rule shapes, for example `{ "kind": "amount", "amountMinor": 500000, "currency": "INR", "basis": "per_day" }`. Quotes are at least 8 characters and must appear on the stated page.

## 3. Grant and revoke roles

```bash
node scripts/curated-source.mjs grant-role <adultId> curator <operatorLabel> <expiresAtISO>
```

```bash
node scripts/curated-source.mjs revoke-role <grantId> <operatorLabel>
```

- Roles are `curator` and `checker`, at most 90 days, re-read on every request. An operator label equal to the adult id is refused.
- Locally, an adult with a session is created by `POST /api/v1/households` with the bootstrap token (the response holds `owner.id` and `session.token`). Use two different adults for curator and checker.
- `operatorLabel` is recorded in the audit trail. It is not authentication: anyone who can run the CLI against the database can grant roles.

## 4. Register a source

```bash
node scripts/curated-source.mjs register <curatorAdultId> metadata.json document.pdf pageTexts.json
```

State `collected`. Refused: no curator role, host not allowlisted, a port in the URL, stale or not yet effective wording, bytes that are not a PDF or over 20 MB, a supplied digest that differs from the bytes, page text with zero or several printed UINs, a UIN or wording version not printed, and a different document already registered for the same UIN and version (`SOURCE_VERSION_CONFLICT`). The same bytes again return the existing submission with `replayed: true`.

## 5. Propose facts

```bash
node scripts/curated-source.mjs propose <curatorAdultId> <submissionId> facts.json
```

State `candidate`. Only the collector may propose. Every page and quote is checked against the archived page text. Re-proposing replaces the facts and invalidates any earlier `factsSha256` a checker saw.

## 6. Check and publish

There is deliberately no CLI command: these need the checker's authenticated session.

1. The checker downloads their own copy of the source and computes its SHA-256 (`shasum -a 256 document.pdf`).
2. `GET /api/v1/curated-products/{submissionId}` with the checker's token. The response withholds the content digest and bytes; it shows `factsSha256`, facts and page text.
3. `POST /api/v1/curated-products/{submissionId}/check` with `{ "decision": "accept", "reasonCode": "quote_matches_source", "observedSha256", "factsSha256", "quotesReviewed": true }`, plus `"uinAndVersionReviewed": true` when no page text was supplied. Reject with `{ "decision": "reject", "reasonCode": "quote_does_not_match_source" | "wrong_product_or_version" | "source_unreadable" | "other" }`.
4. `POST /api/v1/curated-products/{submissionId}/publish` with a checker's token. Publication re-runs every machine check and supersedes a predecessor.

Refused with stable codes: the collector checking or publishing (`SELF_REVIEW_REFUSED`), no live checker role (`SOURCE_ROLE_NOT_AUTHORISED`), a wrong own-copy digest (`SOURCE_DIGEST_MISMATCH`, audited), facts changed since read (`FACTS_CHANGED`), a skipped state (`SUBMISSION_STATE_CONFLICT`), stale wording (`SOURCE_NOT_CURRENT`), a failing archive check (`SOURCE_EVIDENCE_REJECTED`).

## 7. Revalidate a source

```bash
node scripts/curated-source.mjs revalidate <actorAdultId> <submissionId> document.pdf <newSourceVersionId> pageTexts.json
```

- Same bytes: records `last_revalidated_at` only.
- Different bytes (collector only): the published or checked wording moves to `needs_revalidation` and stops informing immediately; an earlier unpublished one moves to `superseded`. A new `collected` submission opens with `previous_id`, and must be proposed, checked by a different person and published again.

```bash
node scripts/curated-source.mjs verify-archives
```

Re-hashes every published archive and, where page text exists, re-runs its UIN, version and quote checks. Reports `{ submissionId, uin, ok, blocking, quotesMachineChecked }` per row, exits 2 when any row fails, and changes nothing. Catalogue reads already leave out any product that fails; this command tells an operator which ones.

## 8. Invalidate a faulty review

```bash
node scripts/curated-source.mjs invalidate <submissionId> <operatorLabel> checker_compromised
```

Reason codes: `checker_compromised`, `review_found_wrong`, `source_superseded`. Moves a `published` or `checked` submission to `needs_revalidation`; review columns are not edited and the audit event records who checked it. Do not use invalidation for normal grant expiry: an honest review stays historically valid.

## 9. Failure recovery and rollback

- Every command is one transaction. A failure leaves nothing half-written; a digest-mismatch attempt is audited after the rollback.
- `verify-archives` reports `digest_mismatch` or `source_bytes_invalid`: the archive was damaged or edited outside the application. The product is already out of use. Invalidate it, then register the correct bytes as a new source and take it through check and publish. Do not edit rows or archives by hand; triggers refuse it, and dropping them is itself tampering.
- A stale source (`SOURCE_NOT_CURRENT`) needs revalidation with a fresh download.
- Rollback of the feature: stop using the routes and CLI. The tables are additive and may stay empty. Dropping them needs a new migration; there is no down path.

## 10. Privacy and audit boundaries

- Public insurer wording only. Never register a household's uploaded document, even if it looks like the public wording.
- Audit payloads hold ids, digests, UINs, decisions and reason codes, never page text or quotes.
- CLI output omits page text. Archived bytes are never returned by any route.
- No synthetic record may be published in a database that serves households: the shipped catalogue (`CURATED_PRODUCT_RECORDS`, `CURATED_OFFICIAL_SOURCES` and the submission tables) is empty, and `tests/curated-sources-empty.test.mjs` asserts the static lists stay empty.
