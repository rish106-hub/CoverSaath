# ADR 0010: Signed curated actions and byte-derived source text

- Status: Implemented 2026-10-21 on the owner's instruction (closeout WP2 option A: "remove the check/publish API routes; operator CLI with Ed25519-signed actions only"; WP3: page text derived from the document's bytes). Pending legal review of nothing in this ADR (no consent wording changes). Independent read-only review: see `docs/iterations/LATEST.md`.
- Date: 2026-10-21
- Scope: `src/features/decision-catalogue/curated-actions.js`, `src/features/input/pdf-text-extraction.js`, `src/features/input/sandboxed-pdf-text.js`, `src/backend/repositories/curated-product-repository.js`, `scripts/curated-source.mjs`, SQLite migration 019, PostgreSQL migration 015, removal of `POST /api/v1/curated-products/{id}/check|publish`.
- Related: [ADR 0009](0009-reviewed-facts-and-decision-catalogue.md), [reviewer-security.md](../architecture/reviewer-security.md), [curated-sources runbook](../runbooks/curated-sources.md), [verified-product-records.md](../architecture/verified-product-records.md).

## Context

Curated insurer wording reached `verified` through two session routes. Any session holding a checker grant could approve, sessions are self-issued after a bootstrap token, and an operator could not tell from the database who actually approved. Machine checks of UIN, wording version and quotes ran against page text the curator supplied, so the collector controlled the text the checks compared against.

## Decision

1. **No approval route.** Check and publish exist only as repository methods taking a signed action, applied by the operator CLI. `GET /api/v1/curated-products/{id}` stays (read only, live role required).
2. **Ed25519 signed actions** (`curated-action/v1`). A checker generates a key pair locally (`keygen`, PKCS#8 PEM, optional passphrase, mode 0600). The operator registers only the base64 SPKI public key on the checker grant; an active checker grant without a key is refused by the repository and by a database trigger. A signed payload is canonical JSON with a fixed key order binding the action, submission, claimed checker id, decision and reason (check), the SHA-256 of the checker's own copy of the source, the facts digest the checker read, a 128-bit nonce, `issuedAt` and `expiresAt` (at most 10 minutes; 60 s skew). The verifier checks the exact signed string, never a re-serialisation.
3. **Authorisation** happens inside the write transaction: live checker grant for the claimed id, signature by that grant's key, freshness, unused nonce. The nonce row is written in the same transaction as the state change, so a refused action never consumes its nonce and an applied one cannot be replayed (primary key, plus an explicit check). Regranting with a new key retires older signatures. Refusals are audited after rollback with the claimed id.
4. **Byte-derived text.** Registration and revalidation derive page text from the PDF bytes in a permission-restricted child (no network, no writes, reads only its own code and pdf-lib). Text comes from content-stream text operators through each font's ToUnicode map or a standard single-byte encoding. A page with an unmapped glyph, a font with no Unicode map, an undecodable stream, no text, or a limit breach is `unestablished`, and one such page refuses the document. Curator page text is a candidate that must agree page for page. Rows record `page_text_origin = 'derived_from_bytes'` and `text_extractor_version`; only rows from the current extractor support machine checks or a verified read. `verify-archives` derives the text again from the archive.
5. **No OCR or model text** enters this path. Scanned wording cannot be registered.

## Consequences

- An operator with database access still controls role grants and could register a key they hold. Signing proves "the holder of the key registered on this grant approved", not a verified person. A real operator identity model (directory, MFA, two-person grant) remains open.
- The curator's id is still a label (curator actions are not signed). Against API callers and a checker acting alone, separation of duties holds: a check needs a checker key and the collector is refused even with one. Against a person with database access it does not: they can grant a checker role to any adult with a key they hold, register as some curator, and check and publish as the other. Signed curator actions or a two-person grant approval would close this; not built.
- Image-only or unusual-font PDFs cannot be curated until a reviewed extraction path exists. That is the intended fail-closed behaviour.
- An extractor version bump leaves existing published rows unreadable as verified. The collector recovers each with `revalidate` on the same bytes, which re-derives the text into a new submission that goes through propose, check and publish again; re-registering the same file is refused with `SOURCE_REVALIDATION_REQUIRED` rather than replaying the stale row. The same path re-opens an invalidated review.
- Invisible text (rendering mode 3/7, typical OCR layers), optional-content sections and malformed content fail a page. Text drawn off the page or in the background colour is not detected (residual).
- The checker's CLI computes both signed digests itself: the source digest from their own copy, the facts digest from the facts file they reviewed.
- Migration 019/015 is expand-only. Code rolled back past this ADR cannot grant checkers on a migrated database (trigger). See the runbook for rollback.

## Rejected

- Keeping the session routes behind a flag: two approval paths to secure.
- HMAC with a shared secret: the operator would hold the secret.
- Adding `pdfjs-dist` or similar: a large dependency for a bounded need. pdf-lib is already a dependency and is used for parsing only.
