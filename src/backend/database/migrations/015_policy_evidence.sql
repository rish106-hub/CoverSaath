-- Evidence-first reasoning (ADR 0008). Expand-only: two derived stores and their guards.
--
--   * policy_clauses: deterministic clauses built from stored OCR blocks (same blocks, same ids and digests).
--     Immutable once inserted. Deleted, never redacted, when the document is erased or consent is revoked.
--   * policy_answers: cited conditional answers to a question about one case. Immutable once inserted;
--     unique per (household, case, idempotency key). Deleted when any cited document is erased.
--   * Erasure safety net: a document moving to deletion_requested or deleted deletes its clauses and the
--     answers that cite it. Repository erasure runs first and adds the audit event.
-- Mirrored by PostgreSQL migration 012.

CREATE TABLE policy_clauses (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  case_id TEXT NOT NULL REFERENCES service_cases(id),
  document_id TEXT NOT NULL REFERENCES document_uploads(id),
  source_version TEXT NOT NULL CHECK (length(source_version) BETWEEN 1 AND 128),
  page INTEGER NOT NULL CHECK (page > 0),
  block_indexes_json TEXT NOT NULL CHECK (json_valid(block_indexes_json) AND json_type(block_indexes_json) = 'array'),
  title TEXT CHECK (title IS NULL OR length(title) <= 200),
  kind TEXT NOT NULL CHECK (kind IN (
    'benefit', 'limit', 'condition', 'exclusion', 'waiting_period', 'definition', 'endorsement', 'schedule_fact', 'procedure', 'other'
  )),
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 100000),
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX policy_clauses_document_idx ON policy_clauses(document_id, page);
CREATE INDEX policy_clauses_household_idx ON policy_clauses(household_id, case_id);

CREATE TRIGGER policy_clauses_scope_insert
BEFORE INSERT ON policy_clauses
WHEN NOT EXISTS (
  SELECT 1 FROM document_uploads document
  JOIN service_cases service_case ON service_case.id = NEW.case_id
  WHERE document.id = NEW.document_id
    AND document.household_id = NEW.household_id
    AND document.case_id = NEW.case_id
    AND service_case.household_id = NEW.household_id
    AND document.lifecycle_state = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'policy clause must match an active document of its case and household');
END;

CREATE TRIGGER policy_clauses_immutable
BEFORE UPDATE ON policy_clauses
BEGIN
  SELECT RAISE(ABORT, 'policy clauses are immutable; erasure deletes them');
END;

CREATE TABLE policy_answers (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  case_id TEXT NOT NULL REFERENCES service_cases(id),
  requested_by_adult_id TEXT NOT NULL REFERENCES adult_users(id),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  question TEXT NOT NULL CHECK (length(question) BETWEEN 1 AND 2000),
  state TEXT NOT NULL CHECK (state IN ('evidence_found', 'conditional', 'insufficient_evidence')),
  document_ids_json TEXT NOT NULL CHECK (json_valid(document_ids_json) AND json_type(document_ids_json) = 'array'),
  answer_json TEXT NOT NULL CHECK (json_valid(answer_json) AND json_type(answer_json) = 'object' AND length(answer_json) <= 262144),
  created_at TEXT NOT NULL,
  UNIQUE (household_id, case_id, idempotency_key)
) STRICT;

CREATE INDEX policy_answers_case_idx ON policy_answers(household_id, case_id, created_at);

CREATE TRIGGER policy_answers_scope_insert
BEFORE INSERT ON policy_answers
WHEN NOT EXISTS (
  SELECT 1 FROM service_cases service_case
  WHERE service_case.id = NEW.case_id AND service_case.household_id = NEW.household_id
)
BEGIN
  SELECT RAISE(ABORT, 'policy answer must match its case and household');
END;

CREATE TRIGGER policy_answers_immutable
BEFORE UPDATE ON policy_answers
BEGIN
  SELECT RAISE(ABORT, 'policy answers are immutable; erasure deletes them');
END;

CREATE TRIGGER policy_evidence_erase_on_document_erasure
AFTER UPDATE OF lifecycle_state ON document_uploads
WHEN NEW.lifecycle_state IN ('deletion_requested', 'deleted')
  AND OLD.lifecycle_state NOT IN ('deletion_requested', 'deleted')
BEGIN
  DELETE FROM policy_answers WHERE EXISTS (SELECT 1 FROM json_each(policy_answers.document_ids_json) WHERE value = NEW.id);
  DELETE FROM policy_clauses WHERE document_id = NEW.id;
END;
