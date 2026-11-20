-- Phase 25 part C (decision #205): the chat card of a consent request (#191) answers Yes / No with a tap, so the note must
-- know which request it carries. reminder_posts rows of kind 'consent_request' written from now on hold it; older ones
-- (NULL) show no buttons, and the person still answers in words as before.
ALTER TABLE reminder_posts ADD COLUMN consent_id INTEGER REFERENCES reminder_consents(id) ON DELETE CASCADE;
CREATE INDEX reminder_posts_consent ON reminder_posts(consent_id) WHERE consent_id IS NOT NULL;
