-- Sealed-column constraints (review fixes for run E1, ADR 0013). Expand-only on the data and safe to run more than once: only
-- CHECK constraints are added, and every existing row already satisfies them (a JSON column holds either a sealed envelope or
-- the JSON written before E1; a profile answer was always sealed).
--
--   * The four JSON columns that migration 019 relaxed accept a sealed envelope (`enc1.` or the padded `enc2.`) or valid JSON,
--     so a build that forgets to seal can no longer write readable JSON into them. A name or text column cannot be constrained
--     this way until the backfill has run everywhere (legacy plaintext is arbitrary text), so those stay as they are.
--   * profile_answers.value_ciphertext must be a sealed envelope.
-- Migration 019 is not edited (its checksum is recorded).
DO $$
DECLARE
  target record;
  constraint_name text;
BEGIN
  FOR target IN
    SELECT * FROM (VALUES
      ('ocr_jobs', 'result_json'),
      ('source_pages', 'blocks_json'),
      ('evidence_facts', 'value_json'),
      ('policy_answers', 'answer_json')
    ) AS item(table_name, column_name)
  LOOP
    constraint_name := format('%s_%s_sealed_or_json_check', target.table_name, target.column_name);
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = format('public.%I', target.table_name)::regclass AND conname = constraint_name
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (%I IS NULL OR %I ~ ''^enc[12][.]'' OR %I IS JSON)',
        target.table_name, constraint_name, target.column_name, target.column_name, target.column_name);
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.profile_answers'::regclass AND conname = 'profile_answers_value_sealed_check'
  ) THEN
    ALTER TABLE public.profile_answers
      ADD CONSTRAINT profile_answers_value_sealed_check CHECK (value_ciphertext ~ '^enc[12][.]');
  END IF;
END
$$;
