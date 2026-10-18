# Runbook: Azure staging

Scope: the Azure staging environment. Synthetic data only. Nothing in this runbook has been run. Every step marked **APPROVE** changes Azure, may cost money, and must be approved by the owner before it is run. Read-only checks are safe to run at any time.

This repository is public. Resource names, the subscription and audit findings are kept out of it: they live in a private variables file on the operator's machine, and audit results are recorded privately, never in the repository, issues or PRs.

## Variables (private file, never committed)

Create `~/.coversaath/azure-staging.env` with mode 600 and load it in each shell with `source ~/.coversaath/azure-staging.env`:

```bash
RG=<resource-group>
APP=<web-app-name>
PLAN=<app-service-plan-name>
PG=<postgresql-flexible-server-name>
LOC=<azure-region>
KV=<key-vault-name>
VNET=<vnet-name>
CLAMD=<clamd-container-group-name>
CLAMD_NSG=<clamd-subnet-nsg-name>
DEPLOY_APP=<deploy-app-registration-name>
DEPLOY_ROLE=<custom-deploy-role-name>
```

`KV` must be globally unique, 3 to 24 characters.

## Pre-flight checks (read-only)

Run these before acting and record the answers privately. Each later step depends on them.

| Check | Why it matters |
|---|---|
| App Service plan tier | Free and Shared tiers have no VNet integration, deployment slots or Always On (Steps 2, 7, 8). |
| Managed identity on the web app | Needed before app settings can reference Key Vault (Step 3). |
| Which app settings hold plain secret values | Plain values are readable by anyone with contributor access; rotate them (Step 4). |
| `DOCUMENT_SCAN_MODE` value | `main` refuses to start on any value other than `disabled` or `clamd` (Step 1). |
| `DATABASE_PATH` set to persistent storage | `main` still uses SQLite and otherwise writes under the deploy directory, which a zip deploy replaces (Step 1). |
| PostgreSQL network access, auth methods, TLS, backups | Public access with password-only auth should move to private access and Entra auth (Step 6). |
| Database collation | ADR 0004 D4 requires `C` (Step 6). |
| Key Vault and container resource providers registered | Steps 2 and 7. |
| Deploy method | A reviewed, reproducible workflow replaces manual deploys (Step 8). |

```bash
az webapp show -g $RG -n $APP --query "{state:state,identity:identity,vnet:virtualNetworkSubnetId}" -o json
```

```bash
az appservice plan show -g $RG -n $PLAN --query "{sku:sku.name}" -o json
```

```bash
az webapp config appsettings list -g $RG -n $APP --query "[].name" -o tsv
```

```bash
az postgres flexible-server db list -g $RG -s $PG --query "[].{name:name,collation:collation}" -o table
```

Never print setting values in a shared terminal or log. Query names only.

## Order

1. Step 1 (scan mode and database path) before any deploy of `main`.
2. Steps 2 to 4 (Key Vault, identity, secret references).
3. Step 5 (readiness detail) ships as code through the normal PR path.
4. Step 6 (C-collation database) can run any time; it is used only once S3.2 wires PostgreSQL into the runtime.
5. Step 7 (clamd) only after the owner approves the paid plan change.
6. Step 8 (deploy workflow) last.

## Step 1: make the current settings valid for `main`

**APPROVE.** `disabled` keeps every upload quarantined, which is the safe default until clamd exists (ADR 0005). Set an explicit persistent SQLite path under `/home/data`, next to the existing document store.

Before you change it, find out where the deployed older build keeps its database and whether it accepts `disabled` (open an SSH session with `az webapp ssh -g $RG -n $APP` and read its config and `/home/site/wwwroot/.local/`). If the staging data matters, stop the app (**APPROVE**, `az webapp stop -g $RG -n $APP`), copy the SQLite file to `/home/data/knowvia.sqlite` in that SSH session, check it with `node -e` and `PRAGMA integrity_check`, then continue. Otherwise record that the staging data is synthetic and disposable.

```bash
az webapp config appsettings set -g $RG -n $APP --settings DOCUMENT_SCAN_MODE=disabled DATABASE_PATH=/home/data/knowvia.sqlite
```

Check:

```bash
az webapp config appsettings list -g $RG -n $APP --query "[?name=='DOCUMENT_SCAN_MODE' || name=='DATABASE_PATH'].{n:name,v:value}" -o table
```

Rollback: set `DOCUMENT_SCAN_MODE` back to its previous value only if the older code is still deployed, and remove `DATABASE_PATH` with `az webapp config appsettings delete -g $RG -n $APP --setting-names DATABASE_PATH`.

## Step 2: Key Vault

**APPROVE.** Register the provider (one time per subscription):

```bash
az provider register -n Microsoft.KeyVault --wait
```

**APPROVE.** Create the vault with Azure RBAC, purge protection and 90-day soft delete. Key Vault standard tier charges per operation; check the Azure pricing page.

```bash
az keyvault create -g $RG -n $KV -l $LOC --sku standard --enable-rbac-authorization true --enable-purge-protection true --retention-days 90 --public-network-access Enabled
```

Public network access stays enabled while the plan has no VNet integration (Free and Shared tiers cannot reach a private endpoint). Access is still limited to Entra identities with a role on the vault. After Step 7 moves the app into a VNet, add a private endpoint for the vault (with the `privatelink.vaultcore.azure.net` private DNS zone linked to the VNet) and only then disable public access; VNet integration alone cannot reach a vault with public access disabled.

**APPROVE.** Give the operator (you) permission to write secrets, scoped to this vault only:

```bash
az role assignment create --assignee "$(az ad signed-in-user show --query id -o tsv)" --role "Key Vault Secrets Officer" --scope "$(az keyvault show -n $KV --query id -o tsv)"
```

## Step 3: system-assigned managed identity

**APPROVE.**

```bash
az webapp identity assign -g $RG -n $APP
```

**APPROVE.** Read-only access to secrets for the app, scoped to this vault:

```bash
az role assignment create --assignee-object-id "$(az webapp identity show -g $RG -n $APP --query principalId -o tsv)" --assignee-principal-type ServicePrincipal --role "Key Vault Secrets User" --scope "$(az keyvault show -n $KV --query id -o tsv)"
```

## Step 4: move secrets into Key Vault

Write each value to a file with mode 600 in a private directory, load it with `--file`, then delete the file. This keeps values out of shell history and process lists. Every command that writes a secret file sets `umask 077` in the same command, and strips the trailing newline (`--file` would store it in the secret).

```bash
(umask 077 && mkdir -p ~/.knowvia-secrets)
```

### 4a. Document encryption key: keep the same value

Changing `DOCUMENT_ENCRYPTION_KEY_BASE64` makes every stored document unreadable. Copy the current value; do not generate a new one.

```bash
(umask 077 && az webapp config appsettings list -g $RG -n $APP --query "[?name=='DOCUMENT_ENCRYPTION_KEY_BASE64'].value" -o tsv | tr -d '\n' > ~/.knowvia-secrets/doc-key)
```

**APPROVE.**

```bash
az keyvault secret set --vault-name $KV -n document-encryption-key --file ~/.knowvia-secrets/doc-key --encoding utf-8 --query id -o tsv
```

### 4b. Rotate the rest

These values sat in plain app settings, so replace them rather than copy them.

- `KNOWVIA_BOOTSTRAP_TOKEN`: `(umask 077 && openssl rand -hex 32 | tr -d '\n' > ~/.knowvia-secrets/bootstrap)`.
- `GEMINI_API_KEY`: create a new key in Google AI Studio, paste it with `(umask 077 && pbpaste | tr -d '\n' > ~/.knowvia-secrets/gemini)`, revoke the old key after Step 4c is checked.
- `SARVAM_API_KEY`: same, from the Sarvam dashboard, into `~/.knowvia-secrets/sarvam`.
- `DATABASE_URL`: prefer the least-privilege role from Step 6 over the admin. If you keep the admin for now, rotate its password: generate it into a file with `(umask 077 && openssl rand -base64 32 | tr -d '/+=\n' > ~/.knowvia-secrets/pg-admin)`, then **APPROVE** `az postgres flexible-server update -g $RG -n $PG --admin-password "$(cat ~/.knowvia-secrets/pg-admin)"`. The value is briefly visible in the process list of your own machine; nothing else records it. This breaks the current app until 4c finishes. Then write `postgres://<user>:<password>@<server>.postgres.database.azure.com:5432/<db>?sslmode=verify-full` (no trailing newline) into `~/.knowvia-secrets/database-url`.

**APPROVE**, one command per secret:

```bash
az keyvault secret set --vault-name $KV -n bootstrap-token --file ~/.knowvia-secrets/bootstrap --encoding utf-8 --query id -o tsv
```

```bash
az keyvault secret set --vault-name $KV -n gemini-api-key --file ~/.knowvia-secrets/gemini --encoding utf-8 --query id -o tsv
```

```bash
az keyvault secret set --vault-name $KV -n sarvam-api-key --file ~/.knowvia-secrets/sarvam --encoding utf-8 --query id -o tsv
```

```bash
az keyvault secret set --vault-name $KV -n database-url --file ~/.knowvia-secrets/database-url --encoding utf-8 --query id -o tsv
```

### 4c. Point the app settings at Key Vault

**APPROVE.** References without a version follow the latest secret version (refreshed within 24 hours, or on restart).

```bash
az webapp config appsettings set -g $RG -n $APP --settings \
  "DOCUMENT_ENCRYPTION_KEY_BASE64=@Microsoft.KeyVault(VaultName=$KV;SecretName=document-encryption-key)" \
  "KNOWVIA_BOOTSTRAP_TOKEN=@Microsoft.KeyVault(VaultName=$KV;SecretName=bootstrap-token)" \
  "GEMINI_API_KEY=@Microsoft.KeyVault(VaultName=$KV;SecretName=gemini-api-key)" \
  "SARVAM_API_KEY=@Microsoft.KeyVault(VaultName=$KV;SecretName=sarvam-api-key)" \
  "DATABASE_URL=@Microsoft.KeyVault(VaultName=$KV;SecretName=database-url)"
```

Check that every reference resolved (`status` must be `Resolved`):

```bash
az rest --method get --url "$(az webapp show -g $RG -n $APP --query id -o tsv)/config/configreferences/appsettings?api-version=2022-03-01" --query "value[].{name:name,status:properties.status}" -o table
```

Then delete the local files and revoke the old Gemini and Sarvam keys:

```bash
rm -f ~/.knowvia-secrets/* && rmdir ~/.knowvia-secrets
```

Deleting a file does not reliably erase it on an SSD. FileVault disk encryption is what protects the remains; check it is on.

Rollback: set the plain values back with `az webapp config appsettings set` (the same values, from the vault with `az keyvault secret show`). Never roll back the encryption key to a different value.

## Step 5: limit `/api/v1/ready` detail

`GET /api/v1/ready` is unauthenticated. Before PR rish106-hub/CoverSaath#15 it returned the full schema validation result to every caller. #15 (merged) changes that in code, not in Azure:

- Non-loopback callers get only `{ status, checks }` with booleans.
- The `database` detail goes only to a loopback peer with no forwarding headers that passes the local request guard. Behind App Service's front end every request carries forwarding headers, so staging never returns the detail. Abuse tests: `tests/ready-detail.test.mjs`.
- Deploy only a build that includes PR #15. Any build of `main` after its merge does.
- Point the App Service health check at `/api/v1/ready` after this ships (**APPROVE**: `az webapp config set -g $RG -n $APP --generic-configurations '{"healthCheckPath":"/api/v1/ready"}'`). Health checks need at least the Basic tier to replace instances; on Free they only report.

## Step 6: new database with C collation (ADR 0004 D4)

The existing `knowvia` database stays as it is until S3.2 cuts over; nothing reads it from `main`. Create a second database and a least-privilege role.

**APPROVE.** Connect as the admin (needs your current IP allowed; add a rule with `az postgres flexible-server firewall-rule create -g $RG -n $PG -r operator-tmp --start-ip-address <ip> --end-ip-address <ip>` and delete it afterwards with `az postgres flexible-server firewall-rule delete -g $RG -n $PG -r operator-tmp --yes`). Then:

```sql
CREATE DATABASE coversaath TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C';
CREATE ROLE coversaath_app LOGIN;
\password coversaath_app
GRANT CONNECT ON DATABASE coversaath TO coversaath_app;
\c coversaath
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO coversaath_app;
```

`\password` prompts for the value without echoing it or writing it to `~/.psql_history`. Store the same value in Key Vault as part of `database-url`. `CREATE` on `public` is needed only while the app runs its own migrations (ADR 0004). Split a migration role from the runtime role when S3.2 adds a separate migration step.

Check (read-only):

```sql
SELECT datname, datcollate, datctype FROM pg_database WHERE datname = 'coversaath';
SELECT 'B' < 'a' AS c_ordering;  -- must be true
```

Before cutover, validate the schema with the PostgreSQL validator (`src/backend/database/postgres/validate-schema.js`) once S3.2 wires a command for it. Blocked until then. Rollback: `DROP DATABASE coversaath;` (holds no data until cutover).

Later, after cutover: drop the per-IP firewall rules in favour of private access (Step 7 VNet), enable Entra authentication for the app identity, and drop `knowvia`.

## Step 7: private clamd (needs a paid plan)

Requirements from `docs/runbooks/clamav.md`: clamd reachable only on a private address, the required settings (`AlertExceedsMax yes`, `AlertEncrypted yes`, `ScanPDF yes`, `StreamMaxLength 16M`), scheduled signature updates, port 3310 never public.

A plan without VNet integration cannot reach a private clamd, so these owner decisions come first:

1. **APPROVE (cost).** Move the plan to Basic B1 or higher: `az appservice plan update -g $RG -n $PLAN --sku B1`. Check the current price in the Azure pricing calculator.
2. **APPROVE (cost).** Run clamd. ClamAV needs about 3 GiB of memory to load signatures. Options: Azure Container Instances in a delegated subnet, or an internal-only Container Apps environment. Both bill while running.

Until then keep `DOCUMENT_SCAN_MODE=disabled`. Uploads are accepted and stay quarantined; nothing is OCR-eligible.

Commands for the Container Instances option, once approved:

```bash
az provider register -n Microsoft.ContainerInstance --wait
```

```bash
az network vnet create -g $RG -n $VNET -l $LOC --address-prefixes 10.40.0.0/16 --subnet-name app --subnet-prefixes 10.40.1.0/24
```

```bash
az network vnet subnet update -g $RG --vnet-name $VNET -n app --delegations Microsoft.Web/serverFarms
```

```bash
az network vnet subnet create -g $RG --vnet-name $VNET -n clamd --address-prefixes 10.40.2.0/24 --delegations Microsoft.ContainerInstance/containerGroups
```

```bash
az webapp vnet-integration add -g $RG -n $APP --vnet $VNET --subnet app
```

Restrict the `clamd` subnet before anything listens on it (**APPROVE**):

```bash
az network nsg create -g $RG -n $CLAMD_NSG -l $LOC
```

```bash
az network nsg rule create -g $RG --nsg-name $CLAMD_NSG -n allow-app-3310 --priority 100 --direction Inbound --access Allow --protocol Tcp --source-address-prefixes 10.40.1.0/24 --destination-port-ranges 3310
```

```bash
az network nsg rule create -g $RG --nsg-name $CLAMD_NSG -n deny-vnet-inbound --priority 200 --direction Inbound --access Deny --protocol '*' --source-address-prefixes VirtualNetwork --destination-port-ranges '*'
```

```bash
az network vnet subnet update -g $RG --vnet-name $VNET -n clamd --network-security-group $CLAMD_NSG
```

Put the runbook settings in a `clamd.conf` (start from the image's default, apply every setting from `docs/runbooks/clamav.md`, and set `TCPAddr 0.0.0.0` because the container only has its private address), then:

```bash
az container create -g $RG -n $CLAMD --image clamav/clamav:<pinned version>@sha256:<digest> --os-type Linux --cpu 1 --memory 3 --vnet $VNET --subnet clamd --ip-address Private --ports 3310 --restart-policy Always --secrets-mount-path /etc/clamav-config --secrets clamd.conf="$(cat clamd.conf)"
```

The official image runs `freshclam` on a schedule inside the container. Check that the image reads the mounted config path (or override its command to `clamd --config-file=/etc/clamav-config/clamd.conf --foreground`).

```bash
az container show -g $RG -n $CLAMD --query ipAddress.ip -o tsv
```

Check clamd before the app depends on it. The upload route rejects a raw EICAR file as not a PDF, so the check runs at scanner level: from an SSH session in the app (`az webapp ssh -g $RG -n $APP`, inside the VNet) run `CLAMD_TEST_HOST=<private ip> node --test tests/clamd-integration.test.mjs` from the deployed source. All five tests must pass. Only then switch the app (**APPROVE**):

```bash
az webapp config appsettings set -g $RG -n $APP --settings DOCUMENT_SCAN_MODE=clamd CLAMD_HOST=<private ip> CLAMD_PORT=3310
```

Watch for `document_scanner_unreachable` in the app log. Rollback: `DOCUMENT_SCAN_MODE=disabled`; pending documents resume once clamd is back.

## Step 8: deploy workflow with rollback

Keep it out of `.github/workflows/` until the owner approves the Azure and GitHub changes below. Design:

- Trigger: `workflow_dispatch` only, plus `workflow_run` after `CI` succeeds on `main` if automatic deploys are wanted later.
- Auth: GitHub OIDC to an Entra app registration with a federated credential for `repo:rish106-hub/CoverSaath:environment:staging`. No client secret, no publish profile.
- Role: a custom role scoped to the web app only, allowing `Microsoft.Web/sites/read`, `Microsoft.Web/sites/publish/action` and `Microsoft.Web/sites/restart/action`, and not `Microsoft.Web/sites/config/list/action` (the pipeline must not read app settings). Built-in `Website Contributor` would also let it read and change app settings.
- GitHub environment `staging` with the owner as required reviewer.
- Build once: `npm ci`, `npm run check`, `npm run eval:safety`, `npm ci --omit=dev` into a zip with `dist/`, `src/`, `node_modules/`, `package.json`. Upload the zip as a workflow artifact named with the commit SHA, kept 30 days.
- Deploy: `azure/login` with OIDC, then `az webapp deploy --type zip`. Pin every action to a full commit SHA, like `ci.yml`.
- Verify: poll `/api/v1/ready` until `200`, fail the job otherwise.
- Rollback: without deployment slots (below the Standard tier), rollback is a re-run of the workflow with input `artifact_run_id` pointing at the last good run; it downloads that run's zip and deploys it. Migrations are expand-only (ADR 0004), so an older build runs against a newer schema. With a Standard plan, switch to a `staging` slot plus swap instead.

**APPROVE** (Entra and GitHub changes, one time):

```bash
az ad app create --display-name $DEPLOY_APP --query appId -o tsv
```

```bash
az ad sp create --id <appId>
```

```bash
az ad app federated-credential create --id <appId> --parameters '{"name":"github-staging","issuer":"https://token.actions.githubusercontent.com","subject":"repo:rish106-hub/CoverSaath:environment:staging","audiences":["api://AzureADTokenExchange"]}'
```

Create the custom role from a reviewed JSON definition (`Actions`: `Microsoft.Web/sites/read`, `Microsoft.Web/sites/publish/action`, `Microsoft.Web/sites/restart/action`; `AssignableScopes`: the web app id), then:

```bash
az role definition create --role-definition @deploy-role.json
```

```bash
az role assignment create --assignee-object-id "$(az ad sp show --id <appId> --query id -o tsv)" --assignee-principal-type ServicePrincipal --role "$DEPLOY_ROLE" --scope "$(az webapp show -g $RG -n $APP --query id -o tsv)"
```

Check before relying on it that `az webapp deploy` works with only these actions (zip deploy goes through the Kudu publish endpoint); add the smallest missing action if it does not.

Then, in GitHub (owner): create environment `staging` with a required reviewer and add variables `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` (identifiers, not secrets).

## Not verified

- None of the APPROVE steps has been run.
- Whether the official ClamAV image honours a mounted config without a command override.
- Whether the custom deploy role is enough for `az webapp deploy`.
- Whether the deployed older build accepts `DOCUMENT_SCAN_MODE=disabled` and where it keeps its SQLite file.
- Whether the older staging build stored documents in a format `main` can read with the same key.
- Prices. Check the Azure pricing calculator before approving Steps 2, 7 and 8.
