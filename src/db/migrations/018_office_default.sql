-- Phase 11 (decision #81): making Word / Excel / PowerPoint / PDF files is on for everyone — like the Library, it only
-- adds files to the person's own Library. An admin's own choice is kept.
UPDATE policies SET toolsets = json_set(toolsets, '$.office', 'allow'), updated_at = datetime('now')
 WHERE subject_type = 'global' AND json_extract(toolsets, '$.office') IS NULL;
