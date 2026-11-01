-- App user data, part 1: device permissions (spec user-data-store-spec.md, ADR 0015). Expand-only: one new table.
-- One row per adult and permission. The permission name, the decision and the screen it was made on are small closed enums the
-- database constrains and may query (for example who denied location), so they stay plain. No typed value lives here.
-- Row level security on with no policy; Data API roles hold nothing (see 016_data_api_lockdown.sql). Rows are erased with the
-- adult or household (ON DELETE CASCADE) and by UserDataRepository.eraseForHousehold. Consent and permission wording is draft
-- and needs legal review; `wording_version` records which wording the person saw.
CREATE TABLE IF NOT EXISTS public.device_permissions (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 100),
  household_id text NOT NULL REFERENCES public.households (id) ON DELETE CASCADE,
  adult_user_id text NOT NULL REFERENCES public.adult_users (id) ON DELETE CASCADE,
  permission text NOT NULL CHECK (permission IN ('location', 'notifications', 'contacts', 'calendar', 'microphone', 'camera')),
  state text NOT NULL CHECK (state IN ('granted', 'denied', 'dismissed', 'revoked')),
  surface text NOT NULL CHECK (surface IN ('onboarding', 'emergency', 'settings', 'family', 'other')),
  wording_version text CHECK (wording_version IS NULL OR wording_version ~ '^[A-Za-z0-9_.-]{1,40}$'),
  decided_at text NOT NULL,
  updated_at text NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  UNIQUE (adult_user_id, permission)
);
CREATE INDEX IF NOT EXISTS device_permissions_household_idx ON public.device_permissions (household_id);

ALTER TABLE public.device_permissions ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.device_permissions FROM %I', api_role);
    END IF;
  END LOOP;
END
$$;
