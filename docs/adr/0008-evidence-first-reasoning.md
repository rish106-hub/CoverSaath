# ADR 0008: Evidence-first policy reasoning

- Status: Proposed (accepted by the product owner 2026-10-20; ADR text awaits independent review)
- Date: 2026-10-20
- Scope: new `src/features/policy-evidence/`, `src/contracts/policy-evidence.js`, clause and answer stores
- Plan: [direction-change.md](../exec-plans/active/direction-change.md)

## Context

A fixed 138-parameter registry cannot hold insurer-specific conditions (room rent caps, riders, disease-specific
waits). Anything that does not fit never reaches comparison logic, which hides the terms the product exists to
surface. Live-run failures on 2026-10-20 were pipeline bugs, fixed in Phase A (S0, S1, S2, S7), not registry rigidity.

## Decision

1. Standardise only: document metadata, evidence structure (clause, finding) and answer structure. Policy content
   stays open-ended.
2. The 138-parameter registry stays as an **optional common-facts catalogue**. It is not the extraction target.
3. **Clause store.** Stored OCR blocks are the clause source. Clauses are built deterministically (same blocks give
   the same clause ids and digests). No model builds or edits a clause.
4. **Context.** For one policy, the whole gated policy is the model context while it is under a token budget
   (provisional 120k gated tokens per question). Above the budget, SQLite FTS5 retrieval per checklist clause kind,
   plus all endorsement and schedule clauses. Embeddings and vector databases only after measured recall failure.
5. **Override sweep.** Every question runs a second pass asking only for clauses that limit, exclude, waive or
   override the first findings. A missed override is a hard evaluation failure.
6. **Authority.** Findings are capped at `extracted_unverified`, `conflicting` or `unknown`. Money, dates, caps and
   all arithmetic are computed by deterministic code. An answer is cited conditional evidence, not a coverage verdict.
7. **Consent.** Question-time Gemini use is a separate purpose. The consent scope table's `action` CHECK has no
   `answer` value, and changing it needs a strict-table rebuild that the SQLite runner cannot do under foreign keys
   (blocker U2). The purpose is therefore carried by `data_category = 'insurance_question'` with
   `action = 'derive'`, recipient `google-gemini`, document-specific. A grant for structuring does not authorise
   questions. **Consent wording is a draft and requires legal review.**
8. **Privacy.** Every clause sent to a model passes the privacy gate (`knowvia-privacy-evidence-v5`) at question
   time; consent is re-checked before each model call and before commit.
9. **Erasure.** Clauses, FTS rows, findings and answers are derived stores. Consent revocation and document erasure
   remove all of them, with tests. FTS virtual tables have no cascade; deletion is explicit.

## Implementation notes (2026-10-20)

- Tables: `policy_clauses`, `policy_answers` (SQLite 015, PostgreSQL 012); FTS5 `policy_clauses_fts` (SQLite 016 only,
  maintained by triggers; PostgreSQL retrieval via tsvector is deferred because the runtime is SQLite).
- Model tasks `policy_evidence_investigate` and `policy_evidence_override_sweep` use the structuring gateway path.
  Code assigns finding state; the model cannot set it. A failed sweep is reported as an unknown, never hidden.
- `POST /api/v1/cases/:caseId/questions` (Idempotency-Key required) and `GET .../questions/:answerId`.
  Off unless `POLICY_EVIDENCE_ENABLED=true`. Needs a document-specific grant: `derive`, `insurance_question`, `google-gemini`.
- Document boundaries (2026-10-20): only the latest active version per logical document (household-wide) is read.
  More than one current document needs a requester-named `documentIds` set, recorded as an unverified association.
  Stored answers are served only while the question grant is active and every read document is still current.
- Finding `effect` (2026-10-20, live-run defects F-B/F-C): the first-pass model reports `effect` (covers, limits, excludes,
  conditions, informs) per finding. Code validates it (unknown or missing becomes `conditions`, never `covers`) and buckets
  by it instead of by the cited clause's keyword kind. It stays `extracted_unverified` display routing, not a coverage
  decision. Task keys and authority (`propose`) are unchanged, so the AI authority matrix needs no new entry. Code also
  adds an unknown when a subject word from the question appears in no clause read.
- Unverified: no live Gemini call was made; recall (slice B5) is unmeasured.

## Consequences

- Gains flexibility; does not guarantee completeness. Retrieval recall and override coverage must be measured
  (golden question set, slice B5) before answers are relied on. Evidence today is one document.
- Hard to reverse: new derived stores and a new consent purpose.

## Rollback

Each store ships in its own migration; the feature is disabled by `POLICY_EVIDENCE_ENABLED` (default off). The
registry path is unchanged.
