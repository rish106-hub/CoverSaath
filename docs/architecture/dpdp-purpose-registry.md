# DPDP field-to-purpose registry (spec)

Status: spec for the S2 build. **Everything legal in this document is a draft FOR LEGAL REVIEW.** That covers DPDP Act 2023 sections, DPDP Rules, lawful bases, retention periods, children's data, cross-border transfer, notice wording and the classification of health and ABHA data. Nothing here is final, and code must never present it as final.

## 1. Why

Consent purposes exist today only as a database `CHECK` list (`consent_grants.purpose` in `001_baseline_schema.sql:187-190`: `profile_intake`, `document_processing`, `coverage_reconstruction`, `voice_intake`, `institutional_clarification`, `human_review`, `purchase_review`, `payment`) and as scattered scope literals: `documentGrantCheck` in `policy-structuring/index.js:33-45`, `QUESTION_CONSENT_SCOPE` in `src/contracts/policy-evidence.js:17-23`, and the Sarvam recipient check in `src/integrations/sarvam/ocr-provider.js:33`.

Nothing ties a stored column or a model payload slot to a purpose, a recipient, a retention rule or an erasure path. The registry makes that mapping one frozen, testable table.

## 2. Location and shape

The new file is `src/contracts/data-purpose-registry.js`. It is a contract: it has no imports from features and no I/O.

```js
export const DATA_PURPOSE_REGISTRY_VERSION = 'data-purpose/v1-draft';
export const LEGAL_REVIEW = 'required';           // the only allowed value until counsel signs off

/** @typedef {Readonly<{
 *   field: string,              // 'db:<table>.<column>' | 'model:<task>.<slot path>' | 'event:<event>.<payload key>'
 *   personal: boolean,          // personal data under DPDP (draft classification)
 *   dataClass: 'PUBLIC'|'INTERNAL'|'CONFIDENTIAL'|'RESTRICTED',   // EVIDENCE_DATA_CLASSES
 *   category: 'identity'|'contact'|'government_id'|'health'|'insurance_document'|'financial'|'location'|'preference'|'telemetry'|'consent_record',
 *   purposes: readonly string[],   // subset of CONSENT_PURPOSES; non-empty when personal
 *   consentScope: Readonly<{ resourceType, action, dataCategory, recipient }> | null,  // the scope that authorises the use
 *   recipients: readonly ('none'|'sarvam'|'google-gemini')[],
 *   modelEligible: boolean,        // may appear in a model payload (gated slots only)
 *   sealed: boolean,               // stored with column crypto (ADR 0013), when field is db:*
 *   retention: string,             // draft text key, e.g. 'until_revocation', 'event_ttl_90d'; FOR LEGAL REVIEW
 *   erasure: Readonly<{ fn: string, test: string }> | null,  // exported function name + test file proving it
 *   childData: 'possible'|'no',    // dependants under 18 can appear (member tables); FOR LEGAL REVIEW
 *   crossBorder: 'possible'|'no',  // provider processing outside India possible; FOR LEGAL REVIEW
 *   legalReview: 'required',
 * }>} PurposeEntry */
export const CONSENT_PURPOSES = Object.freeze([ /* exactly the CHECK list in 001_baseline_schema.sql */ ]);
export const DATA_PURPOSE_REGISTRY = Object.freeze([ /* PurposeEntry, one per field */ ]);
export function purposeEntry(field) // -> PurposeEntry | throws PURPOSE_FIELD_UNKNOWN
```

## 3. Required entries (minimum set for v1)

| Field | Category | Purposes | Recipients | modelEligible | Erasure |
| --- | --- | --- | --- | --- | --- |
| `db:document_blobs.*` (document bytes, migration 020) | insurance_document | document_processing | sarvam | no | existing document erasure path (builder confirms name and test) |
| `db:source_page_blocks.*` (OCR blocks, 009/011) | insurance_document | document_processing | none | no (only through gated slots) | existing |
| `db:policy_clauses` text (012) | insurance_document | document_processing, coverage_reconstruction | none | no (only through gated slots) | existing |
| `model:policy_structuring_extract.payload.chunks[].text` and `.title` | insurance_document | document_processing | google-gemini | yes | n/a (not stored); derived outputs erased by `PolicyStructuringRepository.eraseDerived` |
| `model:policy_structuring_reconcile.payload.groups[].subject` / `readings[].value` / `.quote` | insurance_document | document_processing | google-gemini | yes | as above |
| `model:policy_evidence_investigate.payload.questions[].text` | insurance_document (question) | coverage_reconstruction, scope `insurance_question` | google-gemini | yes | n/a |
| `model:policy_evidence_investigate.payload.clauses[].text` / `.title` | insurance_document | coverage_reconstruction | google-gemini | yes | n/a |
| `model:policy_evidence_override_sweep.payload.findings[].subject` / `.quote` | insurance_document | coverage_reconstruction | google-gemini | yes | n/a |
| `model:<coverage task>.sources[].text` / `.version` / `context.purpose` | insurance_document | coverage_reconstruction | google-gemini | yes | n/a |
| `db:adult_users.phone_ciphertext`, `phone_hash`, `contact_email_hash` (029) | contact | profile_intake | none | no | adult row deletion (ADR 0015 D5) |
| `db:profile_answers.*_ciphertext` (018) | identity / health | profile_intake | none | no | builder confirms |
| `db:household_places.*_ciphertext`, `current_location` (026) | location | profile_intake | none | no | `UserDataRepository.eraseForHousehold` |
| `db:adult_preferences.*`, `onboarding_progress.*`, `tool_scenarios.*` (027/028) | preference | profile_intake | none | no | `UserDataRepository.eraseForHousehold` |
| `db:household_members.date_of_birth`, names | identity | profile_intake | none | known-identifier redaction only (never sent) | builder confirms |
| `event:provider_call.gateVersion` / `gatedSlots` / `placeholders` / `reasonCodes` / `gatedBytes` (ADR 0017 D5) | telemetry | (operational; no personal data by design) | none | no | `expires_at` purge; personal: false |

The builder fills in every `*_ciphertext` column found in the migrations (section 4, R2). The rows above are the floor, not the full list. Where this table says "builder confirms", the build agent must find the actual erasure function and test. If none exists, it reports a **gap** and does not invent one.

## 4. Testable rules (`tests/data-purpose-registry.test.mjs`)

| Rule | Assertion |
| --- | --- |
| R1 | `CONSENT_PURPOSES` equals the `consent_grants.purpose` CHECK list, parsed from `001_baseline_schema.sql` (set equality) |
| R2 | Every column matching `/_ciphertext\b/` in any migration has a `db:` entry with `sealed: true` |
| R3 | Every `gated` or `gated?` slot in `MODEL_INPUT_FIELDS` (ADR 0017 D2) has a `model:` entry with `modelEligible: true` and `recipients` including `google-gemini`; no other slot has `modelEligible: true` |
| R4 | Every entry with `personal: true` has a non-empty `purposes` subset of `CONSENT_PURPOSES` |
| R5 | Every entry with `erasure !== null` names a function that is exported from its module, and a test file that exists and mentions that function name |
| R6 | Every `db:` entry with `personal: true` has `erasure !== null` **or** is listed in `KNOWN_ERASURE_GAPS` (a frozen list in the test whose length can only fall) |
| R7 | Every entry has `legalReview === 'required'`; no string anywhere in the file matches `/\bfinal\b/i` |
| R8 | The scope constants in code equal the registry's `consentScope`: `documentGrantCheck`'s scope for the structuring slots, `QUESTION_CONSENT_SCOPE` for the investigate question, Sarvam `recipient: 'sarvam'` for document bytes |
| R9 | Every `event:` key that the gateway emits (ADR 0017 D5) has an entry with `personal: false` and `category: 'telemetry'` |
| R10 | `childData: 'possible'` is set on every entry whose field can carry member-table content (all `model:` text slots, OCR blocks, clauses) |
| R11 | `crossBorder: 'possible'` is set on every entry with `google-gemini` or `sarvam` in `recipients` (the processing location is unconfirmed) |

## 5. Not in scope for v1

- Runtime enforcement by purpose, for example the seal refusing a slot whose purpose does not match the grant. The registry is checked by tests in v1. Runtime use is a follow-up decision, because the seal does not know the consent grant.
- Notice text generation. Notice wording stays owned by legal (FOR LEGAL REVIEW).
- Retention durations. The strings are placeholders until counsel sets them.

## 6. Open legal questions (FOR LEGAL REVIEW)

1. The lawful basis for each purpose: consent (DPDP section 6) versus any legitimate use (section 7) for insurance claim support.
2. Verifiable parental consent for dependants under 18 who appear in member tables (DPDP section 9 and the DPDP Rules), when a parent uploads a family floater document.
3. Cross-border processing by Gemini and Sarvam: the section 16 position and any contractual terms.
4. Whether an ABHA number and ABHA address are treated as health data or as a government identifier for classification and notice.
5. Whether a masked Aadhaar (last four digits visible) may be sent to a model at all.
6. Retention of counts-only telemetry, and whether it needs to be tied to a grant for erasure (ADR 0017 Q4).
