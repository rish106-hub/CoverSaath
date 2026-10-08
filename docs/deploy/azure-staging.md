# Knowvia Azure staging deploy (Container Apps, centralindia)

Status: kit written and dry-run verified on a machine without `az`. It has **not been run against a real subscription**. Every `# VERIFY:` marker in `scripts/deploy/azure-staging.sh` is a flag or property I could not confirm offline; check each against your installed az version. The GCP kit (`gcp-staging.md`) is untouched and unused.

## Read this first: staging is pre-M3 and NON-DURABLE

| Limitation | Why | Consequence |
|---|---|---|
| Documents are stored on the replica's local disk (`DOCUMENT_STORAGE_PATH=/tmp/knowvia-documents`) | Blob storage is milestone M3 | Documents vanish on every restart, crash or new revision, including every re-run of the deploy script. Local disk is ephemeral and size-limited. Not a system of record. |
| Breakdown jobs run in-process (`setImmediate`) | A queue and worker are M3 | A restart kills running jobs. A second replica would not see the first one's files or jobs. |
| So the app is pinned to **min=max=1 replica**, single-revision mode | State is per replica | No autoscaling. A revision swap restarts the only replica. Cost is a continuous replica. |
| AI breakdown is unconfigured | No Gemini route is chosen yet (see "Gemini options") | `LLM_MODEL` and `BREAKDOWN_LLM_MODEL` are unset, so the runner fails closed. Staging exercises UI, auth, DB, upload and OCR plumbing only. |
| Uploads stay quarantined by default | `DOCUMENT_SCAN_MODE` unset means `antivirus_required`, and no scanner exists | To exercise upload you must opt in with `DOCUMENT_SCAN_MODE=structural_only` (structure check only, no antivirus). Do not use real third-party documents with it. |
| Database is on a public endpoint with an IP allow-list | VNet integration and private endpoints are deferred | See "Database access". |

At M3 this moves to Azure Blob Storage plus a queue and a worker app, and multiple replicas become possible.

## Design choices

- **Build with `az acr build`, not `az containerapp up --source`.** `acr build` builds in the cloud (no local Docker), uses the repository's `Dockerfile` and `.dockerignore`, and leaves us in control of everything else: the user-assigned identity for ACR pull and Key Vault, the secret references, probes, single-replica scale and the firewall order. `containerapp up` creates its own registry and credentials and cannot express Key Vault references or probes. Both rely on ACR Tasks, so the same caveat applies (below).
- **Container app is created from generated YAML**, because probes and Key Vault-backed secrets are not all expressible as plain `az containerapp create` flags. The YAML contains Key Vault URLs only, never secret values.
- **Secrets**: Key Vault (RBAC mode). The app's user-assigned managed identity has `AcrPull` on the registry and `Key Vault Secrets User` on the vault. The deploying user gets `Key Vault Secrets Officer` to write the secrets. Secret references are version-less, so a new secret version is picked up on the next revision restart.
- **Names** that must be globally unique (registry, vault, Postgres server) get an 8-hex suffix derived from the subscription ID. Override with `AZ_NAME_SUFFIX`, `AZ_ACR_NAME`, `AZ_KEYVAULT_NAME`, `AZ_PG_SERVER`.
- **Sizing**: 0.5 vCPU and 1 GiB for the app (a valid Consumption combination, VERIFY the current table); Postgres Burstable `Standard_B1ms`, 32 GiB, version 16, no HA, 7-day backups.

## Prerequisites (you do these; the script will not)

1. `brew install azure-cli`
2. `az login`
3. A subscription with credits or a payment method: `az account list -o table`. Note the subscription ID.
4. The script registers the resource providers (`Microsoft.App`, `Microsoft.OperationalInsights`, `Microsoft.DBforPostgreSQL`, `Microsoft.KeyVault`, `Microsoft.ContainerRegistry`, plus ManagedIdentity and Consumption). You may do it first: `az provider register --namespace Microsoft.App --wait`, and so on. This needs a role that can register providers (Owner or Contributor).
5. Your account needs Owner (or Contributor plus User Access Administrator) on the subscription or resource group, because the script creates role assignments.
6. Check regional availability: `az postgres flexible-server list-skus --location centralindia -o table` should list `Standard_B1ms` for version 16.
7. Optional: the Sarvam API key, the public PostHog project key (`phc_...`), a monthly budget in rupees and an alert email.

## Run

```bash
export AZ_SUBSCRIPTION_ID=<guid>
export AZ_BUDGET_AMOUNT_INR=3000        # optional, whole rupees; needs AZ_BUDGET_EMAIL
export AZ_BUDGET_EMAIL=you@example.com  # optional
export SARVAM_API_KEY=...               # optional; otherwise prompted with hidden input
export VITE_POSTHOG_KEY=phc_...         # optional; the only build-time value (host is fixed to /ingest)
# export DOCUMENT_SCAN_MODE=structural_only   # optional, see limitations

scripts/deploy/azure-staging.sh --dry-run   # review every az command and the generated YAML first
scripts/deploy/azure-staging.sh             # real run; safe to repeat
scripts/deploy/smoke.sh https://<app-fqdn>  # re-run checks any time
```

Order: providers, extension, resource group; identity, registry, Key Vault and role assignments; secrets (only when absent); Postgres server (no firewall rules); Container Apps environment; cloud image build; container app **without** the readiness probe; FQDN check; database firewall for the app's outbound IPs; **readiness probe added**; budget; smoke test.

Why the readiness probe comes late: `/ready` checks the database, but the firewall can only be opened after the app exists (its outbound IPs are not known earlier). The server opens the database lazily and runs migrations on the first request that needs it, so starting without a reachable database is fine; `/live` stays green.

`az account set` changes your default subscription. The script waits for role-assignment propagation (up to about 3 minutes on the Key Vault listing plus a 60-second pause before creating the app); if it still fails with a permission error, re-run it, since every step is idempotent.

## Secrets handling

- Generated with openssl: bootstrap token (32 bytes hex), document encryption key (32 bytes, base64), Postgres password (hex plus `Aa1` so it meets Azure's three-character-class rule; all URL-safe).
- Values are written to files in a private `mktemp -d` (mode 700, files 600), passed with `az keyvault secret set --file`, and shredded on exit (`shred`, or `rm -P` on macOS). Nothing is written to a repo file. The public PostHog key is the only value written into the repo tree (`scripts/deploy/vite-public.env`, removed on exit; it is gitignored).
- **Places where az may put a secret on the command line**:
  - `az postgres flexible-server create/update --admin-password` is the only way to set the admin password. The script passes `@<file>` (az expands `@file` argument values), which keeps it off argv. VERIFY this works in your az version. If az rejects it, `AZ_ALLOW_SECRET_ARGV=1` passes the password directly; it is then briefly visible in this machine's process list.
  - Nothing else puts a secret on argv. The budget email goes in a temp-file JSON body.
- Rotating: add a new Key Vault secret version, then restart the revision. If you change the DB password, also update the server password and `knowvia-database-url`.

## Environment variables (names only)

| Variable | Source | Notes |
|---|---|---|
| `NODE_ENV=production`, `HOST=0.0.0.0`, `PORT=8080`, `STATIC_DIR=dist`, `TRUST_PROXY_HOPS=1`, `POSTHOG_REGION=eu`, `SHUTDOWN_GRACE_MS=8000` | plain env | Container Apps' Envoy front end is assumed to append the client IP to `X-Forwarded-For` (one trusted hop). VERIFY with a request and the access log before trusting per-IP rate limits. |
| `ALLOWED_HOSTS`, `ALLOWED_ORIGINS` | plain env | The app FQDN, `<app>.<environment default domain>`. Predicted before create and checked against `properties.configuration.ingress.fqdn` afterwards; updated only if different. Add a custom domain here later. |
| `DOCUMENT_STORAGE_PATH`, `DATABASE_POOL_MAX`, `DOCUMENT_SCAN_MODE` (opt-in) | plain env | See limitations. |
| `DATABASE_URL` | Key Vault `knowvia-database-url` | `postgresql://knowvia_admin:...@<server>.postgres.database.azure.com:5432/knowvia?sslmode=require` |
| `KNOWVIA_BOOTSTRAP_TOKEN` | Key Vault `knowvia-bootstrap-token` | Creates the first household. |
| `DOCUMENT_ENCRYPTION_KEY_BASE64` | Key Vault `knowvia-document-encryption-key` | Losing it makes stored documents unreadable. |
| `SARVAM_API_KEY` | Key Vault `knowvia-sarvam-api-key` | Mounted only if the secret exists. |
| `VITE_POSTHOG_KEY` | build time only | `VITE_POSTHOG_HOST` is no longer used; the UI uses the fixed same-origin `/ingest`. |

Deliberately unset: `LLM_MODEL`, `BREAKDOWN_LLM_MODEL`, `GEMINI_API_KEY`, `OPENAI_API_KEY`.

## Database access, TLS and migrations

**Firewall.** The server is created with public access and no rules. After the app exists the script reads the app's outbound IPs (`properties.outboundIpAddresses`, VERIFY) and adds one single-IP rule each (`knowvia-app-<ip>`), removing stale `knowvia-app-*` rules on re-runs. Trade-off: this is much narrower than `0.0.0.0/0` or the "allow all Azure services" rule, but a public endpoint still exists, and the outbound IPs can change if the environment is recreated (re-run the script to resync). `AZ_PG_ALLOW_AZURE_SERVICES=1` adds the wider "any Azure-hosted client" rule as a fallback; only the password and TLS then stand in the way. If the property is empty, find the IPs in the Azure portal (container app, Networking) and add rules by hand. To connect from your own machine for debugging, add a temporary rule for your IP and remove it afterwards. VNet integration or a private endpoint is deferred to the launch milestone.

**TLS (report only, no code change needed).** `readDatabaseConfig` passes `DATABASE_URL` straight to `pg.Pool({ connectionString })` and sets no `ssl` option. With `pg` 8.23.1 and `pg-connection-string` 2.14.1, `?sslmode=require` makes the parser set `ssl = {}`, which enables TLS **with certificate verification against Node's built-in CA store**. This should work with Azure's certificate chain, but VERIFY on the first real connection: if you see a certificate error, the options are (a) add the Azure root certificate and pass `sslrootcert` (needs the file in the image), or (b) append `uselibpqcompat=true` to the URL, which makes `require` encrypt without verifying the server (weaker; acceptable only for staging). The server also enforces `require_secure_transport=on`, which the script sets explicitly.

**Migrations.** `openDatabase` runs `runMigrations` by default, in one transaction under `pg_advisory_xact_lock`, with checksums. The server opens the database lazily on the first request that needs it, so migrations run at the first `/ready` or API call. Safe with one replica (and with several, because of the lock). The pool's 15-second `statement_timeout` also bounds migrations. Migrations are forward-only. The app connects as the server admin `knowvia_admin` (needed for DDL); narrowing to a least-privilege role is a later task.

**Runtime imports.** `@electric-sql/pglite` is a devDependency imported dynamically only when `DATABASE_URL` is absent, so the production image (`npm ci --omit=dev`) does not crash at import time.

## Backups

`az postgres flexible-server create` is called with `--backup-retention 7` and no geo-redundancy. Flexible Server takes automated backups with point-in-time restore inside the retention window. Verify and drill:

```bash
az postgres flexible-server show -g knowvia-staging-rg -n <server> --query backup
az postgres flexible-server restore -g knowvia-staging-rg -n knowvia-restore-test --source-server <server> --restore-time <UTC-ISO-8601>
```

The restore drill creates a new server (billed until deleted). Backups cover the database only, not documents.

## Budget

If `AZ_BUDGET_AMOUNT_INR` and `AZ_BUDGET_EMAIL` are set, the script creates a monthly Cost Management budget scoped to the resource group with alerts at 50%, 90% and 100% of actual cost, through `az rest` against `Microsoft.Consumption/budgets` (api-version and filter shape are VERIFY items; the amount is in your billing currency). Without them, create one in the portal under Cost Management, Budgets. Budgets alert only; they do not stop spend. The 300-rupee Gemini cap is a separate in-app limit and is not exercised until an AI route exists.

## Cost estimate (estimate only, not verified against current Azure pricing)

The plan's range is about 1,000 to 2,000 rupees a month for the smallest configuration. Expect:

- PostgreSQL Flexible Server B1ms plus 32 GiB storage: the largest line, always on.
- Container Apps Consumption with one always-on replica (0.5 vCPU, 1 GiB): charged at the idle rate when not serving requests, but never zero because min replicas is 1.
- ACR Basic: a small fixed daily fee. Log Analytics, Key Vault operations: small at this volume.

Use the Azure pricing calculator for Central India before relying on this. Credits should cover the beta.

## Gemini options (decision for you; nothing is implemented)

| Option | What it means | Open question |
|---|---|---|
| (a) Vertex AI in asia-south1, called cross-cloud from Azure via Workload Identity Federation | No long-lived key. Needs a small GCP project just for Vertex, a workload identity pool trusting the Azure managed identity, and the unimplemented `@ai-sdk/google-vertex` integration. Keeps data in India. | Engineering work in `src/`, and two clouds to operate. |
| (b) Paid AI Studio key in Key Vault | Simplest. | The plan forbade real PDFs on a free-tier key. Does the paid tier's data-use terms satisfy that rule? Needs your call before any real document goes through it. |
| (c) Keep AI unconfigured in staging (**default**) | Breakdown runner fails closed. | None; staging cannot demonstrate the AI breakdown. |

## Rollback

Preferred (single-revision mode, images stay in ACR):

```bash
az acr repository show-tags --name <acr> --repository knowvia-api --orderby time_desc --top 5 -o tsv
az containerapp update -g knowvia-staging-rg -n knowvia-staging-api --image <acr>.azurecr.io/knowvia-api:<PREVIOUS_TAG>
```

By revision (VERIFY: requires switching to multiple-revision mode, and would briefly run two replicas):

```bash
az containerapp revision list -g knowvia-staging-rg -n knowvia-staging-api -o table
az containerapp revision set-mode -g knowvia-staging-rg -n knowvia-staging-api --mode multiple
az containerapp revision activate -g knowvia-staging-rg -n knowvia-staging-api --revision <PREVIOUS_REVISION>
az containerapp ingress traffic set -g knowvia-staging-rg -n knowvia-staging-api --revision-weight <PREVIOUS_REVISION>=100
```

Either way local documents from the replaced replica are gone, and migrations are not reverted.

## Logs and bootstrap

```bash
az containerapp logs show -g knowvia-staging-rg -n knowvia-staging-api --tail 100
az keyvault secret show --vault-name <kv> --name knowvia-bootstrap-token --query value -o tsv   # prints the token; keep it out of chat and commits
```

## Teardown

```bash
az group delete --name knowvia-staging-rg --yes --no-wait
az keyvault purge --name <kv> --location centralindia     # after deletion; soft-deleted vault names are reserved for 7 days
az keyvault list-deleted -o table
az rest --method delete --url "https://management.azure.com/subscriptions/<id>/resourceGroups/knowvia-staging-rg/providers/Microsoft.Consumption/budgets/knowvia-staging-budget?api-version=2023-05-01"   # normally removed with the resource group
```

The Container Apps environment's Log Analytics workspace is created in a managed resource group or in the same group; check `az group list -o table` for leftovers.

## Known risks

- **ACR Tasks may be blocked** for some free or trial subscription types, which makes `az acr build` fail. Both `az acr build` and `az containerapp up --source` depend on it. Without local Docker the alternatives are a CI build (for example GitHub Actions pushing to ACR) or requesting access from Azure support.
- External ingress: the URL is public and only the app's own auth protects it. There is no WAF.
- Unconfirmed flags and properties are marked `# VERIFY:` in the script (secret `--file`, `@file` for the password, `outboundIpAddresses`, budget REST shape, `TRUST_PROXY_HOPS` behind Envoy, SKU availability).

## Not done (do not assume any of these exist)

- Any Gemini route (Vertex over federation, AI Studio key); the AI breakdown is unconfigured.
- Azure Blob Storage documents, a queue and a worker (M3); multi-replica operation.
- Phone OTP authentication; the app relies on its own session auth.
- WAF, Front Door or CDN; custom domain and managed certificate.
- VNet integration, private endpoints, least-privilege database role.
- Infrastructure as code, uptime checks and alert rules on latency, 5xx, DB connections.
- Antivirus scanning of uploads; load test and a restore drill (run the drill above once).
