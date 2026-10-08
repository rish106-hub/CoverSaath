# Knowvia GCP staging deploy (Cloud Run, asia-south1)

Status: kit written and dry-run verified on a machine without gcloud. It has **not been run against a real GCP project**. Flags marked `# VERIFY:` in `scripts/deploy/gcp-staging.sh` must be confirmed against your installed gcloud.

## Read this first: staging is pre-M3 and NON-DURABLE

| Limitation | Why | Consequence |
|---|---|---|
| Documents are stored on the instance's local disk (`DOCUMENT_STORAGE_PATH=/tmp/knowvia-documents`) | Object storage (GCS) is milestone M3 | Documents vanish whenever the instance is replaced: new revision, crash, platform maintenance. Cloud Run's disk is also memory-backed, so stored documents consume the 1 GiB instance memory. Do not treat staging as a system of record. |
| Breakdown jobs run in-process (`setImmediate`) | Cloud Tasks + worker is M3 | A restart kills running jobs. A second instance would not see the first one's files or jobs. |
| Therefore the service is pinned to `--min-instances=1 --max-instances=1 --no-cpu-throttling` | Background work needs CPU between requests, and state is per-instance | No autoscaling, no zero-downtime deploy guarantee; a revision swap drops local documents. Cost is a continuous instance (about one vCPU and 1 GiB all month). |
| AI breakdown is unconfigured | Gemini on Vertex is not implemented (`@ai-sdk/google-vertex` is not installed). The plan forbids sending real PDFs through an AI Studio key. | `LLM_MODEL` and `BREAKDOWN_LLM_MODEL` are deliberately not set, so the runner fails closed. Staging exercises UI, auth, DB, upload and OCR plumbing only. |
| Uploads stay quarantined by default | `DOCUMENT_SCAN_MODE` unset means `antivirus_required` and no scanner exists yet | To exercise upload in staging you must opt in with `DOCUMENT_SCAN_MODE=structural_only` (structure check only, no antivirus). Decide this consciously; do not use real third-party documents with it. |
| Cloud SQL uses a public IP reachable only through the Cloud SQL connector | Private IP needs VPC and egress setup | No authorized networks are added. The plan's private IP is deferred to M8. |

These change at M3 (GCS, Cloud Tasks, a worker service, multi-instance) and M8 (private IP, OpenTofu).

## Prerequisites (you do these; the script will not)

1. Install the SDK: `brew install --cask google-cloud-sdk`
2. Sign in: `gcloud auth login`
3. Create a GCP project and note its **project ID** (not the display name). Link a billing account (new-account credits are fine) in the Cloud console.
4. Decide a budget amount in the billing account's currency (for example `3000INR`) and find the billing account ID: `gcloud billing accounts list`
5. Have the Sarvam API key ready (optional; without it OCR is unconfigured).
6. Optional analytics: the public PostHog project key (`phc_...`). It is public by design and is baked into the UI at build time.

## Run

```bash
export GCP_PROJECT_ID=<your-project-id>
export BILLING_ACCOUNT_ID=<AAAAAA-BBBBBB-CCCCCC>   # optional but strongly recommended
export BUDGET_AMOUNT=3000INR                        # required when BILLING_ACCOUNT_ID is set
export SARVAM_API_KEY=...                           # optional; otherwise prompted with hidden input
export VITE_POSTHOG_KEY=phc_...                     # optional
# export DOCUMENT_SCAN_MODE=structural_only         # optional, see limitations

scripts/deploy/gcp-staging.sh --dry-run             # review every command first
scripts/deploy/gcp-staging.sh                       # real run, safe to repeat
scripts/deploy/smoke.sh https://<service-url>       # re-run checks any time
```

What the script does, in order: enable APIs; create the runtime service account (`roles/cloudsql.client`, `roles/logging.logWriter`; secret access is granted per secret only); create the Artifact Registry repo; create Cloud SQL Postgres 16 with backups and PITR; create secrets only when absent; create the budget alert; build and deploy from source with Cloud Build (no local Docker); confirm the assigned URL matches `ALLOWED_HOSTS` and `ALLOWED_ORIGINS` (it predicts the `https://<service>-<project-number>.asia-south1.run.app` URL up front, because the server refuses to start without `ALLOWED_HOSTS`, and updates the variables only if the real URL differs); run the smoke test; print rollback commands.

Re-runs never rotate the database password or overwrite secrets. Every run redeploys the service, which replaces the instance and therefore **wipes local documents**.

## Environment variables (names only)

| Variable | Source | Notes |
|---|---|---|
| `NODE_ENV=production`, `HOST=0.0.0.0`, `TRUST_PROXY_HOPS=1`, `STATIC_DIR=dist`, `POSTHOG_REGION=eu`, `SHUTDOWN_GRACE_MS=8000` | env var | `PORT` is injected by Cloud Run (8080). Shutdown grace stays under Cloud Run's 10 s SIGTERM window. |
| `ALLOWED_HOSTS`, `ALLOWED_ORIGINS` | env var | Derived from the service URL. Add a custom domain here later. |
| `DOCUMENT_STORAGE_PATH`, `DATABASE_POOL_MAX`, `DOCUMENT_SCAN_MODE` (opt-in) | env var | See limitations. |
| `DATABASE_URL` | secret `knowvia-database-url` | Unix-socket form `postgresql://knowvia_app:...@/knowvia?host=/cloudsql/<connection-name>`. Required in production. |
| `KNOWVIA_BOOTSTRAP_TOKEN` | secret `knowvia-bootstrap-token` | Generated with openssl. Creates the first household. |
| `DOCUMENT_ENCRYPTION_KEY_BASE64` | secret `knowvia-document-encryption-key` | Generated 32-byte key. Losing it makes stored documents unreadable. |
| `SARVAM_API_KEY` | secret `knowvia-sarvam-api-key` | Mounted only if the secret exists. |
| `VITE_POSTHOG_KEY`, `VITE_POSTHOG_HOST` | build time only | Written to a temporary `scripts/deploy/vite-public.env`, removed on exit. Host defaults to `/ingest` (the same-origin proxy). Confirm that matches how `src/ui/posthog.js` uses it. |

Left unset on purpose: `LLM_MODEL`, `BREAKDOWN_LLM_MODEL`, `GEMINI_API_KEY`, `OPENAI_API_KEY`.

## Migrations

`openDatabase` (`src/backend/database/postgres-schema.js`) runs `runMigrations` by default. Migrations are applied in one transaction guarded by `pg_advisory_xact_lock`, with checksums (an edited applied file is refused). The server opens the database **lazily on the first request that needs it**, not at process start (`getBackend` in `src/server/create-server.js`). So migrations run when the first `/ready` or API call arrives, which is the smoke step on a fresh deploy. This is safe with one instance and would also be safe with several, because of the advisory lock. Caveats:

- The pool's `statement_timeout` (default 15 s, `DATABASE_STATEMENT_TIMEOUT_MS`) also bounds migrations. A big future migration needs a higher value.
- A failed migration resets the lazy init, so the next request retries it; `/ready` stays failing until it succeeds.
- Migrations are forward-only. Rolling back the revision does not roll back the schema; only roll back to code compatible with the current schema.
- The `knowvia_app` user is created through `gcloud sql users create`, which grants it the `cloudsqlsuperuser` role, enough for DDL. Narrow this at M8.

## Runtime import check

`@electric-sql/pglite` is a devDependency, but it is imported dynamically (`await import(...)` inside `createDatabase`) only when no `DATABASE_URL` is given. The production image installs with `npm ci --omit=dev`, so PGlite is absent; the server will not crash at import time. If `DATABASE_URL` is missing in production the server refuses to start the database (`DATABASE_URL is required in production`), which is the intended behaviour.

## Backups

The script creates the instance with automated daily backups (start 21:00 UTC, 7 retained) and point-in-time recovery. Verify and drill:

```bash
gcloud sql instances describe knowvia-staging-pg --project $GCP_PROJECT_ID \
  --format 'value(settings.backupConfiguration.enabled,settings.backupConfiguration.pointInTimeRecoveryEnabled)'
gcloud sql backups list --instance knowvia-staging-pg --project $GCP_PROJECT_ID
# Restore drill (creates a NEW instance; does not touch the original):
gcloud sql instances clone knowvia-staging-pg knowvia-staging-restore-test --point-in-time <RFC3339-UTC> --project $GCP_PROJECT_ID
```

Backups protect the database only. They do not protect documents, which are on local disk (see limitations).

## Budget

The script creates a budget with alerts at 50%, 90% and 100% when `BILLING_ACCOUNT_ID` and `BUDGET_AMOUNT` are set. Without them, create one yourself:

```bash
gcloud billing budgets create --billing-account <ID> --display-name knowvia-staging \
  --filter-projects projects/<PROJECT_NUMBER> --budget-amount 3000INR \
  --threshold-rule percent=0.5 --threshold-rule percent=0.9 --threshold-rule percent=1.0
```

Budgets only send alerts to billing admins; they do not stop spending. The beta Gemini cap of 300 rupees is a separate in-app limit and is not exercised until Vertex lands.

## Cost estimate (estimate only, not verified against current GCP pricing)

The plan puts the smallest configuration at about 1,000 to 2,000 rupees a month, dominated by Cloud SQL. Expect:

- Cloud SQL `db-g1-small` with 10 GB SSD and backups: the largest line, always on.
- Cloud Run with one always-allocated instance (1 vCPU, 1 GiB): a continuous charge, because CPU is not throttled. This is a real cost and is higher than a scale-to-zero service.
- Cloud Build, Artifact Registry, Secret Manager, logging: small at this volume.

Check the GCP pricing calculator for asia-south1 before relying on these figures. New-account credits should cover the beta.

## Rollback

```bash
gcloud run revisions list --service knowvia-staging-api --region asia-south1 --project $GCP_PROJECT_ID
gcloud run services update-traffic knowvia-staging-api --to-revisions <PREVIOUS_REVISION>=100 \
  --region asia-south1 --project $GCP_PROJECT_ID
```

Traffic moves to the previous revision's instance; local documents from the replaced instance are gone either way. Schema migrations are not reverted.

## Logs and first-household bootstrap

```bash
gcloud run services logs read knowvia-staging-api --region asia-south1 --project $GCP_PROJECT_ID --limit 100
gcloud secrets versions access latest --secret knowvia-bootstrap-token --project $GCP_PROJECT_ID   # prints the token; do not paste it into chat or commits
```

## Teardown

```bash
P=$GCP_PROJECT_ID; R=asia-south1
gcloud run services delete knowvia-staging-api --region $R --project $P
gcloud sql instances delete knowvia-staging-pg --project $P          # destroys the database and its backups
for s in knowvia-database-url knowvia-db-password knowvia-bootstrap-token knowvia-document-encryption-key knowvia-sarvam-api-key; do
  gcloud secrets delete $s --project $P
done
gcloud iam service-accounts delete knowvia-runtime@$P.iam.gserviceaccount.com --project $P
gcloud artifacts repositories delete cloud-run-source-deploy --location $R --project $P
gcloud billing budgets list --billing-account <ID>   # then: gcloud billing budgets delete <BUDGET_NAME>
# Or delete the whole project: gcloud projects delete $P
```

## Not done (do not assume any of these exist)

- Vertex AI Gemini (`@ai-sdk/google-vertex`, `roles/aiplatform.user` is left commented in the script).
- GCS document storage with CMEK and signed upload URLs; Cloud Tasks queues and a worker service (M3).
- Phone OTP authentication (Identity Platform); the app currently relies on its own session auth.
- Global load balancer, Cloud Armor, Cloud CDN (launch milestone, measured trigger only).
- Private IP for Cloud SQL, OpenTofu, uptime checks and alerting policies on p95, 5xx, DB connections (M8).
- Antivirus scanning of uploads.
- Load test (k6) and the backup restore drill (run the drill above once).
- `--allow-unauthenticated` is a beta trade-off: the URL is public and only the app's own auth protects it. Without it the browser could not load the UI. Revisit before any public announcement.
