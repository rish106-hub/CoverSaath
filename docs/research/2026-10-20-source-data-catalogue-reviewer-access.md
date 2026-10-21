# Research: insurer-source data, product catalogue, independent-reviewer access

Date: 2026-10-20. Status: research only, no code changed. Not legal advice.

## How to read this document

Every claim carries one of three tags.

- **[V]** Verified: I fetched the page and read it in this session.
- **[S]** Secondary: from a search-result summary or a third-party write-up. The primary was not read. Re-check before relying on it.
- **[A]** Assumption or my judgment. Needs validation.

Limits of this research, stated up front:

- The web tools returned thin results. I did not reach irdai.gov.in primary circular text. Circular numbers and dates below are **[S]**.
- I found **no first-party engineering write-up** from Policybazaar, InsuranceDekho, Plum or any Indian aggregator on how they source or model plan data. Statements about how Indian aggregators work are therefore **[A]**, not findings. A vendor page claiming Policybazaar has a partner API is **[S]** and unconfirmed.
- GitHub fetches gave licence and popularity but not release or commit dates. "Maintained" is **not established** for any repository below. Check the commit graph before adopting.
- Relevance scores (1-5) are my judgment for CoverSaath's MVP.

## What the repo already has (verified by reading it)

- `src/features/decision-catalogue/curated-sources.js` is an empty frozen array. No official record was ever verified. [V]
- The "catalogue" in the repo is a **decision catalogue derived on read from a household's own uploaded clauses** (`docs/architecture/decision-catalogue.md`). It is not an insurer-product catalogue. [V]
- Facts have an authority model (`extracted_unverified` to `proven`), a household-confirmer path capped at `reported`, and an operator-only independent-reviewer path that is off by default (ADR 0009). [V]

**Assumption to challenge.** The brief says "empty catalogue" as if one big product catalogue must be populated. For comparing a household's own policies, the user's own policy wording is the authoritative contract document. An insurer catalogue is only needed for (a) checking that an uploaded wording is the genuine, current version for that UIN and (b) filling gaps the user did not upload. Neither needs a broad catalogue. Build the smallest verified one.

---

## Part A: Existing solutions

### A1. Verified insurer-source data

| Resource | URL | What it solves | Approach | Learn | Limits / risks | Rel. |
|---|---|---|---|---|---|---|
| IRDAI available-products listing (policyholder.gov.in) | https://policyholder.gov.in/available-products | Official list of products cleared under File and Use | Landing page links to Life, Non-Life and Health product lists. Page shows no UIN, wording, filter or API. [V] | Best primary anchor for "does this UIN exist". | The health list sub-page was not reachable by my guessed URL (404), so row structure is unverified. No API found. Terms of reuse unknown. | 4 |
| IRDAI File and Use circulars (health, June 2022; sample-review March 2023) | https://taxguru.in/corporate-law/irdai-circular-file-procedure-products.html (secondary) | Explains why a product can be live before regulator approval | Health moved to Use and File in 2022; insurers register afterwards; IRDAI samples monthly. [S] | A UIN listing is evidence of filing, not of IRDAI having approved the wording. | Secondary copy only. Get the circular from irdai.gov.in. | 4 |
| IRDAI March 2023 circular on website disclosure | https://taxguru.in/corporate-law/disclosure-benefit-premium-illustration-health-insurance-policies-issued-floater-basis.html (related) | Insurers must upload wording, sales literature and premium calculator on their sites in UIN order within 7 days of UIN allotment [S] | Gives a legal basis to treat insurer sites as the official publication of wording. | Wording URLs on insurer sites are the primary source for text. | Needs primary confirmation. Whether the 2024 Insurance Products Regulations changed this is unchecked. | 5 |
| IRDAI Insurance Products Regulations 2024 | https://ssrana.in/articles/irdai-regulatipons-2024-india/ (secondary) | New product framework; prospectus per retail product [S] | Prospectus plus Customer Information Sheet (CIS) are standard disclosure artefacts. | CIS is a regulator-mandated one-page summary: a good cross-check against extracted wording. | Secondary only. | 4 |
| IRDAI Master Circular on Health Insurance Business 2024 | https://in.milliman.com/insight/irdai-master-circular-health-insurance-business-2024 (commentary) | Sets moratorium (reportedly 60 months), PED waiting cap (reportedly 36 months), cashless timelines [S] | Regulatory floor/ceiling values act as sanity bounds for extraction. | Use as validation bounds: an extracted PED wait above the cap is a flag, not a fact. | Reference number and date disagree across sources. Do not hard-code until read from the primary. | 5 |
| Bima Sugam (BSIF) | https://www.outlookmoney.com/insurance/irdai-launches-bima-sugam-to-simplify-insurance-access (news) | Planned national insurance marketplace | Information hub reportedly launched Sept 2025; transactions repeatedly delayed; no confirmed live date as of 2026-10-20. [S] | Watch it. If it exposes structured product data it could become the best source. | Do not build on it. No evidence of a public data API. | 3 |
| IIB (Insurance Information Bureau) | https://www.india.gov.in/website-insurance-information-bureau-india | Industry statistics | Publishes reports and bulletins; ORF notes consumer analytics have lapsed. [S] | Not a product-terms source. | Irrelevant to wording. Do not pursue. | 1 |
| HL7 FHIR InsurancePlan | https://hl7.org/fhir/R4/insuranceplan.html | Interchange model for a health plan: coverage, benefit, limit, plan, cost | Resource with `coverage` > `benefit` > `limit`, and `plan` > `specificCost`. Maturity level 0 (Trial Use). [V] | Vocabulary for naming limit vs cost-sharing. | US-payer oriented; maturity 0; no India profile found. Do not adopt as storage. | 2 |
| Da Vinci PDex Plan-Net / Formulary IGs | https://build.fhir.org/ig/HL7/davinci-pdex-plan-net/en/toc.html | US payer directory and formulary exchange | IGs sit on FHIR InsurancePlan. [S] | Shows a regulator-driven machine-readable plan feed exists elsewhere; India has none confirmed. | US-specific. | 2 |
| US Summary of Benefits and Coverage + Uniform Glossary | https://cms.gov/marketplace/health-plans-issuers/summary-benefits-coverage | Standardised plan summary and glossary to enable comparison | Regulator-fixed template and fixed definitions. [S] | India's CIS plays the same role; standard definitions are what make comparison honest. | Different jurisdiction. | 3 |
| Docling | https://github.com/docling-project/docling | PDF to structured document (layout, reading order, tables) | MIT licence, 69.2k stars. Runs locally. [V] Bounding-box provenance: not confirmed on the page. | Local extraction avoids sending policy PDFs to a third party. | Release/commit dates not seen. Python, so a second runtime beside the Node app. Output is untrusted evidence like any model output. | 3 |
| Hosted extraction vendors (Nutrient, Reducto, LlamaParse) | https://www.nutrient.io/guides/dws-data-extraction/extract/citations-and-confidence/ | Extraction with per-value page and region citations | Each value carries page plus source regions; one field may span pages. [S] | Store citations per value, not per document. Check value against the cited region. | Commercial. Sends documents to a vendor: conflicts with the privacy gate unless a processing basis exists. | 2 |

### A2. Product catalogue

| Resource | URL | Problem | Approach | Learn | Limits / risks | Rel. |
|---|---|---|---|---|---|---|
| ACORD Reference Architecture (Product Model, Data Model) | https://www.acord.org/standards-architecture/reference-architecture | Industry product and policy data model | Graphical Product Model plus XML Product Schema; Information and Data Models. [S] | Concepts: product, coverage, term, and separation of product definition from policy instance. | Subscription-licensed, not free to reuse. Enterprise-sized. Study concepts only. | 3 |
| HL7 FHIR InsurancePlan | https://hl7.org/fhir/R4/insuranceplan.html | see A1 | `product` vs `plan` split; benefit with limit. [V] | Cheap naming reference for the insurer > product > plan > benefit hierarchy. | Trial use. | 3 |
| CoverSaath `decision-catalogue/v1` and ADR 0009 | `docs/architecture/decision-catalogue.md`, `docs/adr/0009-reviewed-facts-and-decision-catalogue.md` | Typed, source-linked facts per household policy | Derived on read; fact + clause + digest + authority. [V] | Reuse as the evidence layer; catalogue entries should be facts of the same shape with a different source class. | Contains no insurer data. | 5 |
| Indian aggregator catalogues (Policybazaar, InsuranceDekho, Plum) | none found | Unknown | Not documented publicly in anything I found. Vendor pages claim partner APIs. [S] | Nothing verifiable. | Do not infer their schema or data rights. | 1 |
| AltexSoft aggregator write-up | https://altexsoft.com/blog/insurance-aggregator-marketplace | Generic aggregator design | Carrier APIs plus normalisation to a unified format. [S] | Confirms the normalisation step is the hard part. | Generic, mostly motor/quote flow. | 2 |

No open-source Indian health-insurance product catalogue or schema turned up in my searches. That absence is itself a finding, but my search was shallow. Treat "none exists" as **[A]**.

### A3. Independent-reviewer access

| Resource | URL | Problem | Approach | Learn | Limits / risks | Rel. |
|---|---|---|---|---|---|---|
| OWASP Authorization Cheat Sheet | https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html | Baseline access-control rules | Least privilege (horizontal and vertical), deny by default, deny on error. [S, quoted via search] | The existing repo already follows these; use as a checklist for the reviewer route. | Generic. | 5 |
| OWASP Proactive Controls C1 | https://top10proactive.owasp.org/the-top-10/c1-accesscontrol/ | Same | Same | Same | Same | 4 |
| Casbin (node-casbin) | https://github.com/casbin/node-casbin | Embedded RBAC/ABAC library | Apache-2.0; supports ACL, RBAC, ABAC; policy storage via adapters. [V] | Option if rules outgrow hand-written checks. | Adds a policy language and a dependency. Adapter and release status not verified. | 2 |
| OpenFGA | https://github.com/openfga/openfga | Relationship-based access (Zanzibar style) | Apache-2.0. Separate service; production needs Postgres/MySQL (SQLite beta). [V] | Right tool when access is inherited via sharing graphs. | A new service to run. CoverSaath's access is flat: household owner, designated confirmer, operator. | 1 |
| Cerbos | https://www.cerbos.dev/cerbos-vs-openfga | Policy-as-YAML ABAC service | Attribute policies evaluated per request. [S, vendor page] | Shows how role plus resource-status rules are expressed. | Vendor comparison; extra service. | 1 |
| Maker-checker references | https://en.wikipedia.org/wiki/Maker-checker, https://www.opcito.com/blogs/maker-checker-implementation-guide-for-secure-fintech-systems | Two-person control, no self-approval | Maker cannot be checker; enforce in code, not only in permissions. [S] | The repo's supersession rule plus a `created_by <> approver` check is the whole pattern. | Articles give no database-level recipe; the constraint design is mine. | 4 |
| Sumsub 4-eyes review | https://docs.sumsub.com/docs/4-eyes-review | Production example of dual review in an identity workflow | Second reviewer confirms a first reviewer's decision. [S] | Product precedent for a two-step human verification. | Closed product; no internals. | 3 |
| Label Studio | https://github.com/HumanSignal/label-studio | Open-source annotation UI | Apache-2.0, 28.5k stars; multi-user labelling, self-hostable. [V] Review workflow: not confirmed on the page. | Reference for annotation UX. | A separate system holding policy text is a new copy of sensitive data and a new erasure path. Not recommended. | 2 |
| DPDP Rules 2025 (MeitY) | https://www.scconline.com/blog/post/2025/12/26/digital-personal-data-protection-rules-2025-key-highlights/ | Legal frame for processors | Fiduciary stays accountable for processors; staggered commencement, core duties around May 2027. [S] | A reviewer who sees household documents is functioning as a processor or staff. | Law-firm summaries only. Needs legal review of the reviewer's purpose and contracts. | 5 |

---

## Part B: Architecture patterns

### B1. Verified insurer-source data

| Approach | Complexity | Reliability | Security | Maintenance | Dependencies | MVP fit |
|---|---|---|---|---|---|---|
| 1. Hand-curated registry: a person reads the insurer's official wording PDF, records UIN, URL, retrieval date and SHA-256, and two people check each fact | Low | High for the records it holds | Good: no crawler, no user data | Manual; scales per product | None | **Best** |
| 2. Scheduled fetch of insurer wording URLs for change detection only (hash and date, no auto-ingest) | Medium | Medium: detects drift, does not interpret it | Fair: outbound fetches, SSRF controls needed | Breaks when sites change | HTTP client, allow-list | Later, after 1 |
| 3. Aggregator or commercial feed / insurer partnership | High | Unknown | Contract-dependent | Contractual | Partnership, licence | Defer: existence of any public API is unconfirmed |
| 4. Full automated scraping and LLM extraction into the catalogue | Medium | Low: ToS, layout drift, hallucination | Poor | High | Scrapers, model | **Reject**: violates the "model never promotes itself" rule |

### B2. Catalogue

| Approach | Complexity | Reliability | Security | Maintenance | Dependencies | MVP fit |
|---|---|---|---|---|---|---|
| 1. Reviewed-record table keyed by UIN: `official_product` + `official_wording_version` + reviewed `official_fact` rows, same fact shape as ADR 0009 | Low | High | Good | Low | One additive migration | **Best** |
| 2. Full insurer > product > plan > variant > benefit relational model | High | Medium: most tables empty, wrong shape risks | Neutral | High | ACORD/FHIR study | Defer |
| 3. Keep derive-on-read only; no insurer catalogue, only the user's documents | Lowest | High (no unverified data) | Best | None | None | Valid baseline; cannot detect a stale or fake wording |

### B3. Independent reviewer access

| Approach | Complexity | Reliability | Security | Maintenance | Dependencies | MVP fit |
|---|---|---|---|---|---|---|
| 1. Time-boxed grant per case, server-side authorisation, redacted evidence packet, immutable reviews, no self-review (already partly built, off by default) | Low | High | Strong when scoped to one case | Low | None new | **Best** |
| 2. Add a policy engine (Casbin or Cerbos) for reviewer rules | Medium | High | Strong | Medium | New library or service | Only if rules multiply |
| 3. Separate reviewer portal with SSO/IdP and relationship-based access (OpenFGA) | High | High | Strong | High | IdP, OpenFGA, Postgres | Defer: unjustified at this scale |

---

## Part C: Recommendation

### C1. Insurer-source data: curated registry, two-person verified

- **Build now:** a record shape for the empty `curated-sources.js`: insurer, product name, UIN, wording version, official URL, retrieval date, SHA-256 of the file, page and quote for each fact. Reuse `validateOfficialSource`, which already exists.
- **Reuse:** the fact authority model, clause digests, `compareVersions`.
- **Defer:** change-detection fetcher; feed or partnership discussions.
- **Do not build:** a general crawler, LLM-populated catalogue rows, any ingestion of user documents into shared data.
- **Validate:**
  1. Insurer sites permit manual download and storage of wording for this use (ToS and copyright). [A]
  2. Whether the 2023 website-upload rule still applies after the 2024 regulations. [S]
  3. Real row structure of the IRDAI health product list.
- **Evidence hierarchy proposal [A]:** (1) the policy schedule and wording the user holds, as the contract; (2) the insurer's published wording for the same UIN and version; (3) the CIS or prospectus; (4) IRDAI circulars as bounds, not as product terms; (5) aggregators and news never control, they only raise a discrepancy. This matches the repo's existing "non-contractual sources never control" rule.

### C2. Catalogue: UIN-keyed reviewed records, tiny seed

- **Build now:** seed 3 to 5 products from different insurers, each hand-checked against the official wording. One migration, expand-only, same pattern as `017_catalogue_reviews.sql`.
- **Reuse:** `evidence_facts`-style shape from ADR 0009, `catalogue_reviews` immutability and supersession.
- **Key rule [A]:** a catalogue fact is a statement about a product version, never about a person. User endorsements stay in the household's own derived facts. Never merge them.
- **Defer:** variants and riders beyond what the seed needs; search beyond UIN and insurer name; full normalisation of terminology.
- **Do not build:** inferred rows, "latest version" guessing, silent overwrite (new version = new row, old row kept).
- **Validate:** that a UIN uniquely identifies a wording version (it may not, if an insurer revises wording under the same UIN, and IRDAI practice here is unconfirmed).
- **Terminology:** normalise by mapping to the repo's open `topic` labels with a reviewed alias table, and keep the original phrase. Unmapped stays unknown.

### C3. Reviewer access: keep ADR 0009, add operational controls before enabling

- **Build now (before flipping `CATALOGUE_INDEPENDENT_REVIEW_ENABLED`):**
  - Named staff account with a time-limited, case-scoped grant (the grant table exists).
  - Redacted evidence packet: clause text only, from the existing privacy gate output, never the raw document.
  - Maker-checker: reviewer cannot be the household owner or the confirmer (already enforced), and for catalogue-level facts the person who curated a record cannot be its checker.
  - Audit log entry on every view and decision, plus revocation test.
- **Reuse:** grants, immutable reviews, erasure triggers, audit table.
- **Defer:** an IdP or SSO beyond what operators already use; a reviewer portal UI.
- **Do not build:** OpenFGA, Cerbos, Label Studio, or a shared reviewer pool with cross-case access.
- **Validate:** DPDP position of staff and external reviewers (processor contracts, purpose, retention) with a lawyer; this is open in the repo already.

---

## Part D: Where to study what

- IRDAI product list: https://policyholder.gov.in/available-products . Study the Health link and what a row exposes (UIN, date, document). Not yet verified.
- IRDAI circulars: irdai.gov.in. Read the Master Circular on Health Insurance Business 2024 for moratorium, PED wait, CIS requirements; the June 2022 and March 2023 File and Use circulars for filing and website disclosure. I did not reach them.
- FHIR InsurancePlan: https://hl7.org/fhir/R4/insuranceplan.html . Study `coverage.benefit.limit` and `plan.specificCost` for naming.
- ACORD Reference Architecture: https://www.acord.org/standards-architecture/reference-architecture . Study only the product-versus-policy separation. Licensed.
- US SBC and glossary: https://cms.gov/marketplace/health-plans-issuers/summary-benefits-coverage . Study how fixed definitions enable comparison.
- Docling: https://github.com/docling-project/docling . Study the output document format and whether it keeps page and box provenance.
- Per-value citation pattern: https://www.nutrient.io/guides/dws-data-extraction/extract/citations-and-confidence/ . Study the page-and-region-per-leaf idea and the multi-page warning.
- OWASP Authorization Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html . Study least privilege, deny by default.
- Maker-checker: https://www.opcito.com/blogs/maker-checker-implementation-guide-for-secure-fintech-systems . Study segregation of duties enforced in code.
- DPDP Rules 2025 summary: https://www.scconline.com/blog/post/2025/12/26/digital-personal-data-protection-rules-2025-key-highlights/ . Read for processor accountability, then the Gazette text.

## Part E: Roadmap

| # | Milestone | Dependencies | Acceptance | Failure conditions | Security | Verification |
|---|---|---|---|---|---|---|
| 1 | Read primaries: IRDAI health product list, 2024 master circular, 2023 disclosure circular, Insurance Products Regulations 2024 | none | A source note per document with URL, date, retrieval hash, and exact clauses used | A circular cannot be reached or dated: record as unknown, do not paraphrase | Public documents only; no user data | Second person re-reads two sources |
| 2 | ToS and licence check for the 3 to 5 chosen insurers | 1 | Written yes/no per insurer on storing wording for this use | Unclear or no: skip that insurer | n/a | Legal review |
| 3 | Record shape and validator for curated sources, with tests | 1 | `validateOfficialSource` rejects missing hash, URL, date, quote; accepts a complete synthetic record | A record without a source quote is accepted | Synthetic fixtures only | Unit tests; `npm run check` |
| 4 | Seed 3 to 5 products, two-person verified | 2, 3 | Each fact has page, quote, hash, two named verifiers, verifier != curator | Single-verifier fact promoted | Reviewers see public wording only | Spot re-check by a third person |
| 5 | Expand-only catalogue tables keyed by UIN and version | 3 | Migration passes SQLite and PG 17; new version never overwrites an old one | Overwrite of a prior version; UIN reuse across versions unhandled | Tenant isolation unaffected because rows are not household data | Schema and trigger tests |
| 6 | Compare uploaded wording to catalogue by UIN | 4, 5 | Mismatch becomes a discrepancy, never a silent override; absent record = unknown | A catalogue value overrides the user's contract | Existing consent gate unchanged | API journey test |
| 7 | Reviewer operational controls (redacted packet, audit-on-view, expiry, checker != curator) | existing ADR 0009 | Expired or revoked grant denies; every read audited | A view with no audit row | Core of this milestone | Negative tests; independent read-only review |
| 8 | Legal review of reviewer purpose and DPDP processor position | 7 | Written sign-off or list of changes | Reviewer enabled before sign-off | n/a | Counsel |
| 9 | Optional: change-detection fetcher | 4 | Reports hash change only; never auto-ingests | Auto-ingestion | SSRF allow-list | Test against local fixtures |

## What stayed unverified

- All IRDAI circular numbers, dates and thresholds quoted from secondary summaries.
- The real shape and URL of the IRDAI health product list.
- Whether any Indian insurer or aggregator offers a public data API.
- Release and commit activity of every GitHub project listed.
- DPDP treatment of reviewers and health data.
- Cerbos and Sumsub claims come from vendor pages.
