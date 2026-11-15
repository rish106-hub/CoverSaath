-- Paid policy slots (owner decision 2026-11-15): the first policy of a household is free; every further policy schedule needs one paid
-- slot (Rs 199 through Razorpay Standard Checkout). Expand-only and safe to run more than once.
--   One row per Razorpay order created for a household. status 'created' -> 'paid' only after the server verified the checkout signature
--   (HMAC-SHA256 of "order_id|payment_id" under the key secret). Deterministic code decides: the allowed schedule count is 1 + paid rows.
--   order_id / payment_id are Razorpay's opaque ids; no card, UPI, bank or contact detail is stored. amount_paise is the price charged.
-- Household-linked so household erasure deletes it (src/contracts/data-lifecycle.js).
-- Row level security on with no policy; Data API roles hold nothing (see 016_data_api_lockdown.sql).
-- Rollback: expand-only. Leave PAYMENTS_ENABLED unset (no gate, routes answer 503); a synthetic-only project may DROP TABLE
--   public.policy_slot_payments and DELETE FROM schema_migrations WHERE version = '067_policy_slot_payments.sql'.
CREATE TABLE IF NOT EXISTS public.policy_slot_payments (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES public.households(id),
  adult_id text NOT NULL REFERENCES public.adult_users(id),
  provider text NOT NULL CHECK (provider IN ('razorpay')),
  order_id text NOT NULL UNIQUE CHECK (length(order_id) BETWEEN 1 AND 100),
  payment_id text UNIQUE CHECK (payment_id IS NULL OR length(payment_id) BETWEEN 1 AND 100),
  amount_paise integer NOT NULL CHECK (amount_paise >= 100),
  currency text NOT NULL CHECK (currency IN ('INR')),
  status text NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'paid')),
  created_at text NOT NULL,
  paid_at text,
  CHECK ((status = 'paid') = (payment_id IS NOT NULL AND paid_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS policy_slot_payments_household_idx ON public.policy_slot_payments (household_id, status);

ALTER TABLE public.policy_slot_payments ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.policy_slot_payments FROM %I', api_role);
    END IF;
  END LOOP;
END
$$;
