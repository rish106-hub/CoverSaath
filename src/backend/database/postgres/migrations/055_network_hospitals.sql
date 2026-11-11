-- Network hospitals (S-C2, complete.md section 3.1). PUBLIC reference data synced from the insurance-data-api export; expand-only
-- and safe to run more than once. The table has no household, member, case or consent column and must never get one: it holds the
-- public hospital directory (name, address, city, pincode, cashless flag) and nothing about any person. It is global data, like
-- reference_cache (033): household erasure does not touch it.
--   insurer_id   the reference service's insurer id (opaque text, no foreign key: the registry lives in reference_cache). NULL = every insurer.
--   tpa_id       optional TPA id from the same source.
--   source_ref   where the row came from (the export's source reference); valid_from and valid_to bound the listing when the source says so.
--   synced_at    database time of the last upsert by the sync job.
-- Index (insurer_id, pincode) serves the pincode lookup; pincode alone is covered by the second index.
-- SCALE: add PostGIS (geography column, GiST or geohash index) when rows exceed 100k or radius queries exceed 50 rps. Until then pincode
--   equality is enough and PostGIS is not installed.
-- Row level security on with no policy; Data API roles hold nothing (see 016_data_api_lockdown.sql).
-- Rollback: expand-only. Turn HOLDINGS_ENABLED off (the route answers 503); a synthetic-only project may DROP TABLE public.network_hospitals and
--   DELETE FROM schema_migrations WHERE version = '055_network_hospitals.sql'.
CREATE TABLE IF NOT EXISTS public.network_hospitals (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 100 AND id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]*$'),
  insurer_id text CHECK (insurer_id IS NULL OR length(insurer_id) BETWEEN 1 AND 100),
  tpa_id text CHECK (tpa_id IS NULL OR length(tpa_id) BETWEEN 1 AND 100),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  address text NOT NULL DEFAULT '' CHECK (length(address) <= 400),
  city text NOT NULL CHECK (length(city) BETWEEN 1 AND 100),
  pincode text NOT NULL CHECK (pincode ~ '^[0-9]{6}$'),
  lat numeric(9,6) CHECK (lat IS NULL OR lat BETWEEN -90 AND 90),
  lng numeric(9,6) CHECK (lng IS NULL OR lng BETWEEN -180 AND 180),
  cashless boolean NOT NULL,
  source_ref text NOT NULL CHECK (length(source_ref) BETWEEN 1 AND 200),
  valid_from date,
  valid_to date,
  synced_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from)
);
CREATE INDEX IF NOT EXISTS network_hospitals_insurer_pincode_idx ON public.network_hospitals (insurer_id, pincode);
CREATE INDEX IF NOT EXISTS network_hospitals_pincode_idx ON public.network_hospitals (pincode);

ALTER TABLE public.network_hospitals ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.network_hospitals FROM %I', api_role);
    END IF;
  END LOOP;
END
$$;
