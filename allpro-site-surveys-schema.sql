-- AllPro Site Survey table
-- Run this in the Cloudflare D1 dashboard Console for database: termac-crm
-- Or upload via the Import feature

CREATE TABLE IF NOT EXISTS allpro_site_surveys (
  id TEXT PRIMARY KEY,

  -- Section 1: Project & Customer
  opportunity_id TEXT,
  location_id TEXT,
  account_id TEXT,
  rep_name TEXT,
  survey_date TEXT,
  customer_name TEXT,
  customer_contact TEXT,
  customer_phone TEXT,
  customer_email TEXT,
  site_address TEXT,
  site_zip TEXT,
  project_type TEXT,
  project_timeline TEXT,
  decision_maker_present INTEGER DEFAULT 0,
  decision_maker_name TEXT,
  decision_maker_contact TEXT,
  budget_range TEXT,

  -- Section 2: Hood Specifications
  hood_type TEXT,
  hood_style TEXT,
  hood_length_in REAL,
  hood_width_in REAL,
  hood_height_in REAL,
  hood_count INTEGER DEFAULT 1,
  ceiling_height_in REAL,
  existing_hood INTEGER DEFAULT 0,
  existing_hood_size TEXT,
  existing_hood_reason TEXT,
  wall_material TEXT,

  -- Section 3: Equipment Under Hood
  equipment_lineup_json TEXT,
  equipment_count INTEGER DEFAULT 0,
  sketch_photo_url TEXT,
  sketch_analysis_json TEXT,

  -- Section 4: Building & Site Conditions
  duct_routing TEXT,
  duct_run_ft REAL,
  duct_elbows INTEGER DEFAULT 0,
  obstructions_json TEXT,
  roof_access TEXT,
  existing_penetration INTEGER DEFAULT 0,
  power_at_fan INTEGER DEFAULT 0,
  power_voltage TEXT,
  gas_shutoff_accessible INTEGER DEFAULT 0,

  -- Section 5: Suppression System
  suppression_required TEXT,
  existing_suppression TEXT,
  suppression_preferred TEXT,
  suppression_in_scope INTEGER DEFAULT 0,
  fuel_shutoff_type TEXT,

  -- Section 6: Complexity Assessment (L1/L2/L3)
  complexity_duct TEXT DEFAULT 'L1',
  complexity_wall TEXT DEFAULT 'L1',
  complexity_deck TEXT DEFAULT 'L1',
  complexity_notes TEXT,
  overall_complexity_label TEXT,

  -- Section 7: Customer Responsibilities
  resp_permits INTEGER DEFAULT 0,
  resp_drawings_provided INTEGER DEFAULT 1,
  resp_electrician INTEGER DEFAULT 0,
  resp_sprinkler_coord INTEGER DEFAULT 0,
  resp_gc_structural INTEGER DEFAULT 0,
  resp_site_clear INTEGER DEFAULT 0,
  resp_notes TEXT,

  -- Section 8: Photos & Measurements
  photos_json TEXT,
  imagemeter_json TEXT,
  laser_measurements_raw TEXT,
  ai_measurements_json TEXT,
  ai_analysis_notes TEXT,

  -- Section 9: Fire Safety Upsell
  fire_ext_count INTEGER DEFAULT 0,
  fire_ext_condition TEXT,
  fire_ext_units_needed INTEGER DEFAULT 0,
  exit_light_count INTEGER DEFAULT 0,
  exit_light_condition TEXT,
  exit_sign_condition TEXT,
  fe_signage_condition TEXT,
  safety_observations TEXT,
  upsell_flags_json TEXT,
  upsell_accepted_json TEXT,

  -- Section 10: Service Bundle
  service_hood_cleaning TEXT DEFAULT 'none',
  service_hood_cleaning_price REAL DEFAULT 0,
  service_fe_inspection TEXT DEFAULT 'none',
  service_fe_inspection_price REAL DEFAULT 0,
  service_exit_light TEXT DEFAULT 'none',
  service_exit_light_price REAL DEFAULT 0,
  service_bundle_total REAL DEFAULT 0,
  service_bundle_accepted INTEGER DEFAULT 0,

  -- Comps (auto-pulled on ZIP + hood type + length)
  comp_market_low REAL,
  comp_market_avg REAL,
  comp_market_high REAL,
  comp_allpro_target REAL,
  comp_allpro_range_low REAL,
  comp_allpro_range_high REAL,
  comp_complexity_adjusted REAL,
  comp_source TEXT,
  comp_pulled_at INTEGER,
  comp_accepted INTEGER DEFAULT 0,
  comp_override REAL,

  -- T&M specific fields
  tm_work_description TEXT,
  tm_parts_needed TEXT,
  tm_est_shop_hours REAL DEFAULT 0,
  tm_est_install_hours REAL DEFAULT 0,
  tm_material_markup_pct REAL DEFAULT 20,

  -- JotForm reference
  jotform_submission_id TEXT,

  -- Field notes
  field_notes TEXT,
  special_conditions TEXT,

  -- Status & tracking
  status TEXT DEFAULT 'draft',
  quote_id TEXT,
  submitted_at INTEGER,
  created_at INTEGER,
  updated_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_surveys_opportunity ON allpro_site_surveys(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_surveys_location ON allpro_site_surveys(location_id);
CREATE INDEX IF NOT EXISTS idx_surveys_status ON allpro_site_surveys(status);
CREATE INDEX IF NOT EXISTS idx_surveys_zip ON allpro_site_surveys(site_zip);
