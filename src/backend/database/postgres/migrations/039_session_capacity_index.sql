-- P1-3: make the sign-in session capacity count sargable and indexed (docs/architecture/db-schema-review.md).
-- The count was `julianday(expires_at) > julianday(?)`, a per-row PL/pgSQL call over every non-revoked session, run under
-- one global lock. Every writer stores `toISOString()` (fixed width, UTC, `Z`), so a plain text comparison is exact under the
-- C collation (ADR 0004 D4), provided the format is enforced. This file adds that format check and a partial index on the
-- live (unrevoked) sessions. The application now filters on `expires_at > ?`.
-- The check is added NOT VALID and validated in the same transaction: api_sessions is small and short lived, and a legacy
-- row that is not fixed-width UTC makes the migration fail loudly, where a quiet text comparison would miscount it.
-- Existing julianday CHECKs stay. A non-conforming `expires_at` (offset form, no milliseconds, garbage) is now rejected.
-- Rollback: DROP INDEX api_sessions_live_expiry_idx and the constraint; old code (julianday) still works without either.
ALTER TABLE public.api_sessions
  ADD CONSTRAINT api_sessions_expires_at_format_check
  CHECK (expires_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$') NOT VALID;
ALTER TABLE public.api_sessions VALIDATE CONSTRAINT api_sessions_expires_at_format_check;
CREATE INDEX IF NOT EXISTS api_sessions_live_expiry_idx ON public.api_sessions (expires_at) WHERE revoked_at IS NULL;
