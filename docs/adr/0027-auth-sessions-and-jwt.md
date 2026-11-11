# ADR 0027: Web sessions, JWT access tokens and rotating refresh tokens

Status: accepted for the prototype (synthetic data only). Independent review is mandatory before any real user signs in. Notice and consent wording in `notice_acceptances` is a draft for legal review. Design: `docs/exec-plans/active/full-system-design.md` sections 2, 3, 7 and 10.

## Context

The website BFF needs a browser session that survives a page reload, can be revoked at once, and does not put a long-lived bearer secret in the browser. Until now the API only issued an opaque 8 hour bearer token (`api_sessions`, migration 001). This slice adds a second credential kind beside it. The opaque bearer is unchanged and stays the form scripts and tests use.

## Decisions

**D1. Passwordless only.** No password table exists. Methods are added later (Google OIDC via the BFF, e-mail code, passkeys). Identity stays `(issuer, keyed hash of subject)` in `auth_identities` (ADR 0012 D3), never an e-mail. This slice builds none of the challenge, OTP, passkey or OIDC verification routes; their tables ship now (`auth_challenges`, `webauthn_credentials`, `devices`, `notice_acceptances`) so the shape is fixed, and they have no route yet.

**D2. Access token.** EdDSA (Ed25519) JWT signed and verified with `jose` 6.2.12 (exact pin, published 2026-09-05; the only new dependency). Verification passes `algorithms: ['EdDSA']`, `typ: 'at+jwt'`, `issuer`, `audience: 'knowvia-bff'` and `requiredClaims: iss, aud, exp, sub, sid`, with zero clock tolerance; `none`, HS256 and RS256 are refused. Claims: `sub` adult id, `hid` household id, `sid` session id, `jti`, `scp ["household:rw"]`, `amr`, `knd "web"`. No name, e-mail or phone. Lifetime 10 minutes. After the signature, `sub`, `hid` and `sid` must match the live `api_sessions` row.

**D3. Instant revocation.** Every request with a JWT re-reads `api_sessions` by primary key (not revoked, not expired, not past the absolute cap, adult active, same adult and household). A valid signature is necessary, not sufficient. Sign-out, sign-out-all, session delete, refresh reuse and an inactive adult all end the token on the next request.

**D4. Refresh token.** Opaque 256-bit random, stored only as a keyed HMAC (`columnCrypto.blindIndex('auth_refresh_token', token)`, key derived from the data encryption key, no new secret). Rotates on every use; sliding 30 days, capped by `api_sessions.absolute_expires_at` (90 days). Presenting a used token revokes the whole session (`revoked_reason = refresh_reuse`, committed before the 401) and appends `auth.refresh_reuse_detected`. All refresh failures return the same `401 AUTH_REFRESH_INVALID`; the audit trail records why. Rotation runs under the household advisory lock and `SELECT ... FOR UPDATE` on the token and session rows, so two concurrent uses of one token serialise: one rotates, the other counts as reuse and revokes the session. The BFF must therefore single-flight refresh (design section 3). Limit: 20 refreshes per minute per token (per process, like the user-data writes limiter).

**D5. Signing keys.** The private key is an environment secret `KNOWVIA_JWT_PRIVATE_KEY_<kid>` (base64 PKCS#8 DER, Ed25519; `<kid>` is 8 to 64 letters, digits and underscores) and is never in the database, a log, an error or an audit row. `KNOWVIA_JWT_ISSUER` is required for token sessions (https, or http on loopback). Public halves are rows in `auth_signing_keys` with states `next`, `active`, `retiring`, `revoked`; a partial unique index allows one active key. `GET /.well-known/jwks.json` publishes active, next and still-overlapping retiring keys (it is behind the same Host guard as everything else). Without an issuer, a private key and an active key row, `?format=jwt` answers `503 AUTH_NOT_CONFIGURED` before creating anything, and JWT bearers get 401; opaque sessions are unaffected.

**D6. Compatibility.** `services.access.authenticate` accepts both kinds: the opaque pattern (no dots) and a three-segment JWT. A JWT principal carries `householdId`; `requireHousehold` refuses any other household with `403 AUTH_HOUSEHOLD_MISMATCH` before any lookup. A bearer principal has `householdId: null` and behaves as before. `POST /api/v1/identity-sessions` is unchanged by default; `?format=jwt` (identity credential still required) returns `{accessToken, refreshToken, expiresIn, household, memberId, returning}`, any other `format` is 400. Web sessions count against the same `MAX_ACTIVE_SESSIONS` cap and capacity lock.

**D7. Routes.** `POST /api/v1/auth/refresh` (refresh token is the credential), `POST /auth/signout`, `POST /auth/signout-all` (all kinds of session of the adult), `GET /auth/sessions` (id, kind, amr, timestamps, `current`; no token, hash or device detail), `DELETE /auth/sessions/{id}` (own sessions only, otherwise `404 AUTH_SESSION_NOT_FOUND`), `GET /.well-known/jwks.json`. 60 calls per adult per minute on the session routes, in addition to the per-client request limiter. Not built: `POST /auth/challenge`, `/verify`, `/link`, and any `notice_acceptances` route.

**D8. Audit.** `auth.session_started`, `auth.session_refreshed`, `auth.refresh_reuse_detected`, `auth.sign_out`, `auth.sign_out_all`: resource is the session id; payloads hold ids, the method label (`amr`) and counts only. Bearer sessions audit under the null-household chain.

**D9. Migration 045 (renumbered from 030 on rebase; main had taken 030-044).** Expand-only and rerunnable (IF NOT EXISTS, DO-block constraints). One relaxation: `api_sessions.token_sha256` loses NOT NULL because a web session has no opaque token; `api_sessions_kind_shape_check` keeps it required for `session_kind = 'bearer'`, requires `household_id` and `absolute_expires_at` for other kinds, and requires `revoked_at` when `revoked_reason` is set. Every new table has RLS on and no Data API grant. Typed labels (`devices`, `webauthn_credentials`) are sealed columns with the `^enc[12][.]` CHECK. Erasure: `api_sessions.household_id` cascades from `households`, `auth_refresh_tokens` from `api_sessions`, and `webauthn_credentials`, `devices`, `notice_acceptances` from `adult_users`. Existing `api_sessions.adult_user_id` has no cascade (unchanged), so deleting an adult first needs their sessions removed. `auth_challenges` holds no person (keyed hashes expiring in minutes).

## Threat model

- Algorithm confusion, `alg: none`, key substitution: allow-list of one algorithm, key looked up by `kid` in our table only, `typ` and `aud` pinned, library-only parsing.
- Stolen access token: lives 10 minutes and dies at once on revocation.
- Stolen refresh token: single use; the legitimate holder's next refresh, or the thief's second, trips reuse detection and revokes the session. A thief who refreshes first locks the owner out until sign-in; the owner's stale token then also revokes the thief's session.
- Database read: refresh tokens are HMAC hashes under a key derived from the data key; no private signing key is stored. Rotating the data key invalidates all refresh hashes (people sign in again); this is deliberate and must be in the key-rotation runbook.
- Cross-household use: token household must equal the path household and the stored session household.
- Log and audit leakage: no token, hash or key in logs, errors, audit payloads or lists (tested).

## Rotation runbook note

`node scripts/auth-keys.mjs generate <kid>` registers a public key as `next` and prints one secret line for the secret store (pipe it to `fly secrets import`; never paste it elsewhere). Deploy so every machine has the secret, run `activate <kid>`, and the old key stays valid for 15 minutes (longer than the 10 minute token life). `revoke <kid>` cuts a key off immediately. Rotate every 90 days. Activation changes the database, so machines that lack the new private key return 503 for sign-in and refresh until they have it; set the secret first.

## What is unverified

- No browser or BFF run: the BFF cookie, single-flight refresh and CSRF header are in the website repository.
- No test with two API machines; the refresh limiter and the session-route limiter are per process.
- Key rotation across a live deploy, and `activate` racing a second `activate`, are exercised only on a local database (the loser fails on the unique index).
- Clock skew between machines is not tolerated (zero tolerance on a token verified by the machine that issued it or a sibling).
- A refresh whose access-token signing fails after the rotation committed leaves the client with a consumed token (it must sign in again).
- Independent security review not yet done.

## Consequences

One new dependency (`jose`). Every JWT request costs one signing-key read and one session read plus a `last_seen_at` write, like the opaque path plus one key lookup; measure before caching. Rollback: stop sending `?format=jwt`; existing opaque flows are untouched. The migration is additive apart from the NOT NULL relaxation; reverting the code leaves unused columns and tables.
