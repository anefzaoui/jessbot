-- Phase 7b: where people are, and their weather (decision #30, #49).

-- A person's places: home (primary), work, or wherever they said they are. Coordinates from geocoding or the browser.
CREATE TABLE places (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label         TEXT NOT NULL DEFAULT 'home',                  -- home | work | current | a short custom label
  name          TEXT NOT NULL,                                  -- "Lyon, Auvergne-Rhône-Alpes, France"
  latitude      REAL NOT NULL,
  longitude     REAL NOT NULL,
  timezone      TEXT,
  country_code  TEXT,
  source        TEXT NOT NULL DEFAULT 'chat' CHECK (source IN ('chat', 'gps', 'settings', 'admin')),
  is_primary    INTEGER NOT NULL DEFAULT 0,
  alerted_key   TEXT,                                           -- last proactive weather alert (once per event)
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, label)
);
CREATE INDEX places_primary ON places(user_id) WHERE is_primary = 1;

-- Forecasts per rounded coordinate (2 dp ≈ 1 km): shared by everyone nearby, refreshed every 30 min, stale ≤ 6 h.
CREATE TABLE weather_cache (
  key         TEXT PRIMARY KEY,                                  -- "45.76,4.84"
  latitude    REAL NOT NULL,
  longitude   REAL NOT NULL,
  timezone    TEXT,
  data        TEXT,                                              -- normalised JSON (services/weather.js)
  source      TEXT,
  fetched_at  TEXT,
  error       TEXT,
  error_at    TEXT
);
