-- Phase 22 (decisions #161–#163): seeing documents.
-- preview_version: the version whose pictures were made (a PDF's first-page thumbnail; an office file's pages printed by
--   LibreOffice), or tried and failed; NULL = never tried, which is what the lazy backfill looks for.
-- preview_pages: how many page pictures that version has (v<N>.page<k>.jpg next to the file; 0 = none).
-- ocr_version: the version whose text came from OCR (the vision model reading a scan; it may contain errors). The item
--   says so while it is still the current version.
ALTER TABLE library_items ADD COLUMN preview_version INTEGER;
ALTER TABLE library_items ADD COLUMN preview_pages INTEGER NOT NULL DEFAULT 0;
ALTER TABLE library_items ADD COLUMN ocr_version INTEGER;
