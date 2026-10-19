# ADR 0006: Whole-document policy structuring

- Status: Proposed
- Date: 2026-10-19
- Scope: new `src/modules/policy-structuring/`; reads `knowvia.ocr.v1` pages; writes parameter observations and a proposed-parameter store
- Plan: [policy-document-structuring.xml](../exec-plans/active/policy-document-structuring.xml)

## Context

Sarvam Document AI (Block 2) returns every page of a policy PDF with tables intact. On the real retail
health policy schedule used for the parse eval (20 pages), Sarvam captured the Schedule of Benefits, premium and discount
breakdown, loadings, ICD annexure, Customer Information Sheet and declaration page.

The only consumer is `src/modules/ai-analysis/eval-extractor.js`: 18 hand-written regex fields, used by the
eval script and nothing at runtime. About 10% of the document is kept. The 138-key registry in
`src/modules/coverage-analysis/policy-parameter-registry.js` (sections A to K) is never filled from a PDF.
Anything outside the 18 fields is dropped, and cross-section conflicts (for example PED waiting period
"3 Years" in the Schedule of Benefits versus "36 / 24 / 12 months" in the Customer Information Sheet) are
invisible.

## Decision

Add a four-stage pipeline between OCR and storage. Models propose; deterministic code decides.

1. **Sectioner (deterministic).** Drop `header`, `footer`, `page-number`, `image`, `image-caption` blocks
   (the last two are model-written descriptions, not document text). Chunk the rest by page, table and
   section title, keeping page and block index. Tables become row-oriented text.
2. **Extractor (Gemini, per chunk).** Input: chunk text plus the registry key list with labels and value
   types. Output per item: `registry_key` or `proposed` (with `proposed_key`, `category`, `label`),
   `value`, `subject` (policy or member name as printed), `evidence_quote`, `page`, `block_index`.
   Items that do not fit the registry go to the overflow bucket, never dropped.
3. **Reconciler (Gemini, once per document).** Input: all validated items grouped by key. Output: groups
   that disagree, with the quotes on each side. Reuses the `conflicting` state; never picks a winner silently.
4. **Validator and store (deterministic).**
   - `evidence_quote` must be a literal substring of the chunk supplied. Otherwise the item is rejected.
   - `registry_key` must exist in the registry version in force. `page` and `block_index` must exist.
   - Values are normalised by code (dates, money, durations), never by the model.
   - Accepted items become parameter observations with method `document_extraction`, state
     `extracted_unverified` (or `conflicting`). Nothing a model returns can reach `proven`, `calculated`,
     `dynamic` or `not_permitted` (ADR 0003).
   - Overflow items go to a new `proposed_parameters` store, status `pending_review`. A human or a later
     ADR promotes a recurring proposal into the registry. The model never edits the registry.

Gemini receives Sarvam text chunks only, never PDF bytes. That keeps the consent surface the same as
`field-adjudicator.js`: a document-specific grant with recipient `gemini`, re-checked before each call and
again before commit.

## Consequences

- Coverage of a policy PDF is measurable: every non-boilerplate chunk ends up stored, proposed, or listed
  as explicitly skipped with a reason.
- New derived stores (`proposed_parameters`, new observations) each need an erasure path and a test on
  consent revocation (AGENTS.md invariant).
- Cost grows with document size: roughly one Gemini call per chunk group plus one reconcile call. A
  per-document call and token cap is part of the plan. No capacity or cost claim is made without measured runs.
- The registry stays the single schema. Overflow is a review queue, not a second schema.
- Reversible: the pipeline is behind a feature flag, off by default. Existing eval extractor and adjudicator stay.

## Rejected

- **Sending the PDF to Gemini directly.** Skips Sarvam, widens the consent surface, and loses page/block
  provenance the validator relies on.
- **Letting the model write registry keys or schema.** Violates the authority rule; drift becomes silent.
- **More regex fields.** Does not generalise past one insurer's template.

## Open items

- Consent and privacy-notice wording for the Gemini step is not final. Mark for legal review.
- Gemini model choice, limits and billed cost are unmeasured.
- Postgres parity for the new store follows ADR 0004; SQLite is the runtime today.
