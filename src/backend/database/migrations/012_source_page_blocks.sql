-- Stored OCR blocks (ADR 0006 addendum, knowvia.ocr.v2). Expand-only.
-- blocks_json holds a page's validated layout blocks (index, tag, reading order, text, table rows)
-- and is written once with the page. NULL means the page has no stored blocks (v1 pages, erased pages).
-- The application validator (src/modules/document-intake/ocr-blocks.js) owns the shape; the CHECK
-- bounds validity and size. The only permitted change after insert is erasure to NULL.

ALTER TABLE source_pages ADD COLUMN blocks_json TEXT CHECK (
  blocks_json IS NULL OR (json_valid(blocks_json) AND json_type(blocks_json) = 'object' AND length(blocks_json) <= 1000000)
);

-- Blocks are stored only with page text, and never for a document whose erasure has started.
CREATE TRIGGER source_pages_blocks_insert
BEFORE INSERT ON source_pages
WHEN NEW.blocks_json IS NOT NULL AND (
  NEW.extracted_text IS NULL
  OR EXISTS (
    SELECT 1 FROM document_uploads document
    WHERE document.id = NEW.document_upload_id AND document.lifecycle_state IN ('deletion_requested', 'deleted')
  )
)
BEGIN
  SELECT RAISE(ABORT, 'source page blocks require page text and a live document');
END;

CREATE TRIGGER source_pages_blocks_immutable
BEFORE UPDATE OF blocks_json ON source_pages
WHEN NEW.blocks_json IS NOT NULL AND (OLD.blocks_json IS NULL OR NEW.blocks_json <> OLD.blocks_json)
BEGIN
  SELECT RAISE(ABORT, 'source page blocks are immutable; only erasure may clear them');
END;

-- Safety net: blocks never outlive their page text. Revocation and document erasure redact page
-- text; this clears the blocks in the same statement even if a caller forgets to.
CREATE TRIGGER source_pages_blocks_erase_with_text
AFTER UPDATE OF extracted_text ON source_pages
WHEN NEW.extracted_text IS NULL AND NEW.blocks_json IS NOT NULL
BEGIN
  UPDATE source_pages SET blocks_json = NULL WHERE id = NEW.id;
END;

-- Safety net: blocks never outlive a document deletion request or consent revocation.
CREATE TRIGGER source_pages_blocks_erase_on_document_erasure
AFTER UPDATE OF lifecycle_state ON document_uploads
WHEN NEW.lifecycle_state IN ('deletion_requested', 'deleted')
  AND OLD.lifecycle_state NOT IN ('deletion_requested', 'deleted')
BEGIN
  UPDATE source_pages SET blocks_json = NULL WHERE document_upload_id = NEW.id AND blocks_json IS NOT NULL;
END;
