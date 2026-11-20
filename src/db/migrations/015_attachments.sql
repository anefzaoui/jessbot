-- Phase 10 (decision #76): files attached to a message. JSON array of Library public ids, in the order attached.
-- The files themselves are Library items (uploads keep their bytes + extracted text there).
ALTER TABLE messages ADD COLUMN attachments TEXT;
