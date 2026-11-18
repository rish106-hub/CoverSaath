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

`GET /v1/handoffs/{handoff_id}` returns the same shape. CoverSaath polls it at most once an hour per open handoff, only when no notice arrived.

## States

`accepted`, `working` (not final); `matched`, `no_match`, `needs_review`, `unavailable`, `rights_blocked` (final). `version_id` is set only on `matched`.

## Notice

When a handoff reaches a final state FSS sends `POST <CoverSaath receiver URL>` with the same JSON as Get and the header

`X-FSS-Signature: t=<unix ms>,v1=<hex HMAC-SHA256 of "<t>.<raw body>" with the shared secret>`

CoverSaath refuses a notice whose timestamp is more than 5 minutes off, whose HMAC does not match, or whose state is not final. The notice carries no UIN and no facts. On `matched` CoverSaath pulls `GET /v1/versions/{version_id}/facts` through the existing read client.

## Retries

FSS retries a notice with backoff until it gets a `2xx`; CoverSaath answers `2xx` for a repeat it has already applied (idempotent on `handoff_id` and state).
