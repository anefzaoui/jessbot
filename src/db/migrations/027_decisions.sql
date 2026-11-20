-- Jess's quick decisions (docs/JEV.md, decision #106): every call to the decision model (Jev), what it decided and
-- whether the answer was acted on or the old logic took over. Admin → Models shows the latest; kept 30 days.
CREATE TABLE decisions (
  id          INTEGER PRIMARY KEY,
  use         TEXT NOT NULL,                                   -- checkin | memory | reflect | turn | page | risk | steps | feed | try
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  run_id      INTEGER,
  outcome     TEXT,                                            -- short, human: "skip — nothing worth saying (0.12)"
  confidence  REAL,                                            -- the number the outcome rests on (0–1)
  acted       INTEGER NOT NULL DEFAULT 1,                      -- 1: Jev's answer was used · 0: the old logic decided
  fallback    TEXT,                                            -- why not: error | timeout | unsure | off
  ms          INTEGER,
  cost        REAL NOT NULL DEFAULT 0,
  at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX decisions_use_at ON decisions(use, at);
CREATE INDEX decisions_at ON decisions(at);
