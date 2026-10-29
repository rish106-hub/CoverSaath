# Demo UI for the landing-page video (scope and plan)

Status: **PROPOSED. Nothing built.** Created 2026-10-29. Builds on [block5-frontend-audit.md](block5-frontend-audit.md) and [block5-decisions.md](block5-decisions.md) (D1 to D9 still OPEN). Risk class: security-sensitive (a browser path to consent and document APIs) and consent-sensitive (consent copy on screen). Synthetic data only.

## 1. Outcome

A comprehensive UI over this backend that can be driven end to end, deterministically, on a laptop, and recorded as:

- a 60 to 90 second hero cut for the landing page, and
- an optional 3 to 4 minute walkthrough.

The video must show what makes CoverSaath different, not just screens: **consent per purpose, cited answers with visible uncertainty, and revoke-then-erase proof.**

## 2. Non-goals

- A public, hosted, multi-user app. D1 (identity), D2 (topology) and D7 (legal) are open; none of that is needed to record a video.
- Real policies, real people or real provider output in the recording.
- Coverage verdicts. Evidence-first rule: answers are cited and conditional, model fields stay `extracted_unverified`, `conflicting` or `unknown` (ADR 0008).
- Any weakening of the host/origin guard, a CORS allowance, or a demo shortcut inside production code paths.

## 3. Facts that shape the plan

| Fact | Consequence |
| --- | --- |
| API refuses non-loopback `Host` and any browser `Origin` but the dev one; no CORS (`src/shared/http/security.js`) | UI must go through a server-side BFF on the same host. |
| A BFF with sealed cookies, CSRF checks and tests already exists on `Knowvia_website-block5` branch `block5/app` (39 uncommitted files, provisional) | Reuse it; it must be committed and reviewed first (D8). |
| Design artboards O1 to O7, tokens and the landing page live in `Knowvia_website*` (Next 16, React 19). All onboarding screens are static mocks today | UI home is the website repo (D9 recommendation). A `src/ui` in this repo is rejected by `check:architecture`. |
| No routes to list cases or grants, read OCR text or clauses, serve PDF bytes, invite members, or log in | Demo state is held by the BFF cookie and a seed script; citation view is "page and quote sheet" (D4). Gaps are listed on screen as "coming", never faked. |
| Gemini was out of prepaid credit on 2026-10-28 (HTTP 402); Sarvam OCR works but costs money and varies per run | A video cannot depend on live providers. See section 5. |
| clamd is required for an upload to reach `accepted`; with scan disabled it stays `received_pending_checks` | Demo harness must run clamd ([clamav runbook](../../runbooks/clamav.md)). |
| The only real policy used for evals is gitignored under `.local/eval/` | Never appear in a recording. Demo uses generated synthetic policy PDFs. |

## 4. Storyboard (maps UI to backend, so every scene is backed by a real call)

| # | Scene | Screen | Backend | Invariant it shows | ~sec |
| --- | --- | --- | --- | --- | --- |
| 1 | "Start" | O1 start, sign-in (dev identity, labelled demo) | `POST /households` via BFF | token never reaches the browser | 5 |
| 2 | People and what we share | O3, O4 | `GET /households/{id}`, `POST /consents` | consent is per purpose, in plain language | 10 |
| 3 | Add a policy | O5 upload (synthetic PDF) | `POST /cases/{id}/documents` | state `received_pending_checks` then `accepted` after scan | 10 |
| 4 | Reading | O6 progress | `POST /documents/{id}/ocr-jobs`, structuring run, `GET /jobs/{id}` | OCR refused without its own consent (show the refusal once) | 10 |
| 5 | Your cover | O7 matrix | `POST /households/{id}/coverage-preview` | gaps and "unknown" shown, no verdict | 15 |
| 6 | Ask a question | question box, answer with chips | `POST /cases/{id}/questions` | citation to page and quote; `extracted_unverified` chip | 15 |
| 7 | Privacy center | consent ledger, deletion inventory, audit timeline | `GET .../deletion-inventory`, `GET .../audit-events` | what is held, by whom, until when | 10 |
| 8 | Revoke | one switch | `POST /consents/{id}/revoke` | document and derived text erased; in-flight work stopped; audit event added | 10 |
| 9 | Developer lens (toggle, hero cut shows 2 s of it) | side panel | BFF request log | method, path, status, coded error; no tokens or bodies | 5 |

## 5. Decisions needed from the owner

1. **UI home**: `Knowvia_website` `/app` route group over the existing BFF (recommended) or a new `apps/demo` in this repo (needs an ADR).
2. **Provider mode for the recording** (recommended: **replay**). A local stub that speaks the Gemini wire format, pointed at via configuration, with recorded synthetic answers. No production code changes, no privacy-gate bypass, consent flow still real. Live Gemini would need a top-up and gives non-repeatable takes. Needs verification that the model adapter accepts a base-URL override (S1 spike).
3. **Deliverable**: video only (about 2 weeks) or video plus an interactive "try it" on the landing page (needs D1, D2, D7 first and hosting).
4. **Developer lens** in or out of the hero cut.

## 6. Slices

Each slice is one reviewable change with its own checks. Estimates are low confidence, solo, and unmeasured.

| Slice | Work | Acceptance evidence | Est. |
| --- | --- | --- | --- |
| S0 | Decide section 5. Commit or stash the dirty website branch (D8), branch from clean. Update `LATEST.md`. | decisions recorded; clean base | 1 to 2 d |
| S1 | Demo harness: seed script (synthetic household, 2 to 3 synthetic policy PDFs generated with `pdf-lib`), reset script, one command to start backend + clamd + stub provider. Spike: stub provider via base URL | three resets give identical state and screens; no real data; `gitleaks` clean | 3 to 5 d |
| S2 | BFF review and fixes: commit `block5/app`, independent security review, per-demo state in cookie, honest "not available yet" responses | BFF tests pass; reviewer sign-off (required: security change) | 3 to 5 d |
| S3 | Wire O1 to O7: sign-in, consent, upload, reading, cover matrix. Regenerate from artboards, never hand-edit generated files | Playwright journey passes against the real backend; refusal paths shown | 1 to 2 wk |
| S4 | Question answer with citation sheet and uncertainty chips; empty and error states | cited answer from replay; uncertainty states render; copy marked draft for legal | 1 wk |
| S5 | Privacy center: consent ledger, revoke, deletion inventory, audit timeline | revoke journey leaves no document or derived text; audit event visible; test fails first | 1 wk |
| S6 | Developer lens (redacted request log) | no token, body or id leaks in the panel; unit test on the redactor | 3 to 4 d |
| S7 | Motion, accessibility (keyboard, contrast, reduced motion), scripted takes, record 16:9 and 9:16, captions, "synthetic data" label | scripted run reproducible; secrets scan of frames and logs; owner review | 1 wk |

**Fast path for the video only**: S0, S1, S2, S3 (cover matrix), S5 (revoke) and S7 is about 2 to 3 weeks. Full set is about 5 to 7 weeks.

## 7. Risks

| Risk | Mitigation |
| --- | --- |
| Video overstates what the product does (D7: "Files are encrypted", "we will email you", "17 days", "Page 2, line 4") | Remove or soften claims the backend cannot back; label the clip "synthetic demo"; legal review before publishing. |
| Recording leaks a secret (env, token, project URL) | Dedicated demo env with throwaway keys, Developer lens redaction, frame scan before publish. |
| Demo diverges from the real API | Scenes call real routes; replay only substitutes the provider. Missing features are shown as missing. |
| Backend gaps tempt shortcuts (list grants, OCR text) | Hold state in the BFF; add backend routes only as separate reviewed work. |
| Stub provider hides a real Gemini failure | State in the video notes and `LATEST.md` that answers were replayed. |
| Scope creep into a product UI | Section 2 non-goals; S3 to S7 gated on the storyboard. |

## 8. Checks

`npm run check`, `npm run eval:safety`, `git diff --check` in this repo; website repo `npm test` and the BFF bundle-secrets check; `gitleaks git .` in both; independent read-only review for S2, S4 and S5 (security, consent, AI).

## 9. Unverified

Gemini base-URL override; clamd availability on the recording machine; current state of `block5/app` versus `main`; whether `coverage-preview` output is rich enough for scene 5 without a live model.
