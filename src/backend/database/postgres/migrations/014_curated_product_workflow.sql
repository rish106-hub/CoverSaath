-- Trusted insurer-source workflow and bounded reviewer grants. Mirrors SQLite migration 018: same tables, columns, checks,
-- indexes, trigger names, timing, events and messages. Expand-only.

ALTER TABLE public.catalogue_reviewer_grants ADD COLUMN expires_at text;
ALTER TABLE public.catalogue_reviewer_grants ADD COLUMN case_id text REFERENCES public.service_cases(id);
ALTER TABLE public.catalogue_reviewer_grants ADD COLUMN granted_at text;

CREATE FUNCTION public.catalogue_reviewer_grants_independent_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.kind = 'independent_reviewer' AND NEW.status = 'active' AND (NEW.expires_at IS NULL OR NEW.case_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.service_cases AS service_case WHERE service_case.id = NEW.case_id AND service_case.household_id = NEW.household_id)) THEN
    RAISE EXCEPTION 'an independent reviewer grant needs an expiry and a case of the household';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER catalogue_reviewer_grants_independent_insert
BEFORE INSERT ON public.catalogue_reviewer_grants
FOR EACH ROW EXECUTE FUNCTION public.catalogue_reviewer_grants_independent_fn();

CREATE TRIGGER catalogue_reviewer_grants_independent_update
BEFORE UPDATE ON public.catalogue_reviewer_grants
FOR EACH ROW EXECUTE FUNCTION public.catalogue_reviewer_grants_independent_fn();

CREATE TABLE public.source_curator_grants (
  id text PRIMARY KEY,
  adult_user_id text NOT NULL REFERENCES public.adult_users(id),
  role text NOT NULL CHECK (role IN ('curator', 'checker')),
  status text NOT NULL CHECK (status IN ('active', 'revoked')),
  granted_by text NOT NULL CHECK (length(granted_by) BETWEEN 1 AND 128),
  created_at text NOT NULL,
  expires_at text NOT NULL,
  revoked_at text,
  UNIQUE (adult_user_id, role)
);

CREATE TABLE public.curated_source_archives (
  sha256 text PRIMARY KEY CHECK (length(sha256) = 64),
  byte_size bigint NOT NULL CHECK (byte_size BETWEEN 1 AND 20971520),
  content bytea NOT NULL CHECK (length(content) = byte_size),
  created_at text NOT NULL
);

CREATE TABLE public.curated_product_submissions (
  id text PRIMARY KEY,
  uin text NOT NULL CHECK (length(uin) BETWEEN 12 AND 24),
  insurer text NOT NULL CHECK (length(insurer) BETWEEN 1 AND 200),
  product_name text NOT NULL CHECK (length(product_name) BETWEEN 1 AND 200),
  wording_version text NOT NULL CHECK (length(wording_version) BETWEEN 1 AND 200),
  source_url text NOT NULL CHECK (length(source_url) BETWEEN 9 AND 500 AND substr(lower(source_url), 1, 8) = 'https://'),
  source_version_id text NOT NULL CHECK (length(source_version_id) BETWEEN 1 AND 200),
  content_sha256 text NOT NULL REFERENCES public.curated_source_archives(sha256),
  retrieved_on text NOT NULL,
  effective_from text,
  page_texts_json text CHECK (page_texts_json IS NULL OR page_texts_json IS JSON ARRAY),
  facts_json text NOT NULL CHECK (facts_json IS JSON ARRAY),
  machine_checks_json text NOT NULL CHECK (machine_checks_json IS JSON OBJECT),
  state text NOT NULL CHECK (state IN ('collected', 'candidate', 'checked', 'published', 'rejected', 'needs_revalidation', 'superseded')),
  collected_by text NOT NULL REFERENCES public.adult_users(id),
  checked_by text REFERENCES public.adult_users(id),
  checked_at text,
  published_at text,
  previous_id text REFERENCES public.curated_product_submissions(id),
  last_revalidated_at text,
  created_at text NOT NULL,
  CHECK (checked_by IS NULL OR checked_by <> collected_by),
  CHECK (state NOT IN ('checked', 'published') OR (checked_by IS NOT NULL AND checked_at IS NOT NULL)),
  CHECK (state <> 'published' OR published_at IS NOT NULL)
);

CREATE UNIQUE INDEX curated_product_submissions_one_published_idx ON public.curated_product_submissions(uin, wording_version) WHERE state = 'published';
CREATE INDEX curated_product_submissions_uin_idx ON public.curated_product_submissions(uin, wording_version, state);

CREATE FUNCTION public.curated_source_archives_immutable_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'curated source archives are immutable';
END;
$$;

CREATE TRIGGER curated_source_archives_immutable
BEFORE UPDATE ON public.curated_source_archives
FOR EACH ROW EXECUTE FUNCTION public.curated_source_archives_immutable_fn();

CREATE FUNCTION public.curated_source_archives_no_delete_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'curated source archives are never deleted';
END;
$$;

CREATE TRIGGER curated_source_archives_no_delete
BEFORE DELETE ON public.curated_source_archives
FOR EACH ROW EXECUTE FUNCTION public.curated_source_archives_no_delete_fn();

CREATE FUNCTION public.curated_product_submissions_content_immutable_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.uin <> OLD.uin OR NEW.insurer <> OLD.insurer OR NEW.product_name <> OLD.product_name OR NEW.wording_version <> OLD.wording_version
    OR NEW.source_url <> OLD.source_url OR NEW.source_version_id <> OLD.source_version_id OR NEW.content_sha256 <> OLD.content_sha256
    OR NEW.retrieved_on <> OLD.retrieved_on OR NEW.collected_by <> OLD.collected_by OR NEW.created_at <> OLD.created_at
    OR (OLD.state NOT IN ('collected', 'candidate') AND (NEW.facts_json <> OLD.facts_json OR NEW.machine_checks_json <> OLD.machine_checks_json))
    OR NEW.effective_from IS DISTINCT FROM OLD.effective_from OR NEW.page_texts_json IS DISTINCT FROM OLD.page_texts_json OR NEW.previous_id IS DISTINCT FROM OLD.previous_id
    OR (OLD.checked_by IS NOT NULL AND NEW.checked_by IS DISTINCT FROM OLD.checked_by)
    OR (OLD.checked_at IS NOT NULL AND NEW.checked_at IS DISTINCT FROM OLD.checked_at) OR (OLD.published_at IS NOT NULL AND NEW.published_at IS DISTINCT FROM OLD.published_at)
  THEN
    RAISE EXCEPTION 'curated product content is immutable once written; register a new submission instead';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER curated_product_submissions_content_immutable
BEFORE UPDATE ON public.curated_product_submissions
FOR EACH ROW EXECUTE FUNCTION public.curated_product_submissions_content_immutable_fn();

CREATE FUNCTION public.curated_product_submissions_state_transition_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.state <> OLD.state AND NOT (
    (OLD.state = 'collected' AND NEW.state IN ('candidate', 'superseded'))
    OR (OLD.state = 'candidate' AND NEW.state IN ('checked', 'rejected', 'superseded'))
    OR (OLD.state = 'checked' AND NEW.state IN ('published', 'needs_revalidation'))
    OR (OLD.state = 'published' AND NEW.state IN ('needs_revalidation', 'superseded'))
    OR (OLD.state = 'needs_revalidation' AND NEW.state = 'superseded')
  ) THEN
    RAISE EXCEPTION 'illegal curated product state transition';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER curated_product_submissions_state_transition
BEFORE UPDATE OF state ON public.curated_product_submissions
FOR EACH ROW EXECUTE FUNCTION public.curated_product_submissions_state_transition_fn();

CREATE FUNCTION public.curated_product_submissions_no_delete_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'curated product submissions are never deleted';
END;
$$;

CREATE TRIGGER curated_product_submissions_no_delete
BEFORE DELETE ON public.curated_product_submissions
FOR EACH ROW EXECUTE FUNCTION public.curated_product_submissions_no_delete_fn();
