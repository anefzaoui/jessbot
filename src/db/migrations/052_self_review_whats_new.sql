-- Phase 23 (decisions #208, #210): the weekly self-review for the owner, and "What's new in Jess".

-- The weekly self-review (#208): once a week (off by default, Admin), the week's signals are collected in code — thumbs-down,
-- pushes, dead-end checks, repeated changes, declined approvals, failed steps, wishes, lessons — and one background-model call
-- turns them into at most 3 proposals. `stats` is the week's "How I'm doing" (JSON, built in code, no model).
CREATE TABLE self_reviews (
  id           INTEGER PRIMARY KEY,
  period_start TEXT NOT NULL,                                   -- UTC 'YYYY-MM-DD HH:MM:SS', like created_at
  period_end   TEXT NOT NULL,
  origin       TEXT NOT NULL DEFAULT 'weekly' CHECK (origin IN ('weekly', 'admin')),  -- the scheduler, or Run now
  status       TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'nothing', 'error')),
  stats        TEXT,                                            -- JSON: the week's numbers (agent/self-review.js weekStats)
  model        TEXT,                                            -- the model that answered, when one was asked
  note         TEXT,                                            -- why nothing / what went wrong / proposals left out
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at  TEXT
);
CREATE INDEX self_reviews_created ON self_reviews(created_at);

-- One proposal: what it would change (`change`, JSON by kind), why, and the tasks that show it (`evidence`, run ids the admin
-- can open under the usual rules). Approving applies it: AGENTS.md through the versioned save, a person's instructions as a
-- new version, a skill through skill_propose (it still waits for review); memory and developer notes are for the admin.
CREATE TABLE self_review_proposals (
  id             INTEGER PRIMARY KEY,
  review_id      INTEGER NOT NULL REFERENCES self_reviews(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('agents_rule', 'removal', 'instruction', 'skill', 'memory', 'developer')),
  title          TEXT NOT NULL,
  why            TEXT,
  change         TEXT,                                          -- JSON by kind (agent/self-review.js checkProposal)
  evidence       TEXT NOT NULL DEFAULT '[]',                    -- JSON [run id, …]
  target_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, -- instruction / memory: whose
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  decided_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_at     TEXT,
  reason         TEXT,                                          -- the admin's reason for a rejection
  result         TEXT,                                          -- what approving did ("AGENTS.md saved as version 12")
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX self_review_proposals_review ON self_review_proposals(review_id);
CREATE INDEX self_review_proposals_pending ON self_review_proposals(status) WHERE status = 'pending';

-- What's new in Jess (#210): `npm run release` leaves the commit subjects since the last release; the server turns them into a
-- draft (one background-model call: 3-6 plain lines, internal commits left out), the admin edits and publishes it, and each
-- person sees a published entry once (a card, Phase 25).
CREATE TABLE whats_new (
  id           INTEGER PRIMARY KEY,
  commit_ref   TEXT NOT NULL UNIQUE,                            -- the released commit (short hash) the entry is for
  subjects     TEXT NOT NULL DEFAULT '[]',                      -- JSON [commit subject, …] since the previous release
  lines        TEXT NOT NULL DEFAULT '[]',                      -- JSON [plain-language line, …] (drafted, then the admin's)
  status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'discarded')),
  drafted_at   TEXT,                                            -- the model was asked (once by the scheduler; Redraft asks again)
  published_at TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE whats_new_seen (
  entry_id INTEGER NOT NULL REFERENCES whats_new(id) ON DELETE CASCADE,
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seen_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (entry_id, user_id)
);
