# Input rules

Applies to `src/features/input/`. Root `AGENTS.md` still applies.

- Treat filenames, PDF bytes, OCR blocks and provider output as untrusted.
- Authorize the case and exact consent before reading request bytes or calling a provider.
- Keep file, page, text, expansion, time, retry and concurrency bounds explicit.
- Keep uploads quarantined until structural inspection, encrypted storage and malware scanning pass.
- Never retry an uncertain provider submission.
- Re-check consent before each disclosure and before persistence.
- Erase stored bytes, OCR pages and derived data after revocation or deletion.
- Keep fixtures synthetic. Never log document bytes, OCR text, storage keys or provider payloads.
