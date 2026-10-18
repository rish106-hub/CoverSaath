-- Erasure path for evidence facts (S3.1 re-review P2-2). Expand-only.
-- Facts stay append-only except for one redaction update, as for parameter observations:
-- it erases the value and its locators, marks the fact UNKNOWN (the existing CHECKs require
-- that once the value is gone) and stamps redacted_at / redaction_reason_code. Every other
-- column must be unchanged. DELETE stays blocked (007).

ALTER TABLE evidence_facts ADD COLUMN redacted_at TEXT;
ALTER TABLE evidence_facts ADD COLUMN redaction_reason_code TEXT CHECK (
  (redaction_reason_code IS NULL AND redacted_at IS NULL)
  OR (
    redaction_reason_code IS NOT NULL AND redacted_at IS NOT NULL
    AND redacted_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
    AND length(redaction_reason_code) BETWEEN 1 AND 64
    AND redaction_reason_code NOT GLOB '*[^a-z0-9_]*'
  )
);

DROP TRIGGER evidence_facts_provenance_immutable;

CREATE TRIGGER evidence_facts_provenance_immutable
BEFORE UPDATE ON evidence_facts
WHEN NOT (
  OLD.redacted_at IS NULL
  AND NEW.redacted_at IS NOT NULL
  AND NEW.redaction_reason_code IS NOT NULL
  AND NEW.epistemic_state = 'unknown'
  AND NEW.value_json IS NULL
  AND NEW.source_page_id IS NULL
  AND NEW.source_locator IS NULL
  AND NEW.institutional_source_ref IS NULL
  AND NEW.calculation_method IS NULL
  AND NEW.permitted_viewers_json IS NULL
  AND NEW.effective_at IS NULL
  AND NEW.id IS OLD.id
  AND NEW.household_id IS OLD.household_id
  AND NEW.case_id IS OLD.case_id
  AND NEW.policy_id IS OLD.policy_id
  AND NEW.subject_member_id IS OLD.subject_member_id
  AND NEW.fact_key IS OLD.fact_key
  AND NEW.evidence_kind IS OLD.evidence_kind
  AND NEW.provenance_kind IS OLD.provenance_kind
  AND NEW.statement_adult_id IS OLD.statement_adult_id
  AND NEW.asserted_by IS OLD.asserted_by
  AND NEW.observed_at IS OLD.observed_at
  AND NEW.retrieved_at IS OLD.retrieved_at
  AND NEW.confidence_basis_points IS OLD.confidence_basis_points
  AND NEW.review_status IS OLD.review_status
  AND NEW.subject_confirmation_state IS OLD.subject_confirmation_state
  AND NEW.expires_at IS OLD.expires_at
  AND NEW.supersedes_fact_id IS OLD.supersedes_fact_id
  AND NEW.created_at IS OLD.created_at
)
BEGIN
  SELECT RAISE(ABORT, 'evidence facts are append only; add a superseding fact');
END;

CREATE TRIGGER evidence_facts_redaction_insert
BEFORE INSERT ON evidence_facts
WHEN NEW.redacted_at IS NOT NULL OR NEW.redaction_reason_code IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'evidence facts cannot be inserted redacted');
END;

-- Safety net: fact values can never outlive a document deletion request or consent
-- revocation, which moves the document to deletion_requested. The repository erasure path
-- runs first and adds the audit event; this trigger guarantees the redaction itself.
CREATE TRIGGER evidence_facts_redact_on_document_erasure
AFTER UPDATE OF lifecycle_state ON document_uploads
WHEN NEW.lifecycle_state IN ('deletion_requested', 'deleted')
  AND OLD.lifecycle_state NOT IN ('deletion_requested', 'deleted')
BEGIN
  UPDATE evidence_facts
  SET epistemic_state = 'unknown', value_json = NULL, source_page_id = NULL, source_locator = NULL,
      institutional_source_ref = NULL, calculation_method = NULL, permitted_viewers_json = NULL,
      effective_at = NULL,
      redacted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      redaction_reason_code = 'document_erasure'
  WHERE redacted_at IS NULL
    AND source_page_id IN (SELECT id FROM source_pages WHERE document_upload_id = NEW.id);
END;
