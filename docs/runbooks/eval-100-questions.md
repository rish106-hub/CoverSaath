# Runbook: 100-question policy evaluation

Measures the P0 journey (one household, one policy: schedule plus terms and conditions, then facts, then a grounded answer with citations) with five separate scores. There is no blended number and no pass threshold yet.

**Synthetic scores do not measure real-policy accuracy.** Synthetic mode proves the harness and the scoring work. It runs stubs over invented text that was written next to the rules that read it.

## The five scores

| Score | Counts as correct when | Skipped when | Limit |
| --- | --- | --- | --- |
| Extraction accuracy | the value extracted for the expected fact key matches the expected value under the question's matching rule | question has no fact key (including every unknown) | tests the extractor, not the answer |
| Retrieval recall | the expected `{documentKind, page}` is among the retrieved passages | expected answer is `unknown` | page-level, not clause-level; says nothing about ranking quality |
| Answer correctness | the answer matches the expected value under the rule; for `unknown` the answer must be unknown | never | `contains` is lenient, `exact` is strict; choose per question |
| Citation correctness | one cited passage equals the expected `{documentKind, page}` | expected answer is `unknown` | a right answer with a wrong citation fails here only |
| Unsupported claims | counted, lower is better: a value was asserted with no citation, or only a citation that was not retrieved, or for an expected `unknown` | never | counts assertions, not truth; a wrong but cited answer is not unsupported |

Matching rules: `exact` (case and whitespace insensitive), `numeric` (first number, thousands separators ignored, optional `tolerance`), `contains` (case-insensitive substring), `unknown` (answer must be unknown). Scoring is deterministic code; no model judges anything.

## Run synthetic mode (default, offline, free)

```sh
npm run eval:questions
node scripts/eval-policy-questions.mjs --set scripts/fixtures/synthetic-policy-questions.json --out /tmp/report.json
```

No network, provider key, database or cost. Output: a table on stdout and a JSON report (default `.local/eval/policy-questions-report.json`, git-ignored). The exit code is non-zero only for a harness error (malformed set, bad flags, API failure), never for low scores.

What is real in synthetic mode: the repo's clause builder and query shaping. What is stubbed: OCR (fixture is already OCR-shaped blocks), retrieval (in-memory term overlap, not PostgreSQL full-text search), extraction (regexes defined beside the fixture, so extraction scores near 100% by construction), answering (a topic matcher), and the privacy gate, consent checks and model calls (none are run).

Fixtures: `scripts/fixtures/synthetic-eval-policy.mjs` extends the thin three-page `synthetic-policy-pages.mjs` with a schedule and a terms document (invented insurer Zephyr Mutual Health, invented numbers, no personal data). The question set is `scripts/fixtures/synthetic-policy-questions.json`: 100 questions over eight categories, 20 of them with expected answer `unknown`, four of which deliberately resemble a topic that the stub will wrongly answer (to exercise the unsupported-claims score).

## Run on your own verified documents (owner only)

Documents and question sets with real content stay outside this repository and are never committed, pasted into a ticket or sent to a model by hand.

1. Use an environment you control: your own API instance, your own household, documents you have verified by hand, synthetic-free but private. Provider features on that server may cost money; run it on purpose.
2. Write a question set outside the repo (for example `~/eval-private/my-policy.json`) in the same schema as the synthetic set. Each item: `id`, `question`, `category`, `expectedAnswer` (value or `"unknown"`), `expectedFactKey` (a policy fact type, or null), `expectedSource` (`{ "documentKind", "page" }` or null for unknown), `matchRule` (`{ "type": "exact" | "numeric" | "contains" | "unknown", "tolerance"? }`). Malformed sets are rejected with a list of problems before anything is called. Use `contains` for facts whose stored value is not a plain string.
3. Set environment variables (names only here; values are never printed or logged):
   - `RUN_POLICY_QUESTIONS_LIVE=1` (explicit opt-in; real mode refuses without exactly `1`)
   - `EVAL_BASE_URL`, `EVAL_BEARER_TOKEN`, `EVAL_HOUSEHOLD_ID`
   - `EVAL_DOCUMENT_IDS` as `schedule=<documentId>,terms=<documentId>` (the kind names must match `documentKind` in your set)
4. Run: `node scripts/eval-policy-questions.mjs --mode real --set ~/eval-private/my-policy.json --out ~/eval-private/report.json`

Real mode calls only existing routes: `GET /api/v1/documents/{id}/policy-facts` and `POST /api/v1/households/{id}/chat`. Keep the report outside the repo too. It lists question ids and counts, not answers or document text.

Limits of real mode: the API returns only the sources an answer cited, so "retrieved" is the cited sources and retrieval recall equals citation presence. Fact values come from sealed fact records as the API returns them. Real mode was written against the route code and tested with an injected fetch; it has not been run against a live server. One run on one policy is a measurement of that policy and run, not of the product.

## Reading results

Compare scores to each other, not to one number. Low extraction with high answer means answers come from somewhere other than extracted facts. High answer with low citation means right answers without verifiable sources. Any unsupported count above zero on `unknown` questions is a groundedness failure and deserves a look before anything else.
