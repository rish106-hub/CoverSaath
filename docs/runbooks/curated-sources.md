# Runbook: curated insurer sources

Scope: the trusted insurer-source workflow on a developer's local SQLite database, with synthetic documents only. There is no production deployment, no production curator or checker, and no genuine insurer record. Nothing in this runbook makes a record genuinely verified: that needs a real insurer document, a real curator and a different real checker (see [block-3-acceptance.md](../exec-plans/active/block-3-acceptance.md)). Roles and identity limits: [reviewer-security.md](../architecture/reviewer-security.md).

Code: `src/backend/repositories/curated-product-repository.js`, `src/features/decision-catalogue/source-verification.js`, `src/features/decision-catalogue/curated-actions.js` (signed actions), `src/features/input/pdf-text-extraction.js` (byte-derived text), `scripts/curated-source.mjs`. Tables: `source_curator_grants`, `curated_source_archives`, `curated_product_submissions` (SQLite 018, PostgreSQL 014), `curated_action_nonces` and the key and text-origin columns (SQLite 019, PostgreSQL 015). Design: [ADR 0010](../adr/0010-signed-curated-actions-and-derived-text.md).

## 1. Configure a local test environment

- Use a separate database under `.local/`, for example `DATABASE_PATH=.local/curated-trial.sqlite`. Never point these commands at a database holding household data you care about; they write audit rows and archive bytes that are never deleted.
- `CURATED_SOURCE_HOSTS` must list the exact DNS names a source may come from (comma separated). Unset or empty refuses every registration (`SOURCE_HOSTS_NOT_CONFIGURED`). IP addresses, `localhost`, `.local` and `.internal` names are refused at startup. For synthetic trials use a reserved test name such as `wording.synthetic-insurer.test`. The allowlist limits where a source may be named; it does not prove a source is official or reusable.
- `npm run db:init` creates and migrates the database (see [local-database.md](local-database.md)).
- No network access is needed or used. Every document is a local file a person already downloaded.

## 2. Generate synthetic evidence

`tests/support/synthetic-policies.mjs` builds deterministic, clearly labelled ("SYNTHETIC TEST DATA - NOT A REAL POLICY") PDFs with fictional insurers, UINs and policy numbers, plus their page texts and a scenario manifest. The generator's page texts are its own output; the workflow ignores them as evidence and derives the text from the PDF bytes (they must agree). Use them for trials and tests only; never register them in a database that serves households.

Files the CLI needs:

- `metadata.json`: `{ "uin", "insurer", "productName", "wordingVersion", "sourceUrl", "sourceVersionId", "retrievedOn", "effectiveFrom"? }`. `sourceUrl` must be `https://` on an allowlisted host; `retrievedOn` must be within 400 days.
- `document.pdf`: the exact bytes. The SHA-256 is computed from these bytes.
- `pageTexts.json` (optional): one string per page. A candidate only: the text is derived from the PDF bytes in a sandboxed child, and a supplied file must agree with it page for page (whitespace and case aside) or registration is refused (`supplied_text_differs:<page>`).
- `facts.json`: `[{ "factType", "topic", "value", "page", "quote" }]`. Types: `room_rent_limit`, `icu_limit`, `copay`, `deductible`, `sublimit`, `waiting_period`, `exclusion`, `restoration`, `bonus`. Values use the rule shapes, for example `{ "kind": "amount", "amountMinor": 500000, "currency": "INR", "basis": "per_day" }`. Quotes are at least 8 characters and must appear on the stated page.

## 3. Grant and revoke roles

```bash
node scripts/curated-source.mjs grant-role <adultId> curator <operatorLabel> <expiresAtISO>
```

A checker generates their own key on their own machine and gives the operator only the printed base64 public key. Set `CURATED_KEY_PASSPHRASE` to encrypt the private key; the file is written with mode 0600 and never overwritten.

```bash
node scripts/curated-source.mjs keygen checker-key.pem
```

```bash
node scripts/curated-source.mjs grant-role <checkerAdultId> checker <operatorLabel> <expiresAtISO> <publicKeyBase64>
```

```bash
node scripts/curated-source.mjs revoke-role <grantId> <operatorLabel>
```

- Roles are `curator` and `checker`, at most 90 days, re-read on every request. An operator label equal to the adult id is refused. A checker grant without a valid Ed25519 public key is refused (repository and database trigger). Regranting with a new key retires every action signed with the old one.
- Locally, an adult with a session is created by `POST /api/v1/households` with the bootstrap token (the response holds `owner.id` and `session.token`). Use two different adults for curator and checker.
- `operatorLabel` is recorded in the audit trail. It is not authentication: anyone who can run the CLI against the database can grant roles.

## 4. Register a source

```bash
node scripts/curated-source.mjs register <curatorAdultId> metadata.json document.pdf pageTexts.json
```

State `collected`. Refused: no curator role, host not allowlisted, a port in the URL, stale or not yet effective wording, bytes that are not a PDF or over 20 MB, a supplied digest that differs from the bytes, a document whose text cannot be derived on every page (`page_text_unestablished`, with per-page reasons such as `no_text`, `glyph_unmapped`, `font_without_unicode_map`; scanned or image-only wording cannot be registered), supplied page text that disagrees with the derived text, derived text with zero or several printed UINs, a UIN or wording version not printed, and a different document already registered for the same UIN and version (`SOURCE_VERSION_CONFLICT`). The same bytes again return the existing submission with `replayed: true`.

## 5. Propose facts

```bash
node scripts/curated-source.mjs propose <curatorAdultId> <submissionId> facts.json
```

State `candidate`. Only the collector may propose. Every page and quote is checked against the text derived from the archived bytes. Re-proposing replaces the facts and invalidates any earlier `factsSha256` a checker saw.

## 6. Check and publish

There is no API route for either. Both take an action signed with the checker's own Ed25519 key ([ADR 0010](../adr/0010-signed-curated-actions-and-derived-text.md)); the repository verifies it against the key on the checker's live grant, so an id typed by the operator is never enough.

1. The checker reads the submission (`show` below, or `GET /api/v1/curated-products/{submissionId}` with their session). The digest and bytes are withheld; it shows `factsSha256`, the facts and the derived page text.
2. The checker saves the `show` output they reviewed (for example `reviewed.json`), downloads their own copy of the source and signs, on their own machine. The CLI computes the source digest from the copy and the facts digest from `reviewed.json`; a facts file that differs from the submission is refused (`FACTS_CHANGED`).
3. The operator applies the signed file. Each signed action is valid for five minutes (ten at most, 60 s clock skew allowed) and applies once.

```bash
node scripts/curated-source.mjs show <checkerAdultId> <submissionId>
```

```bash
node scripts/curated-source.mjs sign-check checker-key.pem <checkerAdultId> <submissionId> accept quote_matches_source their-copy.pdf reviewed.json --quotes-reviewed > check.json
```

```bash
node scripts/curated-source.mjs check check.json
```

```bash
node scripts/curated-source.mjs sign-publish checker-key.pem <checkerAdultId> <submissionId> their-copy.pdf reviewed.json > publish.json
```

```bash
node scripts/curated-source.mjs publish publish.json
```

Reject with `sign-check ... reject <quote_does_not_match_source|wrong_product_or_version|source_unreadable|other> their-copy.pdf -`. Publication may be signed by the checker of record or another checker, never the collector; it attests the same facts and source digests and re-runs every machine check.

Refused with stable codes: a missing, non-canonical or malformed envelope (`SOURCE_ACTION_MALFORMED`), a signature by any key other than the grant's (`SOURCE_ACTION_SIGNATURE_INVALID`), outside the validity window (`SOURCE_ACTION_EXPIRED`), an already-used nonce (`SOURCE_ACTION_REPLAYED`), the collector checking or publishing (`SELF_REVIEW_REFUSED`), no live checker role (`SOURCE_ROLE_NOT_AUTHORISED`), a wrong own-copy digest (`SOURCE_DIGEST_MISMATCH`, audited), facts changed since read (`FACTS_CHANGED`), a skipped state (`SUBMISSION_STATE_CONFLICT`), stale wording (`SOURCE_NOT_CURRENT`), a failing archive check (`SOURCE_EVIDENCE_REJECTED`). Refused signatures, expiries, replays and role failures are audited as `curated_source.signed_action_refused` with the claimed checker id. A refused action does not use up its nonce.

## 7. Revalidate a source

```bash
node scripts/curated-source.mjs revalidate <actorAdultId> <submissionId> document.pdf <newSourceVersionId> pageTexts.json
```

- Same bytes on a usable row: records `last_revalidated_at` only.
- Same bytes whose text came from an older extractor (or was never derived), or after an operator invalidated the review (collector only): re-derives the text into a new `collected` submission with the same source version, and withdraws the old one. Re-registering such a file instead returns `SOURCE_REVALIDATION_REQUIRED`.
- Different bytes (collector only): the published or checked wording moves to `needs_revalidation` and stops informing immediately; an earlier unpublished one moves to `superseded`. A new `collected` submission opens with `previous_id`, and must be proposed, checked by a different person and published again.

```bash
node scripts/curated-source.mjs verify-archives
```

Re-hashes every published archive, re-runs its UIN, version and quote checks, and derives the page text again from the archived bytes (`derived_text_changed`, `extractor_version_changed`). A row whose text was not derived by the current extractor reports `page_text_not_derived` and never reads as verified. Reports `{ submissionId, uin, ok, blocking, textOrigin, extractor }` per row, exits 2 when any row fails, and changes nothing. Catalogue reads already leave out any product that fails; this command tells an operator which ones.

## 8. Invalidate a faulty review

```bash
node scripts/curated-source.mjs invalidate <submissionId> <operatorLabel> checker_compromised
```

Reason codes: `checker_compromised`, `review_found_wrong`, `source_superseded`. Moves a `published` or `checked` submission to `needs_revalidation`; review columns are not edited and the audit event records who checked it. Do not use invalidation for normal grant expiry: an honest review stays historically valid.

## 9. Failure recovery and rollback

- Every command is one transaction. A failure leaves nothing half-written; a digest-mismatch attempt is audited after the rollback.
- `verify-archives` reports `digest_mismatch` or `source_bytes_invalid`: the archive was damaged or edited outside the application. The product is already out of use. Invalidate it, then register the correct bytes as a new source and take it through check and publish. Do not edit rows or archives by hand; triggers refuse it, and dropping them is itself tampering.
- A stale source (`SOURCE_NOT_CURRENT`) needs revalidation with a fresh download.
- Rollback of the feature: stop using the CLI. The tables and columns are additive and may stay empty. Dropping them needs a new migration; there is no down path. Rolling the code back to before ADR 0010 while keeping migration 019/015 is not clean: the older code cannot grant a checker (the trigger requires a key it never sends) and would publish rows with curator-supplied text again. Roll back only on a database where no curated work matters, or forward-fix.
- A changed extractor version makes every published row report `extractor_version_changed` in `verify-archives` while reads keep refusing rows whose stored version differs (they read as unknown). Re-register affected sources after an extractor upgrade.

## 10. Privacy and audit boundaries

- Public insurer wording only. Never register a household's uploaded document, even if it looks like the public wording.
- Audit payloads hold ids, digests, UINs, decisions and reason codes, never page text or quotes.
- CLI output omits page text. Archived bytes are never returned by any route. Private checker keys never reach the database or the operator; only the public key and a 16-hex fingerprint (audit) are stored.
- No synthetic record may be published in a database that serves households: the shipped catalogue (`CURATED_PRODUCT_RECORDS`, `CURATED_OFFICIAL_SOURCES` and the submission tables) is empty, and `tests/curated-sources-empty.test.mjs` asserts the static lists stay empty.
