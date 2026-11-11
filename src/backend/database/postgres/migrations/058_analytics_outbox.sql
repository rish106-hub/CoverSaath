-- Product analytics outbox (complete.md D6, ADR 0033). Expand-only and safe to run more than once.
-- 1. consent_grants may now carry purpose 'analytics' and consent_scopes may name resource type 'household' (a household-wide scope with no
--    resource id, so the household-resource trigger has nothing to check). Both CHECKs are widened, nothing is removed (migration 001 is not edited).
-- 2. analytics_outbox: one row per allowlisted server-side event waiting to be sent to PostHog by the worker.
--    * distinct_id_hash: HMAC-SHA256 of the household id under ANALYTICS_DISTINCT_ID_SALT, hex. Never the raw id.
--    * properties_json: allowlisted keys only (src/contracts/analytics-events.js), each a closed-vocabulary value or a bounded whole
--      number. No free text, name, policy number, UIN or amount. A CHECK keeps it a JSON object under 1000 characters.
--    * household_id: the row is household-linked so household erasure deletes it; it is never sent to PostHog.
--    * sent_at: set by the drain; sent rows are purged by the drain after seven days.
-- Rows are enqueued only while ANALYTICS_ENABLED is exactly "true" and the household holds an active analytics consent grant; the drain
-- re-checks that grant before sending and deletes the household's unsent rows when it is gone.
-- Row level security is on with no policy and the Data API roles get no privileges (see 016_data_api_lockdown.sql).
-- Rollback: expand-only. Turn ANALYTICS_ENABLED off; a synthetic-only project may drop the table and restore the old purpose CHECK.
ALTER TABLE public.consent_grants DROP CONSTRAINT IF EXISTS consent_grants_purpose_check;
ALTER TABLE public.consent_grants ADD CONSTRAINT consent_grants_purpose_check CHECK (purpose IN (
  'profile_intake', 'document_processing', 'coverage_reconstruction', 'voice_intake',
  'institutional_clarification', 'human_review', 'purchase_review', 'payment', 'analytics'
));

ALTER TABLE public.consent_scopes DROP CONSTRAINT IF EXISTS consent_scopes_resource_type_check;
ALTER TABLE public.consent_scopes ADD CONSTRAINT consent_scopes_resource_type_check CHECK (resource_type IN (
  'profile_field', 'document', 'policy', 'case', 'voice_call', 'payment_order', 'household'
));

CREATE TABLE IF NOT EXISTS public.analytics_outbox (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES public.households(id),
  event text NOT NULL CHECK (event ~ '^[a-z][a-z0-9_]{1,63}$'),
  distinct_id_hash text NOT NULL CHECK (distinct_id_hash ~ '^[0-9a-f]{64}$'),
  properties_json text NOT NULL CHECK (length(properties_json) <= 1000 AND properties_json::jsonb IS NOT NULL AND jsonb_typeof(properties_json::jsonb) = 'object'),
  created_at text NOT NULL,
  sent_at text
);

CREATE INDEX IF NOT EXISTS analytics_outbox_household_idx ON public.analytics_outbox (household_id, created_at);
CREATE INDEX IF NOT EXISTS analytics_outbox_unsent_idx ON public.analytics_outbox (created_at, id) WHERE sent_at IS NULL;

ALTER TABLE public.analytics_outbox ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.analytics_outbox FROM %I', api_role);
    END IF;
  END LOOP;
END
$$;
