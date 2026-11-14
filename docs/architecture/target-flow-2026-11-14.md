# Target flow (owner, 2026-11-14)

The owner's architecture for the product, as stated on 2026-11-14, mapped to what exists in code today. This is a target, not a decision record: hard-to-reverse parts (real data, sanitising PDFs instead of rejecting them, the memory document) need ADRs before they are built. Consent, privacy and notice wording on this path is a draft **FOR LEGAL REVIEW**.

## Services

| Repository | Role |
|---|---|
| `insurance-data-api` (FSS) | Separate service, to be open-sourced as an API. Insurance data of **every Indian insurer and every product, keyed by UIN**: each document scanned and read in detail and stored in a database, easy to retrieve and easy to parse. |
| `CoverSaath` | Working backend: the end user's upload, consent, extraction, privacy reduction, memory, chat. |
| `Knowvia_website` | Beta frontend (app and BFF). |
| `Knowvia Frontend` (`CoverSaath-Frontend`) | Landing page. |

## The flow

| # | Owner's step | Today | Gap |
|---|---|---|---|
| 1 | The end user uploads the insurance PDF. **Any other PDF is rejected right away.** | Upload, consent, size and type checks exist (`src/features/input/`). `src/features/policy-identification/` classifies documents. | Rejecting "not an insurance PDF" at upload time is not wired as a gate; today classification happens after OCR. Needs a fast first-page check (text layer or one OCR page) before the full parse. |
| 2 | Once it is confirmed to be an insurance PDF, **any issue in the PDF (embedded JavaScript or anything else) is resolved automatically**, then parsed in parallel on the server. | Active content is **rejected** (`PDF_ACTIVE_CONTENT`, `pdf-inspection.js`); a ClamAV hit blocks the document (`MALWARE_DETECTED`). PDF inspection, segmentation and text run in sandboxed child processes. Branch `feat/pdf-sanitise` holds FSS autolink work, not a sanitiser. | Build a sanitiser: rebuild the PDF without scripts, actions, embedded files and forms (pdf-lib is already a dependency), re-inspect, then OCR. For a ClamAV hit, the safe resolution is a rebuild from rendered page images in the sandbox (content disarm and reconstruction), never opening or keeping the original. Security-sensitive: needs an ADR and an independent review. |
| 3 | First pass extracts the **UIN, insurer, product (insurance plan) and policy**. | `src/features/insurer-detection/`, deterministic extractors (`src/features/policy-facts/`), FSS autolink by UIN (PR #132). | Measure on real schedules of every insurer; UIN printing varies by insurer. |
| 4 | These go to the **FSS API**, which matches UIN, insurer and product. | FSS client allow-list (`src/integrations/insurance-data/client.js`): insurers, resolve, products, search, by-UIN export. | FSS serves none of this for real data yet: routes are split across unmerged branches, no real insurer or product is loaded. |
| 5 | **Any conflict goes straight back to the user**: "which insurer and plan did you buy?" | `GET /holdings/{id}/product-candidates` and `POST .../confirm-product` exist. | Frontend screen (beta app). |
| 6 | After the user confirms, **fetch the insurer and product contents from FSS**. | FSS reader and fact map (PR #131, #132) map 4 fact types (room rent, co-pay, initial wait, PED wait). | Map every fact type FSS publishes; FSS must publish them with page and clause evidence. |
| 7 | A **reduction step removes sensitive data** from the uploaded PDF text (name, policy number, premium paid, declared medical conditions) before anything reaches a model. | Privacy gate (`src/features/ai-analysis/privacy-evidence-gate.js`, `sanitizeEvidenceForModel`) with a golden corpus and fuzz tests; known identifiers are masked. | Add premium amounts and declared conditions to the reduction set where they reach a model. Note: the UIN identifies the **product**, not the person, and is public; the policy **number** is personal. Proposal: keep the UIN, mask the policy number. |
| 8 | The removed data points are **stored in the separate memory** (step 12), not lost. | Sealed columns (`enc1.` envelope, ADR 0013), `household_memory_facts`, declarations and premium records (migrations 048-052). | Wire the reduced values into the memory with their source page. |
| 9 | The model **correlates and checks references**, resolves conflicts, and builds a full understanding of the user and dependents. | `holding.collate`, conflicts (`fact_conflicts`, `GET .../conflicts`), household reasoning (`src/features/household-reasoning/`). Rule: model output is only `extracted_unverified`, `conflicting` or `unknown`; deterministic code decides. | A model may propose a resolution; the user or deterministic code accepts it. |
| 10 | A **screen asks the user what they declared** when buying (health conditions and so on). | Declarations routes and tables exist (ADR 0032). | Beta app screen; legal review of the wording. |
| 11 | After conflicts are merged, **all remaining questions are asked**. | Context question planner (`context-question-planner`), gap resolver. | Drive it from the memory's gaps. |
| 12 | A **private, separate memory document** holds everything in detail, in sections; the chatbot reads it. | Memory exists as sealed database rows (`household_memory_facts`, `memory_chunks` with pgvector, ADR 0029, ADR 0031). | Proposal: render `memory.md` **per household on demand from the sealed rows** rather than keeping a plaintext file. A file of health data at rest breaks invariant 8 (sealed columns) and is hard to erase on revocation (invariant 3). The rendered document is what the chat model reads, after the privacy gate. |
| 13 | The memory cites the **exact page and clause** for anything the user may ask, plus insurer and product information. | Facts carry `source_page_id`, `block_index`, `policy_clause_id`; chat answers carry sources. Live run: passages are whole pages, and chat invents answers when the policy is silent (19 of 20). | Clause-level segmentation on live OCR, and an honest `unknown` (see the [live-run audit](../audits/2026-11-14-live-run.md)). |

## FSS data model (what "everything mapped to the UIN" needs)

- **Insurer**: IRDAI registration, legal and brand names, aliases, type (public sector, private general, standalone health).
- **Product**: UIN (unique, versioned: an insurer refiles a product under a new UIN version), name, insurer, line of business, status (open, withdrawn), filing and withdrawal dates.
- **Document**: per product version, the policy wording, prospectus, CIS (customer information sheet), brochure and claim form, each with its source URL, sha256 and fetch date (raw file in object storage, never in git).
- **Pages and clauses**: OCR or text layer per page, clauses with section, heading, page and block offsets.
- **Facts**: typed values (sum-insured options, room rent, co-pay, deductibles, waiting periods, sub-limits, exclusions, renewal, portability, claims timelines), each with evidence (document, page, exact quote) and a review state.
- **API**: lookup by UIN, by insurer and name search, product facts with evidence, clause search. Read-only, cacheable, versioned (`export_version`).

## Rules this flow touches (need owner sign-off)

1. **Real data.** AGENTS.md and AI.md allow synthetic data only. FSS needs real public insurer documents; CoverSaath needs real schedules to prove accuracy. Proposal: public documents allowed in FSS storage outside git, each source recorded in the FSS rights register (FOR LEGAL REVIEW); real schedules only with the user's consent, sealed, erasable; CI stays synthetic.
2. **Sanitise instead of reject** (step 2): changes a security control. ADR plus independent review.
3. **Memory document** (step 12): rendered from sealed rows, not a plaintext file.
4. **Open-sourcing FSS**: licence and redistribution rights for insurer documents (FOR LEGAL REVIEW).
