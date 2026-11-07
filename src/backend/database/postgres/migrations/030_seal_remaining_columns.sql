-- Application-level column encryption, remaining user-derived columns (run D2, ADR 0013 addendum D2). Expand-only in the data
-- sense: no row is changed, no column is dropped, and values already stored stay readable (the application reads an unprefixed
-- value as legacy plaintext until scripts/encrypt-existing-rows.mjs has sealed it). Safe to run more than once. Migrations 019
-- and 021 are not edited (their checksums are recorded).
--
-- The application now writes `enc2.<keyId>.<nonce>.<tag>.<ciphertext>` strings into these columns (besides those of 019/021):
--   household_members.relationship_label, date_of_birth        policy_answers.question
--   document_uploads.original_filename                         policies.policy_number_masked, starts_on, ends_on
--   policy_members.member_reference_masked                      ocr_jobs.error_message, source_pages.provenance_json
--   coverage_parameter_observations.value_json                  coverage_parameter_resolutions.resolved_value_json
--   proposed_parameters.label, value_json                       workflow_runs.input_json
--   workflow_tasks.input_json, output_json, last_error_message  workflow_events.event_payload_json
--   idempotency_keys.response_json                              integration_outbox.payload_json, last_error
--   integration_webhook_events.payload_json, processing_error   coverage_graph_snapshots.graph_json
--   coverage_graph_nodes.label, entity_ref                      reviewer_findings.message, resolution_note
--   consent_revocations.reason                                  catalogue_reviews.fact_json
--   service_cases.stated_estimate_ciphertext (new; replaces the plain stated_estimate_minor for new rows)
-- A sealed value is not JSON and is longer than its plaintext, so each single-column IS JSON / length CHECK on a sealed column is
-- replaced by ONE check with two branches: a sealed envelope (`enc1.`/`enc2.`, with a looser length cap where the old check had a
-- cap) OR the old plaintext rule unchanged (valid JSON, JSON object, the old length). Legacy plaintext therefore keeps its old
-- integrity until the backfill seals it, and a build that forgets to seal still cannot write malformed values. Multi-column checks
-- that only compare a column with NULL are untouched. Name and text columns without a CHECK stay unconstrained until every
-- environment is backfilled (as in 021).
-- Every new check is added NOT VALID: new and updated rows are checked at once, but the table is not scanned while the DDL lock is
-- held (the migration runner uses one transaction per file). scripts/encrypt-existing-rows.mjs runs VALIDATE CONSTRAINT for them
-- afterwards in separate statements; every existing row already satisfies them (the old checks were stricter).
--
-- Two additive columns (no table is created, so row level security from 016 is unchanged and still enabled everywhere):
--   service_cases.stated_estimate_ciphertext  sealed text; the plain bigint stated_estimate_minor stays (nullable) for rows not
--                                             yet backfilled and for rollback.
--   idempotency_keys.document_index           keyed hash (HMAC, ADR 0013 D4 style) of the document id for document-upload
--                                             records, so erasing a document can find its idempotency record without reading
--                                             the sealed response. Not the document id itself.
-- Rollback: docs/runbooks/migration-030-rollback.md.
DO $$
DECLARE
  target record;
  old_check record;
  constraint_name text;
  sealed_branch text;
BEGIN
  FOR target IN
    SELECT * FROM (VALUES
      -- table, column, kind ('json' names the check ..._sealed_or_json_check, 'text' ..._sealed_len_check),
      -- cap on the sealed envelope (NULL = none, as before), the old plaintext rule ({c} stands for the column)
      ('coverage_parameter_observations', 'value_json', 'json', NULL::integer, '{c} IS JSON'),
      ('coverage_parameter_resolutions', 'resolved_value_json', 'json', NULL, '{c} IS JSON'),
      ('proposed_parameters', 'value_json', 'json', 60000, '{c} IS JSON AND length({c}) <= 16384'),
      ('proposed_parameters', 'label', 'text', 1200, 'length({c}) BETWEEN 1 AND 120'),
      ('policy_answers', 'question', 'text', 20000, 'length({c}) BETWEEN 1 AND 2000'),
      ('workflow_runs', 'input_json', 'json', NULL, '{c} IS JSON'),
      ('workflow_tasks', 'input_json', 'json', NULL, '{c} IS JSON'),
      ('workflow_tasks', 'output_json', 'json', NULL, '{c} IS JSON'),
      ('workflow_events', 'event_payload_json', 'json', NULL, '{c} IS JSON'),
      ('idempotency_keys', 'response_json', 'json', NULL, '{c} IS JSON'),
      ('integration_outbox', 'payload_json', 'json', NULL, '{c} IS JSON'),
      ('integration_webhook_events', 'payload_json', 'json', NULL, '{c} IS JSON'),
      ('coverage_graph_snapshots', 'graph_json', 'json', NULL, '{c} IS JSON'),
      ('source_pages', 'provenance_json', 'json', NULL, '{c} IS JSON'),
      ('catalogue_reviews', 'fact_json', 'json', 60000, '{c} IS JSON OBJECT AND length({c}) <= 16384')
    ) AS item(table_name, column_name, kind, enc_cap, plain_rule)
  LOOP
    -- Constraint names are cut to 63 characters (the identifier limit) so a repeated run finds the same name.
    constraint_name := left(format('%s_%s_%s', target.table_name, target.column_name,
      CASE target.kind WHEN 'json' THEN 'sealed_or_json_check' ELSE 'sealed_len_check' END), 63);
    -- Single-column CHECK constraints on exactly this column (the old plaintext rule).
    FOR old_check IN
      SELECT con.conname
      FROM pg_constraint con
      JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = con.conkey[1]
      WHERE con.conrelid = format('public.%I', target.table_name)::regclass
        AND con.contype = 'c'
        AND array_length(con.conkey, 1) = 1
        AND att.attname = target.column_name
        AND con.conname <> constraint_name
    LOOP
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', target.table_name, old_check.conname);
    END LOOP;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = format('public.%I', target.table_name)::regclass AND conname = constraint_name
    ) THEN
      sealed_branch := format('%I ~ ''^enc[12][.]''', target.column_name)
        || CASE WHEN target.enc_cap IS NULL THEN '' ELSE format(' AND length(%I) <= %s', target.column_name, target.enc_cap) END;
      EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (%I IS NULL OR (%s) OR (%s)) NOT VALID',
        target.table_name, constraint_name, target.column_name, sealed_branch,
        replace(target.plain_rule, '{c}', format('%I', target.column_name)));
    END IF;
  END LOOP;
END
$$;

ALTER TABLE public.service_cases ADD COLUMN IF NOT EXISTS stated_estimate_ciphertext text;
ALTER TABLE public.idempotency_keys ADD COLUMN IF NOT EXISTS document_index text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.service_cases'::regclass AND conname = 'service_cases_stated_estimate_sealed_check'
  ) THEN
    ALTER TABLE public.service_cases
      ADD CONSTRAINT service_cases_stated_estimate_sealed_check
      CHECK (stated_estimate_ciphertext IS NULL OR stated_estimate_ciphertext ~ '^enc[12][.]') NOT VALID;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idempotency_keys_document_index_idx ON public.idempotency_keys(document_index) WHERE document_index IS NOT NULL;
