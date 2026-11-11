# ADR 0029: Voice transcripts are stored, sealed and erasable (migration 054)

Status: accepted for the prototype (synthetic data only). Consent, privacy and notice wording here is a draft that is not final and needs legal review before any real user data. Plan: `docs/exec-plans/active/complete.md` section 3.1 (054). Overrides the recommendation of `docs/exec-plans/active/app-data-plan.md` D4 (do not store transcripts): the owner has chosen to store them.

## Context

A household member may ask chat a question by voice. The speech-to-text step happens before the backend (BFF or provider); the backend receives the transcript as the message of a turn.

## Decisions

**D1. The transcript is stored.** A user turn of `input_kind = 'voice'` keeps its transcript in `transcript_enc`, sealed with the same column crypto as every other health or policy text (AAD `chat_turns.transcript_enc.<row id>`). The turn content (`content_enc`) holds the same text for display. A text turn has no transcript (a database CHECK).

**D2. The audio is kept only on purpose.** `audio_document_id` (an active document of the household holding the recording) is stored only when the server runs with `VOICE_AUDIO_RETAIN` exactly `true`. With the flag off, or unset, a supplied audio id is ignored and nothing links the turn to a recording. The database repeats that the field belongs to a user voice turn and checks that the document is the household's.

**D3. Erasable.** Turns are deleted with their thread, which is deleted with the household, its holding, a document or consent the answers rested on, or a removed member (`memory-erasure.js`). Deleting the audio document clears `audio_document_id` (the only permitted update of a turn). Transcripts are never sent to a model except through the household privacy gate with the question text (ADR 0030), and never logged or audited.

**D4. Notice.** The in-app wording that tells the household a voice note is transcribed and kept is not written here. FOR LEGAL REVIEW.

## Known limits

- Speech recognition and its provider are outside this backend (the BFF owns them); no audio reaches it unless the BFF uploads a document.
- A transcript can contain a name or a health detail; it is sealed at rest, redacted before any provider call, and erased with the household.

## Rollback

Expand-only. Revert the code; a synthetic-only project may drop `chat_turns`.
