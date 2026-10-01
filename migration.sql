-- Bu 3 komutu remote D1 veritabanına uygula (Cloudflare D1 dashboard konsolunda
-- TEK TEK, ya da Shell'den: npx wrangler d1 execute donor-stream-db --remote --file=./migration.sql)

ALTER TABLE sessions ADD COLUMN event_id INTEGER;

CREATE TABLE IF NOT EXISTS watch_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  name TEXT,
  event_id INTEGER,
  connected_at INTEGER NOT NULL,
  disconnected_at INTEGER
);

CREATE TABLE IF NOT EXISTS event_group_access (
  event_id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  code TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (event_id) REFERENCES events(id)
);
