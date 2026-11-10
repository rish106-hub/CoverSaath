-- R2. Policy type the user tags at upload; later chooses the fact schema. Expand-only: one NOT NULL column with a constant
-- default (metadata-only add on PostgreSQL 11+). Existing cases read as 'other'. Not personal data, so erasure needs no new path.
-- Rollback: old code ignores the column; revert the code and keep or drop the column.
ALTER TABLE public.service_cases
  ADD COLUMN IF NOT EXISTS policy_type text NOT NULL DEFAULT 'other'
  CHECK (policy_type IN ('personal_health', 'group_health', 'term_life', 'other'));
