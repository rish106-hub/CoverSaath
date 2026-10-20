-- Reviewed facts for the decision catalogue (ADR 0009 part 2). Expand-only: two new tables, no existing object changes.
--
--   * catalogue_reviewer_grants: who may record a review for a household, and with what authority.
--       household_confirmer  a household adult the owner designated. Self confirmation: never reaches `proven`.
--       independent_reviewer a person outside the household's own data. Granted by operator tooling only, never by an API request body.
--   * catalogue_reviews: immutable decisions about one cited, typed fact. A later decision on the same fact supersedes an
--     earlier one at read time; rows are never updated. Deleted (never redacted) when a cited document is erased or
--     consent is revoked. No quote text is stored: clause ids and digests link to policy_clauses.
-- Mirrored by PostgreSQL migration 013.

CREATE TABLE catalogue_reviewer_grants (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  adult_user_id TEXT NOT NULL REFERENCES adult_users(id),
  kind TEXT NOT NULL CHECK (kind IN ('household_confirmer', 'independent_reviewer')),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  granted_by TEXT NOT NULL CHECK (length(granted_by) BETWEEN 1 AND 128),
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE (household_id, adult_user_id, kind)
) STRICT;

CREATE TABLE catalogue_reviews (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  case_id TEXT NOT NULL REFERENCES service_cases(id),
  grant_id TEXT NOT NULL REFERENCES catalogue_reviewer_grants(id),
  reviewer_adult_id TEXT NOT NULL REFERENCES adult_users(id),
  authority TEXT NOT NULL CHECK (authority IN ('independent', 'household')),
  decision TEXT NOT NULL CHECK (decision IN ('accepted', 'rejected', 'disputed')),
  reason_code TEXT NOT NULL CHECK (reason_code IN ('matches_clause', 'does_not_match_clause', 'clause_ambiguous', 'other_source_conflicts', 'wrong_policy_or_person')),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  document_id TEXT NOT NULL REFERENCES document_uploads(id),
  source_version TEXT NOT NULL CHECK (length(source_version) BETWEEN 1 AND 128),
  clause_ids_json TEXT NOT NULL CHECK (json_valid(clause_ids_json) AND json_type(clause_ids_json) = 'array'),
  source_digests_json TEXT NOT NULL CHECK (json_valid(source_digests_json) AND json_type(source_digests_json) = 'array'),
  fact_key TEXT NOT NULL CHECK (length(fact_key) = 64),
  fact_json TEXT NOT NULL CHECK (json_valid(fact_json) AND json_type(fact_json) = 'object' AND length(fact_json) <= 16384),
  created_at TEXT NOT NULL,
  UNIQUE (household_id, case_id, idempotency_key)
) STRICT;

CREATE INDEX catalogue_reviews_case_idx ON catalogue_reviews(household_id, case_id, created_at);
CREATE INDEX catalogue_reviews_document_idx ON catalogue_reviews(document_id);
CREATE INDEX catalogue_reviewer_grants_household_idx ON catalogue_reviewer_grants(household_id, adult_user_id, status);

CREATE TRIGGER catalogue_reviews_scope_insert
BEFORE INSERT ON catalogue_reviews
WHEN NOT EXISTS (
  SELECT 1 FROM document_uploads document
  JOIN service_cases service_case ON service_case.id = NEW.case_id
  JOIN catalogue_reviewer_grants reviewer_grant ON reviewer_grant.id = NEW.grant_id
  WHERE document.id = NEW.document_id
    AND document.household_id = NEW.household_id
    AND document.case_id = NEW.case_id
    AND document.lifecycle_state = 'active'
    AND service_case.household_id = NEW.household_id
    AND reviewer_grant.household_id = NEW.household_id
    AND reviewer_grant.adult_user_id = NEW.reviewer_adult_id
    AND reviewer_grant.status = 'active'
    AND ((reviewer_grant.kind = 'independent_reviewer' AND NEW.authority = 'independent')
      OR (reviewer_grant.kind = 'household_confirmer' AND NEW.authority = 'household'))
)
BEGIN
  SELECT RAISE(ABORT, 'catalogue review must match an active document, case, household and active reviewer grant');
END;

CREATE TRIGGER catalogue_reviews_immutable
BEFORE UPDATE ON catalogue_reviews
BEGIN
  SELECT RAISE(ABORT, 'catalogue reviews are immutable; erasure deletes them');
END;

CREATE TRIGGER catalogue_reviewer_grants_scope_insert
BEFORE INSERT ON catalogue_reviewer_grants
WHEN NOT EXISTS (
  SELECT 1 FROM household_roles role
  WHERE role.household_id = NEW.household_id AND role.adult_user_id = NEW.adult_user_id
)
AND NEW.kind = 'household_confirmer'
BEGIN
  SELECT RAISE(ABORT, 'a household confirmer must hold a role in the household');
END;

CREATE TRIGGER catalogue_reviews_erase_on_document_erasure
AFTER UPDATE OF lifecycle_state ON document_uploads
WHEN NEW.lifecycle_state IN ('deletion_requested', 'deleted')
  AND OLD.lifecycle_state NOT IN ('deletion_requested', 'deleted')
BEGIN
  DELETE FROM catalogue_reviews WHERE document_id = NEW.id;
END;
