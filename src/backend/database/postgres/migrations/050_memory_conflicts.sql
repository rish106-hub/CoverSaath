-- Holdings and memory, part 3: memory_conflicts (ADR 0032). Expand-only and safe to run more than once: one new table, its triggers
-- and its lockdown. (The name fact_conflicts is taken by the retired evidence ledger of migration 001.)
-- A conflict is the record that two or more current memory facts of one slot disagree and a person may be asked. It holds ids and
-- closed enums only: no value, no quote, no key residue. The disagreeing values stay sealed in household_memory_facts.
--   candidate_fact_ids  the memory fact ids in disagreement (2 to 10)
--   reason              own_vs_insurer | two_pages | model_disagree | own_vs_declaration
--   resolution          pending | user_chose | insurer_wins | own_wins | dismissed
--   resolving_fact_id   the user_declaration fact written by a user choice (capture_method conflict_resolution), else NULL
--   resolved_by         user | rule (deterministic code); a rule never picks user_chose
-- The user may resolve any conflict, including a product-term conflict; chat still shows both quotes and says to check with the
-- insurer (ADR 0032, FOR LEGAL REVIEW). Resolving never edits the machine rows.
-- Rules this table enforces itself: holding, resolver and resolving fact belong to the conflict's household (scope trigger);
-- a resolved conflict carries resolved_by and resolved_at, a pending one carries neither.
-- Erased with its holding (FK cascade), with the household, and on consent withdrawal (application erasure paths).
-- Row level security is on with no policy and the Data API roles get no privileges (see 016_data_api_lockdown.sql).
-- Rollback: expand-only. Revert the code and turn HOLDINGS_ENABLED off; a synthetic-only project may drop the table.
CREATE TABLE IF NOT EXISTS public.memory_conflicts (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 100),
  household_id text NOT NULL REFERENCES public.households(id),
  holding_id text NOT NULL REFERENCES public.policy_holdings(id) ON DELETE CASCADE,
  fact_key text NOT NULL CHECK (fact_key ~ '^[a-z][a-z0-9_]{2,63}$'),
  candidate_fact_ids text[] NOT NULL CHECK (cardinality(candidate_fact_ids) BETWEEN 2 AND 10),
  reason text NOT NULL CHECK (reason IN ('own_vs_insurer', 'two_pages', 'model_disagree', 'own_vs_declaration')),
  resolution text NOT NULL DEFAULT 'pending' CHECK (resolution IN ('pending', 'user_chose', 'insurer_wins', 'own_wins', 'dismissed')),
  resolving_fact_id text CHECK (resolving_fact_id IS NULL OR length(resolving_fact_id) BETWEEN 1 AND 100),
  resolved_by text CHECK (resolved_by IS NULL OR resolved_by IN ('user', 'rule')),
  resolved_by_adult_id text REFERENCES public.adult_users(id),
  resolved_at text,
  created_at text NOT NULL,
  CONSTRAINT memory_conflicts_resolved_fields_check CHECK (
    (resolution = 'pending' AND resolved_by IS NULL AND resolved_at IS NULL AND resolving_fact_id IS NULL AND resolved_by_adult_id IS NULL)
    OR (resolution <> 'pending' AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL)),
  CONSTRAINT memory_conflicts_user_choice_check CHECK (
    (resolution = 'user_chose') = (resolving_fact_id IS NOT NULL)),
  CONSTRAINT memory_conflicts_actor_check CHECK (
    (resolved_by = 'user') = (resolved_by_adult_id IS NOT NULL)),
  CONSTRAINT memory_conflicts_rule_check CHECK (resolved_by IS DISTINCT FROM 'rule' OR resolution IN ('insurer_wins', 'own_wins', 'dismissed')),
  CONSTRAINT memory_conflicts_user_resolution_check CHECK (resolved_by IS DISTINCT FROM 'user' OR resolution IN ('user_chose', 'dismissed'))
);

CREATE INDEX IF NOT EXISTS memory_conflicts_household_idx ON public.memory_conflicts (household_id, resolution);
CREATE INDEX IF NOT EXISTS memory_conflicts_holding_idx ON public.memory_conflicts (holding_id, fact_key);
CREATE INDEX IF NOT EXISTS memory_conflicts_resolver_idx ON public.memory_conflicts (resolved_by_adult_id) WHERE resolved_by_adult_id IS NOT NULL;
-- At most one open conflict per slot key of a holding.
CREATE UNIQUE INDEX IF NOT EXISTS memory_conflicts_one_pending ON public.memory_conflicts (household_id, holding_id, fact_key) WHERE resolution = 'pending';

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
    <> cardinality(NEW.candidate_fact_ids) THEN
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

DROP TRIGGER IF EXISTS memory_conflicts_scope_insert ON public.memory_conflicts;
CREATE TRIGGER memory_conflicts_scope_insert
BEFORE INSERT ON public.memory_conflicts
FOR EACH ROW EXECUTE FUNCTION public.memory_conflicts_scope_fn();
DROP TRIGGER IF EXISTS memory_conflicts_scope_update ON public.memory_conflicts;
CREATE TRIGGER memory_conflicts_scope_update
BEFORE UPDATE ON public.memory_conflicts
FOR EACH ROW EXECUTE FUNCTION public.memory_conflicts_scope_fn();

-- Only the resolution fields may change, and only once: a resolved conflict is closed.
CREATE OR REPLACE FUNCTION public.memory_conflicts_guard_update_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD.resolution = 'pending'
    AND (to_jsonb(NEW) - 'resolution' - 'resolving_fact_id' - 'resolved_by' - 'resolved_by_adult_id' - 'resolved_at')
      = (to_jsonb(OLD) - 'resolution' - 'resolving_fact_id' - 'resolved_by' - 'resolved_by_adult_id' - 'resolved_at') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a memory conflict can only be resolved once; its candidates and slot are immutable';
END;
$$;

DROP TRIGGER IF EXISTS memory_conflicts_guard_update ON public.memory_conflicts;
CREATE TRIGGER memory_conflicts_guard_update
BEFORE UPDATE ON public.memory_conflicts
FOR EACH ROW EXECUTE FUNCTION public.memory_conflicts_guard_update_fn();

ALTER TABLE public.memory_conflicts ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.memory_conflicts FROM %I', api_role);
    END IF;
  END LOOP;
  REVOKE ALL ON TABLE public.memory_conflicts FROM PUBLIC;
END
$$;
