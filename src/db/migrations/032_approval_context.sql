-- What an approval card needs so the person decides with the facts (Phase 18, decisions #124–#127, docs/SECURITY.md):
-- where the idea came from, why it asks when it normally wouldn't, secret-looking things in what would be sent, whether
-- it can be undone, and who it reaches. All nullable: older rows simply show none of it.
ALTER TABLE approvals ADD COLUMN provenance TEXT;  -- "Suggested after reading: email from Ann <a@x> · “Invoice” · page on example.com"
ALTER TABLE approvals ADD COLUMN ask_reason TEXT;  -- why it asks although a grant or the policy would have let it run
ALTER TABLE approvals ADD COLUMN flags TEXT;       -- JSON [{ kind, label, masked }] from lib/dlp.js (never the secret itself)
ALTER TABLE approvals ADD COLUMN undoable INTEGER; -- 1 can be undone, 0 can't, NULL unknown
ALTER TABLE approvals ADD COLUMN undo_note TEXT;   -- "an email can't be recalled once it's sent"
ALTER TABLE approvals ADD COLUMN reach TEXT;       -- "only you", "the Family group", "sam@example.com", "the website example.com"
