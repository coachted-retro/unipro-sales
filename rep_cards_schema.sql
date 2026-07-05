-- Run this in the Cloudflare D1 console for the termac-crm database.
-- New, dedicated table for Digital Business Card profiles — kept separate
-- from the existing users table since its actual schema isn't documented
-- anywhere in the repo, and guessing at it risked either a silent insert
-- failure or colliding with whatever it's already used for.
--
-- Includes a generic `id` column even though rep_slug is the natural key,
-- because the existing termac-d1-api worker always generates and inserts
-- an `id` on every POST regardless of a table's real key — matching that
-- pattern avoids needing any change to that shared, already-tested code.

CREATE TABLE IF NOT EXISTS rep_cards (
  id TEXT PRIMARY KEY,
  rep_slug TEXT UNIQUE NOT NULL,   -- e.g. 'ted-scholl' — matches the ?rep= URL param
  name TEXT NOT NULL,
  title TEXT,
  divisions TEXT,                  -- comma-separated, e.g. 'UniPro' or 'UniPro,AllPro,GTO'
  phone TEXT,
  email TEXT,
  linkedin TEXT,
  bio TEXT,                        -- short "what I help with" blurb shown on the card
  service_area TEXT,               -- e.g. 'Bucks & Montgomery County, PA'
  years_experience INTEGER,
  created_at INTEGER,
  updated_at INTEGER
);

