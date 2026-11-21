-- Household members, relationship-first profile: a closed `relationship` and sealed `aliases` (ADR 0013, ADR 0026). Expand-only and safe to
-- run more than once: two nullable columns on household_members, no new table, no data rewrite, no change to any existing row or trigger.
--   relationship  closed vocabulary like member_kind (self, spouse, son, daughter, mother, father, sibling, in_law, other); NULL = not stated.
--                 Plain on purpose (a closed enum, not free text). relationship_label stays the sealed free-text label for a custom name.
--   aliases       what the household calls this person ("mum", "papa"): a sealed JSON array of at most 8 short texts, AAD
--                 household_members.aliases.<id>. Sealed from the first write, so the column CHECK refuses plaintext.
-- Both are erased with the member (member and household erasure null them; the row becomes the erased tombstone).
-- RLS was enabled on household_members in 016; it is stated again so this migration stands on its own (tests/rls-coverage.test.mjs).
-- Rollback: expand-only. Revert the code; the columns can stay unused, or a synthetic-only project may drop them.
ALTER TABLE public.household_members
  ADD COLUMN IF NOT EXISTS relationship text
    CHECK (relationship IS NULL OR relationship IN ('self', 'spouse', 'son', 'daughter', 'mother', 'father', 'sibling', 'in_law', 'other'));
ALTER TABLE public.household_members
  ADD COLUMN IF NOT EXISTS aliases text
    CHECK (aliases IS NULL OR aliases ~ '^enc[12][.]');

ALTER TABLE public.household_members ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.household_members FROM %I', api_role);
    END IF;
  END LOOP;
END
$$;
