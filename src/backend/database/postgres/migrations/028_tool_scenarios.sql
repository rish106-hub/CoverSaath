-- App user data, part 4: calculator and review inputs (spec user-data-store-spec.md, ADR 0015). Expand-only: one new table.
-- One saved scenario per adult and tool. `inputs_ciphertext` is a sealed envelope (AES-256-GCM, AAD
-- tool_scenarios.inputs_ciphertext.<id>) the CHECK forces; the tool name is a closed enum and stays plain.
-- Row level security on with no policy; Data API roles hold nothing (see 016_data_api_lockdown.sql).
CREATE TABLE IF NOT EXISTS public.tool_scenarios (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 100),
  household_id text NOT NULL REFERENCES public.households (id) ON DELETE CASCADE,
  adult_user_id text NOT NULL REFERENCES public.adult_users (id) ON DELETE CASCADE,
  tool text NOT NULL CHECK (tool IN ('tax', 'premium_rise', 'hospital_bill', 'inflation', 'compare_weights', 'stress_levers', 'review_state')),
  inputs_ciphertext text NOT NULL CHECK (inputs_ciphertext ~ '^enc[12][.]' AND length(inputs_ciphertext) <= 16384),
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at text NOT NULL,
  UNIQUE (adult_user_id, tool)
);
CREATE INDEX IF NOT EXISTS tool_scenarios_household_idx ON public.tool_scenarios (household_id);

ALTER TABLE public.tool_scenarios ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.tool_scenarios FROM %I', api_role);
    END IF;
  END LOOP;
END
$$;
