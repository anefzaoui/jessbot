// Phase 22 (decisions #190–#193): reminders that follow up until they're done, and muted words in the Feed.
// JS rather than SQL for one reason: feed_mutes.kind must also allow 'word', and SQLite can't alter a CHECK. The table is
// rebuilt from its OWN current definition (sqlite_master) with only that list changed, like migrations 034 and 046.
export const foreignKeys = false; // the 12-step rebuild (docs/DATABASE.md): FKs off around it, foreign_key_check after

export async function up({ exec, get, all }) {
  exec(`
-- Follow-ups (#190): a reminder can keep nudging, gentler to firmer, until the person says it's done. NULL follow_every_min =
-- an ordinary reminder (posts once). Each occurrence starts at occurrence_at (its first post); repeating ones reset these
-- columns when they roll to their next occurrence.
ALTER TABLE alarms ADD COLUMN follow_every_min INTEGER;                              -- minutes between nudges (5–240)
ALTER TABLE alarms ADD COLUMN follow_max INTEGER;                                    -- nudges after the reminder (1–12)
ALTER TABLE alarms ADD COLUMN follow_until TEXT;                                     -- 'HH:MM' local, or '+N' minutes after it
ALTER TABLE alarms ADD COLUMN follow_count INTEGER NOT NULL DEFAULT 0;               -- nudges sent this occurrence
ALTER TABLE alarms ADD COLUMN occurrence_at TEXT;                                    -- UTC ISO of this occurrence's first post
ALTER TABLE alarms ADD COLUMN last_post_msg_id INTEGER;                              -- a reply after this message can confirm it
ALTER TABLE alarms ADD COLUMN escalate_to INTEGER REFERENCES users(id) ON DELETE SET NULL; -- a household member told if unconfirmed
ALTER TABLE alarms ADD COLUMN escalated_at TEXT;
ALTER TABLE alarms ADD COLUMN closed_how TEXT;                                       -- card|chat|tool|stop|unconfirmed|early

-- Every message a reminder posted (the reminder, each nudge, an escalation, a consent request): which chat reply belongs
-- to which reminder (the Done button on its card), and how many times it has spoken.
CREATE TABLE reminder_posts (
  id         INTEGER PRIMARY KEY,
  alarm_id   INTEGER REFERENCES alarms(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,                 -- whose chat it was posted in
  run_id     INTEGER REFERENCES runs(id) ON DELETE SET NULL,
  message_id INTEGER,
  kind       TEXT NOT NULL CHECK (kind IN ('reminder', 'follow_up', 'escalation', 'consent_request')),
  level      INTEGER NOT NULL DEFAULT 0,                                              -- 0 = the reminder, 1.. = nudge number
  posted_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX reminder_posts_alarm ON reminder_posts(alarm_id, id);
CREATE INDEX reminder_posts_run ON reminder_posts(run_id);

-- Escalation consent (#191): a household member agrees, in their own chat or with a tap, to be told when this person
-- doesn't confirm a reminder. Asked once per pair; only the person asked can answer (or change their answer later).
CREATE TABLE reminder_consents (
  id           INTEGER PRIMARY KEY,
  from_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,               -- whose reminders
  to_user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,               -- who would be told
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'granted', 'declined')),
  asked_at     TEXT NOT NULL DEFAULT (datetime('now')),
  answered_at  TEXT,
  UNIQUE (from_user_id, to_user_id),
  CHECK (from_user_id != to_user_id)
);
CREATE INDEX reminder_consents_to ON reminder_consents(to_user_id, status);
`);

  // ---- feed_mutes.kind gains 'word' (#193) ------------------------------------------------------------------------------
  const table = get(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'feed_mutes'`);
  const check = /CHECK\s*\(\s*kind\s+IN\s*\(([^)]*)\)\s*\)/i;
  const m = check.exec(table?.sql || '');
  if (!m) throw new Error('feed_mutes has no kind CHECK where one was expected — not rebuilding blindly.');
  if (/'word'/.test(m[1])) return;
  const newSql = table.sql.replace(check, `CHECK (kind IN (${m[1].trim()}, 'word'))`)
    .replace(/^CREATE TABLE\s+("?)feed_mutes\1\s*\(/i, 'CREATE TABLE feed_mutes_new (');
  if (!newSql.startsWith('CREATE TABLE feed_mutes_new (')) throw new Error('Unexpected feed_mutes definition.');
  const extras = all(`SELECT sql FROM sqlite_master WHERE tbl_name = 'feed_mutes' AND type IN ('index', 'trigger') AND sql IS NOT NULL`);
  exec(newSql);
  exec('INSERT INTO feed_mutes_new SELECT * FROM feed_mutes');
  exec('DROP TABLE feed_mutes');
  exec('ALTER TABLE feed_mutes_new RENAME TO feed_mutes');
  for (const x of extras) exec(x.sql);
}
