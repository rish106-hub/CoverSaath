# ADR 0020: AWS KMS as the root of trust for data keys (envelope encryption)

- Status: Proposed (2026-11-07). Design only: no code, no migration, no cloud resource has been created. Owner decisions pending (see Open questions).
- Synthetic data only. Every statement below about legal duties (DPDP Act, CERT-In, data residency, erasure promises in a notice) is an engineering reading and is **FOR LEGAL REVIEW**.
- Related: ADR 0011 (Supabase + Fly), ADR 0013 and its addendum D2 (column encryption, `enc2.` envelope, key ring, backfill), ADR 0014 (app events, keyed client hash), ADR 0015 (user data, blind index), ADR 0018 (privacy risk acceptance), `docs/runbooks/fly-deploy.md`, `docs/architecture/data-lifecycle.md`. Plan item S4 (Wave 2), which depends on D2 and on the owner creating an AWS account.

## Context

Facts from the code today:

- `src/backend/security/column-crypto.js` seals text columns as `enc2.<keyId>.<nonce>.<tag>.<ciphertext>` with AES-256-GCM, AAD `table.column.rowId`, and length padding. `enc1.` values still open. Keys come from environment variables: `DATA_ENCRYPTION_KEY_BASE64` (current, id `DATA_ENCRYPTION_KEY_ID`, default `k1`) and `DATA_ENCRYPTION_PREVIOUS_KEYS_JSON` (older ids that still decrypt). Key ids are 1 to 16 characters of `[A-Za-z0-9_-]`.
- `seal` and `open` are **synchronous**, and every repository calls them synchronously. The key ring is built once at startup (`create-server.js`, `scripts/encrypt-existing-rows.mjs`, `scripts/backfill-adult-contacts.mjs`).
- Three further keys are **derived** from the current data key: the blind-index key (`blindIndex`, used for `idempotency_keys.document_index`), the per-ring blind indexes (`blindIndexes`), and the app-events client-hash key (`deriveEventHmacKey`, ADR 0014). Changing the raw bytes of the current key changes all of them.
- Document bytes use a separate key, `DOCUMENT_ENCRYPTION_KEY_BASE64`, in the `CSD1` envelope (`src/features/input/document-envelope.js`). `CSD1` carries **no key id**, so the document key cannot be rotated today without re-encrypting every blob in one step.
- `src/backend/security/column-backfill.js` (`--rotate`) re-seals every value whose key id is not current, recomputes the document index, and reports `unreadable` rows instead of skipping them silently.
- The Fly app `knowvia-api` (region `sin`, two machines) is not yet running. `DATA_ENCRYPTION_KEY_BASE64` is not yet set on it; `DOCUMENT_ENCRYPTION_KEY_BASE64` is staged as a Fly secret.
- Owner decision recorded in the plan (2026-11-06): KMS in `ap-south-1` (Mumbai). The AWS account does not exist yet. The owner's AWS environment allows a single project Region (set by the contact address), no cross-Region actions and no multi-Region keys.

The problem: the root of trust is a raw 32-byte key in a Fly secret. Anyone who can read that secret (a Fly org member, a leaked `fly secrets` export, an operator machine's `.env.local`, a mistaken log) and a database dump reads everything, with no audit trail and no way to switch access off without rotating and re-sealing the whole database.

## Threat model

Assets: sealed columns (ADR 0013 D3 and addendum D2), document bytes, the blind-index and event-hash keys derived from the data key.

| Adversary or event | Today (raw key in env) | With this design |
| --- | --- | --- |
| Database dump, leaked backup, Supabase operator | Ciphertext only | Unchanged: ciphertext only |
| Leak of Fly secrets (export, screenshot, operator `.env`) | Full read of every sealed value, silent | Wrapped data keys are useless without KMS `Decrypt`; with OIDC there is no static AWS credential to leak |
| Leaked secret **and** database dump | Full read | Still needs a live `Decrypt` call under the runtime role: logged in CloudTrail, stoppable by disabling the key |
| Compromised running app process (RCE) | Full read | **Not defended.** The process holds plaintext data keys in memory and can call KMS. Gains: CloudTrail record of `Decrypt` calls, and a kill switch (disable the key) |
| Malicious deploy by a Fly org member | Full read | Not defended: deployed code runs as the app and gets the role. Mitigate with Fly org access control and branch protection; record as residual risk |
| AWS-side insider | n/a | Out of scope: KMS keys are non-exportable HSM-backed keys; we trust AWS for that |
| Loss of the key | Data in sealed columns lost | Same, plus new ways to lose it: KMS key scheduled for deletion, AWS account closed, **project paused by a spend limit** (KMS answers access denied, so the app cannot start). See Failure modes |
| Accidental disclosure in logs | Raw key could be logged by mistake | Only wrapped blobs and key ids exist in config; plaintext keys never leave memory |

This is still encryption at rest in the application layer. It moves the root of trust, adds an audit trail and a revocation switch, and removes long-lived raw keys from configuration. It does not protect data from the running server.

## Decision (proposed)

### D1. Key hierarchy: one KMS key wraps the existing key ring

```
AWS KMS customer-managed key (symmetric, single-Region, ap-south-1)    -- KEK, never leaves KMS
  ├── wraps column data key k1, k2, ...   (32 bytes each, AES-256-GCM, the existing ring)
  │     └── derived in process: blind-index key, event-hash key (unchanged derivations)
  └── wraps document data key d1          (32 bytes, CSD1 today)
```

- One KMS key per environment (`coversaath-prod-data`, `coversaath-staging-data`), never shared. Two keys in total. Staging never decrypts production blobs.
- Data keys (DEKs) stay exactly what they are today: 32-byte AES-256-GCM keys identified by a key id. Only their **storage** changes: a KMS ciphertext blob instead of raw base64.
- Every wrap uses a KMS **encryption context**, for example `{"app":"coversaath","env":"production","purpose":"column","keyId":"k1"}` (and `purpose: "document"`, `keyId: "d1"`). The context is bound to the blob by KMS, appears in CloudTrail, and is used in IAM conditions. A column blob cannot be unwrapped as a document key or in another environment.
- Per-household keys are **not** part of this decision; see D7 (option, deferred).

### D2. Envelope compatibility: no data re-encryption

- The column envelope does **not change**. `enc2.<keyId>.…` already names the key id; the key ring only learns where the bytes of each id come from.
- Migration path for the existing key: an operator wraps the **existing** raw `k1` with `kms:Encrypt` (with the context above) on an operator machine. The app then gets the same 32 bytes from KMS at startup instead of from the env var. Every existing `enc2.k1.` and `enc1.` value, the blind index and the event hashes keep working unchanged. Nothing in the database is rewritten.
- Because `k1` once existed as a raw secret, a later **staged rotation** to a KMS-generated `k2` (D4) is recommended. It uses the existing `--rotate` backfill, which re-seals and recomputes the document index; it is the only step that rewrites rows, and it can run in a quiet period at any time after the switch.
- Proposed configuration (names only; values are never in the repository):
  - `DATA_ENCRYPTION_KEY_SOURCE` = `env` (default, today's behaviour) or `kms`.
  - `DATA_ENCRYPTION_KMS_KEY_ARN` = the KMS key ARN (not a secret, but kept with the secrets for one place to change).
  - `DATA_ENCRYPTION_WRAPPED_KEYS_JSON` = `{"current":"k2","keys":{"k1":"<b64 KMS blob>","k2":"<b64 KMS blob>"}}`.
  - `DOCUMENT_ENCRYPTION_WRAPPED_KEY` = `<b64 KMS blob>` for `d1`.
  - With `kms`, production refuses to start if `DATA_ENCRYPTION_KEY_BASE64` or `DATA_ENCRYPTION_PREVIOUS_KEYS_JSON` is also set, except under an explicit, temporary `DATA_ENCRYPTION_ALLOW_RAW_FALLBACK=true` used only during the switch (D8 step 3). This avoids two roots of trust lingering.
- Where the wrapped blobs live: **Fly secrets** (recommended for the first build: no migration, no schema change, one atomic `fly secrets set`), not a database table. A table (`data_key_ring`) becomes worthwhile only with per-household keys (D7).
- Document bytes: `d1` is wrapped the same way, so the root of trust moves for documents too, with no change to `CSD1`. Rotating the document key still needs a new `CSD2` envelope carrying a key id; that is a separate follow-up (it would mirror `enc2`, read both, and re-seal blobs in a batched backfill).

### D3. Runtime behaviour and caching (keeps `seal` and `open` synchronous)

- At startup, before the server listens, the process calls `kms:Decrypt` once per wrapped key (today 2 to 3 calls), builds the same frozen key ring `readDataEncryptionConfig` returns today, and hands it to `createColumnCrypto`. `seal`, `open`, `blindIndex` and every repository stay synchronous and unchanged. This is the main reason to wrap the ring rather than every value.
- Plaintext DEKs are held only in process memory as `Buffer`s, never logged, never written to disk, never returned by a route. Node cannot guarantee zeroing memory; core dumps must stay off on the machines.
- **Soft TTL with re-validation** (proposed 1 hour, owner to confirm): a background timer re-calls `Decrypt` for each blob. Outcomes are treated differently on purpose:
  - Success: keep serving.
  - **Authoritative refusal** (`AccessDeniedException`, `DisabledException`, `KMSInvalidStateException`, `IncorrectKeyException`, `InvalidCiphertextException`): drop the key ring at once, fail every subsequent seal and open closed with a coded `DATA_ENCRYPTION_KEY_REVOKED` (503), report `/ready` false. This is how revocation takes effect on running machines within one TTL.
  - **Transient failure** (network, timeout, 5xx, `ThrottlingException`, credential refresh failure): keep the cached ring, log a counts-only `kms_refresh_failed` warning, alert, retry with backoff. After a **hard maximum** (proposed 24 hours since the last successful re-validation) fail closed as above.
- Fresh credentials: STS credentials expire (1 hour by default); the SDK credential provider refreshes them from the OIDC token on its own. A refresh failure counts as transient.
- The backfill and the two scripts get the ring the same way (one startup unwrap), under an operator role, not the runtime role.

### D4. Rotation

- **KEK rotation:** enable KMS automatic rotation (yearly, the KMS default; the period is configurable). KMS keeps old key material, so existing wrapped blobs keep unwrapping and nothing is rewrapped. Optional: re-wrap blobs with `kms:ReEncrypt` after a rotation for hygiene; not required.
- **DEK rotation** (the existing ADR 0013 D2 procedure, with KMS-generated keys):
  1. Operator role calls `kms:GenerateDataKeyWithoutPlaintext` (AES-256, context with the new key id) to get a wrapped `k2`. Plaintext `k2` never exists outside KMS and the app's memory.
  2. Add `k2` to `DATA_ENCRYPTION_WRAPPED_KEYS_JSON` and make it current; `k1` stays in the ring for reads. One `fly secrets set` (owner approval).
  3. Run `scripts/encrypt-existing-rows.mjs --rotate` (re-seals, recomputes the document index; `blindIndexes` keeps erasure working across both keys meanwhile). Second run reports 0 rows.
  4. Retire `k1` only after a check reports 0 values sealed under `k1` (a counts-only `--dry-run --rotate` already gives this).
- Known impact to verify in the build: the event client-hash key (ADR 0014) is derived from the current key, so client hashes change at a DEK rotation; correlation across the rotation is lost. That is acceptable for a counts-only analytics hash but must be stated in the build PR.
- Cadence: on suspected compromise, after the raw-to-KMS switch (D8 step 5), and otherwise as legal sets (FOR LEGAL REVIEW). The KEK rotates yearly on its own.

### D5. Revocation and the kill switch

- **Disable the KMS key** (`kms:DisableKey`): new machines cannot start; running machines lose access within one soft TTL (D3). Reversible with `EnableKey`. This is the incident-response switch for "the secrets leaked" or "the app is compromised"; add it to `docs/runbooks/incident-response.md` in the build.
- **Remove the role's permission** (detach policy, or tighten the OIDC trust): same effect, scoped to one environment.
- **Schedule key deletion** (7 to 30 days waiting period): after the period every sealed value in that environment, including in every database backup, is unreadable for ever. This is crypto-shredding of the whole dataset. It must be guarded: the key policy grants `ScheduleKeyDeletion` only to the account root/break-glass principal, and an alert fires on any `ScheduleKeyDeletion` or `DisableKey` event (EventBridge rule on CloudTrail, in the same Region).

### D6. IAM least privilege and credentials for the Fly runtime

Runtime role `coversaath-prod-runtime` (one per environment):

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "UnwrapDataKeysOnly",
    "Effect": "Allow",
    "Action": "kms:Decrypt",
    "Resource": "arn:aws:kms:ap-south-1:<account>:key/<prod-key-id>",
    "Condition": {
      "StringEquals": { "kms:EncryptionContext:app": "coversaath", "kms:EncryptionContext:env": "production" },
      "ForAllValues:StringEquals": { "kms:EncryptionContextKeys": ["app", "env", "purpose", "keyId"] }
    }
  }]
}
```

- The runtime can only `Decrypt`, only that key, only with the production context. It cannot `Encrypt`, generate keys, re-encrypt, disable or delete. Rotation and wrapping run under a separate operator role (`coversaath-key-operator`: `Encrypt`, `GenerateDataKeyWithoutPlaintext`, `ReEncrypt*`, `DescribeKey`, never `ScheduleKeyDeletion`), assumed by a human team member for the duration of a rotation.
- The key policy names the account (for IAM delegation), the operator role as key user for wrap operations, and the runtime role for `Decrypt`; administrative actions stay with the account owner. Exact policy text to be written and reviewed in the build, together with an independent security review. (Note for the reviewer: `ForAllValues` passes when the key is absent; the `StringEquals` on `app` and `env` is what makes the context mandatory.)

Credential options:

| Option | How | For | Against |
| --- | --- | --- | --- |
| **A. Fly OIDC to `AssumeRoleWithWebIdentity` (recommended)** | Fly machines can obtain an OIDC token from the Fly API socket; AWS IAM trusts Fly's issuer (`https://oidc.fly.io/<org>`) with conditions on `aud` and on `sub` (org, app); the SDK web-identity provider exchanges the token for 1-hour credentials | No static AWS secret anywhere; credentials expire on their own; trust can be narrowed to the app name; no rotation chore | Depends on Fly's OIDC feature and its claim format, which must be verified against current Fly documentation before the build; anyone who can deploy to the Fly app can use the role (same as any option); needs an IAM OIDC identity provider, which the owner's managed AWS environment (managed SCPs) must allow |
| B. Static access key of a dedicated IAM principal in a Fly secret | `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | Simple, works everywhere, no feature dependency | A long-lived credential next to the wrapped keys: a secrets leak again gives everything until someone notices; needs manual 90-day rotation; Fly egress IPs are not fixed unless reserved, so an `aws:SourceIp` condition is hard; the managed AWS experience may not offer IAM users for this |
| C. IAM Roles Anywhere (X.509 client certificate) | Private CA, certificate in a Fly secret | Short-lived AWS credentials | A long-lived private key in a secret anyway, plus a CA to run: more moving parts than B with little gain over A |

Recommendation: **A**, with **B** only as a documented fallback if Fly OIDC or the IAM OIDC provider is not available in the owner's AWS project. If B is used, the access key gets the same one-statement policy, a 90-day rotation reminder, and an alarm on use from an unexpected source.

### D7. Erasure interplay and per-household keys (option, deferred)

- The first build changes nothing in erasure: rows are deleted or redacted exactly as today (`data-lifecycle.md`). Invariant 3 stays as it is: revocation erases derived data by deleting it, and every derived store keeps its erasure path and test.
- **Option: a per-household DEK** (`household_keys(household_id, key_version, wrapped_dek, created_at, destroyed_at)`, each DEK wrapped by the KMS key, envelope `enc3.<householdKeyRef>.…`), destroyed on household erasure. Benefits: erasure reaches rows that are hard to delete (append-only and immutable stores that today need triggers disabled, audit residue in ADR 0018 Q3, a store someone forgot), and shreds large derived volumes in one statement. Costs and limits:
  - **It does not shred backups by itself.** If `household_keys` lives in the same Supabase database, every backup holds the wrapped DEK, and the KMS key can still unwrap it. Erasure from backups then happens only when the backup ages out, exactly as with plain deletion. True per-household shredding in backups needs either one KMS key per household (schedule deletion per household; about USD 1 per household per month, which does not fit the cost target) or a key store outside the backed-up database with a shorter retention than the database backups (a second system to run and secure). The plan line "deleting DEK = crypto-shred incl. backups" is therefore not true for a same-database key table and must not appear in any notice (FOR LEGAL REVIEW).
  - It breaks the synchronous model: a household's DEK must be unwrapped (async KMS call, cached up to 5 minutes as the plan proposes) before its rows open. Either every repository becomes async, or each request loads its household key into the request context right after the ownership check. Rows that do not carry `household_id` (clauses, pages, workflow rows) need their household resolved before decrypting. This is a large refactor touching every repository.
  - KMS requests rise with active households (see Cost), and a KMS blip now affects households whose key fell out of cache, instead of only startup.
  - Blind indexes would need per-household keys too, or they keep linking values across households.
- Recommendation: **defer**. Ship D1 to D6 first. Revisit per-household keys only if counsel says deletion plus backup expiry does not meet the erasure duty, or if the append-only erasure residue in ADR 0018 Q3 cannot be solved by redaction. If revisited, it needs its own ADR, an erasure test per store, and the backup question answered first.

### D8. Migration plan with rollback

Each step that touches AWS, Fly secrets or a deploy is **OWNER APPROVAL REQUIRED**.

| Step | What | Rollback |
| --- | --- | --- |
| 0 | Owner: create the AWS account/project; confirm the Region in AWS Settings > View all projects > Overview > Additional Info > Region (expected `ap-south-1`); check the plan (`aws freetier get-account-plan-state`) and whether KMS and IAM OIDC providers are available in it; decide whether a spend limit is configured (see Failure modes) | Nothing created by code |
| 1 | Build (flag off): a `KmsPort` adapter under `src/integrations/` (AWS SDK `@aws-sdk/client-kms` plus its credential provider: a new dependency, justified here), `DATA_ENCRYPTION_KEY_SOURCE` defaulting to `env`, startup unwrap, soft/hard TTL, coded errors, local stub, tests. Deployed behaviour unchanged | Revert the PR; nothing else depends on it |
| 2 | Staging: create the staging KMS key, OIDC provider and runtime role; generate a **fresh** staging `k1`/`d1` with `GenerateDataKeyWithoutPlaintext` (staging has no data worth keeping); set wrapped secrets; `DATA_ENCRYPTION_KEY_SOURCE=kms`; verify `/ready`, reads and writes, CloudTrail `Decrypt` events, the disable-key drill (D5) and the outage drill (block egress to KMS) | Set `DATA_ENCRYPTION_KEY_SOURCE=env` |
| 3 | Production switch: operator wraps the **existing** production `k1` and `d1` (D2) on an operator machine; set wrapped secrets and `DATA_ENCRYPTION_KEY_SOURCE=kms` with `DATA_ENCRYPTION_ALLOW_RAW_FALLBACK=true`, the raw secrets still present but unused | Set `DATA_ENCRYPTION_KEY_SOURCE=env`; immediate, no data change |
| 4 | Soak (proposed 7 days), then `fly secrets unset DATA_ENCRYPTION_KEY_BASE64 DOCUMENT_ENCRYPTION_KEY_BASE64` and drop the fallback flag. **This is the moment the root of trust moves.** Remove raw copies from operator machines (or escrow, see Open questions) | While the KMS key is alive, the operator role can `Decrypt` the wrapped blob to recover the raw key and set it back as an env secret; no data change |
| 5 | Rotate to a KMS-generated `k2` (D4) and run `--rotate`, so the key that was once a raw secret is retired. Quiet period, takes a short lock per batch | Before retiring `k1`: keep `k1` in the ring, rows read under either key. After: recover `k2` via operator `Decrypt` as in step 4; `--unseal` exists for a code rollback (ADR 0013 addendum D2) |

No step rewrites data except step 5, and step 5 reuses the tested backfill. Rolling back the code to a build before step 1 works as long as the raw keys are set again (step 4 rollback).

## Failure modes

| Failure | Behaviour |
| --- | --- |
| KMS unreachable or throttled at startup | Fail closed: the process retries with backoff for a bounded time (proposed 60 s), then exits with `DATA_ENCRYPTION_KMS_UNAVAILABLE`. Fly restarts it. The other machine, if already running, keeps serving from its cache. Health (`/api/v1/health`) stays independent of KMS so a KMS blip does not take both machines out of rotation; `/ready` reports the key ring state |
| KMS unreachable while running | Serve from cache; alert on `kms_refresh_failed`; fail closed after the hard maximum (D3) |
| Key disabled, permission removed, key pending deletion | Fail closed within one soft TTL on running machines, at once on new ones (`DATA_ENCRYPTION_KEY_REVOKED`, 503) |
| **Spend limit pauses the AWS project** | KMS answers access denied, which the app treats as revocation: the whole API stops within one TTL and cannot restart. Owner must decide whether to set a spend limit on this project and, if so, alert well before it (AWS Settings > Billing) |
| KMS key deleted, or AWS account/project closed | Permanent loss of every sealed value and document in that environment, in every backup. Guarded by key policy, deletion waiting period and alerts (D5); optional offline escrow (Open questions) |
| Wrapped blob damaged or context mismatch | Startup fails closed with a coded error; no partial ring |
| A value sealed under an id missing from the ring | Unchanged from today: `COLUMN_DECRYPTION_FAILED`, counted as `unreadable` by the backfill |
| Region-wide KMS outage in `ap-south-1` | No failover: multi-Region keys are not allowed in this AWS environment. Running machines serve until the hard maximum. Accepted for the prototype |
| Latency | Fly `sin` to KMS `ap-south-1` is a cross-provider, cross-country call, but only at startup and on refresh, never per request. Not measured |

## Cost estimate drivers (nothing created; verify prices in the AWS pricing page for the project Region before approval)

- Keys: 2 customer-managed keys (prod, staging) at the KMS monthly key price (list price has been USD 1 per key per month; automatic rotation adds a small charge for the first rotations). Per-household keys would multiply this by the number of households, which is why D7 rejects them.
- Requests (symmetric `Decrypt` has been listed at USD 0.03 per 10,000 requests, with a monthly free-tier request allowance): with D3, requests per day are roughly `machines x wrapped keys x (24 h / soft TTL) + restarts x wrapped keys`. Production: 2 x 3 x 24 + about 10 = about 150 per day, about 4,500 per month. Staging is similar or less. This is within the usual free-tier allowance and negligible otherwise.
- Rotation and operator calls: a handful per rotation.
- CloudTrail: the default event history (management events, which include KMS calls) costs nothing; a trail to S3 for longer retention (likely needed for audit, FOR LEGAL REVIEW) adds S3 storage cost.
- Per-household option for comparison: about `active households per day x (session length / 5 min cache)` extra `Decrypt` calls, for example 1,000 households x 3 = 3,000 per day, about 90,000 per month: still small in money, but it turns KMS into a per-request dependency.
- The dominant cost risk is not money but availability (spend-limit pause, outage).

## Test strategy

- A `KmsPort` interface (`decrypt({ ciphertext, encryptionContext })`, plus `encrypt` and `generateDataKeyWithoutPlaintext` for the operator script) with a **local stub** in tests: AES-256-GCM under a fixed synthetic test master key, enforces exact encryption-context equality, and has injectable faults (unavailable, throttled, access denied, disabled, latency, wrong context). No AWS call, no network, no credential in any test.
- Required cases:
  - Compatibility golden test: rows sealed under raw `k1` (`enc1.` and `enc2.`) open unchanged after switching the same `k1` to a wrapped blob; blind index and event-hash values are byte-identical.
  - Startup fails closed when the stub is unavailable, when a blob is damaged, when the context mismatches, and when raw and wrapped keys are both set without the fallback flag in production.
  - Revocation: an authoritative refusal at re-validation drops the ring, the next seal and open answer `DATA_ENCRYPTION_KEY_REVOKED`, `/ready` is false.
  - Transient outage: the cache serves until the hard maximum, then fails closed; a later success restores service.
  - Rotation: wrapped `k2` current, `k1` still reads, `--rotate` leaves 0 `k1` values, second run 0 rows, document index recomputed, erasure works mid-rotation (`blindIndexes`).
  - No key material or wrapped blob in logs, errors or `/ready` output (log scan with a synthetic key).
  - The backfill script and `backfill-adult-contacts.mjs` obtain the ring through the same path.
- Optional, opt-in live test (`test:kms-live`, like `test:sarvam-live`) against the staging key only, never in CI by default.
- The build is security-sensitive: `npm run check`, `npm run eval:safety`, `git diff --check`, and an independent read-only security review are required.

## Consequences

- Positive: no raw data key in configuration after step 4; every unwrap is audited; one switch revokes access; existing ciphertext needs no rewrite; `seal`/`open` and every repository stay synchronous.
- Negative: a new provider and a new dependency (`@aws-sdk/client-kms`); startup depends on KMS; a spend limit, account closure or key deletion can now stop or destroy the service; the KMS key Region becomes part of the data-residency story.
- Residual risk: a compromised running process or a malicious deploy still reads everything.
- Not changed: column envelope, AAD, padding, backfill, erasure paths, RLS model, `CSD1`.

## Open questions for the owner

1. **Region.** Does the AWS project's Region come out as `ap-south-1`? The Region is set by the contact address and cannot be changed per resource. If it is not Mumbai, is a key in another Region acceptable? (Key material is not personal data, but where the key lives may matter to the residency position, FOR LEGAL REVIEW.)
2. **Plan and spend limit.** Free or paid plan? Is KMS (and an IAM OIDC identity provider) available in it? Will a spend limit be set? A pause stops the API.
3. **Credentials.** Accept Fly OIDC (option A), with static keys only as a fallback? This needs verification that Fly's OIDC tokens and claims work as described for this org.
4. **TTLs.** Soft TTL 1 hour (how fast a disabled key stops running machines) and hard maximum 24 hours (how long an outage is tolerated)? Shorter means faster revocation and more exposure to KMS blips.
5. **Escrow.** Keep an offline, sealed copy of the raw DEKs (protects against account loss, weakens the "no raw key anywhere" property), or rely on KMS only (account loss = data loss)?
6. **Rotate after switch.** Run step 5 (rotate to a KMS-generated `k2`) right after the switch, or wait for the first scheduled rotation?
7. **Per-household keys.** Is plain deletion plus backup expiry enough for the erasure duty, or must erasure reach backups sooner (which needs a separate key store, D7)? FOR LEGAL REVIEW.
8. **Document key rotation.** Schedule the `CSD2` envelope (key id in the document envelope) now, or accept a non-rotatable document key until real data?
9. **Audit retention.** How long must CloudTrail records of key use be kept (needs a trail to S3 if longer than the default history)? FOR LEGAL REVIEW.
10. **Who holds the operator role.** Which team member may assume the key-operator role, and should every use need a second person?
