-- Rate limits that survive a restart (decision #223, issue #6): sign-in, setup, invite and the request limiter count here
-- instead of in the process's memory, so restarting Jessbot doesn't hand an attacker a fresh set of attempts.
-- A fixed window per key: `hits` within the window that ends at `reset_at` (milliseconds since 1970).
CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  hits INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX rate_limits_reset ON rate_limits(reset_at);
