# ADR 0034: FSS as the insurer tier, read directly

- Status: Proposed. Supersedes ADR 0021 D1 (import-only). Not reviewed.

**Context.** P0 means one upload and no T&C step. The owner decided on 2026-11-12 that FSS owns insurer data. FSS serves reviewed facts with evidence, but no PDF bytes. CoverSaath already has the client, the cache, the `ida_wording` tier and collate.

**Decision.** In service mode, a server-side reader matches the confirmed product to exactly one FSS version. It maps the four screened families to product-term keys and writes `ida_wording` rows with sealed FSS evidence through collate. `wordingState` is derived, and outcomes are recorded on `policy_holdings` (066, columns only). The reader runs only in jobs, at most once a day per holding. Every failure leads to `missing`.

**Consequences.** This adds a live dependency, contained by the timeout, the breaker and the cache. The insurer tier stays thin until FSS screens more families. Exclusions need scoped collate (P1). Chat cannot quote wording until FSS adds page text.

**Alternatives rejected.**
- An own wording store: a duplicate rights burden plus a new derived store and erasure path.
- The `reference-import-v1` converter: manual and stale, and the export lacks pages and fact ids.
