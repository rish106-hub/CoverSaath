-- Postgres job queue for the worker process group (plan B4). Expand-only: one new table, no change to an existing one.
-- Lets OCR and model work run in separate worker processes: a worker claims one due job with FOR UPDATE SKIP LOCKED, holds a
-- lease it renews by heartbeat, and a job whose lease expires (worker crash) is claimed again by another worker. A failed job
-- is retried with backoff until max_attempts, then parked as 'dead' (dead letter) for an operator.
-- A job carries identifiers only: kind, household_id, optional document_id and consent_grant_id, and a small payload_json of
-- identifier values. Never document text, OCR output, model output or household fields. The consent and ownership checks
-- run again in the handler, not here.
-- Erasure: revocation and document erasure delete the rows of the affected documents and consent grant (see
-- ConsentRepository eraseDerivedRunData). No foreign keys, so the queue never blocks an erasure.
-- Row level security on with no policy; Data API roles hold nothing (see 016_data_api_lockdown.sql).
-- Rollback: old code ignores this table; revert the code and keep or drop the table.
CREATE TABLE IF NOT EXISTS public.job_queue (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
  kind text NOT NULL CHECK (kind ~ '^[a-z0-9_.-]{1,64}$'),
  household_id text NOT NULL CHECK (length(household_id) BETWEEN 1 AND 128),
  document_id text CHECK (document_id IS NULL OR length(document_id) BETWEEN 1 AND 128),
  consent_grant_id text CHECK (consent_grant_id IS NULL OR length(consent_grant_id) BETWEEN 1 AND 128),
  payload_json text NOT NULL DEFAULT '{}' CHECK (length(payload_json) <= 1024),
  dedupe_key text CHECK (dedupe_key IS NULL OR length(dedupe_key) BETWEEN 1 AND 128),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'dead')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  run_after timestamptz NOT NULL DEFAULT now(),
  locked_by text CHECK (locked_by IS NULL OR locked_by ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  lease_expires_at timestamptz,
  last_error_code text CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CHECK ((status = 'running') = (locked_by IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK ((status IN ('succeeded', 'dead')) = (finished_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS job_queue_due_idx ON public.job_queue (run_after, id) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS job_queue_lease_idx ON public.job_queue (lease_expires_at, id) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS job_queue_document_idx ON public.job_queue (document_id) WHERE document_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS job_queue_consent_idx ON public.job_queue (consent_grant_id) WHERE consent_grant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS job_queue_household_idx ON public.job_queue (household_id);
CREATE UNIQUE INDEX IF NOT EXISTS job_queue_dedupe_idx ON public.job_queue (dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running');

ALTER TABLE public.job_queue ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.job_queue FROM %I', api_role);
    END IF;
  END LOOP;
END
$$;
