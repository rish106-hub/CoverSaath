-- Coversaath v2 database integrity and provenance foundation.
-- 001 is immutable. This migration preserves its data while adding the
-- relational contracts needed by consented, recoverable processing.

ALTER TABLE workflow_runs ADD COLUMN case_revision TEXT;
ALTER TABLE workflow_runs ADD COLUMN consent_grant_id TEXT REFERENCES consent_grants(id);
ALTER TABLE workflow_runs ADD COLUMN input_json TEXT CHECK (input_json IS NULL OR json_valid(input_json));
ALTER TABLE workflow_runs ADD COLUMN terminal_reason TEXT;

ALTER TABLE workflow_tasks ADD COLUMN input_json TEXT CHECK (input_json IS NULL OR json_valid(input_json));
ALTER TABLE workflow_tasks ADD COLUMN output_json TEXT CHECK (output_json IS NULL OR json_valid(output_json));
ALTER TABLE workflow_tasks ADD COLUMN lease_owner TEXT;
ALTER TABLE workflow_tasks ADD COLUMN lease_expires_at TEXT;
ALTER TABLE workflow_tasks ADD COLUMN retry_available_at TEXT;
ALTER TABLE workflow_tasks ADD COLUMN last_error_code TEXT;
ALTER TABLE workflow_tasks ADD COLUMN last_error_message TEXT;
ALTER TABLE workflow_tasks ADD COLUMN terminal_reason TEXT;

CREATE TABLE workflow_task_dependencies (
  workflow_task_id TEXT NOT NULL REFERENCES workflow_tasks(id),
  depends_on_task_id TEXT NOT NULL REFERENCES workflow_tasks(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workflow_task_id, depends_on_task_id),
  CHECK (workflow_task_id <> depends_on_task_id)
) STRICT, WITHOUT ROWID;

CREATE TRIGGER workflow_task_dependencies_same_run_insert
BEFORE INSERT ON workflow_task_dependencies
WHEN NOT EXISTS (
  SELECT 1
  FROM workflow_tasks child
  JOIN workflow_tasks parent ON parent.id = NEW.depends_on_task_id
  WHERE child.id = NEW.workflow_task_id
    AND child.workflow_run_id = parent.workflow_run_id
)
BEGIN
  SELECT RAISE(ABORT, 'workflow dependency must belong to the same run');
END;

CREATE TRIGGER workflow_task_dependencies_same_run_update
BEFORE UPDATE ON workflow_task_dependencies
WHEN NOT EXISTS (
  SELECT 1
  FROM workflow_tasks child
  JOIN workflow_tasks parent ON parent.id = NEW.depends_on_task_id
  WHERE child.id = NEW.workflow_task_id
    AND child.workflow_run_id = parent.workflow_run_id
)
BEGIN
  SELECT RAISE(ABORT, 'workflow dependency must belong to the same run');
END;

-- Rebuild the evidence ledger because v1 required a document page for every
-- known value. That made known statements, institutional replies and
-- calculations impossible to represent honestly.
CREATE TABLE evidence_facts_v2 (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  case_id TEXT REFERENCES service_cases(id),
  policy_id TEXT REFERENCES policies(id),
  subject_member_id TEXT REFERENCES household_members(id),
  fact_key TEXT NOT NULL,
  value_json TEXT CHECK (value_json IS NULL OR json_valid(value_json)),
  epistemic_state TEXT NOT NULL CHECK (epistemic_state IN ('known', 'unknown', 'conflict')),
  evidence_kind TEXT NOT NULL CHECK (evidence_kind IN ('document', 'adult_statement', 'institutional_reply', 'calculation', 'fixture')),
  provenance_kind TEXT NOT NULL CHECK (provenance_kind IN ('document_page', 'adult_statement', 'proxy_statement', 'institutional_reply', 'calculation', 'fixture')),
  source_page_id TEXT REFERENCES source_pages(id),
  statement_adult_id TEXT REFERENCES adult_users(id),
  institutional_source_ref TEXT,
  calculation_method TEXT,
  source_locator TEXT,
  asserted_by TEXT NOT NULL,
  effective_at TEXT,
  observed_at TEXT NOT NULL,
  retrieved_at TEXT,
  confidence_basis_points INTEGER CHECK (confidence_basis_points IS NULL OR confidence_basis_points BETWEEN 0 AND 10000),
  review_status TEXT NOT NULL DEFAULT 'unreviewed' CHECK (review_status IN ('unreviewed', 'reviewed', 'rejected')),
  subject_confirmation_state TEXT NOT NULL DEFAULT 'not_applicable' CHECK (subject_confirmation_state IN ('not_applicable', 'unconfirmed', 'confirmed', 'rejected')),
  permitted_viewers_json TEXT CHECK (permitted_viewers_json IS NULL OR json_valid(permitted_viewers_json)),
  expires_at TEXT,
  supersedes_fact_id TEXT REFERENCES evidence_facts_v2(id),
  created_at TEXT NOT NULL,
  CHECK (
    (epistemic_state = 'unknown' AND value_json IS NULL) OR
    (epistemic_state IN ('known', 'conflict') AND value_json IS NOT NULL)
  ),
  CHECK (epistemic_state = 'unknown' OR provenance_kind <> 'document_page' OR source_page_id IS NOT NULL),
  CHECK (epistemic_state = 'unknown' OR provenance_kind NOT IN ('adult_statement', 'proxy_statement') OR statement_adult_id IS NOT NULL),
  CHECK (epistemic_state = 'unknown' OR provenance_kind <> 'institutional_reply' OR institutional_source_ref IS NOT NULL),
  CHECK (epistemic_state = 'unknown' OR provenance_kind <> 'calculation' OR calculation_method IS NOT NULL),
  CHECK (provenance_kind <> 'proxy_statement' OR subject_confirmation_state <> 'not_applicable')
) STRICT;

INSERT INTO evidence_facts_v2 (
  id, household_id, case_id, policy_id, subject_member_id, fact_key, value_json,
  epistemic_state, evidence_kind, provenance_kind, source_page_id, source_locator,
  asserted_by, observed_at, supersedes_fact_id, created_at
)
SELECT id, household_id, case_id, policy_id, subject_member_id, fact_key, value_json,
  epistemic_state, evidence_kind,
  CASE evidence_kind
    WHEN 'document' THEN 'document_page'
    WHEN 'adult_statement' THEN 'adult_statement'
    WHEN 'institutional_reply' THEN 'institutional_reply'
    WHEN 'calculation' THEN 'calculation'
    ELSE 'fixture'
  END,
  source_page_id, source_locator, asserted_by, observed_at, supersedes_fact_id, created_at
FROM evidence_facts;

CREATE TABLE fact_conflicts_v2 (
  id TEXT PRIMARY KEY,
  fact_key TEXT NOT NULL,
  left_fact_id TEXT NOT NULL REFERENCES evidence_facts_v2(id),
  right_fact_id TEXT NOT NULL REFERENCES evidence_facts_v2(id),
  resolution_state TEXT NOT NULL DEFAULT 'open' CHECK (resolution_state IN ('open', 'resolved', 'accepted_unknown')),
  resolved_by_review_id TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  CHECK (left_fact_id <> right_fact_id)
) STRICT;

INSERT INTO fact_conflicts_v2 SELECT * FROM fact_conflicts;

CREATE TABLE coverage_graph_nodes_v2 (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL REFERENCES coverage_graph_snapshots(id),
  node_type TEXT NOT NULL CHECK (node_type IN ('household_member', 'policy', 'protection', 'constraint', 'institution', 'unknown')),
  entity_ref TEXT,
  label TEXT NOT NULL,
  epistemic_state TEXT NOT NULL CHECK (epistemic_state IN ('known', 'unknown', 'conflict')),
  source_fact_id TEXT REFERENCES evidence_facts_v2(id),
  created_at TEXT NOT NULL,
  UNIQUE (snapshot_id, id)
) STRICT;

INSERT INTO coverage_graph_nodes_v2 SELECT * FROM coverage_graph_nodes;

CREATE TABLE coverage_graph_edges_v2 (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL REFERENCES coverage_graph_snapshots(id),
  from_node_id TEXT NOT NULL REFERENCES coverage_graph_nodes_v2(id),
  to_node_id TEXT NOT NULL REFERENCES coverage_graph_nodes_v2(id),
  relationship TEXT NOT NULL,
  source_fact_id TEXT REFERENCES evidence_facts_v2(id),
  created_at TEXT NOT NULL,
  CHECK (from_node_id <> to_node_id)
) STRICT;

INSERT INTO coverage_graph_edges_v2 SELECT * FROM coverage_graph_edges;

DROP VIEW unresolved_evidence;
DROP TABLE coverage_graph_edges;
DROP TABLE coverage_graph_nodes;
DROP TABLE fact_conflicts;
DROP TABLE evidence_facts;

ALTER TABLE evidence_facts_v2 RENAME TO evidence_facts;
ALTER TABLE fact_conflicts_v2 RENAME TO fact_conflicts;
ALTER TABLE coverage_graph_nodes_v2 RENAME TO coverage_graph_nodes;
ALTER TABLE coverage_graph_edges_v2 RENAME TO coverage_graph_edges;

CREATE VIEW unresolved_evidence AS
SELECT * FROM evidence_facts WHERE epistemic_state IN ('unknown', 'conflict');

-- Abort rather than silently carrying forward v1 rows that violate the new
-- household boundary. Valid v1 databases insert no guard row.
CREATE TABLE migration_002_integrity_guard (
  valid INTEGER NOT NULL CHECK (valid = 1)
) STRICT;

INSERT INTO migration_002_integrity_guard(valid)
SELECT 0 WHERE EXISTS (
  SELECT 1 FROM consent_grants cg
  WHERE NOT EXISTS (
    SELECT 1 FROM household_members hm WHERE hm.household_id = cg.household_id AND hm.adult_user_id = cg.subject_adult_id
    UNION ALL
    SELECT 1 FROM household_roles hr WHERE hr.household_id = cg.household_id AND hr.adult_user_id = cg.subject_adult_id
  )
  UNION ALL
  SELECT 1 FROM service_cases sc
  WHERE (sc.subject_member_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM household_members hm WHERE hm.id = sc.subject_member_id AND hm.household_id = sc.household_id
  )) OR NOT EXISTS (
    SELECT 1 FROM household_members hm WHERE hm.household_id = sc.household_id AND hm.adult_user_id = sc.opened_by_adult_id
    UNION ALL
    SELECT 1 FROM household_roles hr WHERE hr.household_id = sc.household_id AND hr.adult_user_id = sc.opened_by_adult_id
  )
  UNION ALL
  SELECT 1 FROM policies p
  WHERE p.source_document_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM document_uploads du WHERE du.id = p.source_document_id AND du.household_id = p.household_id
  )
  UNION ALL
  SELECT 1 FROM policy_members pm
  JOIN policies p ON p.id = pm.policy_id
  JOIN household_members hm ON hm.id = pm.household_member_id
  WHERE p.household_id <> hm.household_id
  UNION ALL
  SELECT 1 FROM evidence_facts ef
  WHERE (ef.case_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM service_cases sc WHERE sc.id = ef.case_id AND sc.household_id = ef.household_id
  )) OR (ef.policy_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM policies p WHERE p.id = ef.policy_id AND p.household_id = ef.household_id
  )) OR (ef.subject_member_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM household_members hm WHERE hm.id = ef.subject_member_id AND hm.household_id = ef.household_id
  )) OR (ef.source_page_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM source_pages sp JOIN document_uploads du ON du.id = sp.document_upload_id
    WHERE sp.id = ef.source_page_id AND du.household_id = ef.household_id
  ))
  UNION ALL
  SELECT 1 FROM document_uploads du
  WHERE NOT EXISTS (
    SELECT 1 FROM consent_grants cg
    WHERE cg.id = du.consent_grant_id
      AND cg.household_id = du.household_id
      AND cg.subject_adult_id = du.uploaded_by_adult_id
      AND cg.purpose = 'document_processing'
  ) OR (du.case_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM service_cases sc WHERE sc.id = du.case_id AND sc.household_id = du.household_id
  ))
  UNION ALL
  SELECT 1 FROM case_participants cp
  JOIN service_cases sc ON sc.id = cp.case_id
  WHERE NOT EXISTS (
    SELECT 1 FROM household_members hm WHERE hm.household_id = sc.household_id AND hm.adult_user_id = cp.adult_user_id
    UNION ALL
    SELECT 1 FROM household_roles hr WHERE hr.household_id = sc.household_id AND hr.adult_user_id = cp.adult_user_id
  )
  UNION ALL
  SELECT 1 FROM coverage_graph_snapshots cgs
  WHERE NOT EXISTS (
    SELECT 1 FROM service_cases sc WHERE sc.id = cgs.case_id AND sc.household_id = cgs.household_id
  )
);

DROP TABLE migration_002_integrity_guard;

-- Core household-boundary guards. SQLite cannot express these multi-table
-- relationships as ordinary foreign keys without replacing every v1 key.
CREATE TRIGGER consent_grants_household_subject_insert
BEFORE INSERT ON consent_grants
WHEN NOT EXISTS (
  SELECT 1 FROM household_members
  WHERE household_id = NEW.household_id AND adult_user_id = NEW.subject_adult_id
  UNION ALL
  SELECT 1 FROM household_roles
  WHERE household_id = NEW.household_id AND adult_user_id = NEW.subject_adult_id
)
BEGIN
  SELECT RAISE(ABORT, 'consent subject must belong to the household');
END;

CREATE TRIGGER consent_grants_household_subject_update
BEFORE UPDATE OF household_id, subject_adult_id ON consent_grants
WHEN NOT EXISTS (
  SELECT 1 FROM household_members
  WHERE household_id = NEW.household_id AND adult_user_id = NEW.subject_adult_id
  UNION ALL
  SELECT 1 FROM household_roles
  WHERE household_id = NEW.household_id AND adult_user_id = NEW.subject_adult_id
)
BEGIN
  SELECT RAISE(ABORT, 'consent subject must belong to the household');
END;

CREATE TRIGGER consent_scopes_household_resource_insert
BEFORE INSERT ON consent_scopes
WHEN NEW.resource_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM consent_grants cg
  WHERE cg.id = NEW.consent_grant_id
    AND (
      (NEW.resource_type = 'case' AND EXISTS (
        SELECT 1 FROM service_cases sc WHERE sc.id = NEW.resource_id AND sc.household_id = cg.household_id
      )) OR
      (NEW.resource_type = 'document' AND EXISTS (
        SELECT 1 FROM document_uploads du WHERE du.id = NEW.resource_id AND du.household_id = cg.household_id
      )) OR
      (NEW.resource_type = 'policy' AND EXISTS (
        SELECT 1 FROM policies p WHERE p.id = NEW.resource_id AND p.household_id = cg.household_id
      )) OR
      NEW.resource_type IN ('profile_field', 'voice_call', 'payment_order')
    )
)
BEGIN
  SELECT RAISE(ABORT, 'consent resource must belong to the grant household');
END;

CREATE TRIGGER consent_scopes_resource_immutable
BEFORE UPDATE OF consent_grant_id, resource_type, resource_id ON consent_scopes
WHEN NEW.consent_grant_id IS NOT OLD.consent_grant_id
  OR NEW.resource_type IS NOT OLD.resource_type
  OR NEW.resource_id IS NOT OLD.resource_id
BEGIN
  SELECT RAISE(ABORT, 'consent scope resource references are immutable');
END;

CREATE TRIGGER service_cases_household_refs_insert
BEFORE INSERT ON service_cases
WHEN
  (NEW.subject_member_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM household_members WHERE id = NEW.subject_member_id AND household_id = NEW.household_id
  )) OR NOT EXISTS (
    SELECT 1 FROM household_members
    WHERE household_id = NEW.household_id AND adult_user_id = NEW.opened_by_adult_id
    UNION ALL
    SELECT 1 FROM household_roles
    WHERE household_id = NEW.household_id AND adult_user_id = NEW.opened_by_adult_id
  )
BEGIN
  SELECT RAISE(ABORT, 'case participants must belong to the household');
END;

CREATE TRIGGER service_cases_household_refs_update
BEFORE UPDATE OF household_id, subject_member_id, opened_by_adult_id ON service_cases
WHEN
  (NEW.subject_member_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM household_members WHERE id = NEW.subject_member_id AND household_id = NEW.household_id
  )) OR NOT EXISTS (
    SELECT 1 FROM household_members
    WHERE household_id = NEW.household_id AND adult_user_id = NEW.opened_by_adult_id
    UNION ALL
    SELECT 1 FROM household_roles
    WHERE household_id = NEW.household_id AND adult_user_id = NEW.opened_by_adult_id
  )
BEGIN
  SELECT RAISE(ABORT, 'case participants must belong to the household');
END;

CREATE TRIGGER case_participants_household_refs_insert
BEFORE INSERT ON case_participants
WHEN NOT EXISTS (
  SELECT 1 FROM service_cases sc
  WHERE sc.id = NEW.case_id
    AND EXISTS (
      SELECT 1 FROM household_members hm WHERE hm.household_id = sc.household_id AND hm.adult_user_id = NEW.adult_user_id
      UNION ALL
      SELECT 1 FROM household_roles hr WHERE hr.household_id = sc.household_id AND hr.adult_user_id = NEW.adult_user_id
    )
    AND (NEW.consent_grant_id IS NULL OR EXISTS (
      SELECT 1 FROM consent_grants cg
      WHERE cg.id = NEW.consent_grant_id AND cg.household_id = sc.household_id AND cg.subject_adult_id = NEW.adult_user_id
    ))
)
BEGIN
  SELECT RAISE(ABORT, 'case participant must be household and consent scoped');
END;

CREATE TRIGGER case_participants_refs_immutable
BEFORE UPDATE OF case_id, adult_user_id, consent_grant_id ON case_participants
WHEN NEW.case_id IS NOT OLD.case_id
  OR NEW.adult_user_id IS NOT OLD.adult_user_id
  OR NEW.consent_grant_id IS NOT OLD.consent_grant_id
BEGIN
  SELECT RAISE(ABORT, 'case participant references are immutable');
END;

CREATE TRIGGER document_uploads_household_refs_insert
BEFORE INSERT ON document_uploads
WHEN NOT EXISTS (
  SELECT 1 FROM consent_grants cg
  WHERE cg.id = NEW.consent_grant_id
    AND cg.household_id = NEW.household_id
    AND cg.subject_adult_id = NEW.uploaded_by_adult_id
    AND cg.purpose = 'document_processing'
    AND cg.revoked_at IS NULL
    AND (cg.expires_at IS NULL OR julianday(cg.expires_at) > julianday(NEW.uploaded_at))
) OR (NEW.case_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM service_cases WHERE id = NEW.case_id AND household_id = NEW.household_id
))
BEGIN
  SELECT RAISE(ABORT, 'document must be household and active-consent scoped');
END;

CREATE TRIGGER document_uploads_quarantine_after_insert
AFTER INSERT ON document_uploads
WHEN NEW.lifecycle_state = 'active'
  AND (NEW.malware_status = 'pending' OR NEW.encryption_status = 'required')
BEGIN
  UPDATE document_uploads SET lifecycle_state = 'quarantined' WHERE id = NEW.id;
END;

CREATE TRIGGER document_uploads_household_refs_immutable
BEFORE UPDATE OF household_id, case_id, uploaded_by_adult_id, consent_grant_id ON document_uploads
WHEN NEW.household_id IS NOT OLD.household_id
  OR NEW.case_id IS NOT OLD.case_id
  OR NEW.uploaded_by_adult_id IS NOT OLD.uploaded_by_adult_id
  OR NEW.consent_grant_id IS NOT OLD.consent_grant_id
BEGIN
  SELECT RAISE(ABORT, 'document household and consent references are immutable');
END;

CREATE TRIGGER document_uploads_activation_guard
BEFORE UPDATE OF lifecycle_state ON document_uploads
WHEN NEW.lifecycle_state = 'active'
  AND NOT (
    NEW.malware_status IN ('clean', 'not_scanned_fixture')
    AND NEW.encryption_status IN ('encrypted_local', 'fixture_only')
  )
BEGIN
  SELECT RAISE(ABORT, 'document cannot activate before validation and protected storage');
END;

CREATE TRIGGER policies_household_source_insert
BEFORE INSERT ON policies
WHEN NEW.source_document_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM document_uploads WHERE id = NEW.source_document_id AND household_id = NEW.household_id
)
BEGIN
  SELECT RAISE(ABORT, 'policy source document must belong to the household');
END;

CREATE TRIGGER policies_household_source_immutable
BEFORE UPDATE OF household_id, source_document_id ON policies
WHEN NEW.household_id IS NOT OLD.household_id OR NEW.source_document_id IS NOT OLD.source_document_id
BEGIN
  SELECT RAISE(ABORT, 'policy household and source references are immutable');
END;

CREATE TRIGGER policy_members_household_refs_insert
BEFORE INSERT ON policy_members
WHEN NOT EXISTS (
  SELECT 1 FROM policies p
  JOIN household_members hm ON hm.id = NEW.household_member_id
  WHERE p.id = NEW.policy_id AND p.household_id = hm.household_id
    AND (NEW.source_page_id IS NULL OR EXISTS (
      SELECT 1 FROM source_pages sp
      JOIN document_uploads du ON du.id = sp.document_upload_id
      WHERE sp.id = NEW.source_page_id AND du.household_id = p.household_id
    ))
)
BEGIN
  SELECT RAISE(ABORT, 'policy member references must belong to the household');
END;

CREATE TRIGGER policy_members_refs_immutable
BEFORE UPDATE OF policy_id, household_member_id, source_page_id ON policy_members
WHEN NEW.policy_id IS NOT OLD.policy_id
  OR NEW.household_member_id IS NOT OLD.household_member_id
  OR NEW.source_page_id IS NOT OLD.source_page_id
BEGIN
  SELECT RAISE(ABORT, 'policy member references are immutable');
END;

CREATE TRIGGER evidence_facts_household_refs_insert
BEFORE INSERT ON evidence_facts
WHEN
  (NEW.case_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM service_cases WHERE id = NEW.case_id AND household_id = NEW.household_id)) OR
  (NEW.policy_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM policies WHERE id = NEW.policy_id AND household_id = NEW.household_id)) OR
  (NEW.subject_member_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM household_members WHERE id = NEW.subject_member_id AND household_id = NEW.household_id)) OR
  (NEW.source_page_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM source_pages sp JOIN document_uploads du ON du.id = sp.document_upload_id
    WHERE sp.id = NEW.source_page_id AND du.household_id = NEW.household_id
  )) OR
  (NEW.statement_adult_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM household_members WHERE household_id = NEW.household_id AND adult_user_id = NEW.statement_adult_id
    UNION ALL
    SELECT 1 FROM household_roles WHERE household_id = NEW.household_id AND adult_user_id = NEW.statement_adult_id
  )) OR
  (NEW.supersedes_fact_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM evidence_facts prior
    WHERE prior.id = NEW.supersedes_fact_id
      AND prior.household_id = NEW.household_id
      AND prior.fact_key = NEW.fact_key
  ))
BEGIN
  SELECT RAISE(ABORT, 'evidence references must belong to the household');
END;

CREATE TRIGGER coverage_graph_snapshots_household_case_insert
BEFORE INSERT ON coverage_graph_snapshots
WHEN NOT EXISTS (
  SELECT 1 FROM service_cases
  WHERE id = NEW.case_id AND household_id = NEW.household_id
)
BEGIN
  SELECT RAISE(ABORT, 'coverage graph case must belong to the household');
END;

CREATE TRIGGER coverage_graph_snapshots_refs_immutable
BEFORE UPDATE OF household_id, case_id ON coverage_graph_snapshots
WHEN NEW.household_id IS NOT OLD.household_id OR NEW.case_id IS NOT OLD.case_id
BEGIN
  SELECT RAISE(ABORT, 'coverage graph household references are immutable');
END;

CREATE TRIGGER evidence_facts_provenance_immutable
BEFORE UPDATE ON evidence_facts
BEGIN
  SELECT RAISE(ABORT, 'evidence facts are append only; add a superseding fact');
END;

CREATE TRIGGER fact_conflicts_same_fact_insert
BEFORE INSERT ON fact_conflicts
WHEN NOT EXISTS (
  SELECT 1 FROM evidence_facts left_fact
  JOIN evidence_facts right_fact ON right_fact.id = NEW.right_fact_id
  WHERE left_fact.id = NEW.left_fact_id
    AND left_fact.household_id = right_fact.household_id
    AND left_fact.fact_key = NEW.fact_key
    AND right_fact.fact_key = NEW.fact_key
)
BEGIN
  SELECT RAISE(ABORT, 'conflict facts must share a household and fact key');
END;

CREATE TRIGGER coverage_graph_nodes_snapshot_fact_insert
BEFORE INSERT ON coverage_graph_nodes
WHEN NEW.source_fact_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM coverage_graph_snapshots cgs
  JOIN evidence_facts ef ON ef.id = NEW.source_fact_id
  WHERE cgs.id = NEW.snapshot_id AND cgs.household_id = ef.household_id
)
BEGIN
  SELECT RAISE(ABORT, 'graph source fact must belong to the snapshot household');
END;

CREATE TRIGGER coverage_graph_edges_snapshot_nodes_insert
BEFORE INSERT ON coverage_graph_edges
WHEN NOT EXISTS (
  SELECT 1 FROM coverage_graph_nodes source
  JOIN coverage_graph_nodes target ON target.id = NEW.to_node_id
  WHERE source.id = NEW.from_node_id
    AND source.snapshot_id = NEW.snapshot_id
    AND target.snapshot_id = NEW.snapshot_id
) OR (NEW.source_fact_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM coverage_graph_snapshots cgs
  JOIN evidence_facts ef ON ef.id = NEW.source_fact_id
  WHERE cgs.id = NEW.snapshot_id AND cgs.household_id = ef.household_id
))
BEGIN
  SELECT RAISE(ABORT, 'graph edge references must belong to the snapshot');
END;

CREATE TRIGGER workflow_runs_household_consent_insert
BEFORE INSERT ON workflow_runs
WHEN NEW.consent_grant_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM service_cases sc
  JOIN consent_grants cg ON cg.id = NEW.consent_grant_id
  WHERE sc.id = NEW.case_id AND sc.household_id = cg.household_id
)
BEGIN
  SELECT RAISE(ABORT, 'workflow consent must belong to the case household');
END;

CREATE TRIGGER workflow_runs_refs_immutable
BEFORE UPDATE OF case_id, case_revision, consent_grant_id ON workflow_runs
WHEN NEW.case_id IS NOT OLD.case_id
  OR NEW.case_revision IS NOT OLD.case_revision
  OR NEW.consent_grant_id IS NOT OLD.consent_grant_id
BEGIN
  SELECT RAISE(ABORT, 'workflow case and consent references are immutable');
END;

DROP VIEW active_consent_grants;
CREATE VIEW active_consent_grants AS
SELECT * FROM consent_grants
WHERE revoked_at IS NULL
  AND (expires_at IS NULL OR julianday(expires_at) > julianday('now'));

CREATE INDEX household_members_household_adult_idx ON household_members(household_id, adult_user_id);
CREATE INDEX case_participants_adult_case_idx ON case_participants(adult_user_id, case_id);
CREATE INDEX document_uploads_household_consent_idx ON document_uploads(household_id, consent_grant_id, lifecycle_state);
CREATE INDEX source_pages_ocr_job_idx ON source_pages(ocr_job_id);
CREATE INDEX policy_members_member_idx ON policy_members(household_member_id, membership_state);
CREATE INDEX evidence_facts_case_idx ON evidence_facts(case_id, fact_key, epistemic_state);
CREATE INDEX evidence_facts_policy_idx ON evidence_facts(policy_id, fact_key);
CREATE INDEX evidence_facts_source_page_idx ON evidence_facts(source_page_id);
CREATE INDEX evidence_facts_supersedes_idx ON evidence_facts(supersedes_fact_id);
CREATE INDEX evidence_facts_statement_adult_idx ON evidence_facts(statement_adult_id, fact_key);
CREATE INDEX fact_conflicts_left_idx ON fact_conflicts(left_fact_id, resolution_state);
CREATE INDEX fact_conflicts_right_idx ON fact_conflicts(right_fact_id, resolution_state);
CREATE INDEX coverage_graph_nodes_snapshot_idx ON coverage_graph_nodes(snapshot_id, node_type);
CREATE INDEX coverage_graph_edges_snapshot_idx ON coverage_graph_edges(snapshot_id, from_node_id);
CREATE INDEX workflow_runs_consent_idx ON workflow_runs(consent_grant_id, status);
CREATE INDEX workflow_tasks_claim_idx ON workflow_tasks(status, created_at, id);
CREATE INDEX workflow_tasks_lease_idx ON workflow_tasks(status, lease_expires_at);
CREATE INDEX workflow_task_dependencies_parent_idx ON workflow_task_dependencies(depends_on_task_id, workflow_task_id);
CREATE INDEX human_approvals_consent_case_idx ON human_approvals(consent_grant_id, case_id);
CREATE INDEX integration_outbox_consent_status_idx ON integration_outbox(consent_grant_id, status);
CREATE INDEX idempotency_keys_expiry_idx ON idempotency_keys(expires_at);
CREATE INDEX audit_events_household_chain_idx ON audit_events(household_id, id DESC);
