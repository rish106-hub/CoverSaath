-- Operator-signed curated actions and byte-derived page text. Expand-only: three new columns, one new table.
--
--   * source_curator_grants.public_key: the checker's Ed25519 public key (base64 SPKI DER), registered by the operator with the
--     grant. An active checker grant must carry one, so check and publish can be verified against a signature made with the
--     checker's own private key rather than an id supplied by whoever runs the tooling. Existing checker rows keep NULL and
--     cannot act until regranted with a key (fail closed). Curator grants may leave it NULL.
--   * curated_action_nonces: one row per accepted signed action, so a signed check or publish is applied at most once.
--     Immutable and never deleted (it is part of the record of who approved what).
--   * curated_product_submissions.page_text_origin / text_extractor_version: where the stored page text came from. Only
--     `derived_from_bytes` text (extracted from the archived PDF by the named extractor) can support machine checks; rows
--     written before this migration keep NULL and never read as verified (fail closed). Immutable once set.
-- Mirrored by PostgreSQL migration 015.

ALTER TABLE source_curator_grants ADD COLUMN public_key TEXT CHECK (public_key IS NULL OR length(public_key) BETWEEN 40 AND 200);

CREATE TRIGGER source_curator_grants_checker_key_insert
BEFORE INSERT ON source_curator_grants
WHEN NEW.role = 'checker' AND NEW.status = 'active' AND NEW.public_key IS NULL
BEGIN
  SELECT RAISE(ABORT, 'an active checker grant needs a public key');
END;

CREATE TRIGGER source_curator_grants_checker_key_update
BEFORE UPDATE ON source_curator_grants
WHEN NEW.role = 'checker' AND NEW.status = 'active' AND NEW.public_key IS NULL
BEGIN
  SELECT RAISE(ABORT, 'an active checker grant needs a public key');
END;

CREATE TABLE curated_action_nonces (
  nonce TEXT PRIMARY KEY CHECK (length(nonce) = 32),
  grant_id TEXT NOT NULL REFERENCES source_curator_grants(id),
  action TEXT NOT NULL CHECK (action IN ('check', 'publish')),
  submission_id TEXT NOT NULL REFERENCES curated_product_submissions(id),
  signature_sha256 TEXT NOT NULL CHECK (length(signature_sha256) = 64),
  used_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER curated_action_nonces_immutable
BEFORE UPDATE ON curated_action_nonces
BEGIN
  SELECT RAISE(ABORT, 'curated action nonces are immutable');
END;

CREATE TRIGGER curated_action_nonces_no_delete
BEFORE DELETE ON curated_action_nonces
BEGIN
  SELECT RAISE(ABORT, 'curated action nonces are never deleted');
END;

ALTER TABLE curated_product_submissions ADD COLUMN page_text_origin TEXT CHECK (page_text_origin IS NULL OR page_text_origin IN ('derived_from_bytes', 'curator_supplied'));
ALTER TABLE curated_product_submissions ADD COLUMN text_extractor_version TEXT CHECK (text_extractor_version IS NULL OR length(text_extractor_version) BETWEEN 1 AND 64);

CREATE TRIGGER curated_product_submissions_text_origin_immutable
BEFORE UPDATE ON curated_product_submissions
WHEN NEW.page_text_origin IS NOT OLD.page_text_origin OR NEW.text_extractor_version IS NOT OLD.text_extractor_version
BEGIN
  SELECT RAISE(ABORT, 'curated page text origin is immutable once written');
END;
