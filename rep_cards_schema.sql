CREATE TABLE IF NOT EXISTS rep_cards (
  id TEXT PRIMARY KEY,
  rep_slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  title TEXT,
  divisions TEXT,
  phone TEXT,
  email TEXT,
  linkedin TEXT,
  bio TEXT,
  service_area TEXT,
  years_experience INTEGER,
  created_at INTEGER,
  updated_at INTEGER
);
