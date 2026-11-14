# Runbook: live run (real ClamAV and Sarvam, local database, stub FSS)

Runs the P0 journey ([demo-journey](demo-journey.md)) against live providers on a local machine, then asks the 100 eval questions through chat v1. Synthetic documents only. Costs: one Sarvam OCR call per document per run. Findings of the first run: [2026-11-14 audit](../audits/2026-11-14-live-run.md).

## Prerequisites

- Local PostgreSQL 17 with pgvector on port 54329 ([local-postgres](local-postgres.md)).
- `clamd` on 127.0.0.1:3310 ([clamav](clamav.md)). If clamd reports `Malformed database`, update ClamAV (`brew upgrade clamav`) and run `freshclam`.
- `.env.local` with `SARVAM_API_KEY` (the launcher reads it like `npm run dev` and prints nothing from it).

## Steps (repo root)

```sh
export LIVE_RUN_BOOTSTRAP_TOKEN="$(openssl rand -hex 24)"
export LIVE_RUN_ENCRYPTION_KEY_BASE64="$(openssl rand -base64 32)"
psql -h localhost -p 54329 -U coversaath -d postgres -c "CREATE DATABASE coversaath_live"
psql -h localhost -p 54329 -U coversaath -d coversaath_live -c "CREATE SCHEMA extensions" -c "CREATE EXTENSION vector SCHEMA extensions"
node scripts/live-run/launch.mjs initdb
node scripts/live-run/build-eval-pdfs.mjs           # writes .local/live-run/pdfs/
node scripts/live-run/fss-stub.mjs 3999             # terminal 1
node scripts/live-run/launch.mjs server             # terminal 2
node scripts/live-run/launch.mjs worker             # terminal 3
node scripts/live-run/journey.mjs --eval            # steps 1-7, then 100 questions through chat v1
```

Notes:

- Migration 053 expects pgvector in the `extensions` schema (Supabase layout), hence the second `psql` line.
- The session token stays in memory; nothing is written to disk. Drop the database after the run.
- The FSS stub serves an invented insurer and product. Replace `LIVE_RUN_FSS_URL` with a real FSS once one branch serves every route.
- Chat runs without model wording unless a `coverage_reconstruction` provider grant is added ([chat-and-memory](chat-and-memory.md) section 4).

## Rollback

Stop the processes and `DROP DATABASE coversaath_live`. Nothing hosted is touched.
