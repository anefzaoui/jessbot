-- Phase 3: threads, messages, runs, the realtime event log, questions, thread summaries, usage.

CREATE TABLE threads (
  id                INTEGER PRIMARY KEY,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL DEFAULT 'side' CHECK (kind IN ('main', 'side')),
  title             TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  last_activity_at  TEXT NOT NULL DEFAULT (datetime('now')),
  context_epoch     INTEGER NOT NULL DEFAULT 0,
  active_summary_id INTEGER,
  last_prompt_tokens INTEGER,
  last_cached_tokens INTEGER,
  deleted_at        TEXT
);
CREATE UNIQUE INDEX threads_one_main ON threads(user_id) WHERE kind = 'main' AND deleted_at IS NULL;
CREATE INDEX threads_user ON threads(user_id, last_activity_at);

-- Every message ever sent is kept (compaction summarizes; it never deletes).
CREATE TABLE messages (
  id             INTEGER PRIMARY KEY,
  thread_id      INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  run_id         INTEGER,                         -- assistant/tool messages produced by a run
  role           TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'system')),
  content        TEXT NOT NULL DEFAULT '',
  tool_calls     TEXT,                            -- JSON (assistant messages that call tools)
  tool_call_id   TEXT,                            -- tool results
  tool_name      TEXT,
  token_count    INTEGER NOT NULL DEFAULT 0,
  summary        TEXT,                            -- short gist for big items (background)
  stub           TEXT,                            -- deterministic placeholder when offloaded
  offloaded_ref  TEXT,                            -- data/blobs/<sha256>.txt
  pinned         INTEGER NOT NULL DEFAULT 0,
  compacted_into INTEGER,                         -- thread_summaries.id once folded into a summary
  client_id      TEXT,                            -- idempotency for optimistic sends
  feedback       TEXT CHECK (feedback IN ('up', 'down')),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX messages_thread ON messages(thread_id, id);
CREATE UNIQUE INDEX messages_client ON messages(thread_id, client_id) WHERE client_id IS NOT NULL;

CREATE VIRTUAL TABLE messages_fts USING fts5(content, content='messages', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER messages_ai AFTER INSERT ON messages WHEN new.role IN ('user', 'assistant') BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER messages_ad AFTER DELETE ON messages WHEN old.role IN ('user', 'assistant') BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;
CREATE TRIGGER messages_au AFTER UPDATE OF content ON messages WHEN new.role IN ('user', 'assistant') BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;

-- One agent run = one reply cycle (may call tools, may wait for the user).
CREATE TABLE runs (
  id              INTEGER PRIMARY KEY,
  thread_id       INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trigger_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  reply_message_id   INTEGER REFERENCES messages(id) ON DELETE SET NULL,  -- the assistant message shown in chat
  status          TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'waiting', 'done', 'error', 'cancelled')),
  activity        TEXT NOT NULL DEFAULT 'thinking',
  activity_target TEXT,
  error           TEXT,
  model           TEXT,
  started_at      TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at        TEXT,
  steps           TEXT NOT NULL DEFAULT '[]',     -- JSON [{ id, iconName, label, detail, status, startedAt, endedAt }]
  draft           TEXT                            -- reply text streamed so far (saved ~1/s; refresh shows it)
);
CREATE INDEX runs_thread ON runs(thread_id, id);
CREATE INDEX runs_active ON runs(status) WHERE status IN ('queued', 'running', 'waiting');

-- Realtime event log (decision #19/#31): the WebSocket replays from here after a reconnect or refresh.
CREATE TABLE events (
  id        INTEGER PRIMARY KEY,                  -- global sequence (clients resume with lastSeq)
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_id INTEGER,
  run_id    INTEGER,
  type      TEXT NOT NULL,
  data      TEXT NOT NULL DEFAULT '{}',
  at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX events_user ON events(user_id, id);

-- ask_user (decision #20)
CREATE TABLE questions (
  id           INTEGER PRIMARY KEY,
  run_id       INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  thread_id    INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id   INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  tool_call_id TEXT NOT NULL,
  questions    TEXT NOT NULL,                     -- JSON (ask-dock contract)
  answers      TEXT,                              -- JSON [{ questionId, value, other? }]
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'answered', 'expired')),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  answered_at  TEXT
);
CREATE INDEX questions_pending ON questions(user_id, status);

-- Rolling / segment / day summaries (docs/CONTEXT-AND-MEMORY.md)
CREATE TABLE thread_summaries (
  id            INTEGER PRIMARY KEY,
  thread_id     INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  level         INTEGER NOT NULL CHECK (level IN (1, 2, 3)),   -- 1 segment, 2 day, 3 rolling
  from_msg_id   INTEGER,
  to_msg_id     INTEGER,
  content_json  TEXT,
  content_md    TEXT NOT NULL,
  token_count   INTEGER NOT NULL DEFAULT 0,
  model         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  supersedes_id INTEGER
);
CREATE INDEX summaries_thread ON thread_summaries(thread_id, level, id);

-- Cost accounting per model call (usage meter, admin usage).
CREATE TABLE usage_events (
  id                INTEGER PRIMARY KEY,
  user_id           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  run_id            INTEGER,
  purpose           TEXT NOT NULL DEFAULT 'chat',  -- chat | summary | extract | feed | test …
  model             TEXT,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens     INTEGER NOT NULL DEFAULT 0,
  cost              REAL NOT NULL DEFAULT 0,
  at                TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX usage_user_at ON usage_events(user_id, at);
