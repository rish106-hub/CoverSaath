-- App user data, part 5: adult contact lookup (spec user-data-store-spec.md, ADR 0015). Expand-only: three nullable columns on
-- adult_users, one partial unique index; no existing value changes and no table is added (RLS from 016 already covers it).
--   phone_ciphertext   the sign-in phone, sealed (AES-256-GCM, AAD adult_users.phone_ciphertext.<id>)
--   phone_hash         keyed HMAC of the normalised phone, so a phone can be matched without opening any row
--   contact_email_hash keyed HMAC of the lower-cased e-mail; UNIQUE, so one e-mail maps to one household (POST /api/v1/access)
-- The HMAC key is derived from the data encryption key in the application; a hash never leaves the database layer. Existing
-- adults get a hash from scripts/backfill-adult-contacts.mjs (a SQL migration cannot hold the key); an adult whose e-mail is
-- shared with another adult is skipped and reported, never merged.
ALTER TABLE public.adult_users ADD COLUMN IF NOT EXISTS phone_ciphertext text;
ALTER TABLE public.adult_users ADD COLUMN IF NOT EXISTS phone_hash text;
ALTER TABLE public.adult_users ADD COLUMN IF NOT EXISTS contact_email_hash text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.adult_users'::regclass AND conname = 'adult_users_phone_sealed_check') THEN
    ALTER TABLE public.adult_users ADD CONSTRAINT adult_users_phone_sealed_check
      CHECK (phone_ciphertext IS NULL OR phone_ciphertext ~ '^enc[12][.]');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.adult_users'::regclass AND conname = 'adult_users_contact_hash_shape_check') THEN
    ALTER TABLE public.adult_users ADD CONSTRAINT adult_users_contact_hash_shape_check
      CHECK ((phone_hash IS NULL OR phone_hash ~ '^[0-9a-f]{64}$') AND (contact_email_hash IS NULL OR contact_email_hash ~ '^[0-9a-f]{64}$'));
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS adult_users_contact_email_hash_unique ON public.adult_users (contact_email_hash) WHERE contact_email_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS adult_users_phone_hash_idx ON public.adult_users (phone_hash) WHERE phone_hash IS NOT NULL;
