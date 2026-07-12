-- Opportunities as real child records of an Account. Per Ted: an
-- account can have any number of independent, named opportunities
-- (e.g. "Hood Inspection", "Fire Extinguisher Inspection", "Dish
-- Machine Install" all under one account), each tracked separately
-- through its own stage/value/timeline - not a single stage value on
-- the account record itself, which is how the old model worked.
--
-- This table already existed (registered in ALLOWED_TABLES/
-- TABLE_PREFIX from before this session, with a partial dropdown in
-- allpro-project-planner.html's New Project flow and a read in
-- termac-os.html's rep metrics) but had no create/edit UI anywhere -
-- the actual missing piece this build fills in. Live schema as of
-- 2026-07-13, documented here for reference:
--
-- CREATE TABLE opportunities (
--   id TEXT PRIMARY KEY,
--   created_at INTEGER,
--   updated_at INTEGER,
--   account_id TEXT,
--   name TEXT,
--   division TEXT,
--   stage TEXT,
--   value REAL,
--   assigned_rep TEXT,
--   expected_close TEXT
-- );
--
-- Added below: notes (free text) and closed_at (when it was actually
-- won or lost, distinct from expected_close which is a forecast date).

ALTER TABLE opportunities ADD COLUMN notes TEXT;
ALTER TABLE opportunities ADD COLUMN closed_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_opportunities_account ON opportunities(account_id);
CREATE INDEX IF NOT EXISTS idx_opportunities_stage ON opportunities(stage);
