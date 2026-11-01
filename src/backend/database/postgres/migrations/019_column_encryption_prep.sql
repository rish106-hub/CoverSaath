-- Application-level column encryption, preparation (run E1b, ADR 0013). Expand-only in the data sense: no row is changed,
-- no column is added or dropped, and plaintext values already stored stay readable (the application reads an unprefixed value
-- as legacy plaintext until scripts/encrypt-existing-rows.mjs has sealed it). Safe to run more than once.
--
-- The application now writes `enc1.<keyId>.<nonce>.<tag>.<ciphertext>` strings into these columns:
--   adult_users.display_name, contact_email, contact_phone      household_members.display_name, households.display_name
--   source_pages.extracted_text, blocks_json                    ocr_jobs.result_json
--   policy_clauses.title, text                                  policy_answers.answer_json
--   evidence_facts.value_json
-- A sealed value is not JSON, so the single-column `IS JSON` CHECKs on the JSON columns and the plaintext length caps on the
-- clause text and title would reject it. Each such check is replaced by a looser `length()` cap sized for the envelope
-- (about 4/3 of the plaintext plus 60 characters); validity is checked in the application, which opens and parses every
-- value it reads. Multi-column checks that only compare a column with NULL are left alone.
-- Row level security stays on for every table involved (016); nothing here creates a table.
DO $$
DECLARE
  target record;
  old_check record;
  new_name text;
BEGIN
  FOR target IN
    SELECT * FROM (VALUES
      ('ocr_jobs', 'result_json', 16000000),
      ('source_pages', 'blocks_json', 2000000),
      ('evidence_facts', 'value_json', 1000000),
      ('policy_clauses', 'title', 2000),
      ('policy_clauses', 'text', 700000),
      ('policy_answers', 'answer_json', 400000)
    ) AS item(table_name, column_name, max_length)
  LOOP
    -- Single-column CHECK constraints on exactly this column (the IS JSON shape and the old length cap).
    FOR old_check IN
      SELECT con.conname
      FROM pg_constraint con
      JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = con.conkey[1]
      WHERE con.conrelid = format('public.%I', target.table_name)::regclass
        AND con.contype = 'c'
        AND array_length(con.conkey, 1) = 1
        AND att.attname = target.column_name
        AND con.conname NOT LIKE '%\_sealed\_len\_check'
    LOOP
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', target.table_name, old_check.conname);
    END LOOP;

    new_name := format('%s_%s_sealed_len_check', target.table_name, target.column_name);
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = format('public.%I', target.table_name)::regclass AND conname = new_name
    ) THEN
      IF target.column_name = 'text' THEN
        EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (length(%I) BETWEEN 1 AND %s)',
          target.table_name, new_name, target.column_name, target.max_length);
      ELSE
        EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (%I IS NULL OR length(%I) <= %s)',
          target.table_name, new_name, target.column_name, target.column_name, target.max_length);
      END IF;
    END IF;
  END LOOP;
END
$$;
