-- ============================================================
-- TERMAC ONE — D1 SCHEMA (termac-crm)
-- Database ID: 27d4d735-57e6-430c-b977-9bbd43502345
-- ============================================================
-- NOTE: D1 console does not support -- comments in batch paste.
-- Use the Console tab and paste table by table, or use wrangler.

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  pin           TEXT NOT NULL,
  name          TEXT NOT NULL,
  email         TEXT,
  role          TEXT NOT NULL,
  division      TEXT,
  territory     TEXT,
  is_bid_mgr    INTEGER DEFAULT 0,
  status        TEXT DEFAULT 'active',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS companies (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  industry      TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS locations (
  id            TEXT PRIMARY KEY,
  company_id    TEXT REFERENCES companies(id),
  business_name TEXT NOT NULL,
  address       TEXT,
  city          TEXT,
  state         TEXT,
  zip           TEXT,
  phone         TEXT,
  email         TEXT,
  pricing_tier  TEXT,
  facility_type TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id              TEXT PRIMARY KEY,
  location_id     TEXT REFERENCES locations(id),
  company_id      TEXT REFERENCES companies(id),
  uni_acct_id     TEXT,
  q3_acct_id      TEXT,
  alp_acct_id     TEXT,
  flm_acct_id     TEXT,
  gto_acct_id     TEXT,
  trm_acct_id     TEXT,
  billing_cadence TEXT DEFAULT 'monthly',
  card_on_file    INTEGER DEFAULT 0,
  square_ref      TEXT,
  msa_signed      INTEGER DEFAULT 0,
  msa_signed_at   INTEGER,
  status          TEXT DEFAULT 'active',
  assigned_rep    TEXT REFERENCES users(id),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS contacts (
  id            TEXT PRIMARY KEY,
  location_id   TEXT REFERENCES locations(id),
  company_id    TEXT REFERENCES companies(id),
  first_name    TEXT,
  last_name     TEXT,
  title         TEXT,
  email         TEXT,
  phone         TEXT,
  is_primary    INTEGER DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS leads (
  id               TEXT PRIMARY KEY,
  business_name    TEXT NOT NULL,
  address          TEXT,
  city             TEXT,
  state            TEXT,
  zip              TEXT,
  phone            TEXT,
  email            TEXT,
  contact_name     TEXT,
  contact_title    TEXT,
  pricing_tier     TEXT,
  facility_type    TEXT,
  division         TEXT,
  lifecycle_stage  TEXT DEFAULT 'new',
  ai_score         INTEGER,
  assigned_rep     TEXT REFERENCES users(id),
  source           TEXT,
  notes            TEXT,
  follow_up_date   TEXT,
  last_activity    INTEGER,
  converted_at     INTEGER,
  account_id       TEXT REFERENCES accounts(id),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS opportunities (
  id              TEXT PRIMARY KEY,
  lead_id         TEXT REFERENCES leads(id),
  account_id      TEXT REFERENCES accounts(id),
  division        TEXT NOT NULL,
  service_type    TEXT,
  estimated_value REAL,
  status          TEXT DEFAULT 'open',
  close_date      TEXT,
  assigned_rep    TEXT REFERENCES users(id),
  notes           TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bids (
  id              TEXT PRIMARY KEY,
  lead_id         TEXT REFERENCES leads(id),
  title           TEXT NOT NULL,
  rfp_source      TEXT,
  due_date        TEXT,
  estimated_value REAL,
  division        TEXT,
  status          TEXT DEFAULT 'open',
  assigned_to     TEXT REFERENCES users(id),
  source          TEXT,
  notes           TEXT,
  submission_url  TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id              TEXT PRIMARY KEY,
  account_id      TEXT REFERENCES accounts(id),
  location_id     TEXT REFERENCES locations(id),
  division        TEXT NOT NULL,
  service_type    TEXT,
  tech_id         TEXT REFERENCES users(id),
  scheduled_date  TEXT,
  scheduled_time  TEXT,
  status          TEXT DEFAULT 'scheduled',
  notes           TEXT,
  report_url      TEXT,
  square_ref      TEXT,
  completed_at    INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS deficiencies (
  id              TEXT PRIMARY KEY,
  account_id      TEXT REFERENCES accounts(id),
  location_id     TEXT REFERENCES locations(id),
  job_id          TEXT REFERENCES jobs(id),
  division        TEXT,
  description     TEXT NOT NULL,
  equipment_type  TEXT,
  severity        TEXT DEFAULT 'standard',
  status          TEXT DEFAULT 'open',
  quoted_amount   REAL,
  quote_ref       TEXT,
  assigned_to     TEXT REFERENCES users(id),
  due_date        TEXT,
  resolved_at     INTEGER,
  notes           TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS collections (
  id              TEXT PRIMARY KEY,
  account_id      TEXT REFERENCES accounts(id),
  invoice_ref     TEXT,
  amount_due      REAL NOT NULL,
  amount_paid     REAL DEFAULT 0,
  due_date        TEXT,
  status          TEXT DEFAULT 'open',
  last_contact    INTEGER,
  notes           TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS scheduler_queue (
  id              TEXT PRIMARY KEY,
  account_id      TEXT REFERENCES accounts(id),
  location_id     TEXT REFERENCES locations(id),
  division        TEXT NOT NULL,
  service_type    TEXT,
  priority        TEXT DEFAULT 'normal',
  status          TEXT DEFAULT 'pending',
  requested_by    TEXT,
  notes           TEXT,
  scheduled_job_id TEXT REFERENCES jobs(id),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS activity_log (
  id              TEXT PRIMARY KEY,
  entity_type     TEXT NOT NULL,
  entity_id       TEXT NOT NULL,
  account_id      TEXT,
  user_id         TEXT REFERENCES users(id),
  action          TEXT NOT NULL,
  detail          TEXT,
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id              TEXT PRIMARY KEY,
  user_id         TEXT REFERENCES users(id),
  type            TEXT NOT NULL,
  title           TEXT NOT NULL,
  body            TEXT,
  entity_type     TEXT,
  entity_id       TEXT,
  read            INTEGER DEFAULT 0,
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  thread_id       TEXT NOT NULL,
  from_user       TEXT REFERENCES users(id),
  to_user         TEXT REFERENCES users(id),
  body            TEXT NOT NULL,
  read            INTEGER DEFAULT 0,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_leads_stage      ON leads(lifecycle_stage);
CREATE INDEX IF NOT EXISTS idx_leads_rep        ON leads(assigned_rep);
CREATE INDEX IF NOT EXISTS idx_leads_zip        ON leads(zip);
CREATE INDEX IF NOT EXISTS idx_jobs_tech        ON jobs(tech_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status      ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_date        ON jobs(scheduled_date);
CREATE INDEX IF NOT EXISTS idx_defic_status     ON deficiencies(status);
CREATE INDEX IF NOT EXISTS idx_defic_account    ON deficiencies(account_id);
CREATE INDEX IF NOT EXISTS idx_collections_stat ON collections(status);
CREATE INDEX IF NOT EXISTS idx_activity_entity  ON activity_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_notif_user       ON notifications(user_id, read);
CREATE INDEX IF NOT EXISTS idx_loc_company      ON locations(company_id);
CREATE INDEX IF NOT EXISTS idx_sched_status     ON scheduler_queue(status);
CREATE INDEX IF NOT EXISTS idx_accounts_rep     ON accounts(assigned_rep);
