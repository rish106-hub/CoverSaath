-- P1-1 (db-schema-review). Expand-only: two nullable columns and two partial indexes on idempotency_keys.
-- Migration 030 sealed idempotency_keys.response_json, so erasure can no longer find run and task keys by the plaintext ids their
-- response mentions. These columns give erasure a real scope: every writer sets household_id (and case_id when known) on insert,
-- and erasure deletes WHERE household_id = ? / case_id = ?.
-- No foreign keys on purpose (same reasoning as app_events and job_queue): a key must never block an erasure.
-- No backfill: keys live 24 hours, so rows written before this migration expire on their own. Erasure keeps the old
-- plaintext-needle and document-upload scope queries for those rows until one TTL has passed after deploy.
-- Rollback: old code ignores the columns; revert the code and keep or drop the columns.
ALTER TABLE public.idempotency_keys ADD COLUMN IF NOT EXISTS household_id text;
ALTER TABLE public.idempotency_keys ADD COLUMN IF NOT EXISTS case_id text;
CREATE INDEX IF NOT EXISTS idempotency_keys_household_idx ON public.idempotency_keys (household_id) WHERE household_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idempotency_keys_case_idx ON public.idempotency_keys (case_id) WHERE case_id IS NOT NULL;
