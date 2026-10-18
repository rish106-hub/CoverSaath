# Evidence facts erasure (S3.1 re-review P2-2)

Owner decision (2026-10-18): option (a), a redaction carve-out modelled on `coverage_parameter_observations`. Option (b), an accepted risk, was declined.

## Problem

`evidence_facts` blocks UPDATE, DELETE and TRUNCATE on both engines with no exception (SQLite `002` and `007`, PostgreSQL `002` and `003`). Consent revocation therefore cannot erase `value_json` or `source_page_id` of facts derived from revoked documents. This breaks the AGENTS.md rule that revocation erases derived data and every derived store has an erasure path and a test. No production code writes facts yet (`EvidenceRepository.append` is test-only), so no live data is affected.

## Scope

- SQLite `009_evidence_fact_redaction.sql`, PostgreSQL `005_evidence_fact_redaction.sql`. Expand-only: two nullable columns with a pairing and timestamp CHECK, two insert guards (no redacted inserts; no citing a document whose erasure has started), one document-erasure trigger with a backfill for documents already being erased, the existing UPDATE guard replaced by the same guard with one redaction exception, and (PostgreSQL only) `unresolved_evidence` recreated so its columns match SQLite. The DELETE and TRUNCATE guards are unchanged.
- `ConsentRepository.eraseDerivedRunData` redacts facts sourced from the affected documents and appends one counts-only audit event. Revocation and the commit-time stop both reach it.
- Non-goals: facts without a document source (adult statements, institutional replies, calculations) have no link to a consent grant, so revocation does not reach them. Consent expiry keeps facts, as it already keeps observations (accepted risk F3). Graph node labels are a separate store. Open `fact_conflicts` rows are not closed when a side is redacted. A whole-run commit-time stop (no attributable document) does not reach facts, which have no run link; a future fact writer should add one.

## Redaction rule

The one permitted UPDATE moves a fact from unredacted to redacted and:

- nulls the value and its locators: `value_json`, `source_page_id`, `source_locator`, `institutional_source_ref`, `calculation_method`, `permitted_viewers_json`, `effective_at`;
- sets `epistemic_state = 'unknown'`, which the existing CHECKs require once the value is gone (UNKNOWN is honest: the household's evidence is no longer held);
- sets `redacted_at` and a lowercase `redaction_reason_code`;
- leaves every other column unchanged (ids, household and case references, fact key, provenance kind, evidence kind, statement adult, asserted by, timestamps, review state, supersession).

A redacted fact cannot be redacted again or changed. Facts cannot be inserted redacted.

## Safety net

`evidence_facts_redact_on_document_erasure` redacts facts whose source page belongs to a document that moves to `deletion_requested` or `deleted` (reason `document_erasure`), even if the repository is bypassed. The repository path runs first so the erasure is audited.

## Verification

- Behaviour tests on SQLite and PostgreSQL: redaction allowed; every non-redaction column change rejected; second redaction rejected; partial redaction rejected; redacted insert rejected; insert citing an erased document rejected; document erasure (`deletion_requested` and `deleted`) redacts; malformed `redacted_at` rejected. SQLite also tests the 009 backfill on a database migrated to 008.
- Repository test: revocation redacts document-derived facts, leaves other facts, writes one counts-only audit event, and is idempotent. The redaction suite was mutation-checked; the recorded mutations and their results are in `docs/iterations/LATEST.md`.
- `npm run check` with `TEST_DATABASE_URL`, `npm run eval:safety`, `git diff --check`, independent read-only review.

## Rollback

Forward-fix only. A follow-up migration can restore the unconditional UPDATE guard; redacted values cannot be restored by design.
