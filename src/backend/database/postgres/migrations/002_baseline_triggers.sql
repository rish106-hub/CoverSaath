-- PostgreSQL baseline, part 2: trigger functions and triggers.
--
-- Reproduces every trigger of SQLite migrations 001-006 in its FINAL state, with the same trigger
-- name, timing, event (UPDATE OF column lists included), condition and message.
--
-- Deliberate dialect differences (ADR 0004, D5 and D6):
--   * CREATE TRIGGER ... WHEN (cond) BEGIN SELECT RAISE(ABORT, 'm'); END becomes a PL/pgSQL
--     function that does RAISE EXCEPTION 'm' (SQLSTATE P0001, the same message text).
--   * PostgreSQL forbids sub-queries in a trigger WHEN clause. A WHEN without a sub-query stays a
--     trigger WHEN. A WHEN with a sub-query moves into the function as IF <same condition>; a NULL
--     condition is false in both engines, so the semantics match.
--   * IS NOT / IS become IS DISTINCT FROM / IS NOT DISTINCT FROM. julianday() stays
--     julianday() (the PostgreSQL port from 001) and strftime(..., 'now') is coversaath_utc_now().
--   * Triggers on one table and event fire in alphabetical name order in PostgreSQL. SQLite leaves the
--     order unspecified. This only matters when two triggers would reject the same statement
--     with different messages.
--   * The trigger bodies read other rows without locking, as the SQLite versions do. SQLite's single
--     writer made that safe; row locking for claims, idempotency and revocation is added at the
--     repository layer in S3.2.

-- ---------------------------------------------------------------------------------------------
-- SQLite 001
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION consent_revocations_mark_grant_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE consent_grants SET revoked_at = NEW.revoked_at WHERE id = NEW.consent_grant_id;
  RETURN NULL;
END;
$$;

CREATE TRIGGER consent_revocations_mark_grant
AFTER INSERT ON consent_revocations
FOR EACH ROW EXECUTE FUNCTION consent_revocations_mark_grant_fn();

CREATE FUNCTION integration_outbox_requires_active_consent_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM consent_grants
    WHERE id = NEW.consent_grant_id
      AND (revoked_at IS NOT NULL OR (expires_at IS NOT NULL AND expires_at <= NEW.created_at))
  ) THEN
    RAISE EXCEPTION 'active consent is required for an integration action';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER integration_outbox_requires_active_consent
BEFORE INSERT ON integration_outbox
FOR EACH ROW EXECUTE FUNCTION integration_outbox_requires_active_consent_fn();

CREATE FUNCTION audit_events_append_only_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit events are append only';
END;
$$;

CREATE TRIGGER audit_events_no_update
BEFORE UPDATE ON audit_events
FOR EACH ROW EXECUTE FUNCTION audit_events_append_only_fn();

CREATE TRIGGER audit_events_no_delete
BEFORE DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION audit_events_append_only_fn();

-- ---------------------------------------------------------------------------------------------
-- SQLite 002
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION workflow_task_dependencies_same_run_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM workflow_tasks AS child
    JOIN workflow_tasks AS parent ON parent.id = NEW.depends_on_task_id
    WHERE child.id = NEW.workflow_task_id
      AND child.workflow_run_id = parent.workflow_run_id
  ) THEN
    RAISE EXCEPTION 'workflow dependency must belong to the same run';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER workflow_task_dependencies_same_run_insert
BEFORE INSERT ON workflow_task_dependencies
FOR EACH ROW EXECUTE FUNCTION workflow_task_dependencies_same_run_fn();

CREATE TRIGGER workflow_task_dependencies_same_run_update
BEFORE UPDATE ON workflow_task_dependencies
FOR EACH ROW EXECUTE FUNCTION workflow_task_dependencies_same_run_fn();

CREATE FUNCTION consent_grants_household_subject_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM household_members
    WHERE household_id = NEW.household_id AND adult_user_id = NEW.subject_adult_id
    UNION ALL
    SELECT 1 FROM household_roles
    WHERE household_id = NEW.household_id AND adult_user_id = NEW.subject_adult_id
  ) THEN
    RAISE EXCEPTION 'consent subject must belong to the household';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER consent_grants_household_subject_insert
BEFORE INSERT ON consent_grants
FOR EACH ROW EXECUTE FUNCTION consent_grants_household_subject_fn();

CREATE TRIGGER consent_grants_household_subject_update
BEFORE UPDATE OF household_id, subject_adult_id ON consent_grants
FOR EACH ROW EXECUTE FUNCTION consent_grants_household_subject_fn();

CREATE FUNCTION consent_scopes_household_resource_insert_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.resource_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM consent_grants AS cg
    WHERE cg.id = NEW.consent_grant_id
      AND (
        (NEW.resource_type = 'case' AND EXISTS (
          SELECT 1 FROM service_cases AS sc WHERE sc.id = NEW.resource_id AND sc.household_id = cg.household_id
        )) OR
        (NEW.resource_type = 'document' AND EXISTS (
          SELECT 1 FROM document_uploads AS du WHERE du.id = NEW.resource_id AND du.household_id = cg.household_id
        )) OR
        (NEW.resource_type = 'policy' AND EXISTS (
          SELECT 1 FROM policies AS p WHERE p.id = NEW.resource_id AND p.household_id = cg.household_id
        )) OR
        NEW.resource_type IN ('profile_field', 'voice_call', 'payment_order')
      )
  ) THEN
    RAISE EXCEPTION 'consent resource must belong to the grant household';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER consent_scopes_household_resource_insert
BEFORE INSERT ON consent_scopes
FOR EACH ROW EXECUTE FUNCTION consent_scopes_household_resource_insert_fn();

CREATE FUNCTION consent_scopes_resource_immutable_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'consent scope resource references are immutable';
END;
$$;

CREATE TRIGGER consent_scopes_resource_immutable
BEFORE UPDATE OF consent_grant_id, resource_type, resource_id ON consent_scopes
FOR EACH ROW
WHEN (NEW.consent_grant_id IS DISTINCT FROM OLD.consent_grant_id
  OR NEW.resource_type IS DISTINCT FROM OLD.resource_type
  OR NEW.resource_id IS DISTINCT FROM OLD.resource_id)
EXECUTE FUNCTION consent_scopes_resource_immutable_fn();

CREATE FUNCTION service_cases_household_refs_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF
    (NEW.subject_member_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM household_members WHERE id = NEW.subject_member_id AND household_id = NEW.household_id
    )) OR NOT EXISTS (
      SELECT 1 FROM household_members
      WHERE household_id = NEW.household_id AND adult_user_id = NEW.opened_by_adult_id
      UNION ALL
      SELECT 1 FROM household_roles
      WHERE household_id = NEW.household_id AND adult_user_id = NEW.opened_by_adult_id
    )
  THEN
    RAISE EXCEPTION 'case participants must belong to the household';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER service_cases_household_refs_insert
BEFORE INSERT ON service_cases
FOR EACH ROW EXECUTE FUNCTION service_cases_household_refs_fn();

CREATE TRIGGER service_cases_household_refs_update
BEFORE UPDATE OF household_id, subject_member_id, opened_by_adult_id ON service_cases
FOR EACH ROW EXECUTE FUNCTION service_cases_household_refs_fn();

CREATE FUNCTION case_participants_household_refs_insert_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM service_cases AS sc
    WHERE sc.id = NEW.case_id
      AND EXISTS (
        SELECT 1 FROM household_members AS hm WHERE hm.household_id = sc.household_id AND hm.adult_user_id = NEW.adult_user_id
        UNION ALL
        SELECT 1 FROM household_roles AS hr WHERE hr.household_id = sc.household_id AND hr.adult_user_id = NEW.adult_user_id
      )
      AND (NEW.consent_grant_id IS NULL OR EXISTS (
        SELECT 1 FROM consent_grants AS cg
        WHERE cg.id = NEW.consent_grant_id AND cg.household_id = sc.household_id AND cg.subject_adult_id = NEW.adult_user_id
      ))
  ) THEN
    RAISE EXCEPTION 'case participant must be household and consent scoped';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER case_participants_household_refs_insert
BEFORE INSERT ON case_participants
FOR EACH ROW EXECUTE FUNCTION case_participants_household_refs_insert_fn();

CREATE FUNCTION case_participants_refs_immutable_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'case participant references are immutable';
END;
$$;

CREATE TRIGGER case_participants_refs_immutable
BEFORE UPDATE OF case_id, adult_user_id, consent_grant_id ON case_participants
FOR EACH ROW
WHEN (NEW.case_id IS DISTINCT FROM OLD.case_id
  OR NEW.adult_user_id IS DISTINCT FROM OLD.adult_user_id
  OR NEW.consent_grant_id IS DISTINCT FROM OLD.consent_grant_id)
EXECUTE FUNCTION case_participants_refs_immutable_fn();

CREATE FUNCTION document_uploads_household_refs_insert_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM consent_grants AS cg
    WHERE cg.id = NEW.consent_grant_id
      AND cg.household_id = NEW.household_id
      AND cg.subject_adult_id = NEW.uploaded_by_adult_id
      AND cg.purpose = 'document_processing'
      AND cg.revoked_at IS NULL
      AND (cg.expires_at IS NULL OR julianday(cg.expires_at) > julianday(NEW.uploaded_at))
  ) OR (NEW.case_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM service_cases WHERE id = NEW.case_id AND household_id = NEW.household_id
  )) THEN
    RAISE EXCEPTION 'document must be household and active-consent scoped';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER document_uploads_household_refs_insert
BEFORE INSERT ON document_uploads
FOR EACH ROW EXECUTE FUNCTION document_uploads_household_refs_insert_fn();

CREATE FUNCTION document_uploads_quarantine_after_insert_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE document_uploads SET lifecycle_state = 'quarantined' WHERE id = NEW.id;
  RETURN NULL;
END;
$$;

CREATE TRIGGER document_uploads_quarantine_after_insert
AFTER INSERT ON document_uploads
FOR EACH ROW
WHEN (NEW.lifecycle_state = 'active'
  AND (NEW.malware_status = 'pending' OR NEW.encryption_status = 'required'))
EXECUTE FUNCTION document_uploads_quarantine_after_insert_fn();

CREATE FUNCTION document_uploads_household_refs_immutable_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'document household and consent references are immutable';
END;
$$;

CREATE TRIGGER document_uploads_household_refs_immutable
BEFORE UPDATE OF household_id, case_id, uploaded_by_adult_id, consent_grant_id ON document_uploads
FOR EACH ROW
WHEN (NEW.household_id IS DISTINCT FROM OLD.household_id
  OR NEW.case_id IS DISTINCT FROM OLD.case_id
  OR NEW.uploaded_by_adult_id IS DISTINCT FROM OLD.uploaded_by_adult_id
  OR NEW.consent_grant_id IS DISTINCT FROM OLD.consent_grant_id)
EXECUTE FUNCTION document_uploads_household_refs_immutable_fn();

CREATE FUNCTION document_uploads_activation_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'document cannot activate before validation and protected storage';
END;
$$;

CREATE TRIGGER document_uploads_activation_guard
BEFORE UPDATE OF lifecycle_state ON document_uploads
FOR EACH ROW
WHEN (NEW.lifecycle_state = 'active'
  AND NOT (
    NEW.malware_status IN ('clean', 'not_scanned_fixture')
    AND NEW.encryption_status IN ('encrypted_local', 'fixture_only')
  ))
EXECUTE FUNCTION document_uploads_activation_guard_fn();

CREATE FUNCTION policies_household_source_insert_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_document_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM document_uploads WHERE id = NEW.source_document_id AND household_id = NEW.household_id
  ) THEN
    RAISE EXCEPTION 'policy source document must belong to the household';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER policies_household_source_insert
BEFORE INSERT ON policies
FOR EACH ROW EXECUTE FUNCTION policies_household_source_insert_fn();

CREATE FUNCTION policies_household_source_immutable_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'policy household and source references are immutable';
END;
$$;

CREATE TRIGGER policies_household_source_immutable
BEFORE UPDATE OF household_id, source_document_id ON policies
FOR EACH ROW
WHEN (NEW.household_id IS DISTINCT FROM OLD.household_id OR NEW.source_document_id IS DISTINCT FROM OLD.source_document_id)
EXECUTE FUNCTION policies_household_source_immutable_fn();

CREATE FUNCTION policy_members_household_refs_insert_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM policies AS p
    JOIN household_members AS hm ON hm.id = NEW.household_member_id
    WHERE p.id = NEW.policy_id AND p.household_id = hm.household_id
      AND (NEW.source_page_id IS NULL OR EXISTS (
        SELECT 1 FROM source_pages AS sp
        JOIN document_uploads AS du ON du.id = sp.document_upload_id
        WHERE sp.id = NEW.source_page_id AND du.household_id = p.household_id
      ))
  ) THEN
    RAISE EXCEPTION 'policy member references must belong to the household';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER policy_members_household_refs_insert
BEFORE INSERT ON policy_members
FOR EACH ROW EXECUTE FUNCTION policy_members_household_refs_insert_fn();

CREATE FUNCTION policy_members_refs_immutable_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'policy member references are immutable';
END;
$$;

CREATE TRIGGER policy_members_refs_immutable
BEFORE UPDATE OF policy_id, household_member_id, source_page_id ON policy_members
FOR EACH ROW
WHEN (NEW.policy_id IS DISTINCT FROM OLD.policy_id
  OR NEW.household_member_id IS DISTINCT FROM OLD.household_member_id
  OR NEW.source_page_id IS DISTINCT FROM OLD.source_page_id)
EXECUTE FUNCTION policy_members_refs_immutable_fn();

CREATE FUNCTION evidence_facts_household_refs_insert_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF
    (NEW.case_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM service_cases WHERE id = NEW.case_id AND household_id = NEW.household_id)) OR
    (NEW.policy_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM policies WHERE id = NEW.policy_id AND household_id = NEW.household_id)) OR
    (NEW.subject_member_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM household_members WHERE id = NEW.subject_member_id AND household_id = NEW.household_id)) OR
    (NEW.source_page_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM source_pages AS sp JOIN document_uploads AS du ON du.id = sp.document_upload_id
      WHERE sp.id = NEW.source_page_id AND du.household_id = NEW.household_id
    )) OR
    (NEW.statement_adult_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM household_members WHERE household_id = NEW.household_id AND adult_user_id = NEW.statement_adult_id
      UNION ALL
      SELECT 1 FROM household_roles WHERE household_id = NEW.household_id AND adult_user_id = NEW.statement_adult_id
    )) OR
    (NEW.supersedes_fact_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM evidence_facts AS prior
      WHERE prior.id = NEW.supersedes_fact_id
        AND prior.household_id = NEW.household_id
        AND prior.fact_key = NEW.fact_key
    ))
  THEN
    RAISE EXCEPTION 'evidence references must belong to the household';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER evidence_facts_household_refs_insert
BEFORE INSERT ON evidence_facts
FOR EACH ROW EXECUTE FUNCTION evidence_facts_household_refs_insert_fn();

CREATE FUNCTION coverage_graph_snapshots_household_case_insert_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM service_cases
    WHERE id = NEW.case_id AND household_id = NEW.household_id
  ) THEN
    RAISE EXCEPTION 'coverage graph case must belong to the household';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER coverage_graph_snapshots_household_case_insert
BEFORE INSERT ON coverage_graph_snapshots
FOR EACH ROW EXECUTE FUNCTION coverage_graph_snapshots_household_case_insert_fn();

CREATE FUNCTION coverage_graph_snapshots_refs_immutable_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'coverage graph household references are immutable';
END;
$$;

CREATE TRIGGER coverage_graph_snapshots_refs_immutable
BEFORE UPDATE OF household_id, case_id ON coverage_graph_snapshots
FOR EACH ROW
WHEN (NEW.household_id IS DISTINCT FROM OLD.household_id OR NEW.case_id IS DISTINCT FROM OLD.case_id)
EXECUTE FUNCTION coverage_graph_snapshots_refs_immutable_fn();

CREATE FUNCTION evidence_facts_provenance_immutable_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'evidence facts are append only; add a superseding fact';
END;
$$;

CREATE TRIGGER evidence_facts_provenance_immutable
BEFORE UPDATE ON evidence_facts
FOR EACH ROW EXECUTE FUNCTION evidence_facts_provenance_immutable_fn();

CREATE FUNCTION fact_conflicts_same_fact_insert_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM evidence_facts AS left_fact
    JOIN evidence_facts AS right_fact ON right_fact.id = NEW.right_fact_id
    WHERE left_fact.id = NEW.left_fact_id
      AND left_fact.household_id = right_fact.household_id
      AND left_fact.fact_key = NEW.fact_key
      AND right_fact.fact_key = NEW.fact_key
  ) THEN
    RAISE EXCEPTION 'conflict facts must share a household and fact key';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER fact_conflicts_same_fact_insert
BEFORE INSERT ON fact_conflicts
FOR EACH ROW EXECUTE FUNCTION fact_conflicts_same_fact_insert_fn();

CREATE FUNCTION coverage_graph_nodes_snapshot_fact_insert_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_fact_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM coverage_graph_snapshots AS cgs
    JOIN evidence_facts AS ef ON ef.id = NEW.source_fact_id
    WHERE cgs.id = NEW.snapshot_id AND cgs.household_id = ef.household_id
  ) THEN
    RAISE EXCEPTION 'graph source fact must belong to the snapshot household';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER coverage_graph_nodes_snapshot_fact_insert
BEFORE INSERT ON coverage_graph_nodes
FOR EACH ROW EXECUTE FUNCTION coverage_graph_nodes_snapshot_fact_insert_fn();

CREATE FUNCTION coverage_graph_edges_snapshot_nodes_insert_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM coverage_graph_nodes AS source
    JOIN coverage_graph_nodes AS target ON target.id = NEW.to_node_id
    WHERE source.id = NEW.from_node_id
      AND source.snapshot_id = NEW.snapshot_id
      AND target.snapshot_id = NEW.snapshot_id
  ) OR (NEW.source_fact_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM coverage_graph_snapshots AS cgs
    JOIN evidence_facts AS ef ON ef.id = NEW.source_fact_id
    WHERE cgs.id = NEW.snapshot_id AND cgs.household_id = ef.household_id
  )) THEN
    RAISE EXCEPTION 'graph edge references must belong to the snapshot';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER coverage_graph_edges_snapshot_nodes_insert
BEFORE INSERT ON coverage_graph_edges
FOR EACH ROW EXECUTE FUNCTION coverage_graph_edges_snapshot_nodes_insert_fn();

CREATE FUNCTION workflow_runs_household_consent_insert_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.consent_grant_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM service_cases AS sc
    JOIN consent_grants AS cg ON cg.id = NEW.consent_grant_id
    WHERE sc.id = NEW.case_id AND sc.household_id = cg.household_id
  ) THEN
    RAISE EXCEPTION 'workflow consent must belong to the case household';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER workflow_runs_household_consent_insert
BEFORE INSERT ON workflow_runs
FOR EACH ROW EXECUTE FUNCTION workflow_runs_household_consent_insert_fn();

CREATE FUNCTION workflow_runs_refs_immutable_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'workflow case and consent references are immutable';
END;
$$;

CREATE TRIGGER workflow_runs_refs_immutable
BEFORE UPDATE OF case_id, case_revision, consent_grant_id ON workflow_runs
FOR EACH ROW
WHEN (NEW.case_id IS DISTINCT FROM OLD.case_id
  OR NEW.case_revision IS DISTINCT FROM OLD.case_revision
  OR NEW.consent_grant_id IS DISTINCT FROM OLD.consent_grant_id)
EXECUTE FUNCTION workflow_runs_refs_immutable_fn();

-- ---------------------------------------------------------------------------------------------
-- SQLite 003
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION consent_scopes_profile_viewer_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.resource_type = 'profile_field'
    AND NEW.recipient IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM consent_grants AS grant_record
      JOIN household_roles AS viewer_role
        ON viewer_role.household_id = grant_record.household_id
       AND viewer_role.adult_user_id = NEW.recipient
       AND viewer_role.status = 'active'
      WHERE grant_record.id = NEW.consent_grant_id
    )
  THEN
    RAISE EXCEPTION 'profile field recipient must be an active household viewer';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER consent_scopes_profile_viewer_insert
BEFORE INSERT ON consent_scopes
FOR EACH ROW EXECUTE FUNCTION consent_scopes_profile_viewer_fn();

CREATE TRIGGER consent_scopes_profile_viewer_update
BEFORE UPDATE OF consent_grant_id, resource_type, recipient ON consent_scopes
FOR EACH ROW EXECUTE FUNCTION consent_scopes_profile_viewer_fn();

-- ---------------------------------------------------------------------------------------------
-- SQLite 004
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION ocr_jobs_document_ready_insert_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM document_uploads AS document
    JOIN consent_grants AS consent ON consent.id = document.consent_grant_id
    WHERE document.id = NEW.document_upload_id
      AND document.lifecycle_state = 'active'
      AND document.malware_status IN ('clean', 'not_scanned_fixture')
      AND document.encryption_status IN ('encrypted_local', 'fixture_only')
      AND consent.purpose = 'document_processing'
      AND consent.revoked_at IS NULL
      AND (consent.expires_at IS NULL OR julianday(consent.expires_at) > julianday(NEW.requested_at))
  ) THEN
    RAISE EXCEPTION 'OCR requires an active protected document and current processing consent';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER ocr_jobs_document_ready_insert
BEFORE INSERT ON ocr_jobs
FOR EACH ROW EXECUTE FUNCTION ocr_jobs_document_ready_insert_fn();

CREATE FUNCTION source_pages_ocr_document_match_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.ocr_job_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM ocr_jobs AS job
    WHERE job.id = NEW.ocr_job_id AND job.document_upload_id = NEW.document_upload_id
  ) THEN
    RAISE EXCEPTION 'source page OCR job must belong to its document';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER source_pages_ocr_document_match_insert
BEFORE INSERT ON source_pages
FOR EACH ROW EXECUTE FUNCTION source_pages_ocr_document_match_fn();

CREATE TRIGGER source_pages_ocr_document_match_update
BEFORE UPDATE OF document_upload_id, ocr_job_id ON source_pages
FOR EACH ROW EXECUTE FUNCTION source_pages_ocr_document_match_fn();

-- ---------------------------------------------------------------------------------------------
-- SQLite 005
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION coverage_parameter_records_scope_insert_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM workflow_runs AS run
    JOIN service_cases AS service_case ON service_case.id = run.case_id
    WHERE run.id = NEW.workflow_run_id
      AND service_case.id = NEW.case_id
      AND service_case.household_id = NEW.household_id
      AND EXISTS (
        SELECT 1 FROM household_members AS member
        WHERE member.id = NEW.subject_id AND member.household_id = NEW.household_id
      )
      AND EXISTS (
        SELECT 1 FROM policies AS policy
        WHERE policy.id = NEW.policy_id AND policy.household_id = NEW.household_id
      )
  ) THEN
    RAISE EXCEPTION 'coverage parameter must match its workflow case and household';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER coverage_parameter_records_scope_insert
BEFORE INSERT ON coverage_parameter_records
FOR EACH ROW EXECUTE FUNCTION coverage_parameter_records_scope_insert_fn();

CREATE FUNCTION coverage_parameter_records_identity_immutable_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'coverage parameter identity is immutable';
END;
$$;

CREATE TRIGGER coverage_parameter_records_identity_immutable
BEFORE UPDATE OF workflow_run_id, registry_version, parameter_key, household_id, case_id,
  subject_id, policy_id ON coverage_parameter_records
FOR EACH ROW EXECUTE FUNCTION coverage_parameter_records_identity_immutable_fn();

CREATE FUNCTION coverage_parameter_observations_source_insert_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM coverage_parameter_records AS parameter
    JOIN source_pages AS page ON page.id = NEW.source_id
    JOIN document_uploads AS document ON document.id = page.document_upload_id
    WHERE parameter.id = NEW.parameter_record_id
      AND document.id = NEW.document_id
      AND document.household_id = parameter.household_id
      AND document.case_id = parameter.case_id
      AND page.source_version = NEW.version
      AND CAST(page.page_number AS text) = NEW.page
  ) THEN
    RAISE EXCEPTION 'parameter observation source must match its case and document page';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER coverage_parameter_observations_source_insert
BEFORE INSERT ON coverage_parameter_observations
FOR EACH ROW EXECUTE FUNCTION coverage_parameter_observations_source_insert_fn();

-- Observations are append-only. The single permitted update is redaction.
CREATE FUNCTION coverage_parameter_observations_append_only_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'coverage parameter observations are append only';
END;
$$;

CREATE TRIGGER coverage_parameter_observations_no_update
BEFORE UPDATE ON coverage_parameter_observations
FOR EACH ROW
WHEN (NOT (
  OLD.redacted_at IS NULL
  AND NEW.redacted_at IS NOT NULL
  AND NEW.value_json IS NULL
  AND NEW.redaction_reason_code IS NOT NULL
  AND NEW.id IS NOT DISTINCT FROM OLD.id
  AND NEW.parameter_record_id IS NOT DISTINCT FROM OLD.parameter_record_id
  AND NEW.source_id IS NOT DISTINCT FROM OLD.source_id
  AND NEW.document_id IS NOT DISTINCT FROM OLD.document_id
  AND NEW.version IS NOT DISTINCT FROM OLD.version
  AND NEW.page IS NOT DISTINCT FROM OLD.page
  AND NEW.extraction_method IS NOT DISTINCT FROM OLD.extraction_method
  AND NEW.review_status IS NOT DISTINCT FROM OLD.review_status
  AND NEW.source_digest IS NOT DISTINCT FROM OLD.source_digest
  AND NEW.observed_at IS NOT DISTINCT FROM OLD.observed_at
  AND NEW.recorded_by IS NOT DISTINCT FROM OLD.recorded_by
  AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
))
EXECUTE FUNCTION coverage_parameter_observations_append_only_fn();

CREATE TRIGGER coverage_parameter_observations_no_delete
BEFORE DELETE ON coverage_parameter_observations
FOR EACH ROW EXECUTE FUNCTION coverage_parameter_observations_append_only_fn();

CREATE FUNCTION coverage_parameter_resolutions_observation_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.resolved_observation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM coverage_parameter_observations AS observation
    WHERE observation.id = NEW.resolved_observation_id
      AND observation.parameter_record_id = NEW.parameter_record_id
  ) THEN
    RAISE EXCEPTION 'resolved observation must belong to the parameter';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER coverage_parameter_resolutions_observation_insert
BEFORE INSERT ON coverage_parameter_resolutions
FOR EACH ROW EXECUTE FUNCTION coverage_parameter_resolutions_observation_fn();

CREATE TRIGGER coverage_parameter_resolutions_observation_update
BEFORE UPDATE OF parameter_record_id, resolved_observation_id ON coverage_parameter_resolutions
FOR EACH ROW EXECUTE FUNCTION coverage_parameter_resolutions_observation_fn();

-- Authority is derived from the selected observation, never from the caller.
CREATE FUNCTION coverage_parameter_resolutions_authority_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.resolved_observation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM coverage_parameter_observations AS observation
    JOIN coverage_parameter_observation_rules AS rule
      ON rule.extraction_method = observation.extraction_method
    WHERE observation.id = NEW.resolved_observation_id
      AND observation.redacted_at IS NULL
      AND observation.review_status IN ('not_reviewed', 'accepted')
      AND rule.resolution_state = NEW.resolution_state
      AND rule.transition_authority = NEW.transition_authority
      AND (rule.requires_accepted = 0 OR observation.review_status = 'accepted')
  ) THEN
    RAISE EXCEPTION 'resolution state and authority are not supported by the observation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER coverage_parameter_resolutions_authority_insert
BEFORE INSERT ON coverage_parameter_resolutions
FOR EACH ROW EXECUTE FUNCTION coverage_parameter_resolutions_authority_fn();

CREATE TRIGGER coverage_parameter_resolutions_authority_update
BEFORE UPDATE ON coverage_parameter_resolutions
FOR EACH ROW EXECUTE FUNCTION coverage_parameter_resolutions_authority_fn();

CREATE FUNCTION coverage_parameter_resolutions_model_no_downgrade_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'model authority cannot replace an established resolution';
END;
$$;

CREATE TRIGGER coverage_parameter_resolutions_model_no_downgrade
BEFORE UPDATE ON coverage_parameter_resolutions
FOR EACH ROW
WHEN (NEW.transition_authority = 'model'
  AND OLD.resolution_state IN ('proven', 'calculated', 'dynamic', 'not_permitted'))
EXECUTE FUNCTION coverage_parameter_resolutions_model_no_downgrade_fn();

CREATE FUNCTION coverage_parameter_resolutions_not_permitted_exit_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'not_permitted can only return to unknown';
END;
$$;

CREATE TRIGGER coverage_parameter_resolutions_not_permitted_exit
BEFORE UPDATE OF resolution_state ON coverage_parameter_resolutions
FOR EACH ROW
WHEN (OLD.resolution_state = 'not_permitted'
  AND NEW.resolution_state NOT IN ('not_permitted', 'unknown'))
EXECUTE FUNCTION coverage_parameter_resolutions_not_permitted_exit_fn();

-- Redacting an observation withdraws any resolution that relied on it, and any conflict built from it.
CREATE FUNCTION coverage_parameter_observations_redaction_resets_resolution_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE coverage_parameter_resolutions
  SET resolution_state = 'unknown',
      resolved_value_json = NULL,
      resolved_observation_id = NULL,
      reason_code = 'source_redacted',
      transition_authority = 'deterministic',
      updated_by = 'privacy-redaction',
      updated_at = NEW.redacted_at
  WHERE parameter_record_id = NEW.parameter_record_id
    AND (resolved_observation_id = NEW.id OR resolution_state = 'conflicting');
  RETURN NULL;
END;
$$;

CREATE TRIGGER coverage_parameter_observations_redaction_resets_resolution
AFTER UPDATE OF redacted_at ON coverage_parameter_observations
FOR EACH ROW
WHEN (OLD.redacted_at IS NULL AND NEW.redacted_at IS NOT NULL)
EXECUTE FUNCTION coverage_parameter_observations_redaction_resets_resolution_fn();

-- Safety net: values can never outlive a document deletion request or consent revocation.
CREATE FUNCTION coverage_parameter_observations_redact_on_document_erasure_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE coverage_parameter_observations
  SET value_json = NULL,
      redacted_at = coversaath_utc_now(),
      redaction_reason_code = 'document_erasure'
  WHERE document_id = NEW.id AND redacted_at IS NULL;
  RETURN NULL;
END;
$$;

CREATE TRIGGER coverage_parameter_observations_redact_on_document_erasure
AFTER UPDATE OF lifecycle_state ON document_uploads
FOR EACH ROW
WHEN (NEW.lifecycle_state IN ('deletion_requested', 'deleted')
  AND OLD.lifecycle_state NOT IN ('deletion_requested', 'deleted'))
EXECUTE FUNCTION coverage_parameter_observations_redact_on_document_erasure_fn();

-- Pins, registry metadata and observation rules are immutable once written.
CREATE FUNCTION coverage_parameter_registry_pins_immutable_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'registry pins are immutable';
END;
$$;

CREATE TRIGGER coverage_parameter_registry_pins_immutable
BEFORE UPDATE ON coverage_parameter_registry_pins
FOR EACH ROW EXECUTE FUNCTION coverage_parameter_registry_pins_immutable_fn();

CREATE FUNCTION coverage_parameter_registry_versions_immutable_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'registry versions are immutable';
END;
$$;

CREATE TRIGGER coverage_parameter_registry_versions_immutable
BEFORE UPDATE ON coverage_parameter_registry_versions
FOR EACH ROW EXECUTE FUNCTION coverage_parameter_registry_versions_immutable_fn();

CREATE TRIGGER coverage_parameter_registry_versions_no_delete
BEFORE DELETE ON coverage_parameter_registry_versions
FOR EACH ROW EXECUTE FUNCTION coverage_parameter_registry_versions_immutable_fn();

CREATE FUNCTION coverage_parameter_observation_rules_immutable_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'observation rules are immutable';
END;
$$;

CREATE TRIGGER coverage_parameter_observation_rules_immutable
BEFORE UPDATE ON coverage_parameter_observation_rules
FOR EACH ROW EXECUTE FUNCTION coverage_parameter_observation_rules_immutable_fn();

CREATE TRIGGER coverage_parameter_observation_rules_no_delete
BEFORE DELETE ON coverage_parameter_observation_rules
FOR EACH ROW EXECUTE FUNCTION coverage_parameter_observation_rules_immutable_fn();

-- ---------------------------------------------------------------------------------------------
-- SQLite 006
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION coverage_parameter_observations_active_document_insert_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM document_uploads AS document
    WHERE document.id = NEW.document_id AND document.lifecycle_state = 'active'
  ) THEN
    RAISE EXCEPTION 'parameter observations require an active document';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER coverage_parameter_observations_active_document_insert
BEFORE INSERT ON coverage_parameter_observations
FOR EACH ROW EXECUTE FUNCTION coverage_parameter_observations_active_document_insert_fn();

CREATE FUNCTION coverage_parameter_observations_human_review_insert_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.extraction_method = 'human_review' AND NOT EXISTS (
    SELECT 1
    FROM coverage_parameter_records AS parameter
    JOIN human_reviews AS review ON review.case_id = parameter.case_id
    WHERE parameter.id = NEW.parameter_record_id
      AND (review.workflow_run_id IS NULL OR review.workflow_run_id = parameter.workflow_run_id)
      AND review.status IN ('in_progress', 'completed')
      AND review.reviewer_adult_id IS NOT NULL
      AND review.reviewer_adult_id = NEW.recorded_by
  ) THEN
    RAISE EXCEPTION 'human review observations must be recorded by the assigned reviewer';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER coverage_parameter_observations_human_review_insert
BEFORE INSERT ON coverage_parameter_observations
FOR EACH ROW EXECUTE FUNCTION coverage_parameter_observations_human_review_insert_fn();
