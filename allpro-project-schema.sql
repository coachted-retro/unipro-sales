-- AllPro Project Planner — schema migration
-- Full lifecycle tracking for AllPro custom stainless fabrication projects
-- (kitchen hoods, fire suppression systems, and general custom stainless work).
-- Links back to existing CRM via account_id / opportunity_id — not a separate app.

CREATE TABLE IF NOT EXISTS allpro_projects (
  id TEXT PRIMARY KEY,
  account_id TEXT,
  opportunity_id TEXT,
  project_name TEXT NOT NULL,

  -- Kitchen Hood | Fire Suppression System | Custom Fabrication | Combined/Bundle
  project_type TEXT NOT NULL DEFAULT 'custom_fabrication',
  -- one-line summary for combined/bundle jobs, e.g. "36ft hood + Ansul R-102 + 2 prep tables"
  scope_summary TEXT,
  -- JSON array of component objects for combined/bundle jobs:
  -- [{"type":"kitchen_hood","desc":"36ft canopy hood"},{"type":"fire_suppression","desc":"Ansul R-102"}]
  -- Single-item projects (a pure hood job, a single custom table) leave this empty
  -- and rely on project_type alone.
  components_json TEXT,

  facility_type TEXT,
  -- New Construction | Renovation/TI | Equipment Replacement | Addition
  build_context TEXT,

  site_address TEXT,
  billing_address TEXT,
  -- JSON array: [{"role":"GC","name":"","phone":"","email":""}, {"role":"Architect",...}]
  project_contacts_json TEXT,

  -- intake | survey_plan_review | design_drawings | costing | permitting |
  -- fabrication | delivery_install | commissioning | closeout
  -- Custom-fab-only projects skip permitting and commissioning in the UI,
  -- jumping straight from costing to fabrication, and from delivery_install to closeout.
  stage TEXT NOT NULL DEFAULT 'intake',
  stage_updated_at INTEGER,

  survey_mode TEXT,          -- site_survey | plan_review
  survey_photos_json TEXT,   -- array of R2 photo URLs, same pattern as account photo storage
  survey_notes TEXT,

  -- Design / shop drawings — real revision history, not single-file overwrite
  -- [{"version":1,"file_url":"","uploaded_at":123,"uploaded_by":"","status":"draft"}, ...]
  drawings_json TEXT,

  -- Costing — the three numbers tracked in parallel at every stage
  estimated_cost REAL,       -- job cost estimate (material + labor + overhead), internal only
  sale_price REAL,           -- what the customer is quoted/invoiced
  actual_cost REAL,          -- rolls up live from allpro_cost_lines actual_amount during fabrication
  estimated_value REAL,      -- feeds the revenue forecasting engine at intake, before full costing exists

  -- LiDAR duct-run scan results (hood/suppression jobs only)
  deck_height_in REAL,
  duct_run_length_in REAL,
  duct_obstacles_json TEXT,  -- [{"type":"joist","offset_in":48,"note":""}, ...] from the native scan
  crane_required INTEGER DEFAULT 0,

  -- AHJ submittals — hood/suppression jobs only, 3 departments per NFPA 96 projects
  -- [{"dept":"building","status":"submitted","submitted_at":123,"days_in_review":0,"notes":""}, ...]
  ahj_submittals_json TEXT,
  -- NFPA 96 / UL 300 checklist state, keyed by requirement:
  -- {"clearance_to_combustibles":true,"duct_slope":true,"enclosure_rating":false,"access_panels":true,"min_velocity":true}
  compliance_checklist_json TEXT,

  -- Fabrication — mirrors/replaces the ad hoc job tracking that used to live only
  -- inside warehouse-portal.html's AllPro tab (queued/fabricating/ready/delivered).
  -- This table is now the source of truth; the warehouse tab reads from here.
  fab_status TEXT,           -- material_ordered | cutting | welding_fab | finish | qc | ready_to_ship
  fab_notes TEXT,

  -- Delivery / install
  delivery_date TEXT,
  install_work_order_id TEXT,   -- links to scheduler_queue as an "AllPro Install" WO type
  install_crew_json TEXT,

  -- Commissioning — hood/suppression jobs only
  commissioning_checklist_json TEXT, -- {"airflow_test":false,"interlock_test":false,"gas_shutoff_verified":false,"final_ahj_inspection":false}
  final_inspection_date TEXT,
  final_inspection_result TEXT,

  -- Closeout
  as_built_docs_json TEXT,
  punch_list_json TEXT,      -- [{"item":"","status":"open","resolved_at":null}, ...]
  cross_sell_triggered INTEGER DEFAULT 0,  -- fires Filter Man / suppression-inspection enrollment once, at closeout

  created_by TEXT,
  created_at INTEGER,
  updated_at INTEGER
);

-- Job costing line items — separate table so estimated vs actual is queryable
-- per line (material takeoff, labor by task, shop hours, coatings, delivery/crane),
-- not just a single lump-sum number on the project.
CREATE TABLE IF NOT EXISTS allpro_cost_lines (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,

  -- material | labor | shop_hours | coating | delivery | crane | other
  line_type TEXT NOT NULL,
  description TEXT NOT NULL,

  -- optional link into the existing AllPro warehouse catalog (ALLPRO_WH_PRODUCTS
  -- in warehouse-portal.html) when this line draws real stocked material
  warehouse_product_id TEXT,

  quantity REAL,
  unit TEXT,                 -- sq_ft, lb, hr, ea, etc.

  estimated_unit_cost REAL,
  estimated_amount REAL,

  actual_unit_cost REAL,
  actual_amount REAL,

  -- allocated | drawn | not_applicable — whether this line has reserved stock
  -- against warehouse_inventory yet (mirrors the "allocated" column already
  -- shown in warehouse-portal.html's AllPro stock table)
  material_status TEXT DEFAULT 'not_applicable',

  created_at INTEGER,
  updated_at INTEGER
);
