-- P1-4 (docs/architecture/db-schema-review.md): PostgreSQL does not index the referencing side of a foreign key. Erasure's
-- catalog-driven prune (#pruneOne), every parent delete and the case/household deletes by column scanned these tables
-- sequentially, under the household advisory lock. Index-only, expand-only, re-runnable; no data or constraint change.
-- Every table and column below was checked against the migrated schema. Each CREATE INDEX takes a SHARE lock on its table for
-- the build (writes wait); fine at synthetic volumes. A large production table needs CREATE INDEX CONCURRENTLY, which the
-- single-transaction runner cannot do (review P2-9). Partial indexes on nullable columns serve equality lookups.
-- evidence_facts also gets subject_member_id: the review's (household_id, subject_member_id) index leads with household_id and
-- cannot serve the subject_member_id foreign key by itself.
-- Left out (small today, index when an adult prune shows in a profile): consent_revocations, human_reviews, policy_answers,
-- profile_answers, catalogue_reviews, retention_records, household_places and curated_* adult references.
-- Rollback: DROP INDEX IF EXISTS for each name; nothing depends on them.
CREATE INDEX IF NOT EXISTS workflow_events_task_idx ON public.workflow_events (workflow_task_id) WHERE workflow_task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS reviewer_findings_task_idx ON public.reviewer_findings (workflow_task_id) WHERE workflow_task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS workflow_tasks_parent_idx ON public.workflow_tasks (parent_task_id) WHERE parent_task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS coverage_parameter_observations_source_idx ON public.coverage_parameter_observations (source_id);
CREATE INDEX IF NOT EXISTS proposed_parameters_source_page_idx ON public.proposed_parameters (source_page_id);
CREATE INDEX IF NOT EXISTS policy_members_source_page_idx ON public.policy_members (source_page_id) WHERE source_page_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS policies_source_document_idx ON public.policies (source_document_id) WHERE source_document_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS source_pages_blocks_upgrade_job_idx ON public.source_pages (blocks_upgrade_job_id) WHERE blocks_upgrade_job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS evidence_facts_household_idx ON public.evidence_facts (household_id, subject_member_id);
CREATE INDEX IF NOT EXISTS evidence_facts_subject_member_idx ON public.evidence_facts (subject_member_id);
CREATE INDEX IF NOT EXISTS integration_outbox_case_idx ON public.integration_outbox (case_id) WHERE case_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS human_approvals_case_idx ON public.human_approvals (case_id);
CREATE INDEX IF NOT EXISTS policy_structuring_jobs_grant_idx ON public.policy_structuring_jobs (consent_grant_id);
CREATE INDEX IF NOT EXISTS case_participants_grant_idx ON public.case_participants (consent_grant_id) WHERE consent_grant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS service_cases_opener_idx ON public.service_cases (opened_by_adult_id);
CREATE INDEX IF NOT EXISTS document_uploads_uploader_idx ON public.document_uploads (uploaded_by_adult_id);
CREATE INDEX IF NOT EXISTS household_members_adult_idx ON public.household_members (adult_user_id) WHERE adult_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS household_roles_adult_idx ON public.household_roles (adult_user_id);
CREATE INDEX IF NOT EXISTS app_events_case_idx ON public.app_events (case_id) WHERE case_id IS NOT NULL;
