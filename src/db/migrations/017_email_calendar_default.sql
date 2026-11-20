-- Email and calendar are on for everyone once they connect an account, as "allow": reading runs freely; sending mail
-- and changing events are outward actions, which always ask first (policy.js). An admin's own choice is kept.
UPDATE policies SET toolsets = json_set(toolsets, '$.email', 'allow'), updated_at = datetime('now')
 WHERE subject_type = 'global' AND json_extract(toolsets, '$.email') IS NULL;
UPDATE policies SET toolsets = json_set(toolsets, '$.calendar', 'allow'), updated_at = datetime('now')
 WHERE subject_type = 'global' AND json_extract(toolsets, '$.calendar') IS NULL;
