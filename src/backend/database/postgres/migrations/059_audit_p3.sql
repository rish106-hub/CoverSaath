-- Audit fixes F4 and F13. Expand-only and safe to run more than once.
-- 1. F4: an in-tier conflict (two own-PDF pages, or deterministic vs model, reasons two_pages / model_disagree) lives in ONE own-PDF memory row that
--    carries the alternatives, so the conflict cites that row twice. The candidate check compared a row count with the array length and refused
--    the repeat; it now compares distinct rows with distinct ids. Every candidate must still be a fact of the conflict's household and fact key.
-- 2. F13: analytics_outbox gets a lease (lease_token, lease_expires_at). The drain claims rows (sets the lease) and commits BEFORE it calls
--    PostHog, then marks sent only while it still holds the lease; a lease that expired (crashed worker) can be claimed again.
--    No row lock is held across the network call. Existing rows stay NULL (unclaimed). Row level security is unchanged (016_data_api_lockdown.sql).
-- Rollback: expand-only. Revert the code; the old drain ignores the lease columns. A synthetic-only project may drop the columns; the previous
--    trigger body is in 050_memory_conflicts.sql.
CREATE OR REPLACE FUNCTION public.memory_conflicts_scope_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.policy_holdings AS holding WHERE holding.id = NEW.holding_id AND holding.household_id = NEW.household_id
  ) THEN
    RAISE EXCEPTION 'memory conflict must match a holding of its household';
  END IF;
  IF TG_OP = 'INSERT' AND (SELECT count(*) FROM public.household_memory_facts AS fact
      WHERE fact.id = ANY (NEW.candidate_fact_ids) AND fact.household_id = NEW.household_id AND fact.fact_key = NEW.fact_key)
    <> (SELECT count(DISTINCT candidate) FROM unnest(NEW.candidate_fact_ids) AS candidate) THEN
    RAISE EXCEPTION 'memory conflict candidates must be facts of its household and key';
  END IF;
  IF NEW.resolving_fact_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.household_memory_facts AS fact
    WHERE fact.id = NEW.resolving_fact_id AND fact.household_id = NEW.household_id AND fact.fact_key = NEW.fact_key
      AND fact.source_tier = 'user_declaration' AND fact.capture_method = 'conflict_resolution'
  ) THEN
    RAISE EXCEPTION 'a resolving fact must be a conflict-resolution declaration of its household and key';
  END IF;
  IF NEW.resolved_by_adult_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.household_roles AS role
    WHERE role.household_id = NEW.household_id AND role.adult_user_id = NEW.resolved_by_adult_id AND role.status = 'active'
  ) THEN
    RAISE EXCEPTION 'memory conflict resolver must be an active adult of the household';
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE public.analytics_outbox ADD COLUMN IF NOT EXISTS lease_token text;
ALTER TABLE public.analytics_outbox ADD COLUMN IF NOT EXISTS lease_expires_at text;
