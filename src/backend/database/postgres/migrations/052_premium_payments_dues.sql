-- Holdings and memory, part 5: premium_payments and premium_dues (ADR 0032, app-data-plan.md money desk). Expand-only and safe to run
-- more than once: two new tables, their triggers and their lockdown.
--   premium_payments  one premium a household paid on a holding: amount, date, channel, who it was paid through, an optional receipt.
--   premium_dues      one premium expected on a holding on a date, and whether it was paid.
-- Classification (honest, not minimal):
--   * Exact amounts are application-encrypted (amount_enc, AAD <table>.amount_enc.<row id>, enc2 only), like policy_facts money (ADR 0025
--     D3): only a coarse amount_band (plain, the 044 vocabulary) is stored beside them. NO plaintext amount column.
--   * The seller of a policy (agent name, agent code) is sealed (agent_name_enc, agent_code_enc). paid_via is a closed enum and plain.
--   * paid_on and due_on are calendar days (plain): reminders and 80D reporting must read them in SQL without unsealing.
-- Rules these tables enforce themselves: holding, receipt document, payer and consent grant belong to the row's household (scope trigger);
-- a premium_dues row may point at the payment that settled it, in the same household and holding; a payment on an agent channel
-- (paid_via agent) carries no plaintext of the agent: only the sealed columns.
-- Erased with their holding (FK cascade), the household, and on consent withdrawal (application erasure paths).
-- Row level security is on with no policy and the Data API roles get no privileges (see 016_data_api_lockdown.sql).
-- Consent, privacy and notice wording is a DRAFT and needs legal review.
-- Rollback: expand-only. Revert the code and turn HOLDINGS_ENABLED off; a synthetic-only project may drop both tables.
CREATE TABLE IF NOT EXISTS public.premium_payments (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 100),
  household_id text NOT NULL REFERENCES public.households(id),
  holding_id text NOT NULL REFERENCES public.policy_holdings(id) ON DELETE CASCADE,
  amount_enc text NOT NULL CHECK (amount_enc ~ '^enc2[.]'),
  amount_band text NOT NULL CHECK (amount_band IN ('lt_10k', '10k_50k', '50k_1l', '1l_5l', '5l_10l', '10l_25l', '25l_50l', '50l_1cr', 'gte_1cr')),
  currency text NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  paid_on text NOT NULL CHECK (paid_on ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'),
  channel text NOT NULL CHECK (channel IN ('upi', 'card', 'netbanking', 'cheque', 'cash', 'salary_deduction', 'unknown')),
  paid_via text NOT NULL DEFAULT 'self' CHECK (paid_via IN ('self', 'agent', 'employer', 'bank')),
  payer_member_id text REFERENCES public.household_members(id) ON DELETE SET NULL,
  agent_name_enc text CHECK (agent_name_enc IS NULL OR agent_name_enc ~ '^enc2[.]'),
  agent_code_enc text CHECK (agent_code_enc IS NULL OR agent_code_enc ~ '^enc2[.]'),
  receipt_document_id text REFERENCES public.document_uploads(id) ON DELETE SET NULL,
  consent_grant_id text NOT NULL REFERENCES public.consent_grants(id),
  created_at text NOT NULL,
  CONSTRAINT premium_payments_agent_via_check CHECK ((agent_name_enc IS NULL AND agent_code_enc IS NULL) OR paid_via = 'agent')
);

CREATE INDEX IF NOT EXISTS premium_payments_household_idx ON public.premium_payments (household_id, holding_id, paid_on);
CREATE INDEX IF NOT EXISTS premium_payments_holding_idx ON public.premium_payments (holding_id);
CREATE INDEX IF NOT EXISTS premium_payments_payer_idx ON public.premium_payments (payer_member_id) WHERE payer_member_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS premium_payments_receipt_idx ON public.premium_payments (receipt_document_id) WHERE receipt_document_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS premium_payments_consent_idx ON public.premium_payments (consent_grant_id);

CREATE TABLE IF NOT EXISTS public.premium_dues (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 100),
  household_id text NOT NULL REFERENCES public.households(id),
  holding_id text NOT NULL REFERENCES public.policy_holdings(id) ON DELETE CASCADE,
  due_on text NOT NULL CHECK (due_on ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'),
  amount_enc text NOT NULL CHECK (amount_enc ~ '^enc2[.]'),
  amount_band text NOT NULL CHECK (amount_band IN ('lt_10k', '10k_50k', '50k_1l', '1l_5l', '5l_10l', '10l_25l', '25l_50l', '50l_1cr', 'gte_1cr')),
  currency text NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  state text NOT NULL DEFAULT 'expected' CHECK (state IN ('expected', 'paid', 'overdue')),
  paid_payment_id text REFERENCES public.premium_payments(id) ON DELETE SET NULL,
  consent_grant_id text NOT NULL REFERENCES public.consent_grants(id),
  created_at text NOT NULL,
  updated_at text NOT NULL,
  UNIQUE (holding_id, due_on),
  CONSTRAINT premium_dues_paid_check CHECK (paid_payment_id IS NULL OR state = 'paid')
);

CREATE INDEX IF NOT EXISTS premium_dues_household_idx ON public.premium_dues (household_id, due_on);
CREATE INDEX IF NOT EXISTS premium_dues_state_idx ON public.premium_dues (household_id, state, due_on);
CREATE INDEX IF NOT EXISTS premium_dues_payment_idx ON public.premium_dues (paid_payment_id) WHERE paid_payment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS premium_dues_consent_idx ON public.premium_dues (consent_grant_id);

CREATE OR REPLACE FUNCTION public.premium_payments_scope_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.policy_holdings AS holding WHERE holding.id = NEW.holding_id AND holding.household_id = NEW.household_id
  ) THEN
    RAISE EXCEPTION 'premium payment must match a holding of its household';
  END IF;
  IF NEW.payer_member_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.household_members AS member WHERE member.id = NEW.payer_member_id AND member.household_id = NEW.household_id
  ) THEN
    RAISE EXCEPTION 'premium payment payer must be a member of its household';
  END IF;
  IF NEW.receipt_document_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.document_uploads AS document WHERE document.id = NEW.receipt_document_id AND document.household_id = NEW.household_id
  ) THEN
    RAISE EXCEPTION 'premium payment receipt must be a document of its household';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.consent_grants AS grant_record WHERE grant_record.id = NEW.consent_grant_id AND grant_record.household_id = NEW.household_id
  ) THEN
    RAISE EXCEPTION 'premium payment must use a consent grant of its household';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS premium_payments_scope_insert ON public.premium_payments;
CREATE TRIGGER premium_payments_scope_insert
BEFORE INSERT ON public.premium_payments
FOR EACH ROW EXECUTE FUNCTION public.premium_payments_scope_fn();
DROP TRIGGER IF EXISTS premium_payments_scope_update ON public.premium_payments;
CREATE TRIGGER premium_payments_scope_update
BEFORE UPDATE OF household_id, holding_id, payer_member_id, receipt_document_id, consent_grant_id ON public.premium_payments
FOR EACH ROW EXECUTE FUNCTION public.premium_payments_scope_fn();

CREATE OR REPLACE FUNCTION public.premium_dues_scope_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.policy_holdings AS holding WHERE holding.id = NEW.holding_id AND holding.household_id = NEW.household_id
  ) THEN
    RAISE EXCEPTION 'premium due must match a holding of its household';
  END IF;
  IF NEW.paid_payment_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.premium_payments AS payment
    WHERE payment.id = NEW.paid_payment_id AND payment.household_id = NEW.household_id AND payment.holding_id = NEW.holding_id
  ) THEN
    RAISE EXCEPTION 'premium due must be settled by a payment of its household and holding';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.consent_grants AS grant_record WHERE grant_record.id = NEW.consent_grant_id AND grant_record.household_id = NEW.household_id
  ) THEN
    RAISE EXCEPTION 'premium due must use a consent grant of its household';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS premium_dues_scope_insert ON public.premium_dues;
CREATE TRIGGER premium_dues_scope_insert
BEFORE INSERT ON public.premium_dues
FOR EACH ROW EXECUTE FUNCTION public.premium_dues_scope_fn();
DROP TRIGGER IF EXISTS premium_dues_scope_update ON public.premium_dues;
CREATE TRIGGER premium_dues_scope_update
BEFORE UPDATE OF household_id, holding_id, paid_payment_id, consent_grant_id ON public.premium_dues
FOR EACH ROW EXECUTE FUNCTION public.premium_dues_scope_fn();

ALTER TABLE public.premium_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.premium_dues ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.premium_payments FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON TABLE public.premium_dues FROM %I', api_role);
    END IF;
  END LOOP;
  REVOKE ALL ON TABLE public.premium_payments FROM PUBLIC;
  REVOKE ALL ON TABLE public.premium_dues FROM PUBLIC;
END
$$;
