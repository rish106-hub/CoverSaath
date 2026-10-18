-- Forward fix for 009 (review of PR #13). 009 is merged and immutable; these changes follow it.
-- 1. A fact cannot cite a page of a document whose erasure has started: the 009 safety net only
--    fires on the lifecycle transition, so a later insert would otherwise keep its value.
-- 2. Redaction timestamps must be exact ISO-8601 UTC with milliseconds (the 009 CHECK accepted
--    any suffix). SQLite cannot tighten a column CHECK in place, so a trigger enforces it.
-- 3. Backfill: redact facts of documents whose erasure started before 009 existed.

CREATE TRIGGER evidence_facts_erased_document_insert
BEFORE INSERT ON evidence_facts
WHEN NEW.source_page_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM source_pages page
  JOIN document_uploads document ON document.id = page.document_upload_id
  WHERE page.id = NEW.source_page_id AND document.lifecycle_state IN ('deletion_requested', 'deleted')
)
BEGIN
  SELECT RAISE(ABORT, 'evidence facts cannot cite an erased document');
END;

CREATE TRIGGER evidence_facts_redaction_format_update
BEFORE UPDATE OF redacted_at ON evidence_facts
WHEN NEW.redacted_at IS NOT NULL AND (
  NEW.redacted_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  OR julianday(NEW.redacted_at) IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'evidence fact redaction time must be ISO-8601 UTC with milliseconds');
END;

UPDATE evidence_facts
SET epistemic_state = 'unknown', value_json = NULL, source_page_id = NULL, source_locator = NULL,
    institutional_source_ref = NULL, calculation_method = NULL, permitted_viewers_json = NULL,
    effective_at = NULL,
    redacted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    redaction_reason_code = 'document_erasure'
WHERE redacted_at IS NULL
  AND source_page_id IN (
    SELECT page.id FROM source_pages page
    JOIN document_uploads document ON document.id = page.document_upload_id
    WHERE document.lifecycle_state IN ('deletion_requested', 'deleted')
  );
