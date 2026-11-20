-- Learned site recipes (decision #165): after Jess searched a site through its own form and landed on a results address
-- with parameters, the SHAPE of that address is kept — host, path with slots, parameter names with slots — never the
-- values (what one person searched for stays theirs; the shape is shared by the household). Session and tracking
-- parameters are stripped before anything is stored. A recipe that fails twice in a row is deleted.
CREATE TABLE site_recipes (
  id            INTEGER PRIMARY KEY,
  host          TEXT NOT NULL,                     -- www.booking.com (as the results page had it)
  path_template TEXT NOT NULL,                     -- /searchresults.html · /s/{query}/homes
  param_names   TEXT NOT NULL,                     -- JSON ["ss={query}","checkin={date}"], in the page's order
  ok_count      INTEGER NOT NULL DEFAULT 1,        -- times it was learned again or worked when opened
  fail_count    INTEGER NOT NULL DEFAULT 0,        -- failures in a row since the last success (2 → deleted)
  last_ok_at    TEXT NOT NULL DEFAULT (datetime('now')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (host, path_template, param_names)
);
CREATE INDEX site_recipes_host ON site_recipes(host);
