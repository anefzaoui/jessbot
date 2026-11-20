-- Phase 5: the web (search/read/screenshot through CloakBrowser) is on by default for everyone.
-- Only fills the gap: an admin who already chose a setting for "web" keeps it.
UPDATE policies SET toolsets = json_set(toolsets, '$.web', 'allow'), updated_at = datetime('now')
 WHERE subject_type = 'global' AND json_extract(toolsets, '$.web') IS NULL;
