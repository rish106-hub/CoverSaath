# ADR 0035: Sanitise active PDF content, gate non-insurance PDFs at upload

- Status: Proposed. Not independently reviewed. (The brief named 0034; that number was already taken by `0034-fss-insurer-tier.md`.)

**Context.** Until now an upload with JavaScript, actions, embedded files or form scripts was rejected (`PDF_ACTIVE_CONTENT`), and any PDF reached storage and OCR regardless of subject, which costs money on non-insurance files. Owner decisions on 2026-11-14: (a) non-insurance PDFs are rejected at upload; (b) active content is sanitised, not rejected.

**Decision.**
1. Sanitise. When inspection raises `PDF_ACTIVE_CONTENT`, a restricted child (same Node permission model, empty env, heap cap and timeout as the inspector; reads only its code and pdf-lib) rebuilds the file with pdf-lib: a new document with the pages copied, so catalog `/OpenAction`, `/AA`, `/Names` (`/JavaScript`, `/EmbeddedFiles`), `/AcroForm`, `/XFA`, `/Perms` and orphaned objects are dropped. Per page: `/AA` removed; annotation `/A`, `/AA` and `/Dest` stripped (so `/URI`, `/Launch` and GoTo actions go); file, sound, movie, screen, rich-media and 3D annotations dropped. The output must pass the existing inspector, otherwise the upload is rejected. Only the rebuilt bytes are hashed, stored and sent on; the original is never stored. The audit event `document.uploaded` carries `sanitised: true` and category labels in `removed` (no migration). Encrypted or unparseable files keep their existing codes. Outlines, metadata and named destinations are lost.
2. Gate. After sanitising, a second restricted child reads the text layer of the first 3 pages (existing extractor) and counts distinct insurance signals plus a UIN-shaped token (weight 3). A text layer of at least 40 characters scoring below 3 is rejected with `NOT_INSURANCE_DOCUMENT` (422). No text layer, undecodable text or thin text passes; OCR-time classification stays.

**Consequences.** Upload costs one more short child run for every PDF (the gate) and a second for active files (the sanitiser). Keyword scoring is crude: an insurance file with very sparse first-page text could be refused, and a non-insurance file full of insurance words passes. Thresholds are untuned on real documents. ClamAV `MALWARE_DETECTED` still blocks and is unchanged (follow-up: decide whether a sanitised file needs a different scan policy).

**Alternatives rejected.** Reject active content (owner decision); strip in place with an incremental update (leaves the original bytes live); run the gate in the API process (untrusted parsing, ADR 0005).
