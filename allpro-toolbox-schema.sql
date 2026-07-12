-- AllPro Toolbox: reference library and editable rate tables.
-- Added 2026-07-12. Backs the calculators and quick-lookup reference
-- library on the AllPro Project Planner toolbar. Rates are editable by
-- Ted, not hardcoded guesses, so estimates stay tuned to real numbers.

CREATE TABLE IF NOT EXISTS reference_library (
  id TEXT PRIMARY KEY,
  -- code_reference, ahj_permits, gauge_chart, general
  category TEXT NOT NULL DEFAULT 'general',
  title TEXT NOT NULL,
  content TEXT,
  -- JSON array of search tags
  tags TEXT DEFAULT '[]',
  created_at INTEGER,
  updated_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_reference_library_category ON reference_library(category);

CREATE TABLE IF NOT EXISTS allpro_rate_tables (
  id TEXT PRIMARY KEY,
  -- material or labor
  rate_type TEXT NOT NULL,
  -- e.g. stainless_304, galvanized, hood_fabrication, field_install
  rate_key TEXT NOT NULL,
  label TEXT NOT NULL,
  value REAL NOT NULL DEFAULT 0,
  -- $/lb, $/hr, hrs/unit, etc.
  unit TEXT,
  notes TEXT,
  created_at INTEGER,
  updated_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_rate_tables_type ON allpro_rate_tables(rate_type);
