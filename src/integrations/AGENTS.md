# Provider integrations (local rules)

Applies to `src/integrations/`. Root `AGENTS.md` still applies.

- Every connector fails closed. Keys alone never enable a call: status stays `not_configured` or `configured_not_verified` until the endpoint, request contract and webhook verification are confirmed from the provider's official documentation.
- Never guess an endpoint, payload or auth scheme.
- Integration code imports nothing outside `src/integrations/`; other code imports only `src/integrations/index.js` (enforced by `npm run check:architecture`).
- A live connector needs a sandbox contract test and an explicit per-operation timeout, retry, idempotency and outage policy before it is wired.
- Credentials are server-only settings. Never `VITE_` variables, logs or fixtures.
