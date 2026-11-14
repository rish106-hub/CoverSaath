# CoverSaath architecture v1 (merged, 2026-11-14)

Status: merged draft from Squad A and Squad B after one round of red-team each way. For owner review; not accepted, not an ADR. All consent, notice, retention, research and on-screen wording is **FOR LEGAL REVIEW**. Synthetic data only in code and tests. No paid provider run was used.

Sources: `arch-a-draft.md`, `arch-b-draft.md`, `arch-a-redteam-of-b.md` (R1-R14), `arch-b-redteam-of-a.md` (B1-B14). Where this file and a draft disagree, this file wins. Builds on ADR 0013, 0014, 0017, 0022, 0023, 0029, 0030, 0031, 0032, 0033 and `target-flow-2026-11-14.md`.

## 1. Rules everything obeys

1. **Deterministic code decides; the model only words.** Coverage, eligibility, money, waiting-period arithmetic, claim steps and the next question are computed by code. The model writes sentences inside a fixed card and never adds a fact.
2. **Every claim cites its evidence or says unknown.** Page, clause, quote of at most 160 characters. "Your documents don't say" is a good answer and always comes with a next step.
3. **The validator is the guardrail, not the prompt.** One output guard checks every reply against the evidence it was given.
4. **One purpose, one consent, one erasure path per store.** "Store everything" means everything the person agreed to, for that purpose, deletable on request.
5. **Household is the tenant; the person is the subject.** Ownership re-checked on every read and write. Health visibility between adults is per person (open decision O7).
6. **Public product data is shared, personal data never is.** A UIN is parsed once in FSS and reused by every holder.
7. **Tap first, type last.** One decision per screen, "Not sure" always allowed, no defensive copy.

## 2. End-user journey

| # | Screen | User does | System does |
|---|---|---|---|
| 1 | Start | "Upload policy" or "I'm in hospital now" | Consent sheet once (what is read, by whom, how to delete), naming every processor including Gnani if voice is used |
| 2 | Checking file | Waits (3-step progress) | Insurance-PDF gate (422 for non-insurance), sanitise, scan, OCR |
| 3 | Is this your product? | "Yes" / "No, show others" (skipped only on an exact UIN match to an FSS product whose UIN came from the document itself, not from a link page, sibling or ambiguous tag) | UIN, insurer and product matched in FSS; up to 3 alternatives; "None" opens one name-fragment field |
| 4 | Who is covered | Confirms name chips, fixes relationship | Members from own PDF, `extracted_unverified` until tapped; minors flagged |
| 5 | Up to 2 questions | Chips | Planner asks only questions that change a tile on the card (members, PED) |
| 6 | **Policy card** | Reads, taps tiles for sources | Resolver output (ADR 0023 D3). Badges: From your policy, From insurer wording, You told us, Not checked yet, Your documents don't say |
| 7 | Ask | Suggested chips, mic or text | Answer card (section 4) |
| 8 | Improve your card | Optional strip of remaining questions, value cards ("Cashless only?") | Planner, unlimited, never blocking |
| 9 | Hospital moment | Signed out: helpline, cashless steps, documents list only. After one-tap emergency consent: who, which city, planned or emergency | Network hospitals, cashless steps, insurer contacts from FSS |

Card tiles, fixed order: sum insured left, room rent limit, waiting periods still running (countdown only after portability is answered, else "depends: did you move from another insurer?"), co-pay and deductible, top 3 exclusions for this household, cashless hospitals in your city.

Research consent (optional): one dismissible card after the first answer card, never at sign-up, at most once per 30 days after "Not now", also in settings.

## 3. Question engine

- **Catalogue** (`question-catalogue/v1`): reviewed fixed copy keyed by locale (en now; hi and others only after human translation and legal review). Each item: slot (fact key, member scope), input kind (`yes_no_unsure`, `single_choice`, `multi_choice_chips`, `amount_presets`, `date_presets`, `member_pick`), `why`, followups, `valueOfInformation`, `sensitivity: health | money | none`, `coverageRelevant`.
- **Planner** (deterministic): candidates are `unknown`, `conflicting`, or `extracted_unverified` declaration slots. Score = weight x tile factor x verdict-need. At most 2 before the card, rest in the strip. No re-ask within 30 days of "Not sure". Conflicts become a 2-choice "Which is right?". Minors get coverage questions only. Interest from tile opens is computed per request and never stored.
- **Answers** write `user_declaration` memory rows under `profile_intake` consent with question id and catalogue version. "Not sure" writes no row; it is logged for the 30-day rule.
- **Chat-triggered**: when a verdict depends on a gap, the card shows `depends` plus the catalogue question inline; one tap re-runs the rule.
- **Built**: branch `sqa/question-planner` (catalogue of 12 questions, planner, `recordAnswer`, 18 tests). Red-team changes B1, B6, B9, B10, B13 in progress.

## 4. Chat and answer card

- **Look**: policy switcher and language toggle on top, answer cards in the middle, 3 suggested chips and input row (text, mic, send) at the bottom. Bot replies are answer cards only; no free text bubbles.
- **No streaming before validation (B2)**: the guard runs on the complete draft; the screen shows "Checking your policy..." until the validated card arrives, then reveals it.
- **Feedback**: thumbs; down opens reason chips. "Wrong" on a fact from the own PDF offers "What's the right value?" with presets, which writes a `user_declaration` and re-renders (B8).

### 4.1 `answer-card/v1` (extends chat v1 `answer`; v1 fields kept)

`status` (`evidence_found | unknown | out_of_scope`), `verdict` (`covered | not_covered | partly_covered | depends | unknown`, describing the wording, never a claim outcome), `ruleResultId`, `headline` (<= 90 chars), `explanation` (<= 280), `conditions[]` (kind, text, typed values, `ruleResultId`, `sourceIds`), `sources[]` (`id`, `factIds`, tier, status, page, clause, quote <= 160), `gaps[]`, `actions[]` (<= 3), `followups[]` (<= 3), `speech` (template, <= 25 words), `legalReview`.

### 4.2 Output guard (`features/chat-answer-guard`, one module = A 4.1 + B L6)

| Check | Rule |
|---|---|
| C1 citation_present | headline, each condition and any non-unknown verdict cite an existing source |
| C2 quote_exact | quote is an exact substring of stored clause text |
| C3 number_grounded | every number equals a rendering of a cited fact or rule output (one Indian-format normaliser: lakh, crore, k, words, Hindi number words, months vs years, dates) |
| C4 verdict_rule_backed | verdict other than unknown/depends needs a rule result and must equal it |
| C5 no_outcome_promise | G1 phrases ("will be paid", "pakka") |
| C6 no_advice | G3 purchase/switch/port, G4 medical, G12 tax, G13 legal |
| C7 no_identifier_echo | Aadhaar, PAN, card (Luhn), OTP |
| C8 speech_template | spoken text equals the template from the headline |
| C9 verdict_inputs_verified | covered/not_covered only if every rule input is `user_confirmed` or `reviewed_reference`; else downgrade to `depends` with "Is this right?" (B5) |

Failure: text mode may retry once on C1-C3; voice never retries. Otherwise the fixed unknown card with the insurer helpline and the exact question to ask. Every drop emits a check id, never text. Built on branch `sqa/answer-guard` (in progress).

## 5. Voice on Gnani

Pipeline: push to talk (max 30 s, client VAD, Opus 16 kHz), then BFF, then `POST /api/v1/voice/turns` (ownership + exact voice consent naming Gnani as recipient), then Gnani STT streaming (en-IN, hi-IN, Hinglish), then editable transcript chip row with one "Send" tap, then the same answer pipeline (`input_kind = voice`), then TTS of the template headline only.

- **Processor (B3)**: Gnani receives raw health speech, so it needs a processor-register row, a purpose-registry recipient, India data-residency confirmation and the consent text naming it. No STT call without that grant.
- **Never spoken**: health declarations, member names, conditions. Headline = verdict + at most one amount or date.
- **TTS cache (B7)**: global cache only for strings with no numbers, dates or names (refusals, catalogue prompts, pre-rendered at build time). Personal headlines are synthesised fresh.
- **Efficiency**: push to talk, VAD, confirm-before-send (catches STT errors before a model call), short TTS, circuit breaker to text.
- **Latency targets** (measure on stub first): 1.5 s to transcript, 2.5 s to validated card, 1.0 s to audio.
- **Adapter**: `transcribe` and `synthesize` through the provider boundary with a local stub and opt-in live test; live run needs owner approval.

## 6. Guardrails (input to output)

| Layer | Does |
|---|---|
| L0 edge | auth, ownership, shared rate limit (fails closed), size caps |
| L1 scrubber | masks Aadhaar/PAN/card/OTP, strips control and zero-width text, tags `contains_health` |
| L2 router | closed intent list; refuses only on high-precision patterns (purchase, medical, tax, legal, other person); emergency goes to the fixed card; everything else takes the answer path. Track false-refusal rate (< 2%) |
| L3 retrieval | household-scoped SQL; FSS facts only for held UINs or a named product |
| L4 rules | integer arithmetic over cited facts, each result with an id, every rendering listed |
| L5 model | wording only, into the card schema, via gateway and privacy gate (ADR 0030), temperature 0, no tools |
| L6 guard | section 4.2 |
| L7 watch | `guardrail_events` (ids and codes only), nightly golden + red-team eval, per-rule kill switch |

Never-rules G1-G14 (arch-b 5.1) map to checks and router rules. G7: document text is quoted evidence only; this includes FSS text, which comes from public insurer websites and is untrusted too. The injected-PDF canary corpus must not change behaviour. Free tests: 300+ golden turns (en, Hinglish, hi), injected PDFs, bad-answer stub model. Owner metric: unsupported-claim rate, target 0.

## 7. Memory per person

| Kind | Store |
|---|---|
| Facts | `household_memory_facts`, declarations, premiums (exist) |
| Timeline | **read-time render** from `document_uploads`, `chat_turns`, `memory_conflicts`, `member_declarations` (no new episodes table, R4) |
| Signals | new `person_signals`: values and preferences from taps, feedback and opinions as the user's own sealed words, `unmet_need` and `flow_abandoned` written by code. No model-inferred signals (R5). Plain codes are topic-free; health topics sealed |
| Open questions | derived at read time from gaps and conflicts |
| Semantic index | `memory_chunks` (pgvector, redacted) |

Rendered view: `memory-document.js` (A5) gains "What matters to you" and "Still open". Minors: facts only, no signals, analytics or research rows (R2). Outcomes ("what they got from the insurer") are user-stated signals with an optional settlement letter.

## 8. Storage patterns

| Data | Store |
|---|---|
| Personal rows | PostgreSQL (Supabase), sealed columns, RLS, household-first keys |
| User document bytes | R2/S3 behind `ByteStorage`, app-encrypted envelope |
| Public insurer PDFs | R2 `knowvia-insurance`, readable key `<insurer>/<UIN or unassigned>/<product>__<doc_type>__<sha8>.pdf`, rows in FSS `documents` (sha256 is the id); rekey only after a spot-checked tag pass |
| Product facts | FSS PostgreSQL, cached per UIN version in CoverSaath |
| Vectors | pgvector, same database |
| Events | `app_events` (operational, purged), `analytics_outbox` to PostHog under `analytics` consent; health and money question answers send only `answered: true` (B1) |
| Research | separate `research` schema and role, opt-in purpose, random per-household id in a mapping table, k >= 10 on exports, revocation deletes mapping and rows |

## 9. Scale

Why it holds: expensive parsing is per UIN version, not per user; per-user work is a short schedule plus a few bounded model calls; everything partitions by household; heavy work is queued and idempotent.

Bottlenecks in order: S1 provider limits and cost (priority queue, DB concurrency leases), **shared answer cache for general product questions keyed by (UIN version, catalogue question id), never personal (R10)**, S2 connection pooling, S3 resolver cache per request, S4 monthly partitions for events and turns, S5 pgvector partitioning, S6 single region by design, S7 per-process state to DB leases. Prove with free load stages L0-L2; paid stages wait for the owner. No capacity numbers until measured.

## 10. Pipelines

- **Gathering (FSS, Squad B)**: insurer sites, raw PDFs (4,322 rows, 4,317 unique, all in R2), tags (pass 4 running: the document's own UIN wins over link-page UINs; 2+ distinct products without a 3:1 leader leave the UIN blank, `uin_source = ambiguous_pdf_text`), registry link, catalog-derived products file (`data/products/catalog-derived.csv`, cleaned names only, never overriding a curated UIN). Done, free: real number-format golden set (B12, `insurance-raw-docs/golden/number-formats.jsonl`, 59 cases from 220 PDFs). Running, free: insurer helplines and e-mails by regex (B14, `links/insurer-contacts.csv`). Next, free, waits on O9: text layer with pypdf per page. Paid structuring held.
- **FSS tag quality**: every catalog tag is `extracted_unverified` with its `uin_source`; downstream code treats `link_page`, `sibling_doc_same_product` and `url` UINs as weaker than `pdf_text`. Pass 3 showed link-page UINs wrong on many Kotak, HDFC Life and Canara rows, so CoverSaath must never auto-confirm a user's product from an FSS tag alone.
- **User (CoverSaath, Squad A)**: upload, gate, sanitise, scan, OCR (paid, held), identify, FSS match, one-tap confirm, privacy reduction, memory facts and declarations, planner, card, chat.
- **Feedback**: signals (`feedback`, `unmet_need`, `outcome`) aggregated nightly by code and UIN; top unknowns per product become FSS parse targets.

## 11. Build status (free work only)

| Item | Branch | State |
|---|---|---|
| Document store tables + R2 loader + rekey | FSS `sqb/supabase-store` | built, used for the full upload |
| Question catalogue + planner | CoverSaath `sqa/question-planner` | built, 18 tests; red-team changes in progress |
| Answer card + output guard | CoverSaath `sqa/answer-guard` | in progress |
| Gnani adapter contract + stub | not started | next |
| Beta UI: question screen, card, feedback, mic | Knowvia_website | next, mock adapter first |
| Number golden set (B12) | `insurance-raw-docs` 5a560e2 | done |
| Insurer contacts (B14) | `insurance-raw-docs` | running |
| Tag pass 4 + catalog-derived products | `insurance-raw-docs`, FSS `data/products` | running |
| Text layer | FSS (Squad B) | waits on O9 |

## 12. Owner decisions

O1 paid live E2E (Sarvam OCR + chat model). O2 dev FSS tenant entitled to real products and export/hospital scopes. O3 `research` purpose and notice. O4 `person_signals` table. O5 Gnani as processor (residency, notice). O6 emergency short consent wording. O7 visibility of health declarations between adults before member invites. O8 compare held plans side by side under G3. O9 free text-layer extraction of FSS PDFs. O10 merges to FSS master. Also: Supabase `/mcp` login, roll the R2 token.
