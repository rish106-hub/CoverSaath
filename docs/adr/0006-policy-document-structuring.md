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
   **Amended 2026-10-19 (owner decision):** when readings disagree, Gemini selects the reading that applies
   (`selected_quote`). Code accepts the selection only when it is one of that group's own quotes. The
   selected value is stored `extracted_unverified` with reason `model_selected_from_conflict`, every reading
   is kept, and the household confirms the value before it is used. Without a grounded selection the key
   stays `conflicting`. Different values for subjects printed in the document (members, benefits) are a
   variation (`per_subject_values`) and are never resolved to one value. Differing readings that cannot be
   compared (a clause beside a schedule value) are `context_differs`. Only contradictions are reported as
   conflicts.
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

## Addendum (2026-10-19): stored OCR blocks (Block 2 close-out W3)

Status: accepted. Before this, `source_pages` kept only page text, so Sarvam's blocks, tables, layout tags and
block indices were lost after OCR persistence and the sectioner could not run from stored data.

Decision:

- **Storage: a nullable `blocks_json` column on `source_pages`** (SQLite 012, PostgreSQL 009, expand-only), written
  once at page insert. Chosen over a `source_page_blocks` table because the repository inserts pages once and
  never replaces them, `source_pages` has no row-immutability trigger that a new column would conflict with, and
  both erasure paths (consent revocation and document deletion) already redact the page row in one UPDATE. One
  row keeps blocks and text together, so they cannot drift and need one erasure step.
- **Shape (`knowvia.ocr.v2`)**: `{ version, page, blocks: [{ index, tag, readingOrder, text, rows?, textOmitted? }] }`.
  `index` is the 0-based position in provider reading order and equals the sectioner's block index. `rows` holds
  table cells parsed from the table text at write time. No provider payload, block ids, coordinates or
  confidences. Blocks whose tag the sectioner drops as `model_description` (`image`, `image-caption`) keep index
  and tag, but their text is replaced by `''` with `textOmitted: 'model_description'`.
- **Versioning**: `knowvia.ocr.v2` is the OCR output and stored-blocks version. `ocr_jobs.contract_version` and
  `source_pages.output_contract_version` stay `knowvia.ocr.v1` because they describe the page text contract,
  which is unchanged. Changing them would drop every new page from coverage-analysis source selection (which
  filters on v1) and break OCR job de-duplication (keyed on contract version), causing paid re-runs.
- **Validation**: `src/modules/document-intake/ocr-blocks.js`. On write, provider blocks must rebuild the page
  text exactly (missing, extra or reordered blocks fail), tags must be a known Sarvam section type, reading order
  must be finite and non-decreasing, and text, block, row and stored sizes are bounded. The repository re-validates
  before insert and on every read (indices must equal positions, rows must match the table text, no extra fields).
  The database CHECK enforces a JSON object of at most 1,000,000 characters.
- **Read path**: `OcrRepository.getDocumentBlockPages({ documentId, householdId })` returns household-scoped
  pages of the active document version. Pages stored before v2 come back with `status: 'blocks_unavailable'`
  and `blocks: null`; `sectionStoredDocument` refuses them (`STRUCTURING_BLOCKS_UNAVAILABLE`).
- **Erasure**: revocation nulls `blocks_json` with the page text. Triggers are the safety net:
  `source_pages_blocks_erase_with_text` (redacting page text clears blocks; this also covers document deletion)
  and `source_pages_blocks_erase_on_document_erasure`. `source_pages_blocks_immutable` allows only clearing;
  `source_pages_blocks_insert` refuses blocks without page text or for an erasing document. The job-level
  `ocr_jobs.result_json` copy of the normalised output, which now includes blocks, is already nulled by both paths.

Limits: existing v1 pages are not backfilled (the provider output is gone; a re-run is a paid, consented OCR
call). The tag list comes from Sarvam's published section types; an unlisted tag fails OCR persistence closed
and needs a code change. Page text still contains image descriptions, as before this addendum. `photograph`,
`chart` and `diagram` blocks keep their text because the sectioner does not drop them; whether that text is
model-written is unverified against real Sarvam output.
