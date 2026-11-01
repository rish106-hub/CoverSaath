-- App user data, part 2: places (spec user-data-store-spec.md, ADR 0015). Expand-only: one new table.
-- A registered address, a saved place or the last device location. Everything a person typed or a device reported sits in
-- `label_ciphertext` and `payload_ciphertext`, sealed envelopes (enc1 or the padded enc2, AES-256-GCM, AAD
-- household_places.<column>.<id>) the CHECKs force. Plain: ids, foreign keys, the closed enums, timestamps and the revision.
-- `slot` (home, work, other) is a closed enum that tells saved places apart, so each slot holds one place.
-- `current_location` is minimised in the application: rounded to 2 decimals unless the Emergency flow asked for exact, and it
-- carries `expires_at` (24 hours after capture); a read-time filter hides it and a purge function deletes it.
-- Row level security on with no policy; Data API roles hold nothing (see 016_data_api_lockdown.sql). A member's places go with
-- the member, and all places with the household or adult (ON DELETE CASCADE).
CREATE TABLE IF NOT EXISTS public.household_places (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 100),
  household_id text NOT NULL REFERENCES public.households (id) ON DELETE CASCADE,
  adult_user_id text REFERENCES public.adult_users (id) ON DELETE CASCADE,
  member_id text REFERENCES public.household_members (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('registered_address', 'current_location', 'saved_place')),
  slot text CHECK (slot IS NULL OR slot IN ('home', 'work', 'other')),
  label_ciphertext text CHECK (label_ciphertext IS NULL OR (label_ciphertext ~ '^enc[12][.]' AND length(label_ciphertext) <= 2048)),
  payload_ciphertext text NOT NULL CHECK (payload_ciphertext ~ '^enc[12][.]' AND length(payload_ciphertext) <= 16384),
  precision text NOT NULL CHECK (precision IN ('exact', 'coarse')),
  source text NOT NULL CHECK (source IN ('user_typed', 'device_gps', 'document', 'digilocker')),
  captured_at text NOT NULL,
  expires_at text,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  CHECK ((kind = 'saved_place') = (slot IS NOT NULL)),
  CHECK (kind <> 'current_location' OR (adult_user_id IS NOT NULL AND member_id IS NULL AND expires_at IS NOT NULL)),
  CHECK (kind = 'current_location' OR expires_at IS NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS household_places_address_unique
  ON public.household_places (household_id, COALESCE(member_id, '')) WHERE kind = 'registered_address';
CREATE UNIQUE INDEX IF NOT EXISTS household_places_location_unique
  ON public.household_places (adult_user_id) WHERE kind = 'current_location';
CREATE UNIQUE INDEX IF NOT EXISTS household_places_saved_unique
  ON public.household_places (household_id, COALESCE(member_id, ''), slot) WHERE kind = 'saved_place';
CREATE INDEX IF NOT EXISTS household_places_household_idx ON public.household_places (household_id);
CREATE INDEX IF NOT EXISTS household_places_member_idx ON public.household_places (member_id) WHERE member_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS household_places_expiry_idx ON public.household_places (expires_at) WHERE expires_at IS NOT NULL;

ALTER TABLE public.household_places ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.household_places FROM %I', api_role);
    END IF;
  END LOOP;
END
$$;
