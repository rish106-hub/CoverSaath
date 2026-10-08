#!/usr/bin/env bash
# Knowvia AZURE STAGING deploy (Container Apps + PostgreSQL Flexible Server + Key Vault, centralindia). Idempotent.
#
#   AZ_SUBSCRIPTION_ID=<guid> scripts/deploy/azure-staging.sh --dry-run   # print every az command, run none
#   AZ_SUBSCRIPTION_ID=<guid> scripts/deploy/azure-staging.sh             # real run
#
# STAGING IS PRE-M3 AND NON-DURABLE: uploaded documents live on the replica's local disk and breakdown jobs run
# in-process, so the app is pinned to exactly ONE always-on replica (min=max=1). Documents vanish on every restart or
# new revision, including every re-run of this script. Changes at M3 (Azure Blob Storage + a queue + a worker).
# AI breakdown is left UNCONFIGURED (no LLM_MODEL): see docs/deploy/azure-staging.md "Gemini options".
#
# Required env:  AZ_SUBSCRIPTION_ID
# Optional env:  AZ_LOCATION (centralindia)  AZ_RESOURCE_GROUP (knowvia-staging-rg)  AZ_NAME_SUFFIX (8 hex from the
#                subscription id; makes globally-unique names)  SARVAM_API_KEY (env or hidden prompt, skipped if absent)
#                VITE_POSTHOG_KEY (public key baked into the UI build)  DOCUMENT_SCAN_MODE (unset|structural_only)
#                AZ_BUDGET_AMOUNT_INR + AZ_BUDGET_EMAIL (monthly budget alerts at 50/90/100%)
#                AZ_PG_ALLOW_AZURE_SERVICES=1 (wider firewall fallback: allow ANY Azure-hosted client)
#                AZ_ALLOW_SECRET_ARGV=1 (fallback if az rejects @file for --admin-password; puts it on argv)
#                AZ_SELF_OBJECT_ID (your Entra object id if `az ad signed-in-user show` is not permitted)
# No secret value is written to a repo file or printed. Secrets go to Key Vault via files in a private mktemp dir
# that is shredded on exit; the places where az would otherwise force a secret on argv are called out inline.
set -euo pipefail

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg (supported: --dry-run, --help)" >&2; exit 2 ;;
  esac
done

if [[ -z "${AZ_SUBSCRIPTION_ID:-}" ]]; then
  echo "ERROR: AZ_SUBSCRIPTION_ID is required, e.g. AZ_SUBSCRIPTION_ID=<guid> $0 [--dry-run]  (az account list -o table)" >&2
  exit 2
fi
if ! [[ "$AZ_SUBSCRIPTION_ID" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]; then
  echo "ERROR: AZ_SUBSCRIPTION_ID '$AZ_SUBSCRIPTION_ID' is not a GUID." >&2
  exit 2
fi
if [[ -n "${AZ_BUDGET_AMOUNT_INR:-}" ]]; then
  [[ "$AZ_BUDGET_AMOUNT_INR" =~ ^[0-9]+$ ]] || { echo "ERROR: AZ_BUDGET_AMOUNT_INR must be a whole number." >&2; exit 2; }
  [[ -n "${AZ_BUDGET_EMAIL:-}" ]] || { echo "ERROR: AZ_BUDGET_EMAIL is required with AZ_BUDGET_AMOUNT_INR (alert recipient)." >&2; exit 2; }
fi

LOCATION="${AZ_LOCATION:-centralindia}"
RG="${AZ_RESOURCE_GROUP:-knowvia-staging-rg}"
SUFFIX="${AZ_NAME_SUFFIX:-$(printf '%s' "$AZ_SUBSCRIPTION_ID" | { sha256sum 2>/dev/null || shasum -a 256; } | cut -c1-8)}"
ACR="${AZ_ACR_NAME:-knowviastg${SUFFIX}}"            # globally unique, 5-50 alphanumeric
KV="${AZ_KEYVAULT_NAME:-kv-knowvia-${SUFFIX}}"        # globally unique, 3-24
PG="${AZ_PG_SERVER:-knowvia-stg-pg-${SUFFIX}}"        # globally unique
PG_ADMIN="knowvia_admin"
DB_NAME="knowvia"
IDENTITY="knowvia-staging-id"
CAE="knowvia-staging-env"
APP="knowvia-staging-api"
IMAGE_REPO="knowvia-api"
IMAGE_TAG="$(date -u +%Y%m%d%H%M%S)"
ACR_SERVER="${ACR}.azurecr.io"

S_DB_PASSWORD="knowvia-db-password"
S_DATABASE_URL="knowvia-database-url"
S_BOOTSTRAP="knowvia-bootstrap-token"
S_ENCRYPTION="knowvia-document-encryption-key"
S_SARVAM="knowvia-sarvam-api-key"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_DIR="$REPO_ROOT/scripts/deploy"
VITE_ENV_FILE="$SCRIPT_DIR/vite-public.env"
WORK_DIR=""

say() { printf '\n== %s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

cleanup() {
  rm -f "$VITE_ENV_FILE"
  if [[ -n "$WORK_DIR" && -d "$WORK_DIR" ]]; then
    if command -v shred >/dev/null 2>&1; then find "$WORK_DIR" -type f -exec shred -u {} + 2>/dev/null || true
    else find "$WORK_DIR" -type f -exec rm -P {} + 2>/dev/null || true; fi   # macOS: rm -P overwrites before unlinking
    rm -rf "$WORK_DIR"
  fi
}
trap cleanup EXIT
umask 077
WORK_DIR="$(mktemp -d)"

run() { if (( DRY_RUN )); then printf '+ %q' "$1"; shift; printf ' %q' "$@"; printf '\n'; else "$@"; fi; }
az_() { run az "$@"; }
# exists: true when an az "show"-style check succeeds. Dry-run cannot know, so it prints the check and reports absent.
exists() { if (( DRY_RUN )); then printf '# check: az'; printf ' %q' "$@"; printf '\n'; return 1; fi; az "$@" -o none >/dev/null 2>&1; }
# val: capture a query result; dry-run returns the placeholder given as $1.
val() { local placeholder="$1"; shift; if (( DRY_RUN )); then echo "$placeholder"; else az "$@" -o tsv; fi; }
retry() { # attempts sleep-seconds command...   (RBAC and identity propagation are eventually consistent)
  local n="$1" s="$2"; shift 2; local i
  for ((i = 1; i <= n; i++)); do "$@" && return 0; (( i < n )) && { echo "  retry $i/$n in ${s}s..." >&2; sleep "$s"; }; done
  return 1
}

# ---------- preflight ----------
if (( DRY_RUN )); then
  say "DRY RUN: nothing below calls az (az is not required). Local temp files may be written and are removed on exit."
else
  command -v az >/dev/null || die "az not found. Install: brew install azure-cli, then az login."
  command -v openssl >/dev/null || die "openssl not found."
  command -v curl >/dev/null || die "curl not found."
  az account show -o none 2>/dev/null || die "Not signed in. Run: az login"
  az account set --subscription "$AZ_SUBSCRIPTION_ID" || die "Cannot select subscription $AZ_SUBSCRIPTION_ID (az account list -o table)."
fi
say "Plan: subscription=$AZ_SUBSCRIPTION_ID location=$LOCATION rg=$RG suffix=$SUFFIX"
say "Staging is pre-M3 and NON-DURABLE: 1 replica, local-disk documents, in-process jobs."
(( DRY_RUN )) && echo "+ az account set --subscription $AZ_SUBSCRIPTION_ID   # changes your default az subscription"

# ---------- 1. providers, extension, resource group ----------
say "1/10 Resource providers, containerapp extension, resource group"
for ns in Microsoft.App Microsoft.OperationalInsights Microsoft.DBforPostgreSQL Microsoft.KeyVault Microsoft.ContainerRegistry Microsoft.ManagedIdentity Microsoft.Consumption; do
  az_ provider register --namespace "$ns" --wait
done
az_ extension add --name containerapp --upgrade --yes
az_ group create --name "$RG" --location "$LOCATION" --tags env=staging app=knowvia durability=non-durable -o none

# ---------- 2. identity, ACR, Key Vault ----------
say "2/10 Managed identity, Container Registry (Basic), Key Vault (RBAC)"
ROLES_FRESH=0
if ! exists identity show --resource-group "$RG" --name "$IDENTITY"; then
  az_ identity create --resource-group "$RG" --name "$IDENTITY" --location "$LOCATION" -o none; ROLES_FRESH=1
fi
ID_RESOURCE="$(val '<IDENTITY_RESOURCE_ID>' identity show --resource-group "$RG" --name "$IDENTITY" --query id)"
ID_PRINCIPAL="$(val '<IDENTITY_PRINCIPAL_ID>' identity show --resource-group "$RG" --name "$IDENTITY" --query principalId)"

if ! exists acr show --name "$ACR" --resource-group "$RG"; then
  az_ acr create --resource-group "$RG" --name "$ACR" --sku Basic --location "$LOCATION" --admin-enabled false -o none
fi
ACR_ID="$(val '<ACR_RESOURCE_ID>' acr show --name "$ACR" --resource-group "$RG" --query id)"

if ! exists keyvault show --name "$KV" --resource-group "$RG"; then
  # If this name exists in a soft-deleted vault from an earlier teardown: az keyvault purge --name "$KV" --location "$LOCATION"
  az_ keyvault create --name "$KV" --resource-group "$RG" --location "$LOCATION" \
    --enable-rbac-authorization true --retention-days 7 -o none
fi
KV_ID="$(val '<KEYVAULT_RESOURCE_ID>' keyvault show --name "$KV" --resource-group "$RG" --query id)"

ensure_role() { # principal-object-id principal-type role scope
  local who="$1" ptype="$2" role="$3" scope="$4"
  if (( DRY_RUN )) || [[ -z "$(az role assignment list --assignee "$who" --role "$role" --scope "$scope" --query '[0].id' -o tsv 2>/dev/null)" ]]; then
    az_ role assignment create --assignee-object-id "$who" --assignee-principal-type "$ptype" --role "$role" --scope "$scope" -o none
    ROLES_FRESH=1
  fi
}
ensure_role "$ID_PRINCIPAL" ServicePrincipal "AcrPull" "$ACR_ID"
ensure_role "$ID_PRINCIPAL" ServicePrincipal "Key Vault Secrets User" "$KV_ID"   # least privilege: read secrets only
# The deploying user needs to WRITE secrets once (data-plane RBAC; subscription Owner does not imply it).
SELF_OID="${AZ_SELF_OBJECT_ID:-}"
if [[ -z "$SELF_OID" ]]; then SELF_OID="$(val '<YOUR_OBJECT_ID>' ad signed-in-user show --query id)" || die "Cannot read your Entra object id; set AZ_SELF_OBJECT_ID."; fi
ensure_role "$SELF_OID" User "Key Vault Secrets Officer" "$KV_ID"

# ---------- 3. secrets (Key Vault) ----------
say "3/10 Key Vault secrets (created only when absent; values go via files in a private temp dir, never argv)"
if (( DRY_RUN )); then KV_NAMES=""; else
  if (( ROLES_FRESH )); then echo "Waiting for RBAC propagation..."; fi
  KV_NAMES="$(retry 18 10 az keyvault secret list --vault-name "$KV" --query '[].name' -o tsv)" || die "Cannot list secrets in $KV (RBAC not propagated yet? re-run in a minute)."
fi
kv_has() { grep -qx "$1" <<<"$KV_NAMES"; }
kv_set() { # name value
  local name="$1" value="$2" f; f="$WORK_DIR/secret.$name"
  if (( DRY_RUN )); then echo "+ az keyvault secret set --vault-name $KV --name $name --file <private-tmp-file> --encoding utf-8 -o none   # VERIFY: --file/--encoding"; return; fi
  printf '%s' "$value" > "$f"
  az keyvault secret set --vault-name "$KV" --name "$name" --file "$f" --encoding utf-8 -o none
  echo "created secret $name"
}
kv_get() { az keyvault secret show --vault-name "$KV" --name "$1" --query value -o tsv; }
gen() { if (( DRY_RUN )); then echo "<generated>"; else "$@"; fi; }

NEW_DB_PASSWORD=""
if ! kv_has "$S_DB_PASSWORD"; then
  # Azure requires 3 of 4 character classes: hex gives lower+digit, 'Aa1' adds upper. All URL-safe.
  NEW_DB_PASSWORD="$(gen openssl rand -hex 24)"; (( DRY_RUN )) || NEW_DB_PASSWORD="${NEW_DB_PASSWORD}Aa1"
  kv_set "$S_DB_PASSWORD" "$NEW_DB_PASSWORD"
fi
kv_has "$S_BOOTSTRAP" || kv_set "$S_BOOTSTRAP" "$(gen openssl rand -hex 32)"
kv_has "$S_ENCRYPTION" || kv_set "$S_ENCRYPTION" "$(gen openssl rand -base64 32)"

HAVE_SARVAM=0
if kv_has "$S_SARVAM"; then HAVE_SARVAM=1; else
  sarvam_value="${SARVAM_API_KEY:-}"
  if [[ -z "$sarvam_value" && -t 0 && $DRY_RUN -eq 0 ]]; then
    read -r -s -p "Sarvam API key (hidden; Enter to skip, OCR then stays unconfigured): " sarvam_value; echo
  fi
  if [[ -n "$sarvam_value" ]]; then kv_set "$S_SARVAM" "$sarvam_value"; HAVE_SARVAM=1
  elif (( DRY_RUN )); then echo "# dry run: a Sarvam secret would be created from \$SARVAM_API_KEY or a hidden prompt"; HAVE_SARVAM=1
  else warn "No Sarvam key: policy OCR stays unconfigured. Re-run with SARVAM_API_KEY set to add it."; fi
fi
unset sarvam_value

# ---------- 4. PostgreSQL Flexible Server ----------
say "4/10 PostgreSQL 16 Flexible Server (Burstable B1ms, 7-day backups, TLS required, no public firewall rules yet)"
PG_FQDN="${PG}.postgres.database.azure.com"
pw_file="$WORK_DIR/pgpassword"
pw_args=()
set_pg_password_args() { # fills pw_args with the --admin-password pair (bash 3.2 safe; no mapfile)
  if (( DRY_RUN )); then pw_args=(--admin-password "@<private-tmp-file>"); return; fi
  printf '%s' "$NEW_DB_PASSWORD" > "$pw_file"
  if [[ "${AZ_ALLOW_SECRET_ARGV:-0}" == 1 ]]; then warn "Passing the DB admin password on argv (AZ_ALLOW_SECRET_ARGV=1)."; pw_args=(--admin-password "$NEW_DB_PASSWORD")
  else pw_args=(--admin-password "@$pw_file"); fi   # VERIFY: az/knack expands @file for any argument value
}
if ! exists postgres flexible-server show --resource-group "$RG" --name "$PG"; then
  [[ -n "$NEW_DB_PASSWORD" ]] || die "Server $PG is absent but the $S_DB_PASSWORD secret already exists; delete that secret (or set AZ_PG_SERVER to the right server) and re-run."
  # VERIFY: B1ms/Postgres 16 offered in your region: az postgres flexible-server list-skus --location "$LOCATION" -o table
  # The admin password is the one secret az must receive; @file keeps it off argv (fallback documented above).
  set_pg_password_args
  az_ postgres flexible-server create --resource-group "$RG" --name "$PG" --location "$LOCATION" \
    --version 16 --tier Burstable --sku-name Standard_B1ms --storage-size 32 \
    --admin-user "$PG_ADMIN" "${pw_args[@]}" --database-name "$DB_NAME" \
    --backup-retention 7 --geo-redundant-backup Disabled --high-availability Disabled \
    --public-access None --tags env=staging app=knowvia --yes -o none
else
  say "Server exists; configuration left untouched."
  if [[ -n "$NEW_DB_PASSWORD" ]]; then
    set_pg_password_args
    az_ postgres flexible-server update --resource-group "$RG" --name "$PG" "${pw_args[@]}" -o none
  fi
fi
az_ postgres flexible-server parameter set --resource-group "$RG" --server-name "$PG" --name require_secure_transport --value on -o none
az_ postgres flexible-server db create --resource-group "$RG" --server-name "$PG" --database-name "$DB_NAME" -o none 2>/dev/null || true

if ! kv_has "$S_DATABASE_URL"; then
  if (( DRY_RUN )); then db_password="<from-keyvault>"; else db_password="${NEW_DB_PASSWORD:-$(kv_get "$S_DB_PASSWORD")}"; fi
  # sslmode=require: pg-connection-string 2.14 turns this into ssl={} with certificate verification ON (see runbook).
  kv_set "$S_DATABASE_URL" "postgresql://${PG_ADMIN}:${db_password}@${PG_FQDN}:5432/${DB_NAME}?sslmode=require"
  unset db_password
fi
unset NEW_DB_PASSWORD

# ---------- 5. Container Apps environment ----------
say "5/10 Container Apps environment (Consumption; a Log Analytics workspace is created automatically)"
if ! exists containerapp env show --resource-group "$RG" --name "$CAE"; then
  az_ containerapp env create --resource-group "$RG" --name "$CAE" --location "$LOCATION" -o none
fi
CAE_ID="$(val '<ENVIRONMENT_RESOURCE_ID>' containerapp env show --resource-group "$RG" --name "$CAE" --query id)"
DEFAULT_DOMAIN="$(val '<ENV_DEFAULT_DOMAIN>' containerapp env show --resource-group "$RG" --name "$CAE" --query properties.defaultDomain)"
PREDICTED_FQDN="${APP}.${DEFAULT_DOMAIN}"   # external-ingress FQDN is <app>.<env default domain>

# ---------- 6. Build (ACR Tasks cloud build, no local Docker) ----------
say "6/10 Build image in ACR (az acr build; uses .dockerignore for the upload context)"
if [[ -n "${VITE_POSTHOG_KEY:-}" ]]; then
  [[ "$VITE_POSTHOG_KEY" =~ ^phc_[A-Za-z0-9]+$ ]] || die "VITE_POSTHOG_KEY must be a public PostHog project key (phc_...)."
  # Only the key is a build-time value; the UI uses the fixed same-origin /ingest host.
  if (( DRY_RUN )); then echo "+ write $VITE_ENV_FILE (VITE_POSTHOG_KEY only); removed on exit"; else
    printf "VITE_POSTHOG_KEY='%s'\n" "$VITE_POSTHOG_KEY" > "$VITE_ENV_FILE"
  fi
else
  warn "VITE_POSTHOG_KEY not set: the UI is built without analytics (the app still works)."
fi
# If ACR Tasks is blocked for your subscription type (some free/trial offers), this step fails; see the runbook.
az_ acr build --registry "$ACR" --resource-group "$RG" --image "${IMAGE_REPO}:${IMAGE_TAG}" --file "$REPO_ROOT/Dockerfile" "$REPO_ROOT"
IMAGE="${ACR_SERVER}/${IMAGE_REPO}:${IMAGE_TAG}"

# ---------- 7. Container app (YAML: probes + Key Vault secret references need it) ----------
say "7/10 Container app (1 replica, external ingress :8080, secrets from Key Vault via managed identity)"
kv_url() { echo "https://${KV}.vault.azure.net/secrets/$1"; }
render_app_yaml() { # fqdn with_readiness(0|1) -> file path
  local fqdn="$1" readiness="$2" f="$WORK_DIR/app-$2.yaml"
  {
    cat <<YAML
# Generated by scripts/deploy/azure-staging.sh. Contains Key Vault URLs only, never secret values.
location: ${LOCATION}
identity:
  type: UserAssigned
  userAssignedIdentities:
    "${ID_RESOURCE}": {}
properties:
  environmentId: "${CAE_ID}"
  configuration:
    activeRevisionsMode: Single
    ingress:
      external: true
      targetPort: 8080
      transport: auto
      allowInsecure: false
    registries:
      - server: ${ACR_SERVER}
        identity: "${ID_RESOURCE}"
    secrets:
      - name: database-url
        keyVaultUrl: $(kv_url "$S_DATABASE_URL")
        identity: "${ID_RESOURCE}"
      - name: bootstrap-token
        keyVaultUrl: $(kv_url "$S_BOOTSTRAP")
        identity: "${ID_RESOURCE}"
      - name: document-encryption-key
        keyVaultUrl: $(kv_url "$S_ENCRYPTION")
        identity: "${ID_RESOURCE}"
YAML
    if (( HAVE_SARVAM )); then cat <<YAML
      - name: sarvam-api-key
        keyVaultUrl: $(kv_url "$S_SARVAM")
        identity: "${ID_RESOURCE}"
YAML
    fi
    cat <<YAML
  template:
    containers:
      - name: knowvia-api
        image: ${IMAGE}
        resources:
          cpu: 0.5
          memory: 1Gi
        env:
          - { name: NODE_ENV, value: production }
          - { name: HOST, value: 0.0.0.0 }
          - { name: PORT, value: "8080" }
          - { name: STATIC_DIR, value: dist }
          - { name: TRUST_PROXY_HOPS, value: "1" }   # VERIFY: Envoy appends the client IP to X-Forwarded-For (one trusted hop)
          - { name: POSTHOG_REGION, value: eu }
          - { name: SHUTDOWN_GRACE_MS, value: "8000" }
          - { name: ALLOWED_HOSTS, value: "${fqdn}" }
          - { name: ALLOWED_ORIGINS, value: "https://${fqdn}" }
          - { name: DOCUMENT_STORAGE_PATH, value: /tmp/knowvia-documents }
          - { name: DATABASE_POOL_MAX, value: "10" }
          - { name: DATABASE_URL, secretRef: database-url }
          - { name: KNOWVIA_BOOTSTRAP_TOKEN, secretRef: bootstrap-token }
          - { name: DOCUMENT_ENCRYPTION_KEY_BASE64, secretRef: document-encryption-key }
YAML
    (( HAVE_SARVAM )) && echo '          - { name: SARVAM_API_KEY, secretRef: sarvam-api-key }'
    # LLM_MODEL / BREAKDOWN_LLM_MODEL deliberately unset: the breakdown runner fails closed (no Gemini route chosen yet).
    [[ "${DOCUMENT_SCAN_MODE:-}" == "structural_only" ]] && echo '          - { name: DOCUMENT_SCAN_MODE, value: structural_only }'
    cat <<YAML
        probes:
          - type: Startup
            httpGet: { path: /live, port: 8080 }
            periodSeconds: 5
            failureThreshold: 24
          - type: Liveness
            httpGet: { path: /live, port: 8080 }
            periodSeconds: 10
            failureThreshold: 3
YAML
    if (( readiness )); then cat <<YAML
          - type: Readiness
            httpGet: { path: /ready, port: 8080 }
            periodSeconds: 10
            failureThreshold: 3
YAML
    fi
    cat <<YAML
    scale:
      minReplicas: 1
      maxReplicas: 1
YAML
  } > "$f"
  echo "$f"
}
if [[ -n "${DOCUMENT_SCAN_MODE:-}" && "$DOCUMENT_SCAN_MODE" != "structural_only" ]]; then die "DOCUMENT_SCAN_MODE may only be unset or structural_only."; fi

if (( ROLES_FRESH && ! DRY_RUN )); then echo "Waiting 60s for new role assignments (AcrPull, Key Vault Secrets User) to propagate..."; sleep 60; fi

APP_EXISTS=0; exists containerapp show --resource-group "$RG" --name "$APP" && APP_EXISTS=1
if (( APP_EXISTS )); then
  yaml="$(render_app_yaml "$PREDICTED_FQDN" 1)"
  az_ containerapp update --resource-group "$RG" --name "$APP" --yaml "$yaml" -o none
else
  # First create WITHOUT the readiness probe: /ready needs the database, and the Postgres firewall can only be
  # opened after the app exists (its outbound IPs are not known earlier). The probe is added in step 9.
  yaml="$(render_app_yaml "$PREDICTED_FQDN" 0)"
  (( DRY_RUN )) && { echo "# --- generated YAML (first create) ---"; sed 's/^/# /' "$yaml"; }
  az_ containerapp create --resource-group "$RG" --name "$APP" --yaml "$yaml" -o none
fi

# ---------- 8. Reconcile the FQDN ----------
say "8/10 Verify assigned FQDN matches ALLOWED_HOSTS/ALLOWED_ORIGINS"
FQDN="$(val "$PREDICTED_FQDN" containerapp show --resource-group "$RG" --name "$APP" --query properties.configuration.ingress.fqdn)"
if (( DRY_RUN )); then
  echo "+ (only if the fqdn read above differs from $PREDICTED_FQDN) re-render the YAML with it and: az containerapp update --resource-group $RG --name $APP --yaml <yaml>"
elif [[ "$FQDN" != "$PREDICTED_FQDN" ]]; then
  warn "Assigned FQDN $FQDN differs from predicted $PREDICTED_FQDN; updating ALLOWED_HOSTS/ALLOWED_ORIGINS."
  az containerapp update --resource-group "$RG" --name "$APP" --yaml "$(render_app_yaml "$FQDN" "$APP_EXISTS")" -o none
fi

# ---------- 9. Database firewall, then readiness probe ----------
say "9/10 Database firewall: allow only the app's outbound IPs (not 0.0.0.0/0)"
# Trade-off: public endpoint + IP allow-list is the smallest beta setup. The IPs can change if the environment is
# recreated; re-run this script to resync (stale rules are removed). VNet integration/private endpoint is deferred.
OUTBOUND="$(val '<OUTBOUND_IP_1> <OUTBOUND_IP_2>' containerapp show --resource-group "$RG" --name "$APP" --query 'properties.outboundIpAddresses' )"   # VERIFY: property name
OUTBOUND="${OUTBOUND//$'\t'/ }"; OUTBOUND="${OUTBOUND//,/ }"; OUTBOUND="$(tr -s '[:space:]' ' ' <<<"$OUTBOUND")"
if [[ -z "${OUTBOUND// }" || "$OUTBOUND" == "None" ]]; then
  warn "No outbound IPs found for $APP. Database access is NOT open. Find them (runbook, 'Database firewall') or set AZ_PG_ALLOW_AZURE_SERVICES=1."
fi
wanted_rules=""
for ip in $OUTBOUND; do
  [[ "$ip" == "None" ]] && continue
  rule="knowvia-app-${ip//./-}"; wanted_rules+="$rule "
  az_ postgres flexible-server firewall-rule create --resource-group "$RG" --name "$PG" --rule-name "$rule" --start-ip-address "$ip" --end-ip-address "$ip" -o none
done
if [[ "${AZ_PG_ALLOW_AZURE_SERVICES:-0}" == 1 ]]; then
  warn "AZ_PG_ALLOW_AZURE_SERVICES=1: allowing ANY Azure-hosted client (any tenant) to attempt a connection. Password and TLS still apply."
  az_ postgres flexible-server firewall-rule create --resource-group "$RG" --name "$PG" --rule-name AllowAllAzureServicesAndResourcesWithinAzureIps_knowvia --start-ip-address 0.0.0.0 --end-ip-address 0.0.0.0 -o none
fi
if (( ! DRY_RUN )); then
  for stale in $(az postgres flexible-server firewall-rule list --resource-group "$RG" --name "$PG" --query "[?starts_with(name,'knowvia-app-')].name" -o tsv); do
    [[ " $wanted_rules " == *" $stale "* ]] || az_ postgres flexible-server firewall-rule delete --resource-group "$RG" --name "$PG" --rule-name "$stale" --yes
  done
fi
if (( ! APP_EXISTS )); then
  say "Adding the readiness probe (/ready) now that the database is reachable"
  yaml="$(render_app_yaml "$FQDN" 1)"
  az_ containerapp update --resource-group "$RG" --name "$APP" --yaml "$yaml" -o none
fi

# ---------- 10. Budget, smoke ----------
say "10/10 Budget alert and smoke test"
if [[ -n "${AZ_BUDGET_AMOUNT_INR:-}" ]]; then
  budget_body="$WORK_DIR/budget.json"
  start="$(date -u +%Y-%m-01T00:00:00Z)"
  {
    printf '{"properties":{"category":"Cost","amount":%s,"timeGrain":"Monthly",' "$AZ_BUDGET_AMOUNT_INR"
    printf '"timePeriod":{"startDate":"%s","endDate":"2035-12-31T00:00:00Z"},' "$start"
    printf '"filter":{"dimensions":{"name":"ResourceGroupName","operator":"In","values":["%s"]}},' "$RG"
    printf '"notifications":{'
    sep=""; for pct in 50 90 100; do
      printf '%s"Actual_GreaterThan_%s_Percent":{"enabled":true,"operator":"GreaterThan","threshold":%s,"thresholdType":"Actual","contactEmails":["%s"]}' "$sep" "$pct" "$pct" "$AZ_BUDGET_EMAIL"; sep=","
    done
    printf '}}}'
  } > "$budget_body"
  # VERIFY: api-version and filter shape against the Microsoft.Consumption/budgets REST reference. The amount is in
  # your billing currency (INR if billed in rupees).
  az_ rest --method put --url "https://management.azure.com/subscriptions/${AZ_SUBSCRIPTION_ID}/resourceGroups/${RG}/providers/Microsoft.Consumption/budgets/knowvia-staging-budget?api-version=2023-05-01" --body "@$budget_body" -o none
  echo "Budgets only alert; they do not stop spend."
else
  warn "AZ_BUDGET_AMOUNT_INR not set: NO budget alert created. Create one before real use (runbook, 'Budget')."
fi

if (( DRY_RUN )); then echo "+ $SCRIPT_DIR/smoke.sh https://$FQDN"; else
  "$SCRIPT_DIR/smoke.sh" "https://$FQDN" || { warn "Smoke failed. Logs: az containerapp logs show --resource-group $RG --name $APP --follow false --tail 100"; exit 1; }
fi

cat <<EOF

== Done$( ((DRY_RUN)) && echo ' (dry run: nothing was executed)' || true ).
URL:       https://$FQDN
Bootstrap: az keyvault secret show --vault-name $KV --name $S_BOOTSTRAP --query value -o tsv   (prints the token; keep it out of chat and commits)
Reminder:  STAGING IS NON-DURABLE (local-disk documents, in-process jobs, 1 replica). AI breakdown is unconfigured.

Rollback (redeploy a previous image; images stay in ACR):
  az acr repository show-tags --name $ACR --repository $IMAGE_REPO --orderby time_desc --top 5 -o tsv
  az containerapp update --resource-group $RG --name $APP --image ${ACR_SERVER}/${IMAGE_REPO}:<PREVIOUS_TAG>
Rollback by revision (VERIFY: needs multiple-revision mode; this app runs in single mode):
  az containerapp revision list --resource-group $RG --name $APP -o table
  az containerapp revision set-mode --resource-group $RG --name $APP --mode multiple
  az containerapp revision activate --resource-group $RG --name $APP --revision <PREVIOUS_REVISION>
  az containerapp ingress traffic set --resource-group $RG --name $APP --revision-weight <PREVIOUS_REVISION>=100
  (migrations are forward-only; only roll back to code compatible with the current schema)

Logs: az containerapp logs show --resource-group $RG --name $APP --tail 100
Teardown: az group delete --name $RG --yes --no-wait   (then: az keyvault purge --name $KV --location $LOCATION)
EOF
