-- Real Location entity, wired up 2026-07-16 per Ted.
--
-- Correct lifecycle: Lead (standalone) -> Location (a lead becomes a real
-- physical site) -> Contact (a person at that location) -> Opportunity
-- (attaches to the location, not the contact) -> Account (created/matched
-- only when an Opportunity at a Location wins; one Account can hold many
-- Locations -- Cintas as one billed account with several job-site
-- Locations underneath it, for example).
--
-- IMPORTANT: a `locations` table already existed live (created during
-- the July 7/8 D1 rebuild, whitelisted in unipro-ai-proxy's
-- ALLOWED_TABLES/TABLE_PREFIX from earlier scaffolding) with 12 rows in
-- it -- one location per legacy imported account from the GTO/UniPro
-- bulk import, a totally different shape than the "one company, many
-- locations" model this build needs. Nothing below recreates or drops
-- that table; every statement is additive.
--
-- This was applied directly against the live D1 database via the
-- Cloudflare connector (not the dashboard Console/Import), since it's
-- available this session. Statements actually run, for reference:

ALTER TABLE locations ADD COLUMN phone TEXT;
ALTER TABLE locations ADD COLUMN assigned_rep TEXT;
ALTER TABLE locations ADD COLUMN source TEXT;
ALTER TABLE locations ADD COLUMN status TEXT DEFAULT 'active';
ALTER TABLE locations ADD COLUMN notes TEXT;
ALTER TABLE locations ADD COLUMN activity_log TEXT;
ALTER TABLE locations ADD COLUMN lead_id TEXT;
-- Free-text parent company name for now (e.g. "Cintas", "XYZ Food
-- Service"). The real `companies` table already exists too
-- (locations.company_id references it) but has 0 rows and no UI writes
-- to it yet -- matching real companies to it properly (dedup, one
-- Cintas record instead of one per location) is follow-up work, not
-- done in this pass. parent_company is additive and doesn't block that.
ALTER TABLE locations ADD COLUMN parent_company TEXT;

ALTER TABLE contacts      ADD COLUMN location_id TEXT;
ALTER TABLE opportunities ADD COLUMN location_id TEXT;
ALTER TABLE leads         ADD COLUMN location_id TEXT;

CREATE INDEX IF NOT EXISTS idx_locations_account      ON locations(account_id);
CREATE INDEX IF NOT EXISTS idx_locations_lead         ON locations(lead_id);
CREATE INDEX IF NOT EXISTS idx_contacts_location       ON contacts(location_id);
CREATE INDEX IF NOT EXISTS idx_opportunities_location  ON opportunities(location_id);

-- Live schema as of 2026-07-16, full locations table, for reference:
-- CREATE TABLE locations (
--   id TEXT PRIMARY KEY, created_at INTEGER, updated_at INTEGER,
--   company_id TEXT, account_id TEXT, name TEXT, address TEXT,
--   city TEXT, state TEXT, zip TEXT, division TEXT,
--   phone TEXT, assigned_rep TEXT, source TEXT,
--   status TEXT DEFAULT 'active', notes TEXT, activity_log TEXT,
--   lead_id TEXT, parent_company TEXT
-- );
