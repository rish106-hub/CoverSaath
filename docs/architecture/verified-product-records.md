# Verified product records contract (`verified-product-records/v1`)

Read-only projection of externally verified insurer product records, for a later API route or an integration. Code: `src/features/decision-catalogue/verified-product-records.js` (`buildVerifiedProductRecords`, `assertVerifiedProductRecordsContract`). It is pure: no network, no clock (`today` is an input), no storage, no new dependency. Nothing is fetched, crawled or invented.

## Inputs (authority comes from the channel)

| Input | Source | Can yield a value |
| --- | --- | --- |
| `verified` | `CuratedProductRepository.listVerified()` | Yes, only if `verified: true`, a `verification` block is present, `checkedBy !== curatedBy`, and freshness is `current` on `today`. A record in this channel that fails the independence check is downgraded to `unverified`. |
| `submissions` | submission DTOs of any state (`collected`, `candidate`, `checked`, `published`, `rejected`, `needs_revalidation`, `superseded`) | Never. A submission's own `verified` flag, `published` state or checker field is ignored. |
| `requested` | optional `[{ uin, wordingVersion }]` | Produces an `unknown` record when nothing exists for that key. |

Malformed input throws (fail closed), so a bad row cannot hide a conflict.

## Output

`{ contractVersion, readOnly: true, asOf, records[], counts, limitations[] }`, with one record per (UIN, wording version), sorted by UIN then wording version.

Record: `uin, wordingVersion, insurer, productName, sourceUrl, sourceVersionId, contentSha256, retrievedOn, effectiveFrom, checkedAt, state, freshness, independentlyChecked, reasons[], conflicts[], history[], facts[]`.

Fact: `factType, topic, state, value, candidateValue, citation`. Citation: `uin, wordingVersion, page, quote, contentSha256, sourceVersionId, retrievedOn, checkedAt`.

### States (closed set)

- `verified`: independently checked, current. The only state with a typed `value`.
- `unverified`: not independently checked or published through the verified channel. Carries `candidateValue` only; it is not a number to calculate with.
- `stale`: freshness not current (older than 400 days, or not yet effective), or `needs_revalidation`. No value.
- `superseded`: replaced by a newer wording source. No value. Older sources of a still-live record appear in `history`.
- `conflicting`: more than one distinct source digest for the same UIN and version, or two values for one factType and topic. Facts are listed with citations, never valued; `conflicts` lists digests (not values).
- `rejected`: a checker rejected the submission. Added beyond the minimum set so a rejection is not shown as unknown.
- `unknown`: nothing usable for a requested key. Absence is never read as "no such term".

## Privacy decisions

- Collector and checker adult ids are omitted entirely rather than hashed: a stable hash of an adult id is still a linkable identifier, and consumers only need `independentlyChecked`. `checkedAt` is kept.
- Public insurer name, product name, source URL and UIN are carried (public wording only). The quote is the only text from the document. No page text, archived bytes, household ids or policy numbers exist in the builder's output.
- Defence in depth: the builder copies named fields only; the assertion refuses any field outside the per-level allowlist and any key matching household, adult, member, policy number, user id, email, phone, collector/checker/curator, page text, bytes or account, at any depth including inside values. Typed values are re-validated against the catalogue rules.

## Assertion refuses

Foreign `contractVersion`, `readOnly !== true`, unknown states, a `value` on a non-verified record (or a `candidateValue` outside `unverified`), `independentlyChecked` mismatching `verified`, an incomplete citation (page, quote, digest, source version id, retrievedOn; and `checkedAt` for verified), unsorted or duplicate records, miscounted `counts`, and any unlisted or forbidden field.

## Not done

No HTTP route, no persistence change, no migration. Wording of limitations is not final and needs legal review. Retrieval completeness and coverage of the insurer universe are not established.
