-- Accounts Payable. Added 2026-07-13 to fix a real localStorage-only
-- bug: 'termac_payables' was being read/written directly to raw
-- localStorage independently in 6 different files (accounting-portal,
-- ap-portal, procurement-portal, warehouse-portal, termac-os,
-- termac-finance.js) with zero D1 sync anywhere. A bill logged from
-- warehouse-portal.html (receiving inventory) never actually reached
-- accounting-portal.html on a different device, despite the app
-- telling the user it would ("Accounting will see this in their Bills
-- Worklist" - that was false).

CREATE TABLE IF NOT EXISTS accounts_payable (
  id TEXT PRIMARY KEY,
  vendor TEXT,
  amount REAL,
  division TEXT,
  category TEXT,
  due_date TEXT,
  invoice_num TEXT,
  notes TEXT,
  -- open, approved, paid
  status TEXT NOT NULL DEFAULT 'open',
  logged_at INTEGER,
  paid_at INTEGER,
  -- warehouse_scan, manual_entry, etc - where this bill came from
  source TEXT,
  created_at INTEGER,
  updated_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_ap_status ON accounts_payable(status);
CREATE INDEX IF NOT EXISTS idx_ap_division ON accounts_payable(division);
