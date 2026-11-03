-- Sync, part 1: per-household change log (ADR 0017, docs/exec-plans/active/full-system-design.md section 5). Expand-only and rerunnable.
-- (030 is reserved for the auth/session slice that is built in parallel; migration numbers are not required to be contiguous.)
--
-- household_changes is an append-only list of "this row changed": entity, id, revision, op, actor id, time. It holds NO values.
-- An AFTER trigger on each synced table writes it, so a route, a script or a hand-run UPDATE cannot change synced data without
-- leaving a cursor entry. household_sync_state records the low-water mark (min_seq) below which the log has been trimmed; a client
-- cursor under it gets 410 CURSOR_EXPIRED and takes a snapshot.
--
-- Ordering: the log trigger takes the household advisory lock (the same key the application takes, see locks.js) before it
-- allocates a seq. The lock is held to the end of the transaction, so within one household seq order is commit order and a
-- reader that has seen seq N can never miss a smaller seq that commits later. The application already holds that lock (re-entrant);
-- a direct SQL writer that did not simply takes it at its first logged row.
--
-- Revision: touch_revision_fn bumps `revision` only when the writer did not (NEW.revision = OLD.revision). The 025-029 repositories
-- bump it themselves (`revision = revision + 1`), so the trigger leaves their writes alone; a direct SQL UPDATE that forgets still
-- gets a new revision. Tables without a revision column are skipped.
--
-- Later migrations attach the same triggers with one call:
--   SELECT public.attach_household_sync('public.<table>', '<entity>');                 -- id column `id`, household-wide
--   SELECT public.attach_household_sync('public.<table>', '<entity>', '<id column>', 'adult');  -- visible only to the row's adult_user_id
--   SELECT public.attach_household_sync('public.<table>', '<entity>', 'id', 'place');   -- household_places rule (current_location is private)
-- The table needs a household_id column. A revision column is optional; when present the touch trigger is attached too.

CREATE OR REPLACE FUNCTION public.sync_now_text_fn() RETURNS text LANGUAGE sql VOLATILE
SET search_path TO pg_catalog, public, pg_temp AS $$
  SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;

CREATE OR REPLACE FUNCTION public.touch_revision_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
DECLARE
  old_json jsonb := to_jsonb(OLD);
  new_json jsonb := to_jsonb(NEW);
  patch jsonb;
BEGIN
  IF NOT (new_json ? 'revision') THEN RETURN NEW; END IF;
  -- The writer already moved the revision: leave it alone (no double bump).
  IF new_json -> 'revision' IS DISTINCT FROM old_json -> 'revision' THEN RETURN NEW; END IF;
  patch := jsonb_build_object('revision', (old_json ->> 'revision')::integer + 1);
  IF new_json ? 'updated_at' AND new_json -> 'updated_at' IS NOT DISTINCT FROM old_json -> 'updated_at' THEN
    patch := patch || jsonb_build_object('updated_at', public.sync_now_text_fn());
  END IF;
  RETURN jsonb_populate_record(NEW, patch);
END;
$$;

CREATE TABLE IF NOT EXISTS public.household_changes (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  household_id text NOT NULL REFERENCES public.households (id) ON DELETE CASCADE,
  entity text NOT NULL CHECK (entity ~ '^[a-z_]{1,40}$'),
  entity_id text NOT NULL CHECK (length(entity_id) BETWEEN 1 AND 100),
  op text NOT NULL CHECK (op IN ('upsert', 'delete')),
  revision integer NOT NULL,
  -- Set for rows only one adult may see (preferences, scenarios, permissions, a current location): the feed shows them to that
  -- adult alone. NULL means household-wide. An id, never a value.
  subject_adult_id text,
  actor_adult_id text,
  at text NOT NULL
);
CREATE INDEX IF NOT EXISTS household_changes_cursor_idx ON public.household_changes (household_id, seq);
CREATE INDEX IF NOT EXISTS household_changes_trim_idx ON public.household_changes (at);

CREATE TABLE IF NOT EXISTS public.household_sync_state (
  household_id text PRIMARY KEY REFERENCES public.households (id) ON DELETE CASCADE,
  min_seq bigint NOT NULL DEFAULT 0 CHECK (min_seq >= 0),
  updated_at text NOT NULL
);

ALTER TABLE public.household_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.household_sync_state ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.household_changes FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON TABLE public.household_sync_state FROM %I', api_role);
    END IF;
  END LOOP;
END
$$;

-- AFTER INSERT OR UPDATE OR DELETE. TG_ARGV: [0] entity, [1] id column (default id), [2] scope (household | adult | place).
-- Reads the row through to_jsonb so one function serves tables with other id columns or without a revision column. A table that
-- cannot name a household writes nothing.
CREATE OR REPLACE FUNCTION public.log_household_change_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
DECLARE
  row_json jsonb;
  hid text; eid text; rev integer; operation text; subject text; scope text;
BEGIN
  IF TG_OP = 'DELETE' THEN row_json := to_jsonb(OLD); operation := 'delete';
  ELSE row_json := to_jsonb(NEW); operation := 'upsert'; END IF;
  hid := row_json ->> 'household_id';
  eid := row_json ->> COALESCE(NULLIF(TG_ARGV[1], ''), 'id');
  IF hid IS NULL OR eid IS NULL THEN RETURN NULL; END IF;
  -- A cascade from a household delete: the household is already gone, and so is its log.
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM public.households WHERE id = hid) THEN RETURN NULL; END IF;
  rev := CASE WHEN row_json ? 'revision' THEN (row_json ->> 'revision')::integer + CASE WHEN TG_OP = 'DELETE' THEN 1 ELSE 0 END
              ELSE 1 END;
  scope := COALESCE(NULLIF(TG_ARGV[2], ''), 'household');
  subject := CASE
    WHEN scope = 'adult' THEN row_json ->> 'adult_user_id'
    WHEN scope = 'place' AND row_json ->> 'kind' = 'current_location' THEN row_json ->> 'adult_user_id'
    ELSE NULL END;
  -- Same key as locks.js householdLock: first 64 bits of SHA-256('household' NUL id), signed.
  PERFORM pg_advisory_xact_lock(('x' || encode(substring(sha256(convert_to('household', 'UTF8') || '\x00'::bytea || convert_to(hid, 'UTF8')) FROM 1 FOR 8), 'hex'))::bit(64)::bigint);
  INSERT INTO public.household_changes (household_id, entity, entity_id, op, revision, subject_adult_id, actor_adult_id, at)
  VALUES (hid, TG_ARGV[0], eid, operation, rev, subject, NULLIF(current_setting('knowvia.actor', true), ''), public.sync_now_text_fn());
  RETURN NULL;
END;
$$;

-- Idempotent attach helper (drop + create), used below and by later migrations.
CREATE OR REPLACE FUNCTION public.attach_household_sync(target regclass, entity text, id_column text DEFAULT 'id', scope text DEFAULT 'household')
RETURNS void LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
DECLARE
  table_name text := (SELECT relname FROM pg_class WHERE oid = target);
BEGIN
  IF entity !~ '^[a-z_]{1,40}$' OR scope NOT IN ('household', 'adult', 'place') THEN
    RAISE EXCEPTION 'attach_household_sync: invalid entity or scope';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = target AND attname = 'household_id' AND NOT attisdropped)
     OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = target AND attname = id_column AND NOT attisdropped) THEN
    RAISE EXCEPTION 'attach_household_sync: table needs household_id and the id column';
  END IF;
  EXECUTE format('DROP TRIGGER IF EXISTS %I ON %s', table_name || '_sync_log', target);
  EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION public.log_household_change_fn(%L, %L, %L)',
    table_name || '_sync_log', target, entity, id_column, scope);
  EXECUTE format('DROP TRIGGER IF EXISTS %I ON %s', table_name || '_sync_touch', target);
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = target AND attname = 'revision' AND NOT attisdropped) THEN
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION public.touch_revision_fn()',
      table_name || '_sync_touch', target);
  END IF;
END;
$$;

-- Trims the log: removes entries older than `cutoff` (ISO text) and raises each affected household's min_seq to the highest seq
-- removed, so a client cursor below it gets CURSOR_EXPIRED. Returns the number of rows removed. Not scheduled by this migration:
-- call it from a maintenance job (SyncRepository.purgeChangeLog) once a day; nothing else depends on it running.
CREATE OR REPLACE FUNCTION public.purge_household_changes(cutoff text) RETURNS bigint LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
DECLARE
  removed bigint;
BEGIN
  WITH gone AS (
    DELETE FROM public.household_changes WHERE at < cutoff RETURNING household_id, seq
  ), floors AS (
    SELECT household_id, max(seq) AS top FROM gone GROUP BY household_id
  ), bumped AS (
    INSERT INTO public.household_sync_state (household_id, min_seq, updated_at)
    SELECT household_id, top, public.sync_now_text_fn() FROM floors
    ON CONFLICT (household_id) DO UPDATE
      SET min_seq = GREATEST(public.household_sync_state.min_seq, EXCLUDED.min_seq), updated_at = EXCLUDED.updated_at
    RETURNING 1
  )
  SELECT count(*) INTO removed FROM gone;
  RETURN removed;
END;
$$;

-- Existing tables only. Later migrations (032-038) call attach_household_sync for theirs.
SELECT public.attach_household_sync('public.household_members', 'members');
SELECT public.attach_household_sync('public.household_places', 'places', 'id', 'place');
SELECT public.attach_household_sync('public.adult_preferences', 'preferences', 'adult_user_id', 'adult');
SELECT public.attach_household_sync('public.onboarding_progress', 'onboarding', 'adult_user_id', 'adult');
SELECT public.attach_household_sync('public.tool_scenarios', 'scenarios', 'id', 'adult');
SELECT public.attach_household_sync('public.device_permissions', 'permissions', 'id', 'adult');
SELECT public.attach_household_sync('public.policies', 'policies');
SELECT public.attach_household_sync('public.service_cases', 'cases');
SELECT public.attach_household_sync('public.document_uploads', 'documents');
