-- Trusted insurer-source workflow and bounded reviewer grants. Expand-only: two new columns on one table, three new tables.
--
--   * catalogue_reviewer_grants gains expires_at and case_id. An independent reviewer's grant is temporary and scoped to one
--     case; the repository refuses an expired, revoked or out-of-case grant on every read and write. Existing rows keep NULL
--     and an independent grant with no expiry or case is treated as inactive (fail closed).
--   * source_curator_grants: who may register or check an insurer wording. Operator tooling only, always temporary.
--   * curated_source_archives: content-addressed, immutable, never deleted. The exact bytes a curated record was checked against.
--   * curated_product_submissions: collection, candidate facts, independent check and publication as separate states.
--     The checker must differ from the collector (CHECK constraint); content columns are immutable once written.
-- Public insurer documents only. No household data. Mirrored by PostgreSQL migration 014.

ALTER TABLE catalogue_reviewer_grants ADD COLUMN expires_at TEXT;
ALTER TABLE catalogue_reviewer_grants ADD COLUMN case_id TEXT REFERENCES service_cases(id);
ALTER TABLE catalogue_reviewer_grants ADD COLUMN granted_at TEXT;

-- An active independent grant must carry an expiry and a case of its own household. Revoking a legacy row stays possible.
CREATE TRIGGER catalogue_reviewer_grants_independent_insert
BEFORE INSERT ON catalogue_reviewer_grants
WHEN NEW.kind = 'independent_reviewer' AND NEW.status = 'active' AND (NEW.expires_at IS NULL OR NEW.case_id IS NULL OR NOT EXISTS (
  SELECT 1 FROM service_cases service_case WHERE service_case.id = NEW.case_id AND service_case.household_id = NEW.household_id))
BEGIN
  SELECT RAISE(ABORT, 'an independent reviewer grant needs an expiry and a case of the household');
END;

CREATE TRIGGER catalogue_reviewer_grants_independent_update
BEFORE UPDATE ON catalogue_reviewer_grants
WHEN NEW.kind = 'independent_reviewer' AND NEW.status = 'active' AND (NEW.expires_at IS NULL OR NEW.case_id IS NULL OR NOT EXISTS (
  SELECT 1 FROM service_cases service_case WHERE service_case.id = NEW.case_id AND service_case.household_id = NEW.household_id))
BEGIN
  SELECT RAISE(ABORT, 'an independent reviewer grant needs an expiry and a case of the household');
END;

CREATE TABLE source_curator_grants (
  id TEXT PRIMARY KEY,
  adult_user_id TEXT NOT NULL REFERENCES adult_users(id),
  role TEXT NOT NULL CHECK (role IN ('curator', 'checker')),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  granted_by TEXT NOT NULL CHECK (length(granted_by) BETWEEN 1 AND 128),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE (adult_user_id, role)
) STRICT;

CREATE TABLE curated_source_archives (
  sha256 TEXT PRIMARY KEY CHECK (length(sha256) = 64),
  byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 20971520),
  content BLOB NOT NULL CHECK (length(content) = byte_size),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE curated_product_submissions (
  id TEXT PRIMARY KEY,
  uin TEXT NOT NULL CHECK (length(uin) BETWEEN 12 AND 24),
  insurer TEXT NOT NULL CHECK (length(insurer) BETWEEN 1 AND 200),
  product_name TEXT NOT NULL CHECK (length(product_name) BETWEEN 1 AND 200),
  wording_version TEXT NOT NULL CHECK (length(wording_version) BETWEEN 1 AND 200),
  source_url TEXT NOT NULL CHECK (length(source_url) BETWEEN 9 AND 500 AND substr(lower(source_url), 1, 8) = 'https://'),
  source_version_id TEXT NOT NULL CHECK (length(source_version_id) BETWEEN 1 AND 200),
  content_sha256 TEXT NOT NULL REFERENCES curated_source_archives(sha256),
  retrieved_on TEXT NOT NULL,
  effective_from TEXT,
  page_texts_json TEXT CHECK (page_texts_json IS NULL OR (json_valid(page_texts_json) AND json_type(page_texts_json) = 'array')),
  facts_json TEXT NOT NULL CHECK (json_valid(facts_json) AND json_type(facts_json) = 'array'),
  machine_checks_json TEXT NOT NULL CHECK (json_valid(machine_checks_json) AND json_type(machine_checks_json) = 'object'),
  state TEXT NOT NULL CHECK (state IN ('collected', 'candidate', 'checked', 'published', 'rejected', 'needs_revalidation', 'superseded')),
  collected_by TEXT NOT NULL REFERENCES adult_users(id),
  checked_by TEXT REFERENCES adult_users(id),
  checked_at TEXT,
  published_at TEXT,
  previous_id TEXT REFERENCES curated_product_submissions(id),
  last_revalidated_at TEXT,
  created_at TEXT NOT NULL,
  CHECK (checked_by IS NULL OR checked_by <> collected_by),
  CHECK (state NOT IN ('checked', 'published') OR (checked_by IS NOT NULL AND checked_at IS NOT NULL)),
  CHECK (state <> 'published' OR published_at IS NOT NULL)
) STRICT;

CREATE UNIQUE INDEX curated_product_submissions_one_published_idx ON curated_product_submissions(uin, wording_version) WHERE state = 'published';
CREATE INDEX curated_product_submissions_uin_idx ON curated_product_submissions(uin, wording_version, state);

CREATE TRIGGER curated_source_archives_immutable
BEFORE UPDATE ON curated_source_archives
BEGIN
  SELECT RAISE(ABORT, 'curated source archives are immutable');
END;

CREATE TRIGGER curated_source_archives_no_delete
BEFORE DELETE ON curated_source_archives
BEGIN
  SELECT RAISE(ABORT, 'curated source archives are never deleted');
END;

CREATE TRIGGER curated_product_submissions_content_immutable
BEFORE UPDATE ON curated_product_submissions
WHEN NEW.uin <> OLD.uin OR NEW.insurer <> OLD.insurer OR NEW.product_name <> OLD.product_name OR NEW.wording_version <> OLD.wording_version
  OR NEW.source_url <> OLD.source_url OR NEW.source_version_id <> OLD.source_version_id OR NEW.content_sha256 <> OLD.content_sha256
  OR NEW.retrieved_on <> OLD.retrieved_on OR NEW.collected_by <> OLD.collected_by OR NEW.created_at <> OLD.created_at
  OR (OLD.state NOT IN ('collected', 'candidate') AND (NEW.facts_json <> OLD.facts_json OR NEW.machine_checks_json <> OLD.machine_checks_json))
  OR NEW.effective_from IS NOT OLD.effective_from OR NEW.page_texts_json IS NOT OLD.page_texts_json OR NEW.previous_id IS NOT OLD.previous_id
  OR (OLD.checked_by IS NOT NULL AND NEW.checked_by IS NOT OLD.checked_by)
  OR (OLD.checked_at IS NOT NULL AND NEW.checked_at IS NOT OLD.checked_at) OR (OLD.published_at IS NOT NULL AND NEW.published_at IS NOT OLD.published_at)
BEGIN
  SELECT RAISE(ABORT, 'curated product content is immutable once written; register a new submission instead');
END;

CREATE TRIGGER curated_product_submissions_state_transition
BEFORE UPDATE OF state ON curated_product_submissions
WHEN NEW.state <> OLD.state AND NOT (
  (OLD.state = 'collected' AND NEW.state IN ('candidate', 'superseded'))
  OR (OLD.state = 'candidate' AND NEW.state IN ('checked', 'rejected', 'superseded'))
  OR (OLD.state = 'checked' AND NEW.state IN ('published', 'needs_revalidation'))
  OR (OLD.state = 'published' AND NEW.state IN ('needs_revalidation', 'superseded'))
  OR (OLD.state = 'needs_revalidation' AND NEW.state = 'superseded')
)
BEGIN
  SELECT RAISE(ABORT, 'illegal curated product state transition');
END;

CREATE TRIGGER curated_product_submissions_no_delete
BEFORE DELETE ON curated_product_submissions
BEGIN
  SELECT RAISE(ABORT, 'curated product submissions are never deleted');
END;
