# Policy breakdown API (for the frontend)

Base path `/api/v1`. JSON in and out. Every call except `POST /households` needs
`Authorization: Bearer <session token>`. Errors are `{ "error": { "code", "message" } }`. Household scope is
enforced on the server: a record from another household returns 404. Creating POSTs that start work need
an `Idempotency-Key` header (8–200 chars); repeating the same key and body returns the same job.

Money is always integer **paise** (`amountMinor`). Every parameter carries an `evidenceState`:
`Proven` · `Calculated` · `Reported` · `Dynamic` · `Unknown` · `Conflicting` · `NotPermitted`.
Show the state next to the value. Never hide Unknown, and never render NotPermitted as Unknown.

## The simplest frontend flow

```text
1  POST /households                                   (bootstrap; once)
2  POST /households/{id}/members        × family      (name, relationship, date of birth)
3  POST /consents  purpose=document_processing        (scope document/collect/insurance_document)
4  POST /households/{id}/documents                    (PDF as base64)          → document.id
5  POST /consents  purpose=coverage_reconstruction    (scopes policy/derive + document/share)
6  POST /households/{id}/policy-records               (documentIds, modelPermission:true) → job.id
7  GET  /breakdown-jobs/{jobId}          poll every 3–5 s until status is succeeded or failed
8  GET  /policy-records/{id}/sections                 show 12 sections
9  POST /policy-records/{id}/parameters/{key}/review  for each critical parameter
10 POST /policy-records/{id}/readiness                → ready
Then: GET /policy-records/{id}/emergency-card  ·  POST /policy-records/{id}/procedure-checks
      POST /policy-records/{id}/estimates  ·  GET /policy-records/{id}/policy-status
Optional: PATCH /households/{id}/city  (enables city-specific insurer and adequacy analysis)
```

Where each of the 314 parameters is checked: `docs/policy-criteria-matrix.md`.

## Endpoints

### Household members
`POST /households/{householdId}/members` → 201
```json
{ "displayName": "Kaushalya Devi", "relationship": "mother", "dateOfBirth": "1962-07-21" }
```

### Consents (existing endpoint)
`POST /consents` → 201. The subject must be the signed-in adult.
```json
{ "householdId": "...", "subjectAdultId": "...", "purpose": "coverage_reconstruction",
  "scopes": [
    { "resourceType": "policy", "action": "derive", "dataCategory": "insurance_document" },
    { "resourceType": "document", "action": "share", "dataCategory": "insurance_document" } ] }
```
The `share` scope is what allows page images to go to Sarvam and page text to Gemini. Ask the person in
plain words before granting it. `POST /consents/{id}/revoke` stops all reads of records built on it.

### Upload a document
`POST /households/{householdId}/documents` → 201 (body limit about 22 MB; file limit 15 MB)
```json
{ "consentGrantId": "...", "documentKind": "policy_wording", "filename": "policy.pdf",
  "mimeType": "application/pdf", "contentBase64": "JVBERi0..." }
```
`documentKind`: `policy_wording` | `policy_schedule` | `endorsement` | `member_card` | `other`.
Response `{ document, accepted, scan, reason? }`. When `accepted` is false the file was quarantined
(active content, unreadable or password-protected PDF) — show `reason`.

`GET /households/{householdId}/documents` → `{ documents: [...] }` (metadata only).

### Start a breakdown
`POST /households/{householdId}/policy-records` + `Idempotency-Key` → 202 (200 on replay)
```json
{ "documentIds": ["..."], "consentGrantId": "...", "modelPermission": true }
```
Response `{ record, job, dispatchStatus }`. Live mode needs `SARVAM_API_KEY` and a Gemini key on the
server; without them the call returns 503 with a clear code.

`GET /households/{householdId}/policy-records` → `{ records: [...] }`

### Job progress
`GET /breakdown-jobs/{jobId}` →
```json
{ "status": "running", "currentStep": "extract:section-06-money",
  "steps": [ { "id": "ocr", "label": "Read every page…", "status": "succeeded", "metrics": { "pageCount": 42 } },
             { "id": "extract:section-01-document-authority", "section": 1, "status": "running" } ],
  "spentUsd": 0.41, "budgetUsd": 5, "error": null }
```
`status`: `queued` · `running` · `succeeded` · `failed` · `interrupted`. 11 steps: OCR, 9 extraction
sections, assembly. `POST /breakdown-jobs/{jobId}/resume` retries failed or interrupted steps (202).

### Record and sections
`GET /policy-records/{recordId}` → `{ record, job, sections: [{ number, title, kind, counts }] }`.
`record.status`: `processing` · `needs_review` · `ready` · `failed` · `revoked`.

`GET /policy-records/{recordId}/sections` and `/sections/{1-12}` →
```json
{ "recordStatus": "needs_review", "consistencyIssues": [],
  "sections": [ { "number": 6, "title": "Money…", "question": "…", "reviewGuidance": "…",
    "parameters": [ {
      "key": "sum_insured_amount", "label": "Sum insured", "valueType": "money",
      "value": { "kind": "money", "amountMinor": 100000000, "currency": "INR" },
      "basis": "per_policy_year", "effect": "cap_amount", "conditions": ["Family floater"],
      "evidenceState": "Proven", "stateReason": "citations_verified", "critical": true,
      "citations": [ { "documentId": "…", "pageNumber": 1, "quote": "Base Sum Insured (Floater): Rs. 10,00,000/-", "matched": true } ],
      "verification": { "verifier": "agrees" }, "review": { "state": "unreviewed" } } ] } ] }
```
Unknown parameters may carry `proposedValue` (the model's unverified suggestion) — show it only as a
suggestion to check. `memberVariants` lists values that apply to a named member only.

### Review a parameter
`POST /policy-records/{recordId}/parameters/{key}/review`
```json
{ "action": "confirm" }
{ "action": "correct", "value": { "valueNumber": 500000 }, "citation": { "documentId": "…", "pageNumber": 3, "quote": "…" }, "note": "…" }
{ "action": "mark_absent", "note": "Not in the schedule" }
```
`value` uses the same fields as extraction: `valueNumber` (rupees, percent or counts), `valueText`
(enums, dates `yyyy-mm-dd`, text), `valueBoolean`, `valueList`. With a citation whose quote is found on the
page, the value becomes Proven; without one it is Reported. Protected parameters can only be reviewed by
the person who created the record.

### Readiness
`POST /policy-records/{recordId}/readiness` → `{ ready, blockers: [{ code, key?, message }], recordStatus }`.
Every critical parameter must be confirmed, corrected or marked absent, and no critical value may remain
Conflicting.

### Emergency card
`GET /policy-records/{recordId}/emergency-card` — always available (never waits for readiness), with
`confirmedByPerson` and a `banner` when unconfirmed. Contains `instruction`, `policyStatus { state, message }`,
`policy`, `cover`, `cashlessProcess`, `ifPaidFirst` (reimbursement deadlines and documents), `waiting`,
`household`, `members[]` (named on policy, likely age co-pay, `memberSpecific[]` values), `unknowns[]`.
Protected fields are never included. Show `instruction.first` first.

### Planned-procedure checklist (no bill needed)
`POST /policy-records/{recordId}/procedure-checks` — same body as the estimate below, bill optional.
Response: `verdict` (`no_blocker_found` | `needs_confirmation` | `blocker_found`), `verdictNote`,
`admissionDate`, `checks[] { id, label, outcome, message, parameterKeys, evidence }` with `outcome`
`met` · `not_met` · `attention` · `unknown` · `not_applicable`, `steps[] { id, label, text, dueBy?, documents? }`
and `parametersRead[]`. Checks cover: policy in force or grace, member named and cover started, child age,
initial / pre-existing / specified-disease / maternity waits (from the stated start basis), disclosure,
treatment covered (day care, maternity, modern, AYUSH, domiciliary, organ donor, mental illness, bariatric),
minimum stay, exclusions mentioning the condition, add-ons and endorsements, treatment abroad, cashless route,
excluded hospitals, preferred providers, and where regulation may differ. Steps cover pre-authorisation (with a
due date), room and deposit, cashless decision, discharge, reimbursement deadlines, pre/post bills, and
settlement and complaints. Show `not_met` and `attention` first. It is never a claim decision.

### Planned-procedure estimate
`POST /policy-records/{recordId}/estimates`
```json
{ "memberId": "…", "procedure": "cataract", "eyes": 1,
  "admissionDate": "2026-11-02", "dischargeDate": "2026-11-02", "stayHours": 6,
  "condition": { "name": "cataract", "preExisting": false, "specifiedDisease": null, "accident": false },
  "hospital": { "networkStatus": "network", "zone": "zone_b", "excluded": null },
  "room": { "category": "single_private_ac_room", "ratePerDayMinor": 900000, "days": 1, "eligibleRoomRatePerDayMinor": null },
  "icu": { "ratePerDayMinor": null, "days": 0 },
  "billLines": [ { "head": "surgeon_fees", "amountMinor": 3000000 } ],
  "sumInsuredAlreadyUsedMinor": 0, "cumulativeBonusAccruedPercent": null, "corporateBufferApproved": null,
  "deductibleAlreadyMetMinor": null, "otherPolicyPaysMinor": null, "previousDeliveries": null, "abroad": false }
```
Every field except the bill is optional; leaving one out widens the range or adds an `attention` check rather
than guessing. `procedure`: general_inpatient · day_care · cataract · maternity_normal · maternity_csection ·
joint_replacement · modern_treatment · ayush · domiciliary · organ_donor · mental_illness · bariatric · other.
`head`: nursing · doctor_fees · surgeon_fees · anaesthetist_fees · ot_charges · medicines_pharmacy ·
consumables · implants_devices · diagnostics · ambulance · air_ambulance · non_payable_misc · other (room and ICU
go through `room` and `icu`). For a top-up record send `otherPolicyPaysMinor` (what the base policy pays).

Response: `status` (`estimate` | `conditional` | `insufficient_evidence`), `insurerPaysMinor {low, high}`,
`householdPaysMinor {low, high}`, `otherPolicyPaysMinor`, `display`, `steps[]`, `assumptions[]`,
`blockingUnknowns[]`, `additionalBenefits[]` (daily cash, attendant allowance), `clausesToRead[]`,
`eligibility` (the checklist above), `usedParameters[]`, `boundaries[]`. When the checklist finds a blocker the
least the insurer may pay is shown as nothing. It is a planning range, never a claim decision.

### Policy status and overview
`GET /policy-records/{recordId}/policy-status` → `state` (`in_force` | `grace_period` | `lapsed` |
`not_started` | `unknown`), `message`, `reminders[] { id, dueBy, text }` (renewal, portability, group conversion,
withdrawal notice) and `groups` of parameter views: `documents`, `servicing`, `membership`, `otherBenefits`,
`insurer`, `household`, `regulation`, `renewal`, `premium`, `changes`, `moving`, `leaving`.

### Household city
`PATCH /households/{householdId}/city` `{ "city": "Pune" }` (or `null`) → `{ householdId, city }`. Re-runs the
analysis sections on every record so network-hospitals-in-city and sum-insured adequacy can use it.
