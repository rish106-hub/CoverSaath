#!/usr/bin/env bash
# Knowvia GCP STAGING deploy (Cloud Run + Cloud SQL, asia-south1). Idempotent; safe to re-run.
#
#   GCP_PROJECT_ID=my-project scripts/deploy/gcp-staging.sh --dry-run   # print every gcloud command, run none
#   GCP_PROJECT_ID=my-project scripts/deploy/gcp-staging.sh             # real run
#
# STAGING IS PRE-M3 AND NON-DURABLE: uploaded documents live on the instance's local disk and breakdown jobs run
# in-process, so the service is pinned to exactly one always-on instance. Documents vanish when the instance is
# replaced (new revision, crash, platform maintenance). See docs/deploy/gcp-staging.md. Changes at M3 (GCS + Cloud Tasks).
#
# Required env:   GCP_PROJECT_ID
# Optional env:   GCP_REGION (asia-south1)  SERVICE_NAME  SQL_INSTANCE  SQL_TIER (db-g1-small)
#                 SARVAM_API_KEY (read from env or prompted; never echoed; skipped if absent)
#                 BILLING_ACCOUNT_ID + BUDGET_AMOUNT (e.g. 3000INR) -> creates the 50/90/100% budget alert
#                 VITE_POSTHOG_KEY / VITE_POSTHOG_HOST (public analytics values baked into the UI build)
#                 DOCUMENT_SCAN_MODE (unset = fail-closed, uploads stay quarantined; structural_only = dev-grade scan)
# No secret value is written to any file or printed. Secrets live only in Secret Manager.
set -euo pipefail

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg (supported: --dry-run, --help)" >&2; exit 2 ;;
  esac
done

if [[ -z "${GCP_PROJECT_ID:-}" ]]; then
  echo "ERROR: GCP_PROJECT_ID is required, e.g. GCP_PROJECT_ID=my-project $0 [--dry-run]" >&2
  exit 2
fi
if ! [[ "$GCP_PROJECT_ID" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]]; then
  echo "ERROR: GCP_PROJECT_ID '$GCP_PROJECT_ID' is not a valid GCP project id (use the id, not the display name)." >&2
  exit 2
fi

REGION="${GCP_REGION:-asia-south1}"
SERVICE="${SERVICE_NAME:-knowvia-staging-api}"
SQL_INSTANCE="${SQL_INSTANCE:-knowvia-staging-pg}"
# db-g1-small (1.7 GB RAM, shared core): db-f1-micro (0.6 GB) is too small for Postgres 16 plus a pool of 10 and is
# excluded from the Cloud SQL SLA. Shared-core tiers require --edition=ENTERPRISE. Raise the tier for load tests.
SQL_TIER="${SQL_TIER:-db-g1-small}"
DB_NAME="knowvia"
DB_USER="knowvia_app"
RUNTIME_SA_NAME="knowvia-runtime"
RUNTIME_SA="${RUNTIME_SA_NAME}@${GCP_PROJECT_ID}.iam.gserviceaccount.com"
SQL_CONNECTION="${GCP_PROJECT_ID}:${REGION}:${SQL_INSTANCE}"
AR_REPO="cloud-run-source-deploy" # the repository `gcloud run deploy --source` uses by default

S_DB_PASSWORD="knowvia-db-password"
S_DATABASE_URL="knowvia-database-url"
S_BOOTSTRAP="knowvia-bootstrap-token"
S_ENCRYPTION="knowvia-document-encryption-key"
S_SARVAM="knowvia-sarvam-api-key"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VITE_ENV_FILE="$REPO_ROOT/scripts/deploy/vite-public.env"

say() { printf '\n== %s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# run: execute (or, in dry-run, print) a command. run_masked: same, but print a redacted display string.
run() {
  if (( DRY_RUN )); then printf '+ %q' "$1"; shift; printf ' %q' "$@"; printf '\n'; else "$@"; fi
}
run_masked() { # display-string command...
  local display="$1"; shift
  if (( DRY_RUN )); then printf '+ %s\n' "$display"; else "$@"; fi
}
# exists: true when the gcloud describe-style check succeeds. Dry-run cannot know, so it prints the check and
# reports "absent" so the full plan is shown.
exists() {
  if (( DRY_RUN )); then printf '# check: gcloud'; printf ' %q' "$@"; printf '\n'; return 1; fi
  gcloud "$@" >/dev/null 2>&1
}
g() { run gcloud "$@"; }

# ---------- preflight ----------
if (( DRY_RUN )); then
  say "DRY RUN: nothing below is executed (gcloud is not required)."
else
  command -v gcloud >/dev/null || die "gcloud not found. Install: brew install --cask google-cloud-sdk, then gcloud auth login."
  command -v openssl >/dev/null || die "openssl not found."
  command -v curl >/dev/null || die "curl not found."
  [[ -n "$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null)" ]] || die "No active gcloud account. Run: gcloud auth login"
  exists projects describe "$GCP_PROJECT_ID" || die "Project $GCP_PROJECT_ID not found or no access."
  # Billing must be linked or API enablement fails.
  [[ "$(gcloud billing projects describe "$GCP_PROJECT_ID" --format='value(billingEnabled)' 2>/dev/null)" == "True" ]] \
    || die "Billing is not linked to $GCP_PROJECT_ID. Link a billing account (new-account credits are fine) first."
fi

say "Plan: project=$GCP_PROJECT_ID region=$REGION service=$SERVICE sql=$SQL_INSTANCE ($SQL_TIER, PostgreSQL 16)"
say "Staging is pre-M3 and NON-DURABLE: 1 instance, local-disk documents, in-process jobs."

# ---------- 1. APIs ----------
say "1/9 Enable APIs"
g services enable \
  run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com sqladmin.googleapis.com \
  secretmanager.googleapis.com aiplatform.googleapis.com cloudresourcemanager.googleapis.com \
  iam.googleapis.com billingbudgets.googleapis.com \
  --project "$GCP_PROJECT_ID"

if (( DRY_RUN )); then PROJECT_NUMBER="<PROJECT_NUMBER>"; else
  PROJECT_NUMBER="$(gcloud projects describe "$GCP_PROJECT_ID" --format='value(projectNumber)')"
fi

# ---------- 2. Service account ----------
say "2/9 Runtime service account (least privilege)"
if ! exists iam service-accounts describe "$RUNTIME_SA" --project "$GCP_PROJECT_ID"; then
  g iam service-accounts create "$RUNTIME_SA_NAME" --display-name "Knowvia staging runtime" --project "$GCP_PROJECT_ID"
fi
for role in roles/cloudsql.client roles/logging.logWriter; do
  g projects add-iam-policy-binding "$GCP_PROJECT_ID" --member "serviceAccount:$RUNTIME_SA" --role "$role" --condition=None --quiet
done
# Secret access is granted per secret in step 5, never project-wide.
# LATER (Vertex AI Gemini, not implemented yet): grant only when @ai-sdk/google-vertex lands.
#   gcloud projects add-iam-policy-binding "$GCP_PROJECT_ID" --member "serviceAccount:$RUNTIME_SA" --role roles/aiplatform.user --condition=None

# Source deploys build with the Compute Engine default service account on newer projects; it needs the Cloud Run
# builder role. # VERIFY: role name per current Cloud Run source-deploy docs (roles/run.builder); harmless if already held.
BUILD_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
g projects add-iam-policy-binding "$GCP_PROJECT_ID" --member "serviceAccount:$BUILD_SA" --role roles/run.builder --condition=None --quiet

# ---------- 3. Artifact Registry repo for source deploys ----------
say "3/9 Artifact Registry repository ($AR_REPO)"
if ! exists artifacts repositories describe "$AR_REPO" --location "$REGION" --project "$GCP_PROJECT_ID"; then
  g artifacts repositories create "$AR_REPO" --repository-format docker --location "$REGION" \
    --description "Cloud Run source deploy images" --project "$GCP_PROJECT_ID"
fi

# ---------- 4. Cloud SQL ----------
say "4/9 Cloud SQL PostgreSQL 16 ($SQL_TIER, zonal, public IP reachable only via the Cloud SQL connector)"
if ! exists sql instances describe "$SQL_INSTANCE" --project "$GCP_PROJECT_ID"; then
  # No authorized networks are added: the only path in is the Cloud Run Cloud SQL connector (IAM + TLS).
  # The plan's private IP needs a VPC and egress setup; deferred to M8 (see runbook). Automated backups + PITR on.
  g sql instances create "$SQL_INSTANCE" \
    --database-version POSTGRES_16 --edition ENTERPRISE --tier "$SQL_TIER" --region "$REGION" \
    --availability-type zonal --storage-type SSD --storage-size 10 --storage-auto-increase \
    --backup-start-time 21:00 --enable-point-in-time-recovery --retained-backups-count 7 \
    --labels env=staging,app=knowvia --project "$GCP_PROJECT_ID"
else
  say "Instance exists; leaving its configuration untouched."
fi
if ! exists sql databases describe "$DB_NAME" --instance "$SQL_INSTANCE" --project "$GCP_PROJECT_ID"; then
  g sql databases create "$DB_NAME" --instance "$SQL_INSTANCE" --project "$GCP_PROJECT_ID"
fi

# ---------- 5. Secrets ----------
say "5/9 Secret Manager (created only when absent; values never printed)"
secret_exists() { exists secrets describe "$1" --project "$GCP_PROJECT_ID"; }
# create_secret NAME VALUE: value goes over stdin, never argv.
create_secret() {
  local name="$1" value="$2"
  if (( DRY_RUN )); then
    printf '+ <value on stdin> | gcloud secrets create %q --replication-policy user-managed --locations %q --data-file - --project %q\n' "$name" "$REGION" "$GCP_PROJECT_ID"
  else
    printf '%s' "$value" | gcloud secrets create "$name" --replication-policy user-managed --locations "$REGION" --data-file - --project "$GCP_PROJECT_ID" >/dev/null
    echo "created secret $name"
  fi
}
grant_secret() {
  g secrets add-iam-policy-binding "$1" --member "serviceAccount:$RUNTIME_SA" --role roles/secretmanager.secretAccessor --condition=None --quiet --project "$GCP_PROJECT_ID"
}

NEW_DB_PASSWORD=""
if ! secret_exists "$S_DB_PASSWORD"; then
  NEW_DB_PASSWORD="$( ((DRY_RUN)) && echo "<generated>" || openssl rand -hex 24 )" # hex only: safe inside a URL
  create_secret "$S_DB_PASSWORD" "$NEW_DB_PASSWORD"
fi
if ! secret_exists "$S_BOOTSTRAP"; then create_secret "$S_BOOTSTRAP" "$( ((DRY_RUN)) && echo "<generated>" || openssl rand -hex 32 )"; fi
if ! secret_exists "$S_ENCRYPTION"; then create_secret "$S_ENCRYPTION" "$( ((DRY_RUN)) && echo "<generated>" || openssl rand -base64 32 )"; fi

HAVE_SARVAM=0
if secret_exists "$S_SARVAM"; then
  HAVE_SARVAM=1
else
  sarvam_value="${SARVAM_API_KEY:-}"
  if [[ -z "$sarvam_value" && -t 0 && $DRY_RUN -eq 0 ]]; then
    read -r -s -p "Sarvam API key (input hidden; Enter to skip, OCR then stays unconfigured): " sarvam_value; echo
  fi
  if [[ -n "$sarvam_value" ]]; then create_secret "$S_SARVAM" "$sarvam_value"; HAVE_SARVAM=1
  elif (( DRY_RUN )); then say "Dry run: a Sarvam secret would be created from \$SARVAM_API_KEY or a hidden prompt."; HAVE_SARVAM=1
  else warn "No Sarvam key: policy OCR stays unconfigured and uploads cannot be digitised. Re-run with SARVAM_API_KEY set to add it."; fi
fi
unset sarvam_value

# Database user. Only set when this run generated the password, so a re-run never rotates a working credential.
if [[ -n "$NEW_DB_PASSWORD" ]]; then
  user_present=""
  if (( DRY_RUN )); then echo "# check: gcloud sql users list --instance $SQL_INSTANCE --filter name=$DB_USER"; else
    user_present="$(gcloud sql users list --instance "$SQL_INSTANCE" --project "$GCP_PROJECT_ID" --filter "name=$DB_USER" --format 'value(name)')"
  fi
  if [[ -n "$user_present" ]]; then
    run_masked "gcloud sql users set-password $DB_USER --instance $SQL_INSTANCE --password <redacted> --project $GCP_PROJECT_ID" \
      gcloud sql users set-password "$DB_USER" --instance "$SQL_INSTANCE" --password "$NEW_DB_PASSWORD" --project "$GCP_PROJECT_ID"
  else
    # The password is briefly visible in this machine's process list; gcloud has no stdin option for it.
    run_masked "gcloud sql users create $DB_USER --instance $SQL_INSTANCE --password <redacted> --project $GCP_PROJECT_ID" \
      gcloud sql users create "$DB_USER" --instance "$SQL_INSTANCE" --password "$NEW_DB_PASSWORD" --project "$GCP_PROJECT_ID"
  fi
fi
# DATABASE_URL over the Cloud SQL unix socket (the `pg` URL form with ?host=). TLS is handled by the connector.
if ! secret_exists "$S_DATABASE_URL"; then
  if (( DRY_RUN )); then db_password="<from-secret>"; else
    db_password="${NEW_DB_PASSWORD:-$(gcloud secrets versions access latest --secret "$S_DB_PASSWORD" --project "$GCP_PROJECT_ID")}"
  fi
  create_secret "$S_DATABASE_URL" "postgresql://${DB_USER}:${db_password}@/${DB_NAME}?host=/cloudsql/${SQL_CONNECTION}"
  unset db_password
fi
unset NEW_DB_PASSWORD

SECRET_NAMES=("$S_DATABASE_URL" "$S_BOOTSTRAP" "$S_ENCRYPTION")
SET_SECRETS="DATABASE_URL=${S_DATABASE_URL}:latest,KNOWVIA_BOOTSTRAP_TOKEN=${S_BOOTSTRAP}:latest,DOCUMENT_ENCRYPTION_KEY_BASE64=${S_ENCRYPTION}:latest"
if (( HAVE_SARVAM )); then SECRET_NAMES+=("$S_SARVAM"); SET_SECRETS+=",SARVAM_API_KEY=${S_SARVAM}:latest"; fi
for name in "${SECRET_NAMES[@]}"; do grant_secret "$name"; done

# ---------- 6. Budget alert ----------
say "6/9 Billing budget alert (50/90/100%)"
if [[ -n "${BILLING_ACCOUNT_ID:-}" ]]; then
  [[ -n "${BUDGET_AMOUNT:-}" ]] || die "BUDGET_AMOUNT is required with BILLING_ACCOUNT_ID, e.g. 3000INR (currency must match the billing account)."
  budget_name="knowvia-staging-${GCP_PROJECT_ID}"
  if (( DRY_RUN )) || [[ -z "$(gcloud billing budgets list --billing-account "$BILLING_ACCOUNT_ID" --filter "displayName=$budget_name" --format 'value(name)' 2>/dev/null)" ]]; then
    # VERIFY: flag names against `gcloud billing budgets create --help` in your installed gcloud version.
    g billing budgets create --billing-account "$BILLING_ACCOUNT_ID" --display-name "$budget_name" \
      --filter-projects "projects/${PROJECT_NUMBER}" --budget-amount "$BUDGET_AMOUNT" \
      --threshold-rule percent=0.5 --threshold-rule percent=0.9 --threshold-rule percent=1.0
  else
    say "Budget $budget_name already exists."
  fi
  echo "Budgets only alert; they do not stop spend. The Gemini rupee cap is enforced in-app (later milestone)."
else
  warn "BILLING_ACCOUNT_ID not set: NO budget alert is being created. Create one before real use (runbook, 'Budget')."
fi

# ---------- 7. Deploy ----------
say "7/9 Build and deploy (Cloud Build from source; no local Docker)"
EXPECTED_HOST="${SERVICE}-${PROJECT_NUMBER}.${REGION}.run.app"
EXPECTED_URL="https://${EXPECTED_HOST}"

# Public Vite values for the UI build (a PostHog project key is public by design). Never a secret.
cleanup_vite_env() { rm -f "$VITE_ENV_FILE"; }
trap cleanup_vite_env EXIT
if [[ -n "${VITE_POSTHOG_KEY:-}" ]]; then
  [[ "$VITE_POSTHOG_KEY" =~ ^phc_[A-Za-z0-9]+$ ]] || die "VITE_POSTHOG_KEY must be a public PostHog project key (phc_...)."
  posthog_host="${VITE_POSTHOG_HOST:-/ingest}"
  [[ "$posthog_host" =~ ^(/ingest|https://[A-Za-z0-9.-]+)$ ]] || die "VITE_POSTHOG_HOST must be /ingest (same-origin proxy) or an https origin."
  if (( DRY_RUN )); then echo "+ write $VITE_ENV_FILE (VITE_POSTHOG_KEY, VITE_POSTHOG_HOST=$posthog_host); removed on exit"; else
    printf "VITE_POSTHOG_KEY='%s'\nVITE_POSTHOG_HOST='%s'\n" "$VITE_POSTHOG_KEY" "$posthog_host" > "$VITE_ENV_FILE"
  fi
else
  warn "VITE_POSTHOG_KEY not set: the UI is built without analytics (the app still works)."
fi

# '^@^' makes '@' the list delimiter so values may contain commas.
ENV_VARS="^@^NODE_ENV=production@HOST=0.0.0.0@TRUST_PROXY_HOPS=1@STATIC_DIR=dist@POSTHOG_REGION=eu@SHUTDOWN_GRACE_MS=8000"
ENV_VARS+="@ALLOWED_HOSTS=${EXPECTED_HOST}@ALLOWED_ORIGINS=${EXPECTED_URL}"
ENV_VARS+="@DOCUMENT_STORAGE_PATH=/tmp/knowvia-documents@DATABASE_POOL_MAX=10"
# LLM_MODEL / BREAKDOWN_LLM_MODEL are deliberately NOT set: Gemini on Vertex is not implemented, and real PDFs must
# not go through an AI Studio key, so the breakdown runner fails closed.
if [[ -n "${DOCUMENT_SCAN_MODE:-}" ]]; then
  [[ "$DOCUMENT_SCAN_MODE" == "structural_only" ]] || die "DOCUMENT_SCAN_MODE may only be unset or structural_only."
  ENV_VARS+="@DOCUMENT_SCAN_MODE=${DOCUMENT_SCAN_MODE}"
fi

# --min/--max-instances 1 + --no-cpu-throttling: documents are on local disk and jobs run in-process (setImmediate),
# so exactly one instance with CPU always allocated is the only correct staging shape (pre-M3).
# --allow-unauthenticated: the app has its own authentication; this is a beta trade-off. Without it the browser
# could not reach the UI at all. Real access control = app auth + the unlisted URL. Revisit before public launch.
# --startup-probe: # VERIFY: flag/format available in your gcloud (`gcloud run deploy --help | grep startup-probe`).
deploy_args=(
  run deploy "$SERVICE" --source "$REPO_ROOT" --project "$GCP_PROJECT_ID" --region "$REGION"
  --service-account "$RUNTIME_SA"
  --min-instances 1 --max-instances 1 --no-cpu-throttling
  --cpu 1 --memory 1Gi --concurrency 40 --timeout 300 --port 8080
  --ingress all --allow-unauthenticated
  --add-cloudsql-instances "$SQL_CONNECTION"
  --set-secrets "$SET_SECRETS"
  --set-env-vars "$ENV_VARS"
  --labels env=staging,durability=non-durable,app=knowvia
  --startup-probe "httpGet.path=/live,httpGet.port=8080,timeoutSeconds=3,periodSeconds=5,failureThreshold=24"
  --quiet
)
g "${deploy_args[@]}"

# ---------- 8. Reconcile hosts/origins with the real URL ----------
say "8/9 Verify assigned URL matches ALLOWED_HOSTS/ALLOWED_ORIGINS"
if (( DRY_RUN )); then
  SERVICE_URL="$EXPECTED_URL"
  echo "+ gcloud run services describe $SERVICE --region $REGION --format 'value(status.url)'   # compare with $EXPECTED_URL"
  echo "+ (only if different) gcloud run services update $SERVICE --update-env-vars ^@^ALLOWED_HOSTS=<host>@ALLOWED_ORIGINS=<url>"
else
  SERVICE_URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --project "$GCP_PROJECT_ID" --format 'value(status.url)')"
  if [[ "$SERVICE_URL" != "$EXPECTED_URL" ]]; then
    warn "Assigned URL $SERVICE_URL differs from the predicted $EXPECTED_URL; updating ALLOWED_HOSTS/ALLOWED_ORIGINS."
    gcloud run services update "$SERVICE" --region "$REGION" --project "$GCP_PROJECT_ID" \
      --update-env-vars "^@^ALLOWED_HOSTS=${SERVICE_URL#https://}@ALLOWED_ORIGINS=${SERVICE_URL}"
  fi
fi

# ---------- 9. Smoke ----------
say "9/9 Smoke test"
if (( DRY_RUN )); then echo "+ $REPO_ROOT/scripts/deploy/smoke.sh $SERVICE_URL"; else
  "$REPO_ROOT/scripts/deploy/smoke.sh" "$SERVICE_URL" || { warn "Smoke test failed. Logs: gcloud run services logs read $SERVICE --region $REGION --project $GCP_PROJECT_ID --limit 100"; exit 1; }
fi

cat <<EOF

== Done$( ((DRY_RUN)) && echo ' (dry run: nothing was executed)' || true ).
URL:       $SERVICE_URL
Bootstrap: the first-household token is in Secret Manager: gcloud secrets versions access latest --secret $S_BOOTSTRAP --project $GCP_PROJECT_ID
Reminder:  STAGING IS NON-DURABLE (local-disk documents, in-process jobs, 1 instance). AI breakdown is unconfigured (no Vertex yet).

Rollback (send traffic back to the previous revision):
  gcloud run revisions list --service $SERVICE --region $REGION --project $GCP_PROJECT_ID
  gcloud run services update-traffic $SERVICE --to-revisions <PREVIOUS_REVISION>=100 --region $REGION --project $GCP_PROJECT_ID
  (migrations are forward-only: roll back code only to a revision compatible with the current schema)

Logs:
  gcloud run services logs read $SERVICE --region $REGION --project $GCP_PROJECT_ID --limit 100
EOF
