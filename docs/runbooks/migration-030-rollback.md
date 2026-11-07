# Migration 030 (D2) rollback

Migration `030_seal_remaining_columns.sql` is expand-only: it relaxes single-column checks on columns that now hold sealed text, adds `service_cases.stated_estimate_ciphertext`, adds `idempotency_keys.document_index` and its partial index. It changes no row and drops no column. Migrations are append-only: do not edit or delete the file. Roll back by a new migration, after the steps below.

## Order matters: data first, then code

Code that wrote `enc2.` values cannot be rolled back to a build older than D2 while sealed values are in the D2 columns. Unseal first, with the key still configured, then deploy the older build.

1. `node --env-file-if-exists=.env.local scripts/encrypt-existing-rows.mjs --dry-run --unseal` (counts only).
2. `node --env-file-if-exists=.env.local scripts/encrypt-existing-rows.mjs --unseal --i-understand-this-writes-plaintext`
   - Run as the table owner, in a quiet period, against a database backup point. It writes readable data back and prints counts only. A second run changes 0 rows.
   - **By default only the D2 columns are unsealed** (the ones migration 030 added), and the stated estimate moves back to the `stated_estimate_minor` bigint. The earlier E1 columns (names, e-mail, text, answers) stay sealed: a build from before D2 still reads them. Add `--include-e1` only when rolling back past E1 as well.
   - Do not set `DATA_ENCRYPTION_LEGACY_PLAINTEXT=false` afterwards: it refuses plaintext on read. The script warns when it is set.
   - Rows with a value it cannot decrypt are left as they are, counted in `unreadable`, and the exit code is 3. Fix the key configuration (`DATA_ENCRYPTION_PREVIOUS_KEYS_JSON`) and run again.
   - To roll back without unsealing, restore from the backup taken before the D2 backfill instead.
3. Deploy the older build.
4. Optional schema cleanup, as a **new** migration (not needed for the old build to run: every changed check still accepts plain JSON and plain text):

```sql
-- Only after step 2, and only if no sealed value remains.
ALTER TABLE public.idempotency_keys DROP COLUMN IF EXISTS document_index;       -- drops idempotency_keys_document_index_idx too
ALTER TABLE public.service_cases DROP CONSTRAINT IF EXISTS service_cases_stated_estimate_sealed_check;
ALTER TABLE public.service_cases DROP COLUMN IF EXISTS stated_estimate_ciphertext;  -- loses estimates still sealed: unseal first
-- The *_sealed_or_json_check and *_sealed_len_check constraints on the columns listed in 030 keep the old plaintext rule as
-- their second branch, so they are harmless to keep.
```

## Data loss risks

- Losing `DATA_ENCRYPTION_KEY_BASE64` loses every sealed column (ADR 0013). Keep the previous key in `DATA_ENCRYPTION_PREVIOUS_KEYS_JSON` until `--rotate` has finished.
- Dropping `stated_estimate_ciphertext` before unsealing loses user-stated estimates.
- `document_index` is keyed to the current data key. `--rotate` recomputes it together with the re-seal; run it before the old key is retired. Until then erasure matches the index under every key of the ring, so keep the old key in `DATA_ENCRYPTION_PREVIOUS_KEYS_JSON`. A record whose response cannot be decrypted keeps its old index (counted as unreadable).

## Check after a rollback

`npm run db:init` validates the schema; `SELECT count(*) FROM household_members WHERE date_of_birth ~ '^enc[12][.]'` (and the same pattern on the other registry columns) must be 0 before an older build runs.
