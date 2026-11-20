-- Phase 22 part E (decisions #157–#160): free time and household busy sharing.

-- Does this occurrence take up the person's time? 0 for events marked free (TRANSP:TRANSPARENT: "show as free", a
-- birthday or a holiday reminder) and cancelled ones (STATUS:CANCELLED). Free-slot finding skips them; everything else
-- (Upcoming, the prompt's "coming up") still lists them. Rows written before this migration count as busy until the next
-- sync (every 15 minutes) rewrites them.
ALTER TABLE calendar_events ADD COLUMN busy INTEGER NOT NULL DEFAULT 1;

-- Consent (#159): "Share when I'm busy with my household". Off by default. When on, people who share a group with this
-- person may see the TIMES they are busy (never titles, places or anything else) when Jess looks for a time that suits
-- everyone (calendar_free_slots with people). Each lookup is written to the audit log (metadata only).
ALTER TABLE users ADD COLUMN share_busy INTEGER NOT NULL DEFAULT 0;
