-- Holdings, FSS insurer tier (ADR 0034): the outcome of the last reference check of a holding. Expand-only and safe to run more than
-- once: two nullable columns on policy_holdings, no new table, no data rewrite, no change to any existing row or trigger.
--   reference_outcome     closed code of the last check (NULL = never checked). 'attached' = insurer terms were read; every other value
--                         is the reason the holding has no insurer terms. Never a value, a locator, a UIN or provider text.
--   reference_checked_at  when that check ran. The daily refresh rule reads it (24 h, or 1 h after unavailable or rate_limited).
-- The columns hold no household-derived fact: the derived rows (household_memory_facts, tier ida_wording) keep their own erasure paths,
-- and these columns go with the holding when it is erased.
-- Rollback: expand-only. Revert the code; the columns can stay unused, or a synthetic-only project may drop them.
ALTER TABLE public.policy_holdings
  ADD COLUMN IF NOT EXISTS reference_outcome text
    CHECK (reference_outcome IS NULL OR reference_outcome IN (
      'attached', 'unavailable', 'rate_limited', 'unauthorized', 'no_match', 'version_unresolved', 'synthetic_only',
      'invalid_response', 'disabled', 'no_usable_facts'));
ALTER TABLE public.policy_holdings
  ADD COLUMN IF NOT EXISTS reference_checked_at timestamptz;
