-- App user data, part 3: settings and onboarding (spec user-data-store-spec.md, ADR 0015). Expand-only: two new tables.
-- `prefs_ciphertext` holds the Settings JSON (sources, notification channels, sharing defaults, voice language, reduced
-- motion, theme) and `state_ciphertext` the onboarding choices (step, chosen way, people toggles, wallet choice), both as
-- sealed envelopes (AES-256-GCM, AAD <table>.<column>.<adult_user_id>) the CHECKs force. Plain: ids, the schema version, the
-- revision, timestamps and `completed_at`. One row per adult.
-- Row level security on with no policy; Data API roles hold nothing (see 016_data_api_lockdown.sql).
CREATE TABLE IF NOT EXISTS public.adult_preferences (
  adult_user_id text PRIMARY KEY REFERENCES public.adult_users (id) ON DELETE CASCADE,
  household_id text NOT NULL REFERENCES public.households (id) ON DELETE CASCADE,
  prefs_ciphertext text NOT NULL CHECK (prefs_ciphertext ~ '^enc[12][.]' AND length(prefs_ciphertext) <= 16384),
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS adult_preferences_household_idx ON public.adult_preferences (household_id);

CREATE TABLE IF NOT EXISTS public.onboarding_progress (
  adult_user_id text PRIMARY KEY REFERENCES public.adult_users (id) ON DELETE CASCADE,
  household_id text NOT NULL REFERENCES public.households (id) ON DELETE CASCADE,
  state_ciphertext text NOT NULL CHECK (state_ciphertext ~ '^enc[12][.]' AND length(state_ciphertext) <= 16384),
  completed_at text,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS onboarding_progress_household_idx ON public.onboarding_progress (household_id);

ALTER TABLE public.adult_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.onboarding_progress ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  api_role text;
  table_name text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      FOREACH table_name IN ARRAY ARRAY['adult_preferences', 'onboarding_progress'] LOOP
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', table_name, api_role);
      END LOOP;
    END IF;
  END LOOP;
END
$$;
