-- Hot-path indexes (run backend-ops). Expand-only and re-runnable. Both were measured with EXPLAIN ANALYZE on 200000
-- synthetic rows (see docs/exec-plans/active/backend-ops.md): the revoke path looked documents up by consent_grant_id alone,
-- which the existing (household_id, consent_grant_id, ...) index cannot serve (full index scan, 9.5 ms to 0.06 ms with the
-- new one); the consent list route filters (household_id, subject_adult_id) and orders by granted_at (1.3 ms to 0.2 ms).
CREATE INDEX IF NOT EXISTS document_uploads_consent_grant_idx ON public.document_uploads (consent_grant_id);
CREATE INDEX IF NOT EXISTS consent_grants_household_subject_idx ON public.consent_grants (household_id, subject_adult_id, granted_at DESC, id DESC);
