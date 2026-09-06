-- ════════════════════════════════════════════════════════════════
--  IRIS AI — PostgreSQL Database Schema
--  Run: psql -U postgres -d iris_ai -f schema.sql
-- ════════════════════════════════════════════════════════════════

-- Create database (run as superuser if needed)
-- CREATE DATABASE iris_ai;

-- ── USERS ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  uid           TEXT PRIMARY KEY,            -- Firebase UID
  email         TEXT NOT NULL UNIQUE,
  display_name  TEXT DEFAULT '',
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  last_seen     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);

-- ── CONVERSATIONS ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS conversations (
  id          SERIAL PRIMARY KEY,
  uid         TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  domain_id   TEXT NOT NULL,                -- e.g. 'study', 'event', 'code'
  messages    JSONB NOT NULL DEFAULT '[]',  -- [{role, content, timestamp, id}]
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (uid, domain_id)
);

CREATE INDEX IF NOT EXISTS idx_conv_uid         ON conversations (uid);
CREATE INDEX IF NOT EXISTS idx_conv_domain      ON conversations (domain_id);
CREATE INDEX IF NOT EXISTS idx_conv_updated_at  ON conversations (updated_at DESC);

-- ── ANALYTICS ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS analytics (
  uid         TEXT PRIMARY KEY REFERENCES users(uid) ON DELETE CASCADE,
  data        JSONB NOT NULL DEFAULT '{}',  -- domain analytics blob
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── USER SETTINGS ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_settings (
  uid         TEXT PRIMARY KEY REFERENCES users(uid) ON DELETE CASCADE,
  settings    JSONB NOT NULL DEFAULT '{}',
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── EVENTS (Event Manager Domain) ──────────────────────────────
CREATE TABLE IF NOT EXISTS events (
  id           TEXT PRIMARY KEY,            -- e.g. 'evt_birthday_2025-06-01'
  uid          TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  event_date   DATE,
  guest_count  TEXT,                        -- planned guest count (string from input)
  event_type   TEXT DEFAULT 'Event',        -- Birthday, Wedding, Corporate…
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_events_uid  ON events (uid);
CREATE INDEX IF NOT EXISTS idx_events_date ON events (event_date);

-- ── EVENT GUESTS ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS event_guests (
  guest_id       TEXT PRIMARY KEY,          -- 'g_<timestamp>_<random>'
  event_id       TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  email          TEXT NOT NULL,
  qr_data        TEXT NOT NULL,             -- JSON payload embedded in QR
  checked_in     BOOLEAN DEFAULT FALSE,
  checked_in_at  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_guests_event_id    ON event_guests (event_id);
CREATE INDEX IF NOT EXISTS idx_guests_checked_in  ON event_guests (checked_in);
CREATE INDEX IF NOT EXISTS idx_guests_email       ON event_guests (email);

-- ── FEEDBACK ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS feedback (
  id          SERIAL PRIMARY KEY,
  uid         TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  domain_id   TEXT NOT NULL,
  rating      SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment     TEXT DEFAULT '',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_feedback_uid    ON feedback (uid);
CREATE INDEX IF NOT EXISTS idx_feedback_domain ON feedback (domain_id);

-- ════════════════════════════════════════════════════════════════
--  HELPER VIEWS
-- ════════════════════════════════════════════════════════════════

-- Event summary view
CREATE OR REPLACE VIEW event_summary AS
SELECT
  e.id,
  e.uid,
  e.name,
  e.event_date,
  e.event_type,
  COUNT(g.guest_id)                                     AS total_guests,
  COUNT(g.guest_id) FILTER (WHERE g.checked_in = true) AS checked_in_count
FROM events e
LEFT JOIN event_guests g ON g.event_id = e.id
GROUP BY e.id, e.uid, e.name, e.event_date, e.event_type;

-- Per-domain message count view
CREATE OR REPLACE VIEW domain_message_counts AS
SELECT
  uid,
  domain_id,
  jsonb_array_length(messages) AS message_count,
  updated_at
FROM conversations;

COMMENT ON TABLE users         IS 'Firebase-authenticated users synced to Postgres';
COMMENT ON TABLE conversations IS 'Per-user, per-domain chat message history';
COMMENT ON TABLE events        IS 'Events created in the Event Manager domain';
COMMENT ON TABLE event_guests  IS 'Registered guests with QR entry tokens';
COMMENT ON TABLE analytics     IS 'Per-user usage analytics blob';
