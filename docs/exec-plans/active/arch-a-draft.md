# Architecture v1, Squad A draft: journey, chat, voice, response structure

Status: draft for red-team by Squad B, then owner review. Not accepted. Consent, privacy and on-screen wording here is FOR LEGAL REVIEW. No paid provider run was used to write this.

Builds on: target flow (`docs/architecture/target-flow-2026-11-14.md`), memory layer (ADR 0023, 0031, 0032), voice transcripts (ADR 0029), analytics outbox (ADR 0033), chat v1 (`src/contracts/chat.js`, statuses `evidence_found | unknown | out_of_scope`), voice prefill (`src/contracts/voice-intake.js`), beta flow (Knowvia_website `/beta`: start, upload, processing, product, declarations, card, chat).

## 0. Design rules (apply to every screen)

1. **Tap first, type last.** Every question has buttons. Typing is the fallback, never the default.
2. **One decision per screen.** A screen asks one thing, shows one primary button, and shows how many are left ("2 of 5").
3. **"Not sure" is always an answer.** It is stored as `unknown`, never guessed, and never blocks the user.
4. **Every claim is one tap from its source.** Page, clause, and a quote of at most 160 characters.
5. **The model never decides.** Deterministic code picks the next question, computes the verdict and checks the citations. The model only drafts wording inside a fixed card, and drafts are thrown away if they fail checks.
6. **Fixed copy for questions.** Questions come from a reviewed catalogue (`question-catalogue/v1`), not from the model. That is what keeps them legal-reviewable and the same for every user.
7. **No defensive copy.** No "sample", "draft" or "this is not advice" banners (owner rule). Status badges say where a fact came from instead.

## 1. Journey (minimum effort, mostly clicks)

Target: policy card on screen within 60 seconds of upload, at most 5 taps of questions before the card, everything else later and optional.

| # | Screen | What the user does | What the system does | Taps |
|---|---|---|---|---|
| 1 | Start | Tap "Upload policy" (PDF or photo). Second button: "I'm in hospital now" goes to screen 9 | Opens consent sheet once: what is read, why, how to delete (FOR LEGAL REVIEW) | 2 |
| 2 | Checking file | Nothing; three-step progress: "Checking file", "Finding your insurer", "Reading your cover" | Insurance-PDF gate (reject non-insurance at once, 422), sanitise active content, scan, OCR | 0 |
| 3 | Is this your product? | Card: insurer, product name, UIN. Buttons: "Yes", "No, show others" | UIN, insurer and product extracted, matched in FSS. Exact UIN match means this screen is skipped | 0-1 |
| 3b | Pick product | Up to 3 product cards from FSS search, plus "None of these" | "None" opens a single text field for a name fragment (max 80 chars, never document text) | 1 |
| 4 | Who is covered | Chips of names from the schedule, each "Correct" by default, tap to fix relationship | Members from own PDF, `extracted_unverified` until confirmed | 0-2 |
| 5 | Questions (max 5) | One question per screen with chips (see section 2) | Question planner picks the highest-value unknowns | 5 max |
| 6 | Policy card | Read. Tap any tile for its source | Card from memory resolver (ADR 0023 D3) | 0 |
| 7 | Ask | Suggested question chips, or mic, or type | Chat v2 answer cards (section 4) | 1 |
| 8 | Later questions | A small "3 more questions improve your card" strip, never a blocker | Remaining unknown slots | optional |
| 9 | Hospital moment | "Who is admitted?" chips, "Which city?" chips (from profile) plus search, "Planned or emergency?" | Network-hospital check, cashless steps, documents list, insurer helpline from FSS | 3-4 |

### 1.1 Policy card (screen 6), fixed tiles in this order

1. Sum insured left (amount, and "for whom").
2. Room rent limit (amount per day or "no limit").
3. Waiting periods still running (each as a countdown: "Knee surgery covered from 12 Mar 2027").
4. Co-pay and deductible.
5. Top 3 exclusions that apply to this household (ranked by the household's declarations, not by the wording order).
6. Cashless: network hospital count in your city, "Find hospital" button.

Each tile carries one status badge: **From your policy** (own PDF), **From insurer wording** (FSS, reviewed reference), **You told us** (declaration), **Not checked yet** (extracted_unverified), **Your documents don't say** (unknown). A conflict shows both values and one button: "Which is right?" (opens a 2-choice question).

## 2. The question engine (when the model asks the user)

The "model asking questions" is a deterministic planner over memory gaps, not a free-form chat.

### 2.1 Question catalogue item (`question-catalogue/v1`)

```json
{
  "id": "ped.has_any",
  "slot": { "factKey": "declaration.ped.any", "memberScope": "dependent" },
  "prompt": { "en": "When you bought this policy, did you tell the insurer about any illness anyone had?", "hi": "..." },
  "why": { "en": "Illnesses you told them about have their own waiting period.", "hi": "..." },
  "input": { "kind": "single_choice", "options": ["yes", "no", "not_sure"] },
  "followups": { "yes": ["ped.which_conditions"] },
  "perMember": true,
  "valueOfInformation": { "unlocksTiles": ["waiting_periods", "exclusions"], "weight": 0.9 },
  "legalReview": "pending"
}
```

Input kinds, all tap-first: `yes_no_unsure`, `single_choice` (max 5 options + "not sure"), `multi_choice_chips` (top 8 + "other"), `amount_presets` (4 presets + "other amount"), `date_presets` ("this year", "last year", "2-4 years ago", "longer", "not sure"), `member_pick`.

### 2.2 Planner (deterministic)

1. Read the resolved memory slots (ADR 0023 D6).
2. Candidates = catalogue items whose slot is `unknown` or `conflicting`, or `extracted_unverified` with a declaration-primary fact class.
3. Score = weight x (tiles it unlocks that the user has opened or that are on the card) x (1 if it can change a verdict the user asked about, else 0.5). Ties break by catalogue order.
4. Never ask the same slot twice in 30 days after "not sure". Never more than 5 before the card. Never a question whose answer the own PDF already holds with status `extracted_unverified` unless the user opened that tile (then ask "Is this right?" with the value shown, yes/no).
5. Every answer writes one `user_declaration` memory row under the `profile_intake` consent grant (ADR 0023 D4), with `question_id` and catalogue version for audit.

### 2.3 Chat-triggered questions

When a user asks "Is my knee surgery covered?" and the verdict depends on a gap (for example when the knee problem started), the answer card shows the partial verdict and one inline question chip row ("When did the knee problem start?" with date presets). Tapping one re-runs the verdict. The model never invents that question; the rule that needs the slot names the catalogue id.

## 3. Chatbot look

- **Layout.** Top: policy switcher (one policy in MVP) and language toggle (English, Hindi). Middle: answer cards. Bottom: 3 suggested-question chips, then the input row: text field, mic button, send.
- **Suggested chips** come from a fixed list ranked by what this household is likely to need (card tiles with unknowns first, then the hospital moment, then common questions). The model does not write them.
- **Answer card** (section 4) is the only thing a bot reply can be. No free text bubbles, no markdown from the model.
- **Streaming.** The headline renders first (from `meta` + first `delta`), the body fills in, sources and actions appear on `answer`. If the final check drops the draft, the card switches to the "documents don't say" form; it never shows a half answer.
- **Feedback.** Every card: thumbs up/down. Down opens reason chips: "Wrong", "Didn't answer my question", "Hard to understand", "Missing my situation", optional text. Stored as a feedback event (section 6).
- **Unknown is a useful answer.** "Your documents don't say. Ask your insurer:" plus a call button with the insurer's helpline from FSS and the exact question to ask, pre-written.

## 4. Response structure (`answer-card/v1`, extends chat v1 `answer` event)

Backward compatible: v1 fields `status`, `answer`, `sources` stay; new fields are added. The server builds the card; the model fills only `draft.headline`, `draft.explanation`, `draft.conditions[].text`, each tied to source ids.

```json
{
  "contract": "answer-card/v1",
  "status": "evidence_found",
  "verdict": "partly_covered",
  "headline": "Covered after 2 years, up to Rs 50,000",
  "explanation": "Knee replacement is in the list of treatments with a 2-year wait. Your wait ends on 12 Mar 2027.",
  "conditions": [
    { "kind": "waiting_period", "text": "2-year wait for listed surgeries", "days": 730, "endsOn": "2027-03-12", "sourceIds": ["s1"] },
    { "kind": "sublimit", "text": "Up to Rs 50,000 per knee", "amountMinor": 5000000, "sourceIds": ["s2"] }
  ],
  "sources": [
    { "id": "s1", "tier": "ida_wording", "status": "reviewed_reference", "page": 12, "clause": "4.2(b)", "quote": "..." },
    { "id": "s2", "tier": "own_pdf", "status": "extracted_unverified", "page": 3, "clause": null, "quote": "..." }
  ],
  "gaps": [ { "questionId": "condition.started_on", "reason": "changes_verdict" } ],
  "actions": [
    { "kind": "answer_question", "label": "When did the knee problem start?", "questionId": "condition.started_on" },
    { "kind": "find_hospital", "label": "Find a cashless hospital" }
  ],
  "followups": ["What documents do I need?", "Is physiotherapy covered?"],
  "speech": { "lang": "en", "text": "Covered after two years, up to fifty thousand rupees." },
  "answer": "...v1 text, same as headline + explanation...",
  "legalReview": "pending"
}
```

Verdict values: `covered`, `not_covered`, `partly_covered`, `depends` (a gap changes it), `unknown`. Verdict comes from `features/insurance-rules` when a rule exists; otherwise only `unknown` or `depends` are allowed with a model draft.

### 4.1 Server checks before a card is released (fail closed)

1. Every `conditions[]` and the `headline` cite at least one source id that exists.
2. Every quote is an exact substring of the stored clause or page text (normalised whitespace), max 160 chars.
3. Every number in headline or explanation (money, days, percent, dates) appears in a cited source or is computed by a rule (for example `endsOn` from start date + days). Unmatched number means the draft is dropped.
4. Verdict matches the rule output when a rule exists. Model text that contradicts it (for example "covered" when the rule says `not_covered`) means the draft is dropped.
5. `speech.text` max 25 words, generated from the headline by a template, not by the model.
6. Drop means: status `unknown`, the fixed "documents don't say" card, the insurer helpline action, and an internal `answer_dropped` event with the failed check id (no text logged).

This is where Squad B's guardrails plug in (their section 5). Section 4.1 is the output side; the privacy gate and consent checks are the input side.

## 5. Voice agent on Gnani (efficient, consented, no paid run yet)

Today `src/integrations/gnani/voice-provider.js` is a refuse-only stub (role: consented transcription and read-back; calling and transfer not verified). ADR 0029 stores transcripts sealed and erasable; audio is kept only if `VOICE_AUDIO_RETAIN` is exactly `true`.

### 5.1 Turn pipeline

```
mic (push to talk, max 30 s, client VAD trims silence, Opus 16 kHz mono)
  -> BFF /api/beta/voice (session cookie, size cap 512 KB)
  -> CoverSaath POST /api/v1/voice/turns (ownership + exact voice consent re-checked)
  -> Gnani STT (streaming, language hint from toggle: en-IN | hi-IN, Hinglish allowed)
  -> partial transcript shown live; final transcript shown as an editable chip row:
       [ "is my mother's knee surgery covered" ]  [Send] [Edit]
  -> same chat v2 pipeline as text (section 4), input_kind = 'voice'
  -> answer card on screen; speech.text sent to Gnani TTS
  -> TTS audio cached by sha256(text + voice + lang), 7 days, no user data in the key
```

### 5.2 Why this is efficient

- **Push to talk, not always listening.** No idle streaming cost and no accidental capture.
- **Client VAD.** Removes silence before upload, about 30-50% less audio to transcribe (to be measured).
- **Confirm before answer.** One tap "Send" after the transcript. It catches STT errors before they cost a model call, and the user sees what was heard.
- **Speak only the headline.** At most 25 words of TTS; sources and conditions stay on screen. Cheaper and faster than reading the full card.
- **TTS cache.** Common headlines ("Your documents don't say...") repeat across users and are cached by text hash.
- **Voice prefill for forms.** The hospital moment accepts one sentence ("my mother is admitted in Pune") and fills `relationship`, `hospital_city`, `event_kind` chips (`voice-intake/v0`, all `extracted_unverified`) for one-tap confirmation.
- **Circuit breaker.** Same pattern as the FSS client: after repeated Gnani failures the mic button greys out with "Type instead" and the text path keeps working.

### 5.3 Latency budget (targets, to measure on a free stub first)

| Step | Target |
|---|---|
| Release mic to final transcript | 1.5 s |
| Send to first headline token | 2.5 s |
| Answer to TTS audio start | 1.0 s |

### 5.4 Adapter contract to build now (no paid call)

`transcribe({ authorization, audio, lang }) -> { transcript, lang, durationMs, provider: 'gnani' }` and `synthesize({ authorization, text, lang, voice }) -> { audio, mime }`, both through the existing provider boundary (privacy gate, consent, budget). Tests use a local stub server. A live test is opt-in (`test:gnani-live`, like `test:sarvam-live`), owner approval needed to run.

## 6. Events the journey emits (input to Squad B's storage design)

Every tap above emits one event through the analytics outbox (ADR 0033), only under an analytics consent purpose, with no free text and no document content:

`journey_step_viewed`, `question_shown`, `question_answered` (option id, not free text), `question_skipped`, `not_sure_chosen`, `tile_opened`, `source_opened`, `answer_shown` (verdict, status, check outcome), `answer_dropped` (check id), `feedback_given` (thumb, reason chip ids), `voice_turn` (duration bucket, lang, edited before send yes/no), `hospital_moment_started`, `helpline_tapped`.

Free-text feedback and opinions are a separate sealed store under their own consent purpose (Squad B to design). Values and preferences the user states (for example "I prefer cashless only") become `user_declaration` memory rows through catalogue questions, not inferred by the model.

## 7. Build plan, free only (Squad A)

1. `src/contracts/answer-card.js`: schema + validator + tests (pure, no provider).
2. `src/features/chat-answer-guard/`: the section 4.1 checks, golden tests from the live-run failures (19 of 20 expected-unknown answered anyway in the 2026-11-14 run, `docs/audits/2026-11-14-live-run.md`).
3. `src/contracts/question-catalogue.js` + 12 starter questions (members, PED, prior claims, other cover, city, hospital preference) + planner with tests.
4. Gnani adapter contract + local stub + tests (section 5.4).
5. Knowvia_website `/beta`: question screen component (chips), answer card component, feedback chips, mic button wired to the stub. Mock adapter first (owner rule: every backend change ships with a beta counterpart).

## 8. Open for red-team (Squad B, please attack these)

1. Is a 5-question cap before the card too many or too few for value?
2. Planner scoring uses tiles the user opened: is that a privacy problem (behaviour drives questions)?
3. Showing member names from the own PDF on screen 4: masking needed?
4. TTS cache keyed by text hash: can a headline ever contain personal data (amounts plus dates)? If yes, cache per household or not at all.
5. Section 4.1 check 3 (every number must appear in a source) may drop correct answers with computed numbers. Is the rule list enough?
6. Hindi: catalogue wording needs a human translator and legal review; machine translation is not acceptable for consent text.
