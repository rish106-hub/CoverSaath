# AI analysis (local rules)

Applies to `src/modules/ai-analysis/`. Root `AGENTS.md` still applies.

- No provider call bypasses `privacy-evidence-gate.js` or the pre-dispatch consent validator. Add a call path only through `model-gateway.js`.
- Source excerpts, OCR text, user fields and upstream outputs stay in the untrusted-evidence section of the prompt (`prompts.js`), never in system or developer instructions.
- Send the smallest excerpt: allowlisted, parameter-matched lines within the existing source and byte caps. Do not raise caps without a privacy review.
- Model output authority is fixed in `src/contracts/ai-authority.js`. Never map model output to proven, calculated or dynamic.
- A prompt, schema, model or provider change bumps its version and reruns `npm run eval:safety` plus the privacy gate tests.
- A refused or undispatched call releases its budget reservation.
- Never log or persist prompts, raw provider responses or unredacted page text. Fixtures are synthetic.
