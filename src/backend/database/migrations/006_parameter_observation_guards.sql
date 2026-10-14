-- Expand-only guards on coverage parameter observations, required before observations are
-- written by the runtime or by reviewers. Existing rows are not touched.
--
--   * An observation can only be recorded from a document that is currently active. A
--     document moving to deletion_requested or deleted already redacts its observations
--     (migration 005); this stops new values from appearing after that point.
--   * A human_review observation is bound to a real review: a human_reviews row for the same
--     case (and, when the review names a run, the same run) that is in progress or completed,
--     whose reviewer is the adult recorded as the observation's author.

CREATE TRIGGER coverage_parameter_observations_active_document_insert
BEFORE INSERT ON coverage_parameter_observations
WHEN NOT EXISTS (
  SELECT 1 FROM document_uploads document
  WHERE document.id = NEW.document_id AND document.lifecycle_state = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'parameter observations require an active document');
END;

CREATE TRIGGER coverage_parameter_observations_human_review_insert
BEFORE INSERT ON coverage_parameter_observations
WHEN NEW.extraction_method = 'human_review' AND NOT EXISTS (
  SELECT 1
  FROM coverage_parameter_records parameter
  JOIN human_reviews review ON review.case_id = parameter.case_id
  WHERE parameter.id = NEW.parameter_record_id
    AND (review.workflow_run_id IS NULL OR review.workflow_run_id = parameter.workflow_run_id)
    AND review.status IN ('in_progress', 'completed')
    AND review.reviewer_adult_id IS NOT NULL
    AND review.reviewer_adult_id = NEW.recorded_by
)
BEGIN
  SELECT RAISE(ABORT, 'human review observations must be recorded by the assigned reviewer');
END;
