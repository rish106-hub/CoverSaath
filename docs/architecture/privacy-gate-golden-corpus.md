# Privacy gate golden corpus, fuzzing and second detector (ADR 0017 D6)

Status: spec for the S2 build. Synthetic data only. Health-data and identifier classifications are drafts **FOR LEGAL REVIEW**.

## 1. Purpose and pass rule

The corpus is how we prove that the deterministic gate (`privacy-evidence-gate.js`) removes Indian direct identifiers and health data before text reaches a model, and that it does not destroy the policy wording the product needs.

A CI run passes only when all of the following hold:

- **P1. Zero leaks.** Every `enforced` row with `expect: redact` leaks no `mustNotContain` fragment, using the leak oracle in section 4.
- **P2. Fail closed.** Every `enforced` row with `expect: refuse` throws one of the listed codes, and no text is returned.
- **P3. Preservation.** At least 95% of `expect: preserve` rows come back unchanged, and every row marked `critical: true` comes back unchanged.
- **P4. Gap ledger.** `known_gap` rows run as `test.todo`. Their count must be less than or equal to `KNOWN_GAP_CEILING`, a constant in the corpus file. Lowering the ceiling is allowed; raising it fails review.
- **P5. Idempotence.** For every row that does not refuse, `gate(gate(x).text, { regate: true }).text === gate(x).text`.
- **P6. Brand.** For every row that does not refuse, `isGatedText(gateText(x))` is true and the object is frozen.
- **P7. Second detector.** Over all P1 and P5 outputs and all enforced fuzz outputs, the second detector (section 6) reports zero hits outside its preserve allow-list.
- **P8. Time.** The whole corpus runs in under 10 s on CI, and no single row takes more than 200 ms. Under a loaded run, rerun the timing check in isolation, as AI.md notes for the existing 200 ms bound.

## 2. Files (all new, test-only)

| Path | Content |
| --- | --- |
| `tests/support/privacy-corpus.mjs` | Frozen `CORPUS` array, `KNOWN_GAP_CEILING`, the generator helpers and the seeded PRNG |
| `tests/support/second-detector.mjs` | The independent detector (section 6). It must not import anything from `src/` |
| `tests/privacy-gate-golden-corpus.test.mjs` | P1 to P6 and P8 |
| `tests/privacy-gate-fuzz.test.mjs` | Section 5 |
| `tests/privacy-gate-second-detector.test.mjs` | P7, plus the detector's own self-test |

There are no `.json` fixtures. Cases are `.mjs`, consistent with `tests/support/privacy-probes.mjs`.

## 3. Case schema

```js
{
  id: 'AAD-007',                       // stable; prefix = category code
  category: 'aadhaar',                 // one of section 7
  variant: 'ocr_devanagari_digits',    // short snake_case
  input: '...synthetic text...',
  knownIdentifiers: [],                // [{ kind: 'NAME'|'DOB'|'PHONE'|'EMAIL', value }]
  expect: 'redact' | 'refuse' | 'preserve',
  mustNotContain: ['2345', '6789'],    // redact: raw fragments that must not survive (oracle, section 4)
  mustContain: ['Sum insured'],        // optional: wording that must survive alongside redaction
  placeholderKinds: ['GOV_ID'],        // redact: at least these placeholder kinds appear (<GOV_ID_n>)
  refuseCodes: ['RESTRICTED_EVIDENCE'],// refuse only
  critical: false,                     // preserve: true means it must never be over-redacted
  status: 'enforced' | 'known_gap',
  gapRef: null,                        // 'GAP-ABHA-14' etc. when status = known_gap
}
```

A meta-test validates the schema of every row: unique ids, known category, and `gapRef` present exactly when `status === 'known_gap'`.

## 4. Leak oracle

Given the output `o` and each fragment `f` in `mustNotContain`:

1. Normalise both strings: NFKC, map every Unicode decimal digit to ASCII (the gate's `\p{Nd}` rule), remove the characters `\p{Cf}`, collapse whitespace, and lower-case.
2. Remove every placeholder (`<[A-Z_]+_\d+>`) from `o`.
3. A leak is any of the following:
   - (a) `f` appears in `o`.
   - (b) For numeric secrets, a run of 4 or more consecutive digits of the secret's digit skeleton appears in `o`'s digit skeleton, where both skeletons have all non-digits removed.
   - (c) For name secrets, any name token of 3 or more letters appears as a whole word.

Rule (b) is deliberately strict: an Aadhaar "last four" counts as a leak. A row that legitimately keeps a last four (for example a masked Aadhaar printed by an insurer) must say so with `mustNotContain` limited to the masked part and a comment. FOR LEGAL REVIEW: whether a masked last four is acceptable.

## 5. Synthetic value rules

- **Aadhaar (12 digits, starting 2 to 9) and VID (16 digits):** every generated value must **fail** the Verhoeff checksum. A meta-test asserts this for every row in the `aadhaar` category. A Verhoeff-invalid number cannot be a real issued Aadhaar. The gate must not rely on Verhoeff (fail closed), and a test asserts that Verhoeff-valid shapes are redacted too. That test generates its values at runtime and never prints them or writes them to a file.
- **PAN:** `[A-Z]{3}[PCHFATBLJG][A-Z]\d{4}[A-Z]`, generated from the seeded PRNG. The fourth letter is mostly `P` (person). Never copy a value from a real document.
- **ABHA number:** 14 digits, printed `XX-XXXX-XXXX-XXXX` or contiguous. The checksum rules are unconfirmed (open question). Values come from the seeded PRNG.
- **ABHA address:** `<handle>@abdm` and `<handle>@sbx`, where `handle` is built from the synthetic name list.
- **Phones:** generated 10-digit mobiles starting 6 to 9, and STD landlines. No fictional Indian range is known (ADR 0017 Q3). Never dial a corpus value. The file header states this.
- **Emails:** only the `example.test` and `example.invalid` domains.
- **Names:** from a fixed synthetic list (for example `Meera Testcase`, `Ravi Synthetic`, `Kavya Placeholder`, `Rahul Fakename`, `अनन्या नमूना`, `राहुल काल्पनिक`), plus transliteration variants of these. Never use names of real public figures.
- **Seed:** `CORPUS_SEED = 0x5EC2_2026`. The PRNG is mulberry32, inline, with no dependency. The generated corpus is frozen at module load, so ids and values are identical on every run.

## 6. Second detector (CI only)

`tests/support/second-detector.mjs` must be written **from this spec, without reading the gate source**, so that the two share no blind spots. It uses a different technique from the gate:

1. **Skeleton stream:** NFKC, Unicode digits mapped to ASCII, confusables mapped (`O`/`o` to 0, `I`/`l`/`|` to 1, `S` to 5, `B` to 8, `Z` to 2, only inside runs that are at least 60% digits), placeholders removed, and every character other than `[0-9A-Za-z]` removed. Keep an offset map back into the original text.
2. **Windowed shape scans over the skeleton:**
   - 12 digits starting `[2-9]`: Aadhaar.
   - 16 digits: VID.
   - 14 digits: ABHA.
   - 10 digits starting `[6-9]`, optionally preceded by `91` or `0`: mobile.
   - `[A-Z]{5}\d{4}[A-Z]` (case-folded): PAN.
   - `[A-Z]{4}0[A-Z0-9]{6}`: IFSC.
   - `\d{9,18}` within 20 characters of `a/c|account`: bank account.
3. **Known-name fuzzy match:** for each known `NAME`, match tokens case-insensitively with Damerau-Levenshtein distance ≤ 1 for tokens of 5 or more letters and exact match for shorter tokens; match initial plus surname; and use a small Devanagari↔Latin transliteration table for the corpus names only.
4. **Preserve allow-list:** toll-free `1800\d{6,7}`, product UIN (`^[A-Za-z]{5,10}\d{5}V\d{6}$`, as in gate `PRODUCT_UIN`), years `(19|20)\d{2}`, and round amounts from the `preserve` rows. The allow-list lives in the detector file and every entry has a comment.

The detector runs over gate **outputs** only. It has its own self-test: on the raw `input` of every `redact` row it must report at least one hit, which proves it is not a no-op. The architecture check already keeps `src/` from importing `tests/`. Rejected alternative: Presidio or another NLP library. It is Python, adds a new dependency and CI image, and has weak Indian-identifier coverage without custom recognisers. Revisit only with measured misses.

## 7. Categories and counts (336 rows)

| Code | Category | Rows | Enforced variants (examples) | Known gaps (rows) |
| --- | --- | --- | --- | --- |
| AAD | Aadhaar and VID | 40 | spaced, compact, dashed, dotted; labels `Aadhaar`, `Adhaar`, `UID`, `आधार`; Devanagari digits; NBSP, double space, tab, zero-width inside groups; groups split across a line break; in a pipe table cell; VID 16 digits; masked `XXXX XXXX 1234`; JSON-number form in `upstream` | OCR `O`/`I` inside a group (4), `GAP-AAD-OCR` |
| PAN | PAN | 24 | labelled, bare, lower-case, inside a sentence, in a table cell, after `PAN Card No.` | split by spaces `ABCPE 1234 F` (3), `GAP-PAN-SPLIT`; OCR `0`/`O` (2), `GAP-PAN-OCR` |
| ABH | ABHA number and address | 24 | ABHA address `@abdm` and `@sbx` (labelled and bare) | 14-digit number in all forms (12), `GAP-ABHA-14`; label `ABHA`/`Health ID`/`आभा` with 14 digits (counted in the 12) |
| PHN | Phones | 36 | +91, 0, 91 prefixes; spaced, dashed, dotted, bracketed STD; Devanagari digits; label `मोबाइल`/`फ़ोन`; pairs `98 76 54 32 10`; WhatsApp label; in a member table | OCR `I`/`l` for 1 (3), `GAP-PHN-OCR` |
| EML | Email and UPI | 12 | plain, obfuscated `(at)`/`(dot)`, labelled `ईमेल`, UPI `@okaxis` | none |
| NML | Latin names, labelled | 20 | `Insured name:`, `Proposer:`, `Nominee`, honorifics, `S/O`, `W/O`, capitalised and upper case, name lists `Members: A, B and C` | none |
| NDV | Devanagari names | 24 | honorifics `श्री`/`श्रीमती`/`सुश्री`/`कुमारी`/`डॉ.`; label `नाम:`; known Devanagari names unlabelled | unlabelled unknown Devanagari name (4), `GAP-NDV-BARE`, accepted as a design limit and documented |
| NTR | Transliterated and known-name variants | 24 | case variants, reversed order, extra spaces or dots (enforced today) | spelling variant `Sharma`/`Sarma` (4), initial plus surname (4), Latin known name printed in Devanagari (4), Hinglish mix (2); all `GAP-NTR-*` |
| MBR | Member tables | 30 | pipe tables with identity, DOB and health columns; headers split over two rows; header carried over a page break; numbered rows `1. Name Self 45 M`; space-aligned rows with relationship words; Hindi headers `नाम`/`संबंध`/`जन्म तिथि`; ICD column; mixed DOB formats | space-aligned table without relationship or date signals (3), `GAP-MBR-ALIGN` |
| MBR-R | Tab tables (refuse) | (in MBR's 30) | two or more tab-separated rows → `RESTRICTED_EVIDENCE` | none |
| DOA | DOB and address | 20 | `DOB`, `D.O.B.`, `जन्म तिथि`; labelled addresses with PIN; unlabelled address tails; Devanagari localities; landmarks | none listed; new misses become gaps |
| OCR | OCR noise across identifier kinds | 30 | fullwidth digits, combining marks, ZWJ/ZWNJ, soft hyphen, RTL or LTR marks, hyphenation across a line, duplicated characters `98765 543210` (rejected as a non-phone), ligature `ﬁ` in labels | confusable mixes beyond AAD/PHN (4), `GAP-OCR-CONF` |
| RST | Restricted (refuse) | 12 | private key, `api_key=`, Bearer, OTP or PIN phrases, AWS or Google key shapes, payment card (Luhn-valid **generated** at runtime) | none |
| PRS | Must-preserve policy wording | 40 | `Sum insured: 500000`, `waiting period of 24 months`, `room rent 1% of SI`, `co-pay 20%`, product UIN, `toll free 1800 xxx xxxx`, `in-patient`, `Plan name: Gold`, `pre-existing disease waiting period`, exclusion code lists `Excl01`, ICD chapter mention in exclusion wording, age band table `61 62 63 64 65`, policy period `01/04/2026 to 31/03/2027`, Hindi policy wording | over-redaction misses go here as gaps (target 0) |

Totals: 336 rows. Known gaps at the start: 4 + 5 + 12 + 3 + 4 + 14 + 3 + 4 = **49** (`KNOWN_GAP_CEILING = 49`). If owner decision Q1 is yes, Phase 4 (gate v10) promotes the `GAP-ABHA-14` rows to enforced and the ceiling falls to 37.

Every `known_gap` row has a one-line comment that names the gap and states whether it is accepted as a design limit (for example a bare unknown Devanagari name) or scheduled for work.

## 8. Fuzzing (`tests/privacy-gate-fuzz.test.mjs`)

- **Base cases:** every `enforced` `redact` row.
- **Mutators**, of which a sample gets one to three, chosen by the seeded PRNG:
  - **Separators:** swap or insert `' '`, `'  '`, `\t`, NBSP (U+00A0), U+2007, U+202F, `-`, `‐` (U+2010), `–`, `.`, `/`, `·`, or `\n` between digit groups.
  - **Digit scripts:** map digits to Devanagari (U+0966 to U+096F), Arabic-Indic, fullwidth, or Bengali.
  - **Invisibles:** insert U+200B, U+200C, U+200D, U+2060, U+FEFF, or U+00AD at a random position inside the identifier.
  - **Case:** flip the case of labels and of PAN letters.
  - **Label variants:** draw from each category's label list in English and Hindi.
  - **Context:** wrap the sample in a random `PRS` row before and after it, or embed it as a pipe-table cell.
  - **Line split:** put a line break between label and value, or between groups.
  - **Confusables** (exploratory only): `0`↔`O`, `1`↔`I`/`l`, `5`↔`S`, `8`↔`B`.
- **Classes:**
  - Enforced: every mutator except confusables. These **must** pass the leak oracle or refuse; refusal counts as a pass because it is fail-closed.
  - Exploratory: any mutation that includes a confusable. These are report-only and print a counts-only summary (`mutations`, `leaks`, `refusals`), never values. They do not fail CI until gate v10 handles confusables.
- **Volume:** 5 000 enforced mutations per run across the fixed seeds `[1, 2, 3, 0x5EC2]`, plus one extra seed from `PRIVACY_FUZZ_SEED` when set. On a failure, print the seed, iteration and case id, never the generated value. The time budget is under 20 s.
- **Shrinking:** on a failure, retry with each mutator removed in turn and report the smallest failing mutator set by name.

## 9. Brand and allow-list probes (also in the corpus file)

These are not text rows. They are an exported `BRAND_PROBES` list that the WP3 and WP4 tests use:

- a hand-built `{ text, gateVersion }` object, a copy with the symbol attached through `Object.getOwnPropertySymbols`, a `structuredClone` of a real `GatedText`, a `Proxy` around a real `GatedText`, a real `GatedText` whose version was overwritten (frozen, so the write must fail), and an object with a getter `text`;
- for every task in `MODEL_INPUT_FIELDS`: one valid draft, one draft per slot with a raw string in a `gated` slot, one with an extra key, one with a missing key, one with a symbol key, one with an over-long array, and one over `MODEL_INPUT_MAX_BYTES`.

## 10. Build notes (S2 build)

- Rows are generated in `tests/support/corpus-rows.mjs` (seeded mulberry32, `CORPUS_SEED = 0x5EC22026`); `tests/support/privacy-corpus.mjs` re-exports `CORPUS`, `KNOWN_GAP_CEILING`, `CATEGORY_COUNTS` and the brand probes. The leak oracle is `tests/support/leak-oracle.mjs`. Rule (b) needs a window of three different digits, so a round amount never counts as a fragment of a secret; digit runs join across spaces and punctuation, never across a letter.
- The category counts are the spec's, except PRS (40 became 44: four rows guard the split-PAN rule against "Table 1500 A" style wording, review P2-3), so the corpus has 340 rows. The gap count started at 61, not 49: the corpus found 12 misses the design did not list (see `TRACKED` in `corpus-rows.mjs`). After gate v10 it is 33 and `KNOWN_GAP_CEILING = 33`. P4 also fails when a `known_gap` row starts passing, so a fix must promote its rows.
- Fuzz volume is 1 800 iterations per seed over seeds `[1, 2, 3, 0x5EC2]` (5 000 or more applied mutations); `PRIVACY_FUZZ_SEED` adds one seed. Three row and mutator pairs are tracked as fuzz gaps in the test file.
- The second detector (`tests/support/second-detector.mjs`) uses token windows over the skeleton instead of a character stream. Its self-test exempts four variants, each with its reason in the test.
