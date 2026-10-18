# Backend rules

Applies to `src/backend/` and its subdirectories. Root `AGENTS.md` still applies.

- Validate and authorise at the service boundary. Check household ownership on every protected read and write.
- Use bounded, parameterised queries. Paginate lists and index measured access patterns.
- Keep multi-row invariants and their counts-only audit event in one transaction.
- Make retried writes idempotent. Prove duplicate and concurrency behaviour with tests.
- Map database failures to coded, client-safe errors. Never return driver or runtime messages.
- Every external call needs an explicit timeout, retry, idempotency and failure policy. Zero retries is valid when retry is unsafe.
- Every store containing household-derived data needs a revocation erasure path and test.

