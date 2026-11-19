-- FSS handoff pull redrive (ADR 0037 review fix). Expand-only and safe to run more than once: one counter column and one partial index on
-- the existing fss_handoffs table. No new table, so RLS and the anon/authenticated revoke of migration 068 already cover it.
--   pull_attempts   how many times the hourly poll re-queued the pull job of a matched handoff whose pull never finished (a dead job). The poll gives up
--                   at a cap and records the outcome 'pull_gave_up'. A counter only: no name, UIN or value. Reset to 0 when a pull succeeds.
-- Erasure: unchanged, the row goes with its holding (ON DELETE CASCADE).
-- Rollback: expand-only. Revert the code; a synthetic-only project may drop the index and the column. Nothing else reads them.
ALTER TABLE public.fss_handoffs ADD COLUMN IF NOT EXISTS pull_attempts integer NOT NULL DEFAULT 0 CHECK (pull_attempts >= 0);
CREATE INDEX IF NOT EXISTS fss_handoffs_matched_poll_idx ON public.fss_handoffs (updated_at) WHERE state = 'matched';
