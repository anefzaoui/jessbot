-- Phase 23 (decisions #171–#173): skills Jess drafts with skill_propose. The skill itself is an ordinary folder in
-- data/skills/<name>/ that waits for the admin's review like any other (nothing here approves it). This table keeps what
-- must not sit in that folder, because the approval checksum covers every file in it: who asked, from which chat and run,
-- why, and the test requests (tests = should open the skill, near_misses = sound similar but shouldn't) that the admin's
-- trigger test runs. One row per proposal: Jess updating her own earlier draft adds a row. `checksum` is the folder
-- checksum right after the proposal was written, so the newest row describes the folder only while they still match
-- (an admin's edit breaks the match, and then the skill is the admin's). `raw` is the proposed SKILL.md as written.
CREATE TABLE skill_proposals (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,
  proposer_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  thread_id    INTEGER REFERENCES threads(id) ON DELETE SET NULL,
  run_id       INTEGER REFERENCES runs(id) ON DELETE SET NULL,
  why          TEXT NOT NULL DEFAULT '',
  tests        TEXT NOT NULL DEFAULT '[]',
  near_misses  TEXT NOT NULL DEFAULT '[]',
  checksum     TEXT NOT NULL,
  raw          TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX skill_proposals_name ON skill_proposals(name, id);
