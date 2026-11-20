-- Phase 18 (decisions #121–#123).
-- Skill review: what the admin approved, kept so "changed since you approved it" can show a line diff. approved_body is
-- the approved SKILL.md exactly as it was (front matter included); approved_files maps every file in the skill's folder
-- to its SHA-256 at approval ({"SKILL.md": "…", "examples.md": "…"}), so a changed supporting file can be named.
-- Approvals made before this migration keep NULL here until they are re-pinned (services/skills.js, #122).
ALTER TABLE skills ADD COLUMN approved_body TEXT;
ALTER TABLE skills ADD COLUMN approved_files TEXT;

-- Off-the-record chats (#123): no memory is extracted or flushed from a thread while no_memory = 1. no_memory_upto is the
-- newest message id written while it was off the record (set when it goes back on the record), so that stretch is never
-- extracted later either.
ALTER TABLE threads ADD COLUMN no_memory INTEGER NOT NULL DEFAULT 0;
ALTER TABLE threads ADD COLUMN no_memory_upto INTEGER;

-- Skill usage counts (use_skill calls per skill) read tool results by tool name.
CREATE INDEX messages_tool_name ON messages(tool_name, created_at) WHERE tool_name IS NOT NULL;
