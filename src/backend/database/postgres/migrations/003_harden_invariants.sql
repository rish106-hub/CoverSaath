-- Close PostgreSQL-only paths around the baseline consent, provenance and append-only guards.
-- The merged 001 and 002 baselines remain immutable.

-- Trigger functions must resolve project relations in public before pg_temp. PostgreSQL otherwise
-- searches a session's temporary schema first, which lets a same-named temporary table bypass a
-- guard. pg_catalog stays first for built-in functions and operators.
ALTER FUNCTION public.julianday(text) SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.coversaath_utc_now() SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.consent_revocations_mark_grant_fn() SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.integration_outbox_requires_active_consent_fn() SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.audit_events_append_only_fn() SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.workflow_task_dependencies_same_run_fn() SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.consent_grants_household_subject_fn() SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.consent_scopes_household_resource_insert_fn() SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.consent_scopes_resource_immutable_fn() SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.service_cases_household_refs_fn() SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.case_participants_household_refs_insert_fn() SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.case_participants_refs_immutable_fn() SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.document_uploads_household_refs_insert_fn() SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.document_uploads_quarantine_after_insert_fn() SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.document_uploads_household_refs_immutable_fn() SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.document_uploads_activation_guard_fn() SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.policies_household_source_insert_fn() SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.policies_household_source_immutable_fn() SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.policy_members_household_refs_insert_fn() SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.policy_members_refs_immutable_fn() SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.evidence_facts_household_refs_insert_fn() SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.coverage_graph_snapshots_household_case_insert_fn() SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.coverage_graph_snapshots_refs_immutable_fn() SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.evidence_facts_provenance_immutable_fn() SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.fact_conflicts_same_fact_insert_fn() SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.coverage_graph_nodes_snapshot_fact_insert_fn() SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.coverage_graph_edges_snapshot_nodes_insert_fn() SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.workflow_runs_household_consent_insert_fn() SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.workflow_runs_refs_immutable_fn() SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.consent_scopes_profile_viewer_fn() SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.ocr_jobs_document_ready_insert_fn() SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.source_pages_ocr_document_match_fn() SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.coverage_parameter_records_scope_insert_fn() SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.coverage_parameter_records_identity_immutable_fn() SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.coverage_parameter_observations_source_insert_fn() SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.coverage_parameter_observations_append_only_fn() SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.coverage_parameter_resolutions_observation_fn() SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.coverage_parameter_resolutions_authority_fn() SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.coverage_parameter_resolutions_model_no_downgrade_fn() SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.coverage_parameter_resolutions_not_permitted_exit_fn() SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.coverage_parameter_observations_redaction_resets_resolution_fn() SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.coverage_parameter_observations_redact_on_document_erasure_fn() SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.coverage_parameter_registry_pins_immutable_fn() SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.coverage_parameter_registry_versions_immutable_fn() SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.coverage_parameter_observation_rules_immutable_fn() SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.coverage_parameter_observations_active_document_insert_fn() SET search_path TO pg_catalog, public, pg_temp;
ALTER FUNCTION public.coverage_parameter_observations_human_review_insert_fn() SET search_path TO pg_catalog, public, pg_temp;

-- Row-level DELETE triggers do not run for TRUNCATE. Statement-level triggers preserve the same
-- error messages for the protected tables, including TRUNCATE ... CASCADE.
CREATE TRIGGER audit_events_no_truncate
BEFORE TRUNCATE ON public.audit_events
FOR EACH STATEMENT EXECUTE FUNCTION public.audit_events_append_only_fn();

CREATE TRIGGER evidence_facts_no_truncate
BEFORE TRUNCATE ON public.evidence_facts
FOR EACH STATEMENT EXECUTE FUNCTION public.evidence_facts_provenance_immutable_fn();

CREATE TRIGGER evidence_facts_no_delete
BEFORE DELETE ON public.evidence_facts
FOR EACH ROW EXECUTE FUNCTION public.evidence_facts_provenance_immutable_fn();

CREATE TRIGGER coverage_parameter_observations_no_truncate
BEFORE TRUNCATE ON public.coverage_parameter_observations
FOR EACH STATEMENT EXECUTE FUNCTION public.coverage_parameter_observations_append_only_fn();

CREATE TRIGGER coverage_parameter_registry_versions_no_truncate
BEFORE TRUNCATE ON public.coverage_parameter_registry_versions
FOR EACH STATEMENT EXECUTE FUNCTION public.coverage_parameter_registry_versions_immutable_fn();

CREATE TRIGGER coverage_parameter_registry_pins_no_truncate
BEFORE TRUNCATE ON public.coverage_parameter_registry_pins
FOR EACH STATEMENT EXECUTE FUNCTION public.coverage_parameter_registry_pins_immutable_fn();

CREATE TRIGGER coverage_parameter_registry_pins_no_delete
BEFORE DELETE ON public.coverage_parameter_registry_pins
FOR EACH ROW EXECUTE FUNCTION public.coverage_parameter_registry_pins_immutable_fn();

CREATE TRIGGER coverage_parameter_observation_rules_no_truncate
BEFORE TRUNCATE ON public.coverage_parameter_observation_rules
FOR EACH STATEMENT EXECUTE FUNCTION public.coverage_parameter_observation_rules_immutable_fn();

-- PUBLIC is not a runtime role. This removes the default temporary-schema privilege. A dedicated
-- least-privilege runtime role remains part of the S3.2 runtime work.
DO $$
BEGIN
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
END;
$$;

REVOKE TRUNCATE ON TABLE
  public.audit_events,
  public.evidence_facts,
  public.coverage_parameter_observations,
  public.coverage_parameter_registry_versions,
  public.coverage_parameter_registry_pins,
  public.coverage_parameter_observation_rules
FROM PUBLIC;
