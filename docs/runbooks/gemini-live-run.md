# Runbook: one live Gemini run on a synthetic policy (B2)

Purpose: prove, once and cheaply, that the structuring path works against the real Gemini API: privacy gate, model
gateway reservation and budget, extractor, reconciler, deterministic decisions. Scope: the built-in synthetic fixture
only. For real documents through the API use [policy-structuring.md](policy-structuring.md).

The script is `scripts/smoke-test-gemini.mjs`; the fixture is `scripts/fixtures/synthetic-policy-pages.mjs`
(three pages, fictional insurer and people, fake IDs, an injection-style line to prove document text is not
obeyed). It cannot be pointed at another document. The paid Sarvam OCR step is skipped: the fixture already has the
block shape Sarvam produces. OCR is a separate paid check (`npm run test:sarvam-live`, `scripts/smoke-test-sarvam.mjs`).

## Pipeline and flags

```
synthetic block pages -> sectioner -> privacy gate (known names masked; fails closed) -> model gateway
  (task allowlist, input cap, per-call reservation, run + project budget, 1 call at a time, no retries)
  -> extractor -> reconciler -> deterministic decisions (extracted_unverified | conflicting only)
```

| Setting | Meaning |
| --- | --- |
| `--live` (argument) | The only switch that spends money. Without it the script is a dry run. |
| `LLM_PROVIDER=google`, `GEMINI_API_KEY` | Server-side key on a billing-enabled project. Never printed. |
| `LLM_MODEL`, `LLM_INPUT_USD_PER_MILLION`, `LLM_OUTPUT_USD_PER_MILLION` | Account-available model and its current rates from Google's pricing page. Wrong rates make every cap wrong. No default model exists. |
| `ORCHESTRATION_RUN_BUDGET_USD` | Hard cap for this run. Must be set explicitly and be at most `0.50` (script ceiling). |
| `ORCHESTRATION_PROJECT_BUDGET_USD` | Cap shared across live paths in the process. Must be set explicitly. |
| `STRUCTURING_MAX_INPUT_BYTES` / `STRUCTURING_MAX_OUTPUT_TOKENS` | Per-call caps. The script defaults to 24000 / 8000 (production: 64000 / 16000). |

`POLICY_STRUCTURING_ENABLED` is set in-process by the script for this run only; the server flag is not touched and
no provider call can happen from the server because of this run. The synthetic fixture plus `--live` is the consent
for this run; there is no household or stored grant.

## Preconditions (all must hold; the script checks them)

1. Owner has added Google billing credit and approved this run.
2. `ORCHESTRATION_RUN_BUDGET_USD` is at most the ceiling and one reservation fits it. One reservation is
   `(maxInputBytes x input rate + maxOutputTokens x output rate) / 1e6`; the shared config also checks the same formula
   with `LLM_MAX_INPUT_BYTES` / `LLM_MAX_OUTPUT_TOKENS` (defaults 48000 / 1500).
3. The dry run reports `"liveReady": true`, `"gate": { "status": "pass" }` and `canariesFoundInOutgoingText: 0`.
4. Working tree is the reviewed branch; `npm run check` and `npm run eval:safety` are green.

## Step 1: dry run (free, offline)

```sh
node --env-file=.env scripts/smoke-test-gemini.mjs
```

(Equivalent: add `--dry-run`. With no `.env` it still runs and lists the missing settings in `problems`.) Read:
model, `estimate.plannedCalls` (extraction batches plus one possible reconcile call), `estimate.worstCaseUsd`
(calls x reservation), `budget.runCapUsd`, gate status. Expected input is tiny (about 5k tokens on the current
fixture); the worst case is bounded by the reservations, and the run cap stops spend before it is reached.

## Step 2: the live run (one command)

```sh
node --env-file=.env scripts/smoke-test-gemini.mjs --live
```

Run it once. Do not loop or retry on failure; a failed run may already have been charged for the attempted call.
If any precondition is missing the script exits 1 with `refused: true` and `providerCallsMade: 0`.

## Cost ceiling

The run cannot spend more than `ORCHESTRATION_RUN_BUDGET_USD` plus the one in-flight call's overshoot, and the
gateway stops all further paid work if an actual cost exceeds its reservation (`reservation_exceeded`). Planned
worst case on the fixture is three reservations (about 0.1 USD at 1 USD per million tokens each way, 24000 bytes in and
8000 tokens out). Use a run cap just above one reservation (for example 0.10) for the first run.

## Pass criteria

All of these in the printed `run` block (exit code 0 means they held):

- `pass.insideRunBudget`: `spentUsd` is not above `runCapUsd`.
- `pass.outputStatesAllowed`: every `decisionStates` entry is `extracted_unverified` or `conflicting`
  (`unknown` is an absent reading); nothing is `proven` or `confirmed`.
- `pass.gateClean`: no synthetic identifier was in outgoing text.
- `callOutcomes` are all `ok`, `chunks.unaccounted` is 0, and `outcome.evidenceOutcome` is `complete` or
  `partial_review_required` (never `failed`). The fixture holds a deliberate 3 years vs 36 months pre-existing
  disease conflict: expect `f.ped_waiting_period` to be reported as conflicting, not resolved.
- The injection-style line on page 3 produced no change in state.

## What to record

Counts only, in `docs/iterations/LATEST.md` or the run ledger: date, model id, rates used, run cap, `providerCalls`,
`tokens`, `spentUsd`, `outcome`, `conflicts`, `decisionStates`, pass/fail per criterion, and any `callOutcomes` other
than `ok`. Also check the actual charge in Google AI Studio billing against `spentUsd`. Do not record the key, the
`.env` contents or provider response text.

## If it fails

| Printed | Meaning and action |
| --- | --- |
| `refused: true`, `problems: [...]` | A precondition is missing; fix the named item. Nothing was sent. |
| `failed: true`, `code: LIVE_AI_CONFIG_INVALID` | Shared live config check (missing rate, reservation above the run cap). Nothing was sent. |
| `callOutcomes` has `budget_refused` | Cap reached; working as designed. Raise the cap only with the owner's approval. |
| `reservation_exceeded` | Actual cost above the reservation: stop, check rates and model id, do not rerun. |
| `usage_unknown`, provider HTTP errors | Provider side. Do not loop. Check billing and model access, rerun once at most. |
| `pass.outputStatesAllowed` false | Treat as a defect in the authority guard. Stop and report; do not weaken the guard. |

## Roll back

Nothing is stored and no server flag changes, so there is nothing to undo in the application. To close the exposure:
unset `GEMINI_API_KEY` and the budget variables in the shell or `.env` (or revoke the key in Google AI Studio),
delete any synthetic PDF written with `--write-pdf`, and revert the branch if the script itself must be withdrawn.

## Optional: synthetic PDF for an OCR check

```sh
node scripts/smoke-test-gemini.mjs --write-pdf=./synthetic-policy.pdf   # refuses to overwrite; no provider call
```

The PDF is deterministic and banner-marked on every page. Running Sarvam on it is a separate paid step that needs its
own approval and the Sarvam flags in [clamav.md](clamav.md) and [policy-structuring.md](policy-structuring.md).
