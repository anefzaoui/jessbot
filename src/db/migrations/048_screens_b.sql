-- Phase 25 part B (decisions #194–#196): what the approval card and the chat's follow-up chips need that wasn't stored.

-- The approval card (#194): the facts a tool lays out beside the preview (JSON [{ key, label, value?, items?: [{ title,
-- meta?, href? }] }]: who an email goes to, the files attached, a picture's shape and model), written by createApproval
-- from the tool's approvalFacts(args); and how outside content marked the run when it asked (none | low | high = some of
-- it addressed AI assistants), so a card in the history keeps the level it was decided under.
ALTER TABLE approvals ADD COLUMN facts TEXT;
ALTER TABLE approvals ADD COLUMN provenance_level TEXT;

-- Follow-up nudges (#196): when a reply last ended with "A few things worth a second look:" in this chat (UTC). The main
-- chat keeps at most one a day: a second within 24 hours is taken out of the reply before it is stored.
ALTER TABLE threads ADD COLUMN last_nudge_at TEXT;
