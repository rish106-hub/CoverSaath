# FSS handoff v1 (ADR 0037, Proposed)

The contract between CoverSaath and the FSS reference service (`insurance-data-api`). CoverSaath side: `src/integrations/insurance-data/handoff.js`. The FSS side implements this; nothing here is deployed yet. Identifiers only: no household, person, policy number or document text.

## Create

`POST /v1/handoffs` with `Authorization: Bearer <key>` and `Idempotency-Key: <request_id>`.

```json
{ "request_id": "req-12345678", "insurer_name": "Test Insurer", "product_name": "Test Plan", "uin": "OPTIONAL" }
```

Answer `202` (or `200` on a repeat of the same `request_id`):

```json
{ "handoff_id": "h-1", "request_id": "req-12345678", "state": "accepted", "version_id": null }
```

Strict body: any other field is a `400`. The same `request_id` always returns the same handoff.

## Get

`GET /v1/handoffs/{handoff_id}` returns the same shape plus an optional `reason` (a closed code such as `product_unknown` or `wording_missing`; FSS addition, never in a notice). CoverSaath keeps `reason` of a non-matched final state as the closed `last_outcome` of the handoff row, nothing else. CoverSaath polls it at most once an hour per open handoff, only when no notice arrived; a poll claims its rows with `FOR UPDATE SKIP LOCKED`, so two workers never poll the same handoff.

## Pack

`GET /v1/handoffs/{handoff_id}/pack` (FSS scopes `handoff:read`, `facts:export`, `service:uin`; allow-listed in CoverSaath as `handoff.pack`) returns the UIN reference pack (insurance-data-api `docs/contracts/uin-pack-v1.md`, FOR LEGAL REVIEW) of the version FSS matched: version-pinned (not the newest) and every gate re-checked when served. The request carries no UIN, only the FSS handoff id.

| Answer | Meaning | CoverSaath |
| --- | --- | --- |
| `200` | the pack | cache facts and page chunks by version id, link the holding, queue collate |
| `409 handoff_not_matched` | FSS has no matched state for this id (yet) | retryable: the job queue retries with backoff (8 attempts, about ten minutes); the outcome `handoff_not_matched` is recorded |
| `404 pack_not_available` | a gate (entitlement, rights, integrity) no longer holds | permanent: outcome `pack_not_available` recorded, the job completes, no retry |
| `5xx`, timeout, `429` | outage | retryable (queue backoff) |

The pack's version must equal the handoff's `version_id`, else nothing is written (`version_mismatch`). `GET /v1/products/by-uin/{uin}/pack` stays allow-listed (`products.packByUin`) but is not used by the pull: it is not version-pinned, and a `404` from the handoff route means a gate failed, which the UIN route would only bypass.

Of the facts in a pack, `shown: true` ones with a verbatim quote on a cited page are kept. All seven shown fact types map to CoverSaath fact keys: `waiting_initial`, `waiting_ped`, `pre_hospitalisation_days`, `post_hospitalisation_days`, `free_look_period` (durations, stored as days), `day_care_covered` (yes/no) and `clause_ayush` (yes/no, stored as the fixed words "AYUSH treatment is covered" or "... is not covered"; the slot is a text slot, so "how" is not captured). A fact with a scope or with `value.conditions` is conditional and never maps. `independently_verified` is a reviewed insurer value; `extracted_unverified` is held as not checked (ADR 0036).

## States

`accepted`, `working` (not final); `matched`, `no_match`, `needs_review`, `unavailable`, `rights_blocked` (final). `version_id` is set only on `matched`.

## Notice

When a handoff reaches a final state FSS sends `POST <CoverSaath receiver URL>` with the same JSON as Get and the header

`X-FSS-Signature: t=<unix ms>,v1=<hex HMAC-SHA256 of "<t>.<raw body>" with the shared secret>`

CoverSaath refuses a notice whose timestamp is more than 5 minutes off, whose HMAC does not match, or whose state is not final. The notice carries no UIN and no facts. On `matched` CoverSaath pulls the pack (section Pack above). The matched state and the pull job are written in one database transaction: if the job cannot be queued the state change rolls back, the notice answers non-2xx, and FSS's retry (or the hourly poll) applies it again.

The notice goes to its own endpoint: FSS sends handoff notices to `handoff_endpoint_url` of the tenant webhook settings (else `endpoint_url`). CoverSaath's handoff receiver URL must be set as `handoff_endpoint_url`, separate from the source-change webhook (different signature scheme: `X-FSS-Signature: t=<ms>,v1=<hex>` here, `x-fss-timestamp` and `x-fss-signature: sha256=<hex>` there; both share one secret).

## Retries

FSS retries a notice with backoff until it gets a `2xx`; CoverSaath answers `2xx` for a repeat it has already applied (idempotent on `handoff_id` and state).
