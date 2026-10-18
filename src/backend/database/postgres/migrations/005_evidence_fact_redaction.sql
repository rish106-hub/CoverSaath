-- Erasure path for evidence facts (S3.1 re-review P2-2). Expand-only. Mirrors SQLite migration 009.
-- Facts stay append-only except for one redaction update, as for parameter observations:
-- it erases the value and its locators, marks the fact UNKNOWN (the existing CHECKs require
-- that once the value is gone) and stamps redacted_at / redaction_reason_code. Every other
-- column must be unchanged. DELETE and TRUNCATE stay blocked (003).

ALTER TABLE public.evidence_facts ADD COLUMN redacted_at text;
ALTER TABLE public.evidence_facts ADD COLUMN redaction_reason_code text;
ALTER TABLE public.evidence_facts ADD CONSTRAINT evidence_facts_redaction_check CHECK (
  (redaction_reason_code IS NULL AND redacted_at IS NULL)
  OR (
    redaction_reason_code IS NOT NULL AND redacted_at IS NOT NULL
    AND redacted_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}.*Z$'
    AND length(redaction_reason_code) BETWEEN 1 AND 64
    AND NOT (redaction_reason_code ~ '[^a-z0-9_]')
  )
);

-- The view selects every fact column; PostgreSQL fixes the column list at creation.
CREATE OR REPLACE VIEW public.unresolved_evidence AS
SELECT * FROM public.evidence_facts WHERE epistemic_state IN ('unknown', 'conflict');

-- Same name, function and message as before; only the redaction update is exempt.
DROP TRIGGER evidence_facts_provenance_immutable ON public.evidence_facts;

CREATE TRIGGER evidence_facts_provenance_immutable
BEFORE UPDATE ON public.evidence_facts
FOR EACH ROW
WHEN (NOT (
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
  AND NEW.id IS NOT DISTINCT FROM OLD.id
  AND NEW.household_id IS NOT DISTINCT FROM OLD.household_id
  AND NEW.case_id IS NOT DISTINCT FROM OLD.case_id
  AND NEW.policy_id IS NOT DISTINCT FROM OLD.policy_id
  AND NEW.subject_member_id IS NOT DISTINCT FROM OLD.subject_member_id
  AND NEW.fact_key IS NOT DISTINCT FROM OLD.fact_key
  AND NEW.evidence_kind IS NOT DISTINCT FROM OLD.evidence_kind
  AND NEW.provenance_kind IS NOT DISTINCT FROM OLD.provenance_kind
  AND NEW.statement_adult_id IS NOT DISTINCT FROM OLD.statement_adult_id
  AND NEW.asserted_by IS NOT DISTINCT FROM OLD.asserted_by
  AND NEW.observed_at IS NOT DISTINCT FROM OLD.observed_at
  AND NEW.retrieved_at IS NOT DISTINCT FROM OLD.retrieved_at
  AND NEW.confidence_basis_points IS NOT DISTINCT FROM OLD.confidence_basis_points
  AND NEW.review_status IS NOT DISTINCT FROM OLD.review_status
  AND NEW.subject_confirmation_state IS NOT DISTINCT FROM OLD.subject_confirmation_state
  AND NEW.expires_at IS NOT DISTINCT FROM OLD.expires_at
  AND NEW.supersedes_fact_id IS NOT DISTINCT FROM OLD.supersedes_fact_id
  AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
))
EXECUTE FUNCTION public.evidence_facts_provenance_immutable_fn();

CREATE FUNCTION public.evidence_facts_redaction_insert_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'evidence facts cannot be inserted redacted';
END;
$$;

CREATE TRIGGER evidence_facts_redaction_insert
BEFORE INSERT ON public.evidence_facts
FOR EACH ROW
WHEN (NEW.redacted_at IS NOT NULL OR NEW.redaction_reason_code IS NOT NULL)
EXECUTE FUNCTION public.evidence_facts_redaction_insert_fn();

-- Safety net: fact values can never outlive a document deletion request or consent
-- revocation, which moves the document to deletion_requested. The repository erasure path
-- runs first and adds the audit event; this trigger guarantees the redaction itself.
CREATE FUNCTION public.evidence_facts_redact_on_document_erasure_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  UPDATE public.evidence_facts
  SET epistemic_state = 'unknown', value_json = NULL, source_page_id = NULL, source_locator = NULL,
      institutional_source_ref = NULL, calculation_method = NULL, permitted_viewers_json = NULL,
      effective_at = NULL,
      redacted_at = public.coversaath_utc_now(),
      redaction_reason_code = 'document_erasure'
  WHERE redacted_at IS NULL
    AND source_page_id IN (SELECT id FROM public.source_pages WHERE document_upload_id = NEW.id);
  RETURN NULL;
END;
$$;

CREATE TRIGGER evidence_facts_redact_on_document_erasure
AFTER UPDATE OF lifecycle_state ON public.document_uploads
FOR EACH ROW
WHEN (NEW.lifecycle_state IN ('deletion_requested', 'deleted')
  AND OLD.lifecycle_state NOT IN ('deletion_requested', 'deleted'))
EXECUTE FUNCTION public.evidence_facts_redact_on_document_erasure_fn();
