-- ADR 0036: an insurer fact that a model extracted from the public wording and FSS has not reviewed is held as an ida_wording row with
-- status extracted_unverified (shown to the person as "not checked", never a decided value, never promoted). Expand-only: the tier and
-- status pairing CHECK of migration 049 gains one allowed pair; existing rows already satisfy it and are untouched. No new table, column
-- or index, so there is nothing to seal, erase or add RLS to beyond what household_memory_facts already has: the rows go with the holding,
-- the document or a consent revocation exactly as the reviewed insurer rows do.
-- Rollback: expand-only. Revert the code; a synthetic-only project may restore the old CHECK after deleting any ida_wording
-- extracted_unverified rows.
-- Later, on a large table: add the CHECK as NOT VALID, then VALIDATE CONSTRAINT in a separate step, so the table is not held under a long lock.
-- Not done here (the table is small and this runs once); behaviour is unchanged.
ALTER TABLE public.household_memory_facts DROP CONSTRAINT IF EXISTS household_memory_facts_tier_status_check;
ALTER TABLE public.household_memory_facts ADD CONSTRAINT household_memory_facts_tier_status_check CHECK (
  (source_tier = 'own_pdf' AND status IN ('extracted_unverified', 'conflicting', 'unknown'))
  OR (source_tier = 'ida_wording' AND status IN ('reviewed_reference', 'extracted_unverified', 'conflicting', 'unknown'))
  OR (source_tier = 'user_declaration' AND status = 'user_confirmed'));
