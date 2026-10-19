# ADR 0003: AI authority matrix

- Status: Proposed (P1-A, branch `claude/p1-contracts`)
- Date: 2026-10-15
- Scope: `src/contracts/ai-authority.js`

## Context

What a model may decide is spread across three files:

- `responsibility-matrix.js`: which tasks may use a model, and which are protected.
- `parameter-records.js`: `OBSERVATION_RESOLUTION_RULES` and the guards on model authority.
- `agent-contracts.js`: which envelope evidence states a model may carry.

Reviewers and a later PostgreSQL adapter need these rules in one place.

## Decision

`AI_AUTHORITY_MATRIX` is a frozen literal table with five parts:

- **protectedDecisions.** Every `DETERMINISTIC_TASKS` entry, each with a category and authority `deterministic`:
  - authorization: consent check, source authorization, external action authorization
  - arithmetic
  - state transition
  - release
  - graph construction
  - classification
  - review (evidence, privacy, safety)
- **modelTasks.** The five `AI_TASKS`. All of them have authority `propose`. Each lists the workflow tasks that use it and whether it records parameter observations: true for the three extraction tasks, `MODEL_OBSERVATION_TASK_KEYS`.
- **workflowTasks.** The owner and model task of all 22 workflow tasks, equal to `RUNTIME_RESPONSIBILITIES`.
- **modelOutput.** What model output can become:
  - envelope evidence states: `Unknown` and `Conflicting` only
  - parameter resolution states: `unknown`, `extracted_unverified` and `conflicting` only
  - protected resolutions it may never replace: `proven`, `calculated`, `dynamic` and `not_permitted`
  - its one observation rule: `document_extraction → extracted_unverified`
  - no release statuses
  - `externalActionsAuthorized: false`
- **resolutionAuthorities.** For each value-carrying resolution state, which observation method and authority can establish it, and whether an accepted review is needed. Taken from `OBSERVATION_RESOLUTION_RULES`.

The table is written out by hand rather than computed from the sources. A computed table would always agree with its sources, so it could not catch drift. `tests/p1a-ai-authority.test.mjs` proves the table agrees with all three sources, both by comparing the data and by calling the guards: `assertModelTask`, `assertResolutionTransition`, `assertModelMayReplaceResolution`, `deriveResolutionAuthority` and `validateTaskOutputEnvelope`. If a source changes, the test fails until the table and this ADR are updated together.

## Outcome

- **No AI-controlled critical tasks.** There are 0 AI-controlled authorization, arithmetic, state-transition or release tasks. The workflow loader refuses a model on a deterministic or protected task (ADR 0001).
- **No path from model output to proven, calculated, dynamic or released.**
  - Parameter records: model authority cannot create or replace those states, and a `document_extraction` observation supports only `extracted_unverified`, even after an accepted review.
  - Envelopes: a model-produced envelope can carry only `Unknown` or `Conflicting`.
  - Release: a release result with model metadata is refused when written and when read, and a release can never authorise external actions.
- **No change to runtime behaviour.** The matrix is data plus two lookup helpers.

## Rollback

Revert the commit. The matrix is new and contract-only.
