-- Trade Partner Network
-- Cross-division database of subcontractors, fire-protection vendors who sub
-- work to Termac, and general contractors used for bid work. Shared across
-- all divisions (Termac, AllPro, GTO, UniPro, Quality III, Filter Man) --
-- not scoped to any single one. Added 2026-07-12.

CREATE TABLE IF NOT EXISTS trade_partners (
  id TEXT PRIMARY KEY,
  company_name TEXT NOT NULL,
  -- JSON array, a company can be more than one: ["subcontractor","vendor","gc"]
  partner_types TEXT NOT NULL DEFAULT '[]',
  -- JSON array of trade tags: electrician, plumber, hvac, hood_cleaning,
  -- fire_suppression, fire_extinguisher, stainless_fabrication, general_contractor, other
  trades TEXT NOT NULL DEFAULT '[]',
  -- JSON array of which Termac divisions use this partner: termac, allpro,
  -- gto, unipro, quality3, filterman
  divisions TEXT NOT NULL DEFAULT '[]',
  -- we_refer: we send them work only. they_refer: they send us work only.
  -- reciprocal: both directions.
  referral_direction TEXT NOT NULL DEFAULT 'reciprocal',
  primary_contact_name TEXT,
  primary_contact_phone TEXT,
  primary_contact_email TEXT,
  company_phone TEXT,
  company_email TEXT,
  address TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  -- JSON array of zip codes / region names this partner covers
  territory TEXT DEFAULT '[]',
  license_number TEXT,
  license_expiration TEXT,
  coi_expiration TEXT,
  w9_on_file INTEGER DEFAULT 0,
  -- active, vetted, prospect, inactive
  status TEXT NOT NULL DEFAULT 'prospect',
  notes TEXT,
  created_by TEXT,
  created_at INTEGER,
  updated_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_trade_partners_status ON trade_partners(status);

CREATE TABLE IF NOT EXISTS trade_partner_referrals (
  id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL,
  -- sent: we referred a customer to them. received: they referred a
  -- customer/job to us.
  direction TEXT NOT NULL,
  division TEXT,
  account_id TEXT,
  job_description TEXT,
  referred_by TEXT,
  referred_date TEXT,
  -- pending, won, lost, no_response
  outcome TEXT NOT NULL DEFAULT 'pending',
  value_estimate REAL,
  notes TEXT,
  created_at INTEGER,
  updated_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_referrals_partner ON trade_partner_referrals(partner_id);
CREATE INDEX IF NOT EXISTS idx_referrals_direction ON trade_partner_referrals(direction);

CREATE TABLE IF NOT EXISTS trade_partner_bids (
  id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL,
  project_name TEXT,
  -- optional link into allpro_projects.id when the bid is tied to a
  -- known AllPro job
  allpro_project_id TEXT,
  bid_amount REAL,
  submitted_date TEXT,
  -- pending, won, lost
  result TEXT NOT NULL DEFAULT 'pending',
  result_date TEXT,
  notes TEXT,
  created_at INTEGER,
  updated_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_bids_partner ON trade_partner_bids(partner_id);
