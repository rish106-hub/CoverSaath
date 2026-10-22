-- Operator-signed curated actions and byte-derived page text. Mirrors SQLite migration 019. Expand-only.
-- An active checker grant must carry an Ed25519 public key; curated_action_nonces records each accepted signed action once;
-- page_text_origin / text_extractor_version record where stored page text came from and are immutable.

ALTER TABLE public.source_curator_grants ADD COLUMN public_key text CHECK (public_key IS NULL OR length(public_key) BETWEEN 40 AND 200);

CREATE FUNCTION public.source_curator_grants_checker_key_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.role = 'checker' AND NEW.status = 'active' AND NEW.public_key IS NULL THEN
    RAISE EXCEPTION 'an active checker grant needs a public key';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER source_curator_grants_checker_key_insert
BEFORE INSERT ON public.source_curator_grants
FOR EACH ROW EXECUTE FUNCTION public.source_curator_grants_checker_key_fn();

CREATE TRIGGER source_curator_grants_checker_key_update
BEFORE UPDATE ON public.source_curator_grants
FOR EACH ROW EXECUTE FUNCTION public.source_curator_grants_checker_key_fn();

CREATE TABLE public.curated_action_nonces (
  nonce text PRIMARY KEY CHECK (length(nonce) = 32),
  grant_id text NOT NULL REFERENCES public.source_curator_grants(id),
  action text NOT NULL CHECK (action IN ('check', 'publish')),
  submission_id text NOT NULL REFERENCES public.curated_product_submissions(id),
  signature_sha256 text NOT NULL CHECK (length(signature_sha256) = 64),
  used_at text NOT NULL
);

CREATE FUNCTION public.curated_action_nonces_immutable_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'curated action nonces are immutable';
END;
$$;

CREATE TRIGGER curated_action_nonces_immutable
BEFORE UPDATE ON public.curated_action_nonces
FOR EACH ROW EXECUTE FUNCTION public.curated_action_nonces_immutable_fn();

CREATE FUNCTION public.curated_action_nonces_no_delete_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'curated action nonces are never deleted';
END;
$$;

CREATE TRIGGER curated_action_nonces_no_delete
BEFORE DELETE ON public.curated_action_nonces
FOR EACH ROW EXECUTE FUNCTION public.curated_action_nonces_no_delete_fn();

ALTER TABLE public.curated_product_submissions ADD COLUMN page_text_origin text CHECK (page_text_origin IS NULL OR page_text_origin IN ('derived_from_bytes', 'curator_supplied'));
ALTER TABLE public.curated_product_submissions ADD COLUMN text_extractor_version text CHECK (text_extractor_version IS NULL OR length(text_extractor_version) BETWEEN 1 AND 64);

CREATE FUNCTION public.curated_product_submissions_text_origin_immutable_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.page_text_origin IS DISTINCT FROM OLD.page_text_origin OR NEW.text_extractor_version IS DISTINCT FROM OLD.text_extractor_version THEN
    RAISE EXCEPTION 'curated page text origin is immutable once written';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER curated_product_submissions_text_origin_immutable
BEFORE UPDATE ON public.curated_product_submissions
FOR EACH ROW EXECUTE FUNCTION public.curated_product_submissions_text_origin_immutable_fn();
