-- Phase 22 (decision #146): a Library item made from another one keeps a link to it. Today: the PDF or PNG that
-- library_export prints from an HTML page points back at that page (a new export of the same page, format and size
-- becomes a new version of the same item instead of another copy). The link clears if the source is ever removed.
ALTER TABLE library_items ADD COLUMN source_item_id INTEGER REFERENCES library_items(id) ON DELETE SET NULL;
CREATE INDEX library_items_source ON library_items(source_item_id) WHERE source_item_id IS NOT NULL;
