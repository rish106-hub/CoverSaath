# Policy criteria completeness — addendum to policy-breakdown-backend-intake.md

Date: 2026-10-02 · Branch: `claude/policy-backend` · Class: S2 (money and eligibility logic, migration)

## Objective
"Make sure all the architecture is built properly, all the criteria are properly getting checked, all 12
sections are done to 100%."

## Gap audit (before)
| Gap | Evidence |
|---|---|
| Planned-procedure track checked only money | estimate read ~24 of 63 money parameters; sections 4, 5, 8, 9 were read by no consumer; nothing checked member eligibility, policy in force, waiting periods, treatment cover, exclusions, excluded hospitals or deadlines |
| Emergency card missed deadlines and status | no reimbursement deadlines, excluded-hospital rule or in-force state; two emergencyCard-flagged keys absent |
| Sections 10–12 inert in production | service passed `references: {}` and `city: null`; adequacy had no method |
| Found-path untested | 60 extraction keys were only ever tested as "not found"; member-scoped gold was never scored |
| Top-up | layering read the base deductible, not the top-up threshold |

## Design (after)
- `consumers/procedure-check.js` — deterministic eligibility checklist and dated steps. Outcomes
  met / not_met / attention / unknown / not_applicable; verdict never claims approval.
- `consumers/estimate.js` — new inputs (admission date, condition, top-up base payout, buffer, bonus, met
  threshold, deliveries, abroad); air ambulance; surgery component caps; AYUSH, domiciliary, organ donor and
  modern-treatment sub-limits; disease-wise sub-limits from text; top-up threshold that never pays what the base
  paid; member and parent caps; bonus, restoration and corporate buffer raise only the high bound unless
  certain; PED co-pay; daily cash and attendant allowance; clauses to read; eligibility embedded, and a blocker
  forces the insurer low bound to nothing.
- `consumers/policy-status.js` — in force / grace / lapsed / not started, reminders, and grouped views of
  documents, servicing, membership, other benefits, insurer quality, household, regulation, renewal.
- `consumers/record-values.js` — a value stated only for other named members reads as not stated for this
  member (all variants must be Proven).
- `references/reference-store.js` + `BREAKDOWN_REFERENCE_DIR` — dated, operator-reviewed JSON for sections
  10–12; broken files ignored; no data embedded.
- Migration 006 `households.city`; `PATCH /households/{id}/city` re-runs analysis.
- New endpoints: `POST /policy-records/{id}/procedure-checks`, `GET /policy-records/{id}/policy-status`,
  `PATCH /households/{id}/city` (16 policy routes in total).
- `scripts/criteria-matrix.mjs` → `docs/policy-criteria-matrix.md`; test fails if any parameter is unchecked.
- Synthetic packs B (employer group) and C (super top-up), written by three fixture agents from a shared story
  (`tests/fixtures/policy-breakdown/pack-b/STORY.md`).

## Acceptance evidence
- Criteria matrix: 314/314 parameters checked by at least one consumer; every critical parameter reaches a
  track as well as readiness; every emergencyCard-flagged parameter is on the card.
- Found-path: 285/285 extraction parameters Proven with their gold value in at least one pack; every found gold
  item in every pack assembles as Proven (or Conflicting where the pack contradicts itself on purpose).
- Fixture eval: pack A 296, pack B 306, pack C 107 scored rows, all 100%, citation validity 100%.
- Behavioural scenarios: tests/policy-breakdown-criteria.test.mjs; HTTP: tests/policy-breakdown-api.test.mjs.

## Rollback
All changes are additive. Migration 006 adds a nullable column that older code ignores. Reverting the branch
files restores the previous consumers; the stored records are unchanged in shape.

## Limits that remain
Fixture accuracy proves the plumbing, not model accuracy on real PDFs (needs keys and `.local/eval`). Matching a
condition to exclusions and specified-disease lists is by words, so those results are `attention`, never a
final answer. Reference datasets must be sourced and reviewed by a person before they are placed in
`BREAKDOWN_REFERENCE_DIR`.
