-- Chat provider consent (audit F1, invariant 2). Expand-only and safe to run more than once.
-- A model-worded assistant turn records the household grant (purpose coverage_reconstruction, scope household / derive / insurance_question,
-- recipient = the chat provider) it was dispatched and committed under, so revoking that grant erases the chat it made possible
-- (memory-erasure.js eraseMemoryForConsentGrant deletes the whole thread). Deterministic turns carry NULL: no provider was called.
-- Existing rows stay NULL. Row level security is unchanged (016_data_api_lockdown.sql).
-- Rollback: expand-only. Revert the code; a synthetic-only project may drop the column.
ALTER TABLE public.chat_turns ADD COLUMN IF NOT EXISTS consent_grant_id text REFERENCES public.consent_grants(id);
CREATE INDEX IF NOT EXISTS chat_turns_consent_idx ON public.chat_turns (consent_grant_id) WHERE consent_grant_id IS NOT NULL;
