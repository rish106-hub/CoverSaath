# UI journey plan (run C record)

Status: proposed. Synthetic data only. Wording marked DRAFT needs legal and medical review. Decisions: [ADR 0012](../../adr/0012-ui-journey-bff-and-intake-blocks.md).

## Flow

S00 start (three tiles and Sign in) to S01 emergency card (no sign-in) or S02 sign-in. S01 to S02. S02 to Google to S03 callback (server only), then S04 keep-my-document consent (new user) or S11 dashboard (returning user, state rebuilt). S04 to upload (S05 connect only if more than one real connector). Upload to S08 reading consent (once per batch) to S09 auto-reading, then S11. S11 to S12 chip detail, S14 hospital checklist, S15 permissions, S13 ask a question (paid, optional). Revoking in S15 returns to S11 with derived data erased. Session expiry goes to S02 with reason expired.

## Widgets and the data behind them

| Widget | Data | Source today |
|---|---|---|
| W01 setup progress | document kinds, read state, reading grant | documents list, `GET /households/{id}/consents` (new) |
| W07, W15, W16 | document kinds, stage, page count | documents list |
| W17, W04 | read values and passages | gap: needs read-back routes (D9, U5) |
| W12 | nextAction | document DTO |
| W13 | permissions summary | consent list (new) |
| W14, W09 | static text | none; marked for review |
| W02, W03, W05, W06, W11 | model-backed answers | shown as unknown until an answer exists |

The case list route (new) lets the BFF recover a lost case. No route lists documents across cases.

## Gaps

- No identity route yet (run V1a, migration 017 needs approval).
- No read-back of OCR values or passages (D9, U5).
- No image intake (D10, U10); camera, email forward and voice are stubs.
- Provider TPA helpline and member id are not extracted, so W14 stays a static pointer to the health card.
- No per-household page cap for paid OCR (U9 follow-up).

## Friction to watch

Two consent prompts must stay clear and short. Scanning off means documents wait: the UI must say so without an ETA. Chips never show a number without its state.
